// macd.js — MACD: classic MACD(fast, slow, signal) trend/momentum strategy, always-in-market style (exit = opposite signal = reversal).
//
// SIGNAL (on completed candles of this instrument's timeframe — the raw candles, not HA):
//   mode "cross" (default): histogram = MACD line − signal line.  hist > +buffer -> LONG side, hist < −buffer -> SHORT side, else neutral
//   mode "zero":            MACD line itself.                    macd > +buffer -> LONG side, macd < −buffer -> SHORT side, else neutral
//   buffer = histBuffer × ATR(14)  (0 = none). A flip-flop filter: tiny wiggles around the crossing no longer flip the position.
//   confirmBars (default 1): the side must hold for N consecutive candles before it counts. Until a new side is confirmed the previous one stays.
//   zeroFilter "on" (cross mode): a LONG entry additionally needs MACD > 0 and a SHORT entry MACD < 0 (the opposite signal still EXITS;
//     only the re-entry is withheld). Keeps you out of counter-trend crosses near the zero line, where chop lives.
// ACTION: only when the CONFIRMED side CHANGES (a fresh cross), never on boot into an old trend. Open position opposite to the confirmed side
//   is closed (safety, also after a restart); entry blocked by a gate on the trigger candle is retried while that confirmed side stands.
// STOP: stopAtrMult × ATR(14) fixed stop from entry (0 = none: the opposite signal is the only exit). Universal target (context.targetPoints) honoured.
// GATES: universal entry gates apply exactly like every other trend strategy (chop, double-order, volume, long-candle, HTF, daily-HA/entry-time).
// SIZE: fixed context.lots.
"use strict";

const c = require("../utils/c");
const { atr, ema } = require("../indicators/indicators");
const { emitEvent } = require("../core/eventBridge");
const { isChopBlocked } = require("../gates/chopGate");
const { isDoubleOrderBlocked } = require("../gates/doubleOrderGate");
const { isVolumeBlocked } = require("../gates/volumeGate");
const { evaluateLongCandle } = require("../gates/longCandleGate");
const { reportBlocks } = require("../gates/blockReport");
const { resolveParams } = require("./strategyParams");

const SRC = "MACD";

// Pure — exported for tests. SMA-seeded EMAs (same convention as indicators.ema). Arrays align with `closes`; null until defined.
function macdSeries(closes, fast, slow, signal) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const macd = closes.map((_, i) => (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]);
    const first = macd.findIndex(v => v != null);
    const sig = new Array(closes.length).fill(null);
    if (first >= 0) { const e = ema(macd.slice(first), signal); for (let i = 0; i < e.length; i++) sig[first + i] = e[i]; }
    const hist = macd.map((m, i) => (m == null || sig[i] == null) ? null : m - sig[i]);
    return { macd, signal: sig, hist };
}

// Pure — exported for tests. Per-candle side before confirmation: "LONG" | "SHORT" | null (neutral / not enough data).
function rawSides(closes, atrs, P) {
    const { macd, hist } = macdSeries(closes, P.fast, P.slow, P.signal);
    return closes.map((_, i) => {
        const v = P.mode === "zero" ? macd[i] : hist[i];
        if (v == null) return null;
        const buf = P.histBuffer > 0 && atrs[i] > 0 ? P.histBuffer * atrs[i] : 0;
        return v > buf ? "LONG" : v < -buf ? "SHORT" : null;
    });
}

// Pure — exported for tests. Sticky confirmed side per candle (changes only after `confirmBars` consecutive equal raw sides).
function confirmedSides(raw, confirmBars) {
    const out = []; let cur = null, run = 0, runSide = null;
    for (const s of raw) {
        if (s && s === runSide) run++; else { runSide = s; run = s ? 1 : 0; }
        if (s && run >= confirmBars) cur = s;
        out.push(cur);
    }
    return out;
}

function atrSeriesFor(candles, len) {
    const out = new Array(candles.length).fill(0);
    for (let i = len; i < candles.length; i++) out[i] = atr(candles.slice(0, i + 1), len) || 0;   // trailing window only: O(n·len)
    return out;
}

function createMacdStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() }, htf, dailyHa }) {
    const resolved = resolveParams(SRC, context.strategyParams);
    const P = resolved.values;
    for (const m of [...resolved.errors, ...resolved.warnings]) console.warn(c.yellow(`[${context.tgPrefix}] ${SRC} param: ${m}`));
    const ATR_LEN = 14;
    const persist = (position, entryPrice) => db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, SRC);

    async function doExit(side, price, reason) {
        const closed = await orders.exit(side);
        if (engineConfig.LIVE_ORDERS && closed === null) { console.log(c.yellow(`[${context.tgPrefix}] ${side} exit failed (${reason}) — will retry next candle`)); return false; }
        tg(`${side} EXIT (${reason}) @ ₹${price.toFixed(2)}`);
        const pnl = await positionsClose(price, reason);
        slStore.clearTrail(); targetStore.clearTarget(); persist(null, 0);
        console.log((pnl > 0 ? c.green : pnl < 0 ? c.red : c.white)(`[${context.tgPrefix}] ${side} ${reason}  @ ${price.toFixed(2)}`));
        return true;
    }

    async function doEnter(side, price, reason, atrVal, macdNow) {
        const isReversal = /REVERSAL/i.test(reason);
        const doubleBlocked = isDoubleOrderBlocked(context, state, isReversal);
        const chopBlocked = isChopBlocked(context, engineConfig, candles, { force: engineConfig.CHOP_GATE_ALWAYS_FORCE !== false });
        const volumeBlocked = isVolumeBlocked(context, engineConfig, candles);
        const longCandleBlocked = evaluateLongCandle(context, engineConfig, candles, state);
        const htfBlocked = htf ? await htf.isBlocked() : false;
        const dailyHaBlocked = dailyHa ? await dailyHa.isBlocked(side) : false;
        reportBlocks(context, side, candles.getLivePrice(), { double: doubleBlocked, chop: chopBlocked, volume: volumeBlocked, longCandle: longCandleBlocked, htf: htfBlocked, dailyHa: dailyHaBlocked });
        const blocked = doubleBlocked || chopBlocked || volumeBlocked || longCandleBlocked || htfBlocked || dailyHaBlocked;
        if (blocked) {
            const why = doubleBlocked ? "double orders disabled" : chopBlocked ? "Choppiness Index filter" : volumeBlocked ? "volume not above its SMA" : longCandleBlocked ? "long-candle cooldown" : htfBlocked ? "higher-timeframe gate" : ((dailyHa && dailyHa.lastBlockDetail) || "daily HA / entry-time gate");
            console.log(c.yellow(`[${context.tgPrefix}] ${side} entry blocked — ${why}`));
            return false;
        }
        const ordered = await orders.enter(side);
        if (engineConfig.LIVE_ORDERS && ordered === null) { console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed (${reason}) — will retry next candle`)); return false; }
        state.position = side; state.tradesToday = (state.tradesToday || 0) + 1; state.entryPrice = price; state.positionSource = SRC;
        state.openTradeId = await db.insertOpenTrade(context.tgPrefix, context.symbol, side, context.lots, price);
        const dir = side === "LONG" ? 1 : -1;
        let stop = null;
        if (P.stopAtrMult > 0 && atrVal > 0) { stop = price - dir * P.stopAtrMult * atrVal; slStore.setTrail(stop, dir); }
        if (context.targetPoints) targetStore.setTarget(price + dir * context.targetPoints, dir);
        persist(side, price);
        console.log((state.pnl > 0 ? c.green : state.pnl < 0 ? c.red : c.white)(`[${context.tgPrefix}] ${side} ${reason}  @ ${price.toFixed(2)}${stop != null ? `  SL ${stop.toFixed(2)}` : ""}  MACD ${macdNow != null ? macdNow.toFixed(3) : "?"}`));
        emitEvent(context.tgPrefix, "ENTRY", { side, price, trail: stop, pure: null });
        tg(`${side} ${reason} @ ₹${price.toFixed(2)}${stop != null ? `  SL ₹${stop.toFixed(2)}` : ""}`);
        return true;
    }

    async function processCandle(candle) {
        if (lifecycle.isShutdown()) return;
        const raw = candles.getRawCandles();
        const livePrice = candles.getLivePrice() ?? (candle && candle.close);
        const uPnL = positionsUnrealised(livePrice);
        const session = (state.pnl || 0) + uPnL;
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null, pure: null });
        if (!engineConfig.ENGINE_ENABLED || raw.length < P.slow + P.signal + 2) return;

        const closes = raw.map(x => x.close), atrs = atrSeriesFor(raw, ATR_LEN);
        const rs = rawSides(closes, atrs, P), cs = confirmedSides(rs, P.confirmBars);
        const n = cs.length - 1, side = cs[n], prev = cs[n - 1];
        const ms = macdSeries(closes, P.fast, P.slow, P.signal), macdNow = ms.macd[n], histNow = ms.hist[n];
        const lineColor = !state.position ? c.white : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${clock.now().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" })} MACD ${livePrice.toFixed(2).padStart(7)}  ${(uPnL < 0 ? "-" : "+") + Math.abs(uPnL).toFixed(0)}  macd:${macdNow != null ? macdNow.toFixed(3) : "-"} hist:${histNow != null ? histNow.toFixed(3) : "-"} side:${side || "-"}`));
        if (!side) return;
        if (side !== state.pendingSide && state.pendingSide) state.pendingSide = null;   // a different side is confirmed now: any retry is moot
        const fresh = side !== prev;                          // a NEW confirmed side on this candle
        if (fresh) state.pendingSide = side;

        const entryAllowed = P.zeroFilter !== "on" || (side === "LONG" ? macdNow > 0 : macdNow < 0);
        const a = atrs[n];
        if (state.position && state.position !== side) {      // opposite of the confirmed side: exit (and reverse if the filter allows)
            if (!(await doExit(state.position, livePrice, "MACD SIGNAL EXIT"))) return;
            state.pendingSide = side;
            if (entryAllowed && (await doEnter(side, livePrice, side === "LONG" ? "REVERSAL LONG" : "REVERSAL SHORT", a, macdNow))) state.pendingSide = null;
        } else if (!state.position && state.pendingSide === side && entryAllowed) {
            if (await doEnter(side, livePrice, side === "LONG" ? "LONG ENTRY" : "SHORT ENTRY", a, macdNow)) state.pendingSide = null;
        }
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];
            state.resumedFromDb = false;
            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                if ((saved.entry_date ?? null) === today || context.carryOvernight) {
                    state.position = saved.position; state.entryPrice = saved.entry_price; state.positionSource = saved.position_source || SRC;
                    const open = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = open ? open.id : null; state.resumedFromDb = true;
                } else db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
            }
            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);
            state.tradesToday = await db.getTradeCountToday(context.tgPrefix);
            console.log(); console.log(c.green(`[${context.tgPrefix}] ${state.position ? `${state.position}@${state.entryPrice}` : "flat (acts on the next fresh MACD cross)"}`)); console.log();
            await orders.reconcile(state);
        } catch (err) { console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message); }
    }

    return { processCandle, initSignals };
}

module.exports = { createMacdStrategy, macdSeries, rawSides, confirmedSides };
