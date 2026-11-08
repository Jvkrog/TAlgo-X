// trendDonchianVt.js — TREND_DONCHIAN_VT: multi-day Donchian-channel trend following with ATR volatility-targeted sizing.
//
// SIGNAL (daily bars, decided ONCE per IST day at/after `entryTime`, on the last COMPLETED daily bar — same cadence as DAILY_HA_BIAS):
//   LONG  entry  close > highest high of the `entryN` bars BEFORE the signal bar      SHORT entry  close < lowest low of those bars
//   LONG  exit   close < lowest low of the `exitN` bars before the signal bar          SHORT exit   close > highest high of those bars
//   reentry "fresh" (default): enter only when THIS bar is the first to break the channel (the bar before did not) — otherwise a
//   stop-out inside a running trend would re-enter at the next decision on the very same stale signal. "any": enter whenever beyond.
//   A decision may exit and reverse in one go (exit fires first; the opposite entry is then evaluated on the same bar).
// STOP: fixed hard stop `stopAtrMult` x daily ATR(atrLen) from the entry price, held in slStore (tick-checked by candlePoll, persisted
//   across restarts by core/riskState.js). The channel exit above is the trailing exit; there is no profit target.
// SIZING (vol targeting): equity > 0  ->  lots = floor(equity x riskPct% / (stopAtrMult x ATR x lotMult)), clamped to [1, maxLots]; if
//   even ONE lot risks more than budget x minLotOvershoot the trade is SKIPPED with an alert (never silently over-risk). equity = 0 ->
//   the deployment's fixed lots. context.lots is set per entry (orders / P&L / DB / reconcile all read it) and restored from the open
//   trade row on resume.
// PRODUCT: positions carry overnight -> deploy NRML + carry-overnight. Decisions need no intraday candles beyond the 15m clock tick.
// GATES: wires in NONE of chop / volume / long-candle / HTF / daily-HA (they would veto breakouts by construction); the once-a-day
//   decision + `entryTime` replace the entry-time and double-order gates.
"use strict";

const c = require("../utils/c");
const { atr } = require("../indicators/indicators");
const { istParts } = require("../utils/istTime");
const { emitEvent } = require("../core/eventBridge");
const { createDailyBarReader } = require("../indicators/dailyBarReader");
const { istDay } = require("../utils/formingBar");
const { resolveParams } = require("./strategyParams");

const SRC = "TREND_DONCHIAN_VT";

// Pure signal evaluation — exported for tests. bars: completed daily bars oldest -> newest.
function donchianSignal(bars, { entryN, exitN, reentry }) {
    const need = Math.max(entryN, exitN) + 2;
    if (!bars || bars.length < need) return null;
    const hh = (end, n) => Math.max(...bars.slice(end - n, end).map(b => b.high));
    const ll = (end, n) => Math.min(...bars.slice(end - n, end).map(b => b.low));
    const i = bars.length - 1, last = bars[i];
    const longNow = last.close > hh(i, entryN), shortNow = last.close < ll(i, entryN);
    const longPrev = bars[i - 1].close > hh(i - 1, entryN), shortPrev = bars[i - 1].close < ll(i - 1, entryN);
    return {
        date: last.date, close: last.close,
        enterLong:  longNow  && (reentry === "any" || !longPrev),
        enterShort: shortNow && (reentry === "any" || !shortPrev),
        exitLong:   last.close < ll(i, exitN),
        exitShort:  last.close > hh(i, exitN),
        entryHigh: hh(i, entryN), entryLow: ll(i, entryN), exitHigh: hh(i, exitN), exitLow: ll(i, exitN),
    };
}

// Pure sizing — exported for tests. Returns { lots, skip, reason, budget, perLotRisk }.
function sizeLots({ equity, riskPct, maxLots, minLotOvershoot, stopAtrMult, atrVal, lotMult, fixedLots }) {
    if (!(equity > 0)) return { lots: fixedLots, skip: false, reason: "fixed lots (vol-targeting off)" };
    const perLotRisk = stopAtrMult * atrVal * lotMult, budget = equity * riskPct / 100;
    if (!(perLotRisk > 0)) return { lots: fixedLots, skip: false, reason: "no ATR — fixed lots" };
    const raw = Math.floor(budget / perLotRisk);
    if (raw >= 1) return { lots: Math.min(raw, maxLots), skip: false, budget, perLotRisk, reason: `${raw} lots by risk budget` };
    if (perLotRisk <= budget * minLotOvershoot) return { lots: 1, skip: false, budget, perLotRisk, reason: `1 lot risks ${(perLotRisk / budget).toFixed(2)}x budget (allowed up to ${minLotOvershoot}x)` };
    return { lots: 0, skip: true, budget, perLotRisk, reason: `1 lot risks Rs ${perLotRisk.toFixed(0)} = ${(perLotRisk / budget).toFixed(2)}x the Rs ${budget.toFixed(0)} budget (limit ${minLotOvershoot}x)` };
}

function createTrendDonchianVtStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() }, dailyBars }) {
    const resolved = resolveParams(SRC, context.strategyParams);
    const P = resolved.values;
    for (const m of [...resolved.errors, ...resolved.warnings]) console.warn(c.yellow(`[${context.tgPrefix}] ${SRC} param: ${m}`));
    const [ENTRY_H, ENTRY_M] = P.entryTime.split(":").map(Number);
    const fixedLots = context.lots;   // the deployment's own lot count — the fallback when vol-targeting is off
    const reader = (dailyBars && typeof dailyBars.getCompleted === "function")
        ? dailyBars : createDailyBarReader({ token: context.token, engineConfig, label: context.tgPrefix });

    const persist = (position, entryPrice) => db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, SRC);

    async function exitPosition(sig, why) {
        const side = state.position, price = candles.getLivePrice() ?? sig.close;
        const ordered = await orders.exit(side);
        if (engineConfig.LIVE_ORDERS && ordered === null) {
            console.error(c.red(`[${context.tgPrefix}] ${SRC} exit order FAILED — position kept, retrying next candle`));
            tg(`⚠ [${context.tgPrefix}] ${SRC} ${side} EXIT order failed (${why}) — still open, retrying next candle`);
            return false;
        }
        tg(`${side} EXIT (${SRC}) @ ₹${price.toFixed(2)}\nreason: ${why}`);
        await positionsClose(price, why.startsWith("channel") ? "DONCHIAN_EXIT" : why);
        slStore.clearTrail(); targetStore.clearTarget();
        persist(null, 0);
        return true;
    }

    async function enterPosition(side, sig, atrVal) {
        const price = candles.getLivePrice() ?? sig.close;
        const size = sizeLots({ equity: P.equity, riskPct: P.riskPct, maxLots: P.maxLots, minLotOvershoot: P.minLotOvershoot,
            stopAtrMult: P.stopAtrMult, atrVal, lotMult: context.lotMult, fixedLots });
        if (size.skip) {
            console.warn(c.yellow(`[${context.tgPrefix}] ${SRC} ${side} signal SKIPPED — ${size.reason}`));
            tg(`⚠ [${context.tgPrefix}] ${SRC} ${side} signal skipped: ${size.reason}`);
            return false;
        }
        const prevLots = context.lots;
        context.lots = size.lots;   // everything downstream (orders, P&L, DB row, reconcile) reads context.lots
        const ordered = await orders.enter(side);
        if (engineConfig.LIVE_ORDERS && ordered === null) {
            context.lots = prevLots;
            console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed (${SRC}) — decided for today, no retry`));
            return false;
        }
        const stop = side === "LONG" ? price - P.stopAtrMult * atrVal : price + P.stopAtrMult * atrVal;
        state.position = side; state.tradesToday = (state.tradesToday || 0) + 1; state.entryPrice = price; state.positionSource = SRC;
        state.openTradeId = await db.insertOpenTrade(context.tgPrefix, context.symbol, side, context.lots, price);
        slStore.setTrail(stop, side === "LONG" ? 1 : -1);
        persist(side, price);
        const desc = `${side} ${context.lots} lot${context.lots > 1 ? "s" : ""} @ ₹${price.toFixed(2)}  stop ₹${stop.toFixed(2)} (${P.stopAtrMult}x ATR ${atrVal.toFixed(2)})  [${size.reason}]  channel ${P.entryN}d ${side === "LONG" ? "high" : "low"} ${(side === "LONG" ? sig.entryHigh : sig.entryLow).toFixed(2)}`;
        console.log(c.white(`[${context.tgPrefix}] ${SRC} ENTRY ${desc}`));
        emitEvent(context.tgPrefix, "ENTRY", { side, price, trail: stop, pure: null });
        tg(`${SRC} ENTRY\n${desc}`);
        return true;
    }

    async function runSignals(rawCandle) {
        const livePrice = candles.getLivePrice() ?? rawCandle.close;
        const uPnL = positionsUnrealised(livePrice);
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session: (state.pnl || 0) + uPnL, position: state.position, entryPrice: state.entryPrice || null, pure: null });
        if (!engineConfig.ENGINE_ENABLED) return;

        const today = istDay(clock.now().getTime());
        if (state.donchianDecidedFor === today) return;
        const { hours, minutes } = istParts(clock.now());
        if (!(hours > ENTRY_H || (hours === ENTRY_H && minutes >= ENTRY_M))) return;

        const bars = await reader.getCompleted();
        const sig = donchianSignal(bars, P);
        const atrVal = atr(bars, P.atrLen);
        if (!sig || atrVal === null) return;   // not enough daily history yet (or fetch failing) — try again next candle

        // 1) manage an open position: channel exit
        if (state.position) {
            const out = state.position === "LONG" ? sig.exitLong : sig.exitShort;
            if (out) {
                const ex = state.position === "LONG" ? sig.exitLow : sig.exitHigh;
                if (!(await exitPosition(sig, `channel exit: close ${sig.close} beyond ${P.exitN}d ${state.position === "LONG" ? "low" : "high"} ${ex}`))) return;   // failed -> retry next candle
            }
        }
        // 2) flat (originally, or just exited): entry / reversal
        if (!state.position) {
            const side = sig.enterLong ? "LONG" : sig.enterShort ? "SHORT" : null;
            if (side) await enterPosition(side, sig, atrVal);
        }
        state.donchianDecidedFor = today;   // decided for today whatever happened (a failed ENTRY is not retried; a failed EXIT returned above)
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        await runSignals(rawCandle || {});
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position && (context.carryOvernight || (saved.entry_date ?? null) === new Date(clock.now()).toISOString().split("T")[0])) {
                state.position = saved.position; state.entryPrice = saved.entry_price; state.positionSource = saved.position_source || SRC;
                const open = await db.getOpenTrade(context.tgPrefix);
                state.openTradeId = open ? open.id : null;
                if (open && Number(open.qty) >= 1) context.lots = Number(open.qty);   // the size THIS trade was opened with
                state.resumedFromDb = true;
            } else if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
            }
            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);
            state.tradesToday = await db.getTradeCountToday(context.tgPrefix);
            if (reader.prewarm) reader.prewarm();
            const info = state.position ? `${state.position}@${state.entryPrice} x${context.lots}` : `flat (waiting for ${P.entryTime} IST decision)`;
            console.log(); console.log(c.green(`[${context.tgPrefix}] ${info}`)); console.log();
            await orders.reconcile(state);
        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

module.exports = { createTrendDonchianVtStrategy, donchianSignal, sizeLots };
