// entrySnapshot.js — deterministic entry-time context for the TAlgo-Ai review. OBSERVER ONLY: called after a
// trade row is inserted, wrapped in try/catch, never read by any trading decision. Everything here is computed
// from the candle buffer and engine state the strategy itself was looking at.
"use strict";

const IST_MS = 5.5 * 3600000;
const r2 = v => Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

function trueRanges(c) {
    const out = [];
    for (let i = 0; i < c.length; i++) {
        const prevClose = i > 0 ? c[i - 1].close : c[i].open;
        out.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - prevClose), Math.abs(c[i].low - prevClose)));
    }
    return out;
}
function atr(c, n = 14) {
    if (c.length < 2) return null;
    const tr = trueRanges(c).slice(-n);
    return tr.reduce((a, b) => a + b, 0) / tr.length;
}
// Choppiness Index: 100 * log10(sum(TR, n) / (maxHigh - minLow)) / log10(n)   (higher = choppier)
function chop(c, n = 14) {
    if (c.length < n + 1) return null;
    const w = c.slice(-n), tr = trueRanges(c).slice(-n);
    const range = Math.max(...w.map(x => x.high)) - Math.min(...w.map(x => x.low));
    if (!(range > 0)) return null;
    return 100 * Math.log10(tr.reduce((a, b) => a + b, 0) / range) / Math.log10(n);
}

function snapshot({ context, engineConfig, state, candles, side, price, now = new Date() }) {
    const src = (candles && (candles.getSourceCandles || candles.getRawCandles)) ? (candles.getSourceCandles || candles.getRawCandles).call(candles) : [];
    const bars = (src || []).filter(x => x && Number.isFinite(x.close)).slice(-60);
    const ist = new Date(now.getTime() + IST_MS);
    const snap = {
        entryTimeIst: ist.toISOString().slice(11, 16),
        weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][ist.getUTCDay()],
        side, price: r2(price),
        sessionPnlBefore: r2(state.pnl), tradesBefore: Number.isFinite(state.trades) ? state.trades : null,
        atr14: r2(atr(bars, 14)),
        chop: r2(chop(bars, Number(context.chopPeriod) || Number(engineConfig && engineConfig.CHOP_LEN) || 14)),
        lastCandles: bars.slice(-3).map(b => ({ o: r2(b.open), h: r2(b.high), l: r2(b.low), c: r2(b.close) })),
    };
    const hi = state.bandHigh, mid = state.bandMid, lo = state.bandLow;
    if ([hi, mid, lo].every(Number.isFinite)) {
        snap.band = { high: r2(hi), mid: r2(mid), low: r2(lo), width: r2(hi - lo) };
        snap.priceVsBand = price > hi ? "above band high" : price < lo ? "below band low" : price >= mid ? "inside band, upper half" : "inside band, lower half";
    }
    if (snap.atr14 && snap.lastCandles.length) {
        const lc = snap.lastCandles[snap.lastCandles.length - 1];
        snap.lastCandleRangeAtrX = r2((lc.h - lc.l) / snap.atr14);
    }
    return snap;
}

module.exports = { snapshot, atr, chop };
