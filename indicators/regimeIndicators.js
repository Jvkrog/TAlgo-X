// regimeIndicators.js — pure indicator computation for the Market State
// Engine. Reuses indicators.js directly rather than recomputing anything —
// no new indicator math lives here, just packaging existing functions'
// outputs into one snapshot per instrument per candle-close.
//
// Deliberately separate from marketProfiler.js: this file only answers
// "what do the raw numbers say right now," marketProfiler.js is the only
// place that turns numbers into a labeled Market Profile. Keeping that
// split means the indicator basket can change without touching
// classification logic, and vice versa.
"use strict";

const { adx, atr, atrSeries, supertrend, choppinessIndex, toHA } = require("./indicators");

// computeRegimeIndicators(rawCandles, opts) -> snapshot | null
//
// rawCandles — same shape every other consumer uses ({ open, high, low,
// close, date }, optionally + volume — see the participation note below).
//
// Returns null while there isn't enough history yet for every indicator
// to have a real value — callers should treat null as "still warming up,"
// same convention as processCandle()'s own warmup guards elsewhere.
function computeRegimeIndicators(rawCandles, opts = {}) {
    const adxLen           = opts.adxLen           ?? 14;
    const atrLen            = opts.atrLen            ?? 14;
    const chopLen          = opts.chopLen           ?? 14;
    const stAtrLen         = opts.stAtrLen          ?? 10;
    const stFactor         = opts.stFactor          ?? 2.0;
    const volLookback      = opts.volLookback       ?? 20;
    const breakoutLookback = opts.breakoutLookback  ?? 20;

    const n = rawCandles.length;
    // ADX needs roughly 2x its own length to seed (see indicators.js's own
    // adx() — its result only starts at index len*2). This minimum reflects
    // that, plus enough room for the volatility/breakout lookbacks.
    const minLen = Math.max(adxLen * 2 + 2, atrLen + volLookback, chopLen, stAtrLen + 1, breakoutLookback + 1);
    if (n < minLen) return null;

    const haCandles = toHA(rawCandles);

    const adxArr = adx(rawCandles, adxLen);
    const adxVal = lastNonNull(adxArr);

    const stArr = supertrend(haCandles, stAtrLen, stFactor);
    const stLast = lastNonNull(stArr);
    const stDir  = stLast ? stLast.dir : null;

    const atrVal       = atr(rawCandles, atrLen);
    const atrSeriesArr = atrSeries(rawCandles, atrLen);
    const atrAvg       = averageOfLastN(atrSeriesArr, volLookback);

    const chopArr = choppinessIndex(rawCandles, chopLen);
    const chopVal = lastNonNull(chopArr);

    const closeVal = rawCandles[n - 1].close;

    // Breakout reference range — deliberately EXCLUDES the current candle
    // (slice ends one before the last index), so "closeVal broke the
    // range" is checked against the range that existed BEFORE this candle,
    // not a range this candle itself already widened.
    const lookbackSlice = rawCandles.slice(-(breakoutLookback + 1), -1);
    const priceHighN = lookbackSlice.length ? Math.max(...lookbackSlice.map(cd => cd.high)) : null;
    const priceLowN  = lookbackSlice.length ? Math.min(...lookbackSlice.map(cd => cd.low))  : null;

    // Participation (volume) — OPTIONAL. Every other candle source in this
    // codebase (preload.js, candlePoll.js, historicalFetch.js) currently
    // discards the volume field Kite's OHLCV bars actually include —
    // they only ever parse open/high/low/close. Rather than touching those
    // already-live trading files just to plumb volume through for this new
    // feature, marketFeed.js fetches its own candles independently (see
    // that file) and CAN include volume. This function stays honest about
    // it either way: if `volume` isn't present on every candle, participation
    // comes back null (never a fabricated number) — marketProfiler.js and
    // marketStateClient.js both already treat a null participation.score
    // as "no data," not "zero participation."
    const hasVolume = rawCandles.every(cd => cd.volume != null);
    const volumeVal = hasVolume ? rawCandles[n - 1].volume : null;
    const volumeAvg = hasVolume ? averageOfLastN(rawCandles.map(cd => cd.volume), volLookback) : null;

    if (adxVal == null || atrVal == null || chopVal == null) return null;

    return { adxVal, stDir, atrVal, atrAvg, chopVal, closeVal, priceHighN, priceLowN, volumeVal, volumeAvg };
}

function lastNonNull(arr) {
    if (!arr) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] != null) return arr[i];
    }
    return null;
}

function averageOfLastN(arr, n) {
    if (!arr) return null;
    const vals = arr.slice(-n).filter(v => v != null);
    if (!vals.length) return null;
    return vals.reduce((sum, v) => sum + v, 0) / vals.length;
}

module.exports = { computeRegimeIndicators };
