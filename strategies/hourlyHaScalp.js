// hourlyHaScalp.js — HOURLY_HA_SCALP: one scalp per hour, direction from the PREVIOUS 1h candle's colour.
//
// Runs on the 1h clock (STRATEGY_TIMEFRAME). Every time a 1h candle closes (candlePoll fires ~5 s after the slot):
//   1) if a trade from the previous hour is still open it is closed AT THE HOUR END (reason HOUR_END);
//   2) the candle that just closed decides the next trade: HA (default) or normal colour, green -> LONG / red -> SHORT
//      (`direction: fade` inverts it); a doji (open == close) -> no trade that hour;
//   3) entry at the live price with a fixed stop-loss and a fixed target, both configurable (`unit` pct | points | atr).
// TARGET and STOP are tick-checked by candlePoll (targetStore / slStore). Whichever is hit first closes the trade and the engine
// then waits for the next hour boundary — one trade per hour at most, no re-entry inside the hour.
// WINDOW: entries only from `firstEntryTime` to `lastEntryTime` (IST, compared with the CLOSE time of the deciding candle) so a trade
//   always has a full hour to run before the session ends. Stale candles (boot catch-up long after the close) never trigger an entry.
// GATES: none of chop / volume / long-candle / HTF / daily-HA / entry-time apply (STRATEGY_INFO.ownGates forces the universal ones off).
// PRODUCT: intraday only. Deploy MIS (or NRML with no carry); positions never intentionally cross the hourly boundary.
"use strict";

const c = require("../utils/c");
const { atr, toHAAlways } = require("../indicators/indicators");
const { istParts } = require("../utils/istTime");
const { emitEvent } = require("../core/eventBridge");
const { resolveParams } = require("./strategyParams");

const SRC = "HOURLY_HA_SCALP";
const HOUR_MS = 3600000, STALE_MS = 15 * 60000;

// Pure — exported for tests. bars: completed 1h bars oldest -> newest. Returns "green" | "red" | null (doji / no data).
function candleColor(bars, candleType) {
    if (!bars || !bars.length) return null;
    const last = candleType === "normal" ? bars[bars.length - 1] : toHAAlways(bars)[bars.length - 1];
    return last.close > last.open ? "green" : last.close < last.open ? "red" : null;
}

// Pure — exported for tests. Returns { stop, target, tpDist, slDist } or null when the distance can't be computed.
function levels({ side, price, unit, targetVal, slVal, atrVal }) {
    const dist = v => unit === "points" ? v : unit === "pct" ? price * v / 100 : unit === "atr" ? (atrVal > 0 ? atrVal * v : NaN) : NaN;
    const tpDist = dist(targetVal), slDist = dist(slVal);
    if (!(tpDist > 0) || !(slDist > 0)) return null;
    const dir = side === "LONG" ? 1 : -1;
    return { stop: price - dir * slDist, target: price + dir * tpDist, tpDist, slDist };
}

function toMin(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }

function createHourlyHaScalpStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    const resolved = resolveParams(SRC, context.strategyParams);
    const P = resolved.values;
    for (const m of [...resolved.errors, ...resolved.warnings]) console.warn(c.yellow(`[${context.tgPrefix}] ${SRC} param: ${m}`));
    const FIRST = toMin(P.firstEntryTime), LAST = toMin(P.lastEntryTime);
    const bars = () => (candles.getSourceCandles ? candles.getSourceCandles() : candles.getRawCandles());
    const persist = (position, entryPrice) => db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, SRC);

    async function exitAtHourEnd(price) {
        const side = state.position;
        const ordered = await orders.exit(side);
        if (engineConfig.LIVE_ORDERS && ordered === null) {
            console.error(c.red(`[${context.tgPrefix}] ${SRC} hour-end exit order FAILED — position kept`));
            tg(`⚠ [${context.tgPrefix}] ${SRC} ${side} hour-end EXIT failed — still open, retrying next hour; check manually`);
            return false;
        }
        tg(`${side} EXIT (${SRC}) @ ₹${price.toFixed(2)}\nreason: hour end`);
        await positionsClose(price, "HOUR_END");
        slStore.clearTrail(); targetStore.clearTarget();
        persist(null, 0);
        return true;
    }

    async function enter(side, price, color, atrVal) {
        const lv = levels({ side, price, unit: P.unit, targetVal: P.targetVal, slVal: P.slVal, atrVal });
        if (!lv) { console.warn(c.yellow(`[${context.tgPrefix}] ${SRC} no valid target/SL distance (unit ${P.unit}, ATR ${atrVal}) — skipping`)); return false; }
        const ordered = await orders.enter(side);
        if (engineConfig.LIVE_ORDERS && ordered === null) {
            console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed (${SRC}) — no trade this hour`));
            return false;
        }
        state.position = side; state.tradesToday = (state.tradesToday || 0) + 1; state.entryPrice = price; state.positionSource = SRC;
        state.openTradeId = await db.insertOpenTrade(context.tgPrefix, context.symbol, side, context.lots, price);
        const dir = side === "LONG" ? 1 : -1;
        slStore.setTrail(lv.stop, dir);
        targetStore.setTarget(lv.target, dir);
        persist(side, price);
        const desc = `${side} @ ₹${price.toFixed(2)}  SL ₹${lv.stop.toFixed(2)}  TP ₹${lv.target.toFixed(2)}  (prev 1h ${P.candleType === "ha" ? "HA " : ""}${color}, ${P.direction})`;
        console.log(c.white(`[${context.tgPrefix}] ${SRC} ENTRY ${desc}`));
        emitEvent(context.tgPrefix, "ENTRY", { side, price, trail: lv.stop, pure: null });
        emitEvent(context.tgPrefix, "TARGET", { side, entry: price, points: lv.tpDist, level: lv.target, mode: "fixed", regime: null });
        tg(`${SRC} ENTRY\n${desc}`);
        return true;
    }

    async function processCandle(candle) {
        if (lifecycle.isShutdown()) return;
        const src = bars();
        const last = src[src.length - 1] || candle || {};
        const livePrice = candles.getLivePrice() ?? last.close;
        const uPnL = positionsUnrealised(livePrice);
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session: (state.pnl || 0) + uPnL, position: state.position, entryPrice: state.entryPrice || null, pure: null });
        if (!engineConfig.ENGINE_ENABLED || !last.date) return;

        // 1) hour end: whatever is still open from the previous hour is closed now
        if (state.position) { if (!(await exitAtHourEnd(livePrice))) return; }

        // 2) next trade from the candle that just closed
        const closeMs = new Date(last.date).getTime() + HOUR_MS, now = clock.now().getTime();
        if (now - closeMs > STALE_MS) return;   // boot catch-up / late poll: a stale candle never opens a trade
        const { hours, minutes } = istParts(new Date(closeMs));
        const closeMin = hours * 60 + minutes;
        if (closeMin < FIRST || closeMin > LAST) return;
        const color = candleColor(src, P.candleType);
        if (!color) return;   // doji
        const side = (color === "green") === (P.direction === "follow") ? "LONG" : "SHORT";
        await enter(side, livePrice, color, P.unit === "atr" ? atr(src, P.atrLen) : null);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position && (saved.entry_date ?? null) === new Date(clock.now()).toISOString().split("T")[0]) {
                // Resume a same-day position: re-arm SL/TP from its entry price so a restart mid-hour keeps protection.
                state.position = saved.position; state.entryPrice = saved.entry_price; state.positionSource = saved.position_source || SRC;
                const open = await db.getOpenTrade(context.tgPrefix);
                state.openTradeId = open ? open.id : null;
                state.resumedFromDb = true;
                const src = bars(), lv = levels({ side: state.position, price: state.entryPrice, unit: P.unit, targetVal: P.targetVal, slVal: P.slVal, atrVal: P.unit === "atr" ? atr(src, P.atrLen) : null });
                if (lv) { const dir = state.position === "LONG" ? 1 : -1; if (slStore.getTrail().trail == null) slStore.setTrail(lv.stop, dir); if (targetStore.getTarget().target == null) targetStore.setTarget(lv.target, dir); }
            } else if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
            }
            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);
            state.tradesToday = await db.getTradeCountToday(context.tgPrefix);
            console.log(); console.log(c.green(`[${context.tgPrefix}] ${state.position ? `${state.position}@${state.entryPrice} (closes at the next hour end)` : "flat (waiting for the next 1h candle close)"}`)); console.log();
            await orders.reconcile(state);
        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

module.exports = { createHourlyHaScalpStrategy, candleColor, levels };
