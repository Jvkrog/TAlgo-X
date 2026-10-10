// dualHedgeAtr.js — ATR stop-loss support for the dual-account hedge
// (dualHedgeEngine.js live, backtestDualHedge.js replay). Added Oct 2026.
//
// The dual hedge's stop used to be rupees only (DH_MAX_LOSS_RUPEES_OVERRIDE:
// a flipped leg exits once its unrealised P&L drops below -₹N). SL mode
// "ATR" replaces that with a price-distance stop: ATR_SL_MULT x ATR of the
// bars at `atrTimeframe`, measured from the leg's ENTRY price and snapshotted
// at entry (fixed afterwards — no trailing). Same arming rule as the rupee
// stop: only once the leg has flipped. Same ATR function every strategy uses
// (indicators.js atr(), length engineConfig.ST_ATR_LEN) so the multiplier
// means the same thing here as in strategies.js.
//
// Both sides share THIS file's atrLookup(), so live and backtest read "the
// ATR a leg would have seen at entry" identically: the newest bar that had
// fully closed by that moment (bar start + timeframe) and the `len` bars
// before it.
"use strict";

const { atr } = require("./indicators");
const { fetchHistoricalCandles, TIMEFRAME_MINUTES } = require("./historicalFetch");

const SL_MODES = ["RUPEES", "ATR"];
const ATR_TIMEFRAMES = Object.keys(TIMEFRAME_MINUTES).filter(tf => tf !== "1d");   // 5m, 15m, 30m, 1h
const DEFAULT_ATR_TIMEFRAME = "15m";
const LOOKBACK_DAYS = 10;   // far more bars than ATR(len) needs, even at 1h

const barEnd = (bar, timeframe) => bar.date.getTime() + TIMEFRAME_MINUTES[timeframe] * 60000;

// atrLookup(bars, timeframe, len) -> { at(ms) }
//   bars: raw OHLC bars at `timeframe`, sorted oldest -> newest.
//   at(ms): ATR over the last `len`+1 bars fully closed by `ms`, or null while
//   there aren't enough of them yet (warm-up).
function atrLookup(bars, timeframe, len) {
    if (!(timeframe in TIMEFRAME_MINUTES)) throw new Error(`atrLookup: unsupported timeframe "${timeframe}" (known: ${ATR_TIMEFRAMES.join(", ")})`);
    const done = bars.map(b => barEnd(b, timeframe));
    return {
        at(ms) {
            let lo = 0, hi = done.length - 1, idx = -1;
            while (lo <= hi) {   // last bar with done <= ms
                const mid = (lo + hi) >> 1;
                if (done[mid] <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1;
            }
            if (idx < len) return null;
            return atr(bars.slice(idx - len, idx + 1), len);
        },
    };
}

// createAtrReader — live. Lazily refreshed, fails safe (any error serves the
// last good bars; null on a cold start), same shape as haCandleReader.js.
function createAtrReader({ getKc, token, timeframe, len, label = "DUAL_HEDGE" }) {
    if (!(timeframe in TIMEFRAME_MINUTES)) throw new Error(`createAtrReader: unsupported timeframe "${timeframe}" (known: ${ATR_TIMEFRAMES.join(", ")})`);
    const refreshMs = Math.min(5 * 60 * 1000, TIMEFRAME_MINUTES[timeframe] * 30 * 1000);   // half a bar, capped at 5 min
    let lookup = null, fetchedAt = 0, lastErrAt = 0;

    async function refresh() {
        const now = Date.now();
        fetchedAt = now;   // set first: a failing fetch is retried after refreshMs, not every call
        try {
            const bars = await fetchHistoricalCandles({
                kc: getKc(), token, timeframe, from: new Date(now - LOOKBACK_DAYS * 86400000), to: new Date(now),
            });
            if (bars.length) lookup = atrLookup(bars, timeframe, len);
        } catch (err) {
            if (now - lastErrAt > 10 * 60 * 1000) {
                lastErrAt = now;
                console.warn(`[${label}] ATR(${len}) ${timeframe} refresh failed: ${err.message} — serving the last good read`);
            }
        }
    }

    return {
        // ATR(len) of the bars fully closed right now, or null (no data yet).
        async get() {
            if (!lookup || Date.now() - fetchedAt > refreshMs) await refresh();
            return lookup ? lookup.at(Date.now()) : null;
        },
    };
}

module.exports = { SL_MODES, ATR_TIMEFRAMES, DEFAULT_ATR_TIMEFRAME, atrLookup, createAtrReader };
