// indicators.js
"use strict";

const config = require("./engineConfig"); // default-arg fallbacks only; signals.js always passes explicit args

// ─── HEIKIN ASHI ─────────────────────────────────────────────────────────────
function toHA(raw) {
    const ha = [];
    for (let i = 0; i < raw.length; i++) {
        const c      = raw[i];
        const haClose = (c.open + c.high + c.low + c.close) / 4;
        const haOpen  = i === 0
            ? (c.open + c.close) / 2
            : (ha[i - 1].open + ha[i - 1].close) / 2;
        ha.push({
            open:  haOpen,
            high:  Math.max(c.high, haOpen, haClose),
            low:   Math.min(c.low,  haOpen, haClose),
            close: haClose,
            date:  c.date,
        });
    }
    return ha;
}

// ─── ALMA ────────────────────────────────────────────────────────────────────
// Pine-exact: m = floor(offset * (len - 1))
function alma(values, len = config.ALMA_LEN, offset = config.ALMA_OFFSET, sigma = config.ALMA_SIGMA) {
    if (!values || values.length < len) return null;
    const m     = Math.floor(offset * (len - 1));
    const s     = len / sigma;
    const slice = values.slice(-len);
    let sum = 0, norm = 0;
    for (let i = 0; i < len; i++) {
        const w  = Math.exp(-((i - m) ** 2) / (2 * s * s));
        sum  += slice[i] * w;
        norm += w;
    }
    return sum / norm;
}

// ─── ATR (Wilder's smoothed) ─────────────────────────────────────────────────
// Used by SuperTrend internally and by external callers.
function atr(candles, len = config.ATR_LEN) {
    if (!candles || candles.length < len + 1) return null;
    const slice = candles.slice(-(len + 1));
    // Seed with simple average of first `len` TRs
    let atrVal = 0;
    for (let i = 1; i <= len; i++) {
        const h = slice[i].high, l = slice[i].low, pc = slice[i - 1].close;
        atrVal += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    atrVal /= len;
    return atrVal;
}

// ─── ATR SERIES (Wilder's smoothed, full array) ──────────────────────────────
// Same math as atr() but returns the whole array instead of just the latest
// value — needed by DPI to normalize each candle in its lookback window.
// Aligned to candle index; null until warmed up.
function atrSeries(candles, len = config.ST_ATR_LEN) {
    const n = candles.length;
    const result = new Array(n).fill(null);
    if (n < len + 1) return result;

    const tr = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
        const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
        tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }

    let seed = 0;
    for (let i = 1; i <= len; i++) seed += tr[i];
    result[len] = seed / len;
    for (let i = len + 1; i < n; i++) {
        result[i] = (result[i - 1] * (len - 1) + tr[i]) / len;
    }
    return result;
}

// ─── DPI (Directional Persistence Index) ─────────────────────────────────────
// ATR-normalized HA candle bodies with streak-based persistence weighting,
// filtered by Kaufman Efficiency Ratio. Reads the last `period` candles from
// `haCandles` + the matching `atrArr` (from atrSeries()).
//
// dpi > 0 = bull pressure, dpi < 0 = bear pressure (roughly ±3 normal, ±10 extreme)
// efficiency ∈ [0,1] — 1.0 = clean trend, 0.3ish = chop
function dpi(haCandles, atrArr, period = config.DPI_LEN, streakMult = config.DPI_STREAK_MULT, streakCap = config.DPI_STREAK_CAP) {
    const n = haCandles.length;
    if (n < period || !atrArr || atrArr.length < n) return null;

    const start = n - period;

    const dir = new Array(period);
    for (let i = 0; i < period; i++) {
        const idx  = start + i;
        const body = haCandles[idx].close - haCandles[idx].open;
        dir[i] = body > 0 ? 1 : body < 0 ? -1 : 0;
    }

    const streak = new Array(period).fill(1);
    for (let i = 1; i < period; i++) {
        if (dir[i] !== 0 && dir[i] === dir[i - 1]) streak[i] = streak[i - 1] + 1;
    }

    let dpiVal = 0;
    for (let i = 0; i < period; i++) {
        const idx    = start + i;
        const atrVal = atrArr[idx];
        if (!atrVal) continue;
        const body           = haCandles[idx].close - haCandles[idx].open;
        const normalizedBody = body / atrVal;
        const bonus          = Math.min(streak[i] * streakMult, streakCap);
        dpiVal += normalizedBody * (1 + bonus);
    }

    const closes  = haCandles.slice(start, n).map(c => c.close);
    // netMove is signed (no abs) — positive net-up move, negative net-down.
    // totalMove stays absolute — it's the "how much back-and-forth happened"
    // denominator, summing signed diffs here would telescope back to netMove
    // and destroy the chop signal entirely.
    // efficiency's SIGN now reflects net direction; its MAGNITUDE still
    // reflects trend quality — a strong downtrend reads close to -1, not
    // "low efficiency." Callers must compare |efficiency|, not efficiency,
    // when checking trend strength — see getDPIState().
    const netMove = closes[period - 1] - closes[0];
    let totalMove = 0;
    for (let i = 1; i < period; i++) totalMove += Math.abs(closes[i] - closes[i - 1]);
    const efficiency = totalMove > 0 ? netMove / totalMove : 0;

    return { dpi: parseFloat(dpiVal.toFixed(4)), efficiency: parseFloat(efficiency.toFixed(4)) };
}

// dpi/efficiency → state label used to gate entries.
// Only STRONG_BULL / STRONG_BEAR are "tradeable"; everything else blocks entry.
// efficiency is now SIGNED (direction), so the strength check compares its
// MAGNITUDE against effThresh — direction still comes entirely from dpiVal.
function getDPIState(dpiVal, efficiency, opts = {}) {
    const bullThresh = opts.bullThresh ?? config.DPI_BULL_THRESH;
    const bearThresh = opts.bearThresh ?? config.DPI_BEAR_THRESH;
    const effThresh  = opts.effThresh  ?? config.DPI_EFF_THRESH;
    const balanced   = opts.balancedBand ?? config.DPI_BALANCED_BAND;
    const effStrong  = Math.abs(efficiency) >= effThresh;

    if (dpiVal >= bullThresh && effStrong)               return "STRONG_BULL";
    if (dpiVal >= bullThresh)                            return "BULL_LOW_EFF";
    if (dpiVal <= bearThresh && effStrong)                return "STRONG_BEAR";
    if (dpiVal <= bearThresh)                            return "BEAR_LOW_EFF";
    if (Math.abs(dpiVal) < balanced)                     return "BALANCED";
    return "NEUTRAL";
}

// ─── SUPERTREND ───────────────────────────────────────────────────────────────
// Returns array of { upper, lower, trend, dir } for each candle in `haCandles`.
// dir: 1 = bullish (GREEN), -1 = bearish (RED)
// trend = the active trailing line (lower when bullish, upper when bearish)
//
// Implementation matches Pine Script SuperTrend logic:
//   basic upper = (H+L)/2 + factor * ATR
//   basic lower = (H+L)/2 - factor * ATR
//   final upper/lower are adaptive (can only tighten, never widen while trend holds)
//
function supertrend(haCandles, atrLen = config.ST_ATR_LEN, factor = config.ST_FACTOR) {
    const n = haCandles.length;
    if (n < atrLen + 1) return null;

    // Compute Wilder ATR across full candle array
    const trArr = [];
    for (let i = 1; i < n; i++) {
        const h = haCandles[i].high, l = haCandles[i].low, pc = haCandles[i - 1].close;
        trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    // Wilder smooth
    const atrArr = new Array(n).fill(null);
    let seed = 0;
    for (let i = 0; i < atrLen; i++) seed += trArr[i];
    atrArr[atrLen] = seed / atrLen;
    for (let i = atrLen + 1; i < n; i++) {
        atrArr[i] = (atrArr[i - 1] * (atrLen - 1) + trArr[i - 1]) / atrLen;
    }

    const result = new Array(n).fill(null);
    let prevUpper = null, prevLower = null, prevDir = 1;

    for (let i = atrLen; i < n; i++) {
        const c = haCandles[i];
        const hl2 = (c.high + c.low) / 2;
        const a   = atrArr[i];

        let basicUpper = hl2 + factor * a;
        let basicLower = hl2 - factor * a;

        // Adaptive upper: can only tighten (lower) when trend is bearish
        let finalUpper = basicUpper;
        if (prevUpper !== null) {
            finalUpper = (basicUpper < prevUpper || haCandles[i - 1].close > prevUpper)
                ? basicUpper : prevUpper;
        }

        // Adaptive lower: can only tighten (higher) when trend is bullish
        let finalLower = basicLower;
        if (prevLower !== null) {
            finalLower = (basicLower > prevLower || haCandles[i - 1].close < prevLower)
                ? basicLower : prevLower;
        }

        // Determine direction
        let dir;
        if (prevDir === 1) {
            // Was bullish — stays bullish unless close drops below lower trail
            dir = c.close >= finalLower ? 1 : -1;
        } else {
            // Was bearish — stays bearish unless close rises above upper trail
            dir = c.close <= finalUpper ? -1 : 1;
        }

        const trend = dir === 1 ? finalLower : finalUpper;

        result[i] = { upper: finalUpper, lower: finalLower, trend, dir };
        prevUpper = finalUpper;
        prevLower = finalLower;
        prevDir   = dir;
    }

    return result;
}

// ─── ADX (Wilder's smoothed, matches Pine Script DMI/ADX) ────────────────────
// Returns array aligned to candle index, null until warmed up.
// Uses RAW candles — ADX measures raw directional movement, not HA.
function adx(candles, len = 14) {
    const n = candles.length;
    if (n < len * 2 + 1) return new Array(n).fill(null);

    const plusDM  = new Array(n).fill(0);
    const minusDM = new Array(n).fill(0);
    const tr      = new Array(n).fill(0);

    for (let i = 1; i < n; i++) {
        const cur  = candles[i];
        const prev = candles[i - 1];
        const up   = cur.high  - prev.high;
        const dn   = prev.low  - cur.low;
        plusDM[i]  = (up > 0 && up > dn) ? up : 0;
        minusDM[i] = (dn > 0 && dn > up) ? dn : 0;
        tr[i] = Math.max(
            cur.high - cur.low,
            Math.abs(cur.high - prev.close),
            Math.abs(cur.low  - prev.close)
        );
    }

    // Wilder RMA seed — simple average of first `len` values
    let smPlus = 0, smMinus = 0, smTR = 0;
    for (let i = 1; i <= len; i++) {
        smPlus  += plusDM[i];
        smMinus += minusDM[i];
        smTR    += tr[i];
    }

    const alpha  = 1 / len;
    const dx     = new Array(n).fill(null);
    const result = new Array(n).fill(null);

    for (let i = len; i < n; i++) {
        if (i > len) {
            smPlus  = smPlus  * (1 - alpha) + plusDM[i]  * alpha;
            smMinus = smMinus * (1 - alpha) + minusDM[i] * alpha;
            smTR    = smTR    * (1 - alpha) + tr[i]      * alpha;
        }
        if (smTR === 0) continue;
        const pDI  = 100 * smPlus  / smTR;
        const mDI  = 100 * smMinus / smTR;
        const dSum = pDI + mDI;
        dx[i] = dSum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / dSum;
    }

    // ADX = Wilder smooth of DX, seeded at index (len * 2)
    let adxVal = 0, count = 0;
    for (let i = len; i < n && count < len; i++) {
        if (dx[i] !== null) { adxVal += dx[i]; count++; }
    }
    if (count < len) return result;
    adxVal /= len;

    const start = len * 2;
    result[start - 1] = adxVal;
    for (let i = start; i < n; i++) {
        if (dx[i] === null) continue;
        adxVal = adxVal * (1 - alpha) + dx[i] * alpha;
        result[i] = adxVal;
    }

    return result;
}

// ─── RSI (Wilder's smoothed — matches Pine Script RSI) ───────────────────────
function rsi(values, len = 14) {
    const n = values.length;
    if (n < len + 1) return new Array(n).fill(null);
    const result = new Array(n).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= len; i++) {
        const delta = values[i] - values[i - 1];
        if (delta > 0) avgGain += delta;
        else           avgLoss += Math.abs(delta);
    }
    avgGain /= len;
    avgLoss /= len;
    const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[len] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0);
    for (let i = len + 1; i < n; i++) {
        const delta = values[i] - values[i - 1];
        const gain  = delta > 0 ? delta : 0;
        const loss  = delta < 0 ? Math.abs(delta) : 0;
        avgGain = (avgGain * (len - 1) + gain) / len;
        avgLoss = (avgLoss * (len - 1) + loss) / len;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
    }
    return result;
}

// ─── CHOPPINESS INDEX ─────────────────────────────────────────────────────────
// Range: 0–100. >61.8 = choppy/ranging. <38.2 = trending.
// Uses RAW candles — measures raw price structure, not HA smoothed.
function choppinessIndex(candles, len = 14) {
    const n = candles.length;
    const result = new Array(n).fill(null);
    if (n < len) return result;

    for (let i = len - 1; i < n; i++) {
        let sumTR = 0;
        let highestHigh = -Infinity;
        let lowestLow   =  Infinity;

        for (let j = i - len + 1; j <= i; j++) {
            const prevClose = j > 0 ? candles[j - 1].close : candles[j].close;
            const tr = Math.max(
                candles[j].high - candles[j].low,
                Math.abs(candles[j].high - prevClose),
                Math.abs(candles[j].low  - prevClose)
            );
            sumTR += tr;
            if (candles[j].high > highestHigh) highestHigh = candles[j].high;
            if (candles[j].low  < lowestLow)   lowestLow   = candles[j].low;
        }

        const range = highestHigh - lowestLow;
        result[i] = range === 0 ? 100 : (100 * Math.log10(sumTR / range)) / Math.log10(len);
    }

    return result;
}

// ─── HILEGA-MILEGA (HM) ───────────────────────────────────────────────────────
// RSI(9) → WMA(21) of RSI [Strength/slow] + EMA(3) of RSI [Price/fast]
// Exit signal: EMA_3 crosses WMA_21 against position direction.
// Returns array aligned to candle index: { rsi9, wma21, ema3 } | null until warmed.
// Uses HA closes — same source as ALMA for consistency.
function hmIndicator(haCloses) {
    const n = haCloses.length;
    const RSI_LEN = 9;
    const WMA_LEN = 21;
    const EMA_LEN = 3;

    // Warm-up requirement: RSI needs RSI_LEN+1, then WMA needs WMA_LEN candles of RSI
    const minLen = RSI_LEN + 1 + WMA_LEN;
    const result = new Array(n).fill(null);
    if (n < minLen) return result;

    // Step 1: compute RSI(9) array — Wilder's smoothed
    const rsi9 = new Array(n).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= RSI_LEN; i++) {
        const d = haCloses[i] - haCloses[i - 1];
        if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
    }
    avgGain /= RSI_LEN;
    avgLoss /= RSI_LEN;
    rsi9[RSI_LEN] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = RSI_LEN + 1; i < n; i++) {
        const d    = haCloses[i] - haCloses[i - 1];
        const gain = d > 0 ? d : 0;
        const loss = d < 0 ? Math.abs(d) : 0;
        avgGain = (avgGain * (RSI_LEN - 1) + gain) / RSI_LEN;
        avgLoss = (avgLoss * (RSI_LEN - 1) + loss) / RSI_LEN;
        rsi9[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    // Step 2: WMA(21) of RSI(9) — weighted moving average, Pine-style
    // WMA weights: 1,2,3,...,WMA_LEN (newest gets highest weight)
    const wmaStart = RSI_LEN + WMA_LEN;  // first index where WMA is valid
    for (let i = wmaStart; i < n; i++) {
        let num = 0, den = 0;
        for (let j = 0; j < WMA_LEN; j++) {
            const w = WMA_LEN - j;           // weight: WMA_LEN for newest, 1 for oldest
            const idx = i - j;
            if (rsi9[idx] === null) { num = null; break; }
            num += rsi9[idx] * w;
            den += w;
        }
        if (num === null) continue;
        result[i] = { rsi9: rsi9[i], wma21: num / den, ema3: null };
    }

    // Step 3: EMA(3) of RSI(9) — seed at first valid RSI index
    const emaAlpha = 2 / (EMA_LEN + 1);
    let emaVal = null;
    for (let i = RSI_LEN; i < n; i++) {
        if (rsi9[i] === null) continue;
        if (emaVal === null) {
            emaVal = rsi9[i];
        } else {
            emaVal = rsi9[i] * emaAlpha + emaVal * (1 - emaAlpha);
        }
        // Attach ema3 to existing result slot if WMA is already set
        if (result[i] !== null) {
            result[i].ema3 = emaVal;
        }
    }

    // Null out slots where ema3 wasn't reached yet
    for (let i = 0; i < n; i++) {
        if (result[i] !== null && result[i].ema3 === null) result[i] = null;
    }

    return result;
}

// ─── SMA ──────────────────────────────────────────────────────────────────────
// Simple moving average. Returns an array aligned to `values` (null until
// there are `len` values to average). Used for the fast reversal exit —
// deliberately simple/responsive, not smoothed like ALMA, since its whole
// job is to react quickly to a reversal DPI hasn't caught yet.
function sma(values, len) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= len) sum -= values[i - len];
        if (i >= len - 1) out[i] = sum / len;
    }
    return out;
}

// ─── EMA ──────────────────────────────────────────────────────────────────────
// Standard exponential moving average, seeded with a plain SMA of the first
// `len` values (the common convention — Pine's ta.ema does the same
// internally). Returns an array aligned to `values` (null until there are
// `len` values to seed from). Added for MA_SLOPE — the first strategy in
// this file that actually needs a plain EMA rather than SMA/ALMA/Wilder-
// smoothed ATR.
function ema(values, len) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (len + 1);
    let sum = 0;
    let prevEma = null;

    for (let i = 0; i < values.length; i++) {
        if (i < len) {
            sum += values[i];
            if (i === len - 1) {
                prevEma = sum / len;
                out[i] = prevEma;
            }
            continue;
        }
        prevEma = values[i] * k + prevEma * (1 - k);
        out[i] = prevEma;
    }
    return out;
}

// ─── VWAP (session, cumulative) ──────────────────────────────────────────
// Volume-weighted average price using each candle's typical price
// (high+low+close)/3 — the standard approximation when only OHLCV bars are
// available (no per-trade price/size data). Cumulative from the start of
// the candles array passed in, so the CALLER controls what "session" means
// by slicing candles to the current session's bars before calling this —
// same "caller controls the window" convention every other indicator here
// already follows (e.g. atr/adx take the full array and their own `len`).
// Returns the single latest VWAP value, or null if there's no volume at
// all in the window (every bar's volume is 0 — e.g. running before this
// codebase's volume parsing existed, or a feed that doesn't supply it).
function vwap(candles) {
    if (!candles || candles.length === 0) return null;
    let cumPV = 0, cumVol = 0;
    for (const c of candles) {
        const typical = (c.high + c.low + c.close) / 3;
        const vol = c.volume || 0;
        cumPV += typical * vol;
        cumVol += vol;
    }
    if (cumVol === 0) return null;
    return cumPV / cumVol;
}

// ─── RELATIVE VOLUME ──────────────────────────────────────────────────────
// currentVolume / average(previous `len` candles' volume) — NOT including
// the current candle in its own average (a still-forming or just-closed
// candle comparing itself to a window that includes itself would bias the
// ratio toward 1.0). Returns null until there are at least `len` PRIOR
// candles to average.
function relativeVolume(candles, len = config.RELATIVE_VOLUME_LOOKBACK) {
    if (!candles || candles.length < len + 1) return null;
    const current = candles[candles.length - 1].volume || 0;
    const priorWindow = candles.slice(candles.length - 1 - len, candles.length - 1);
    const avg = priorWindow.reduce((sum, c) => sum + (c.volume || 0), 0) / len;
    if (avg === 0) return null; // avoid divide-by-zero — no volume in the comparison window at all
    return current / avg;
}

// ─── DELTA Z-SCORE ────────────────────────────────────────────────────────
// (currentDelta - mean) / stdDev over the trailing `len` delta values —
// deltaHistory here is candleDeltaBuffer.js's array of {delta, ...}
// entries (or a plain array of numbers — either works, see the .delta
// extraction below). Returns null on insufficient history or a
// zero-stdDev window (every value identical — a z-score is undefined
// there, not zero; zero would falsely claim "exactly average" when the
// window has no variance to be average WITHIN).
function deltaZScore(deltaHistory, len = config.DELTA_Z_LOOKBACK) {
    if (!deltaHistory || deltaHistory.length < len) return null;
    const window = deltaHistory.slice(-len).map(d => (typeof d === "number" ? d : d.delta));
    const mean = window.reduce((a, b) => a + b, 0) / len;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / len;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return null;
    const current = window[window.length - 1];
    return (current - mean) / stdDev;
}

module.exports = { toHA, alma, atr, atrSeries, supertrend, adx, rsi, choppinessIndex, hmIndicator, dpi, getDPIState, sma, ema, adaptiveTrendEnvelope, vwap, relativeVolume, deltaZScore };

// ─── ADAPTIVE TREND ENVELOPE [BackQuant] ──────────────────────────────────────
// Direct port of the Pine v6 script "Adaptive Trend Envelope [BackQuant]"
// (user-supplied source, strategy #11). Volatility-adaptive EMA blend (fast
// EMA weighted more in low-vol/trending regimes, slow EMA more in high-vol/
// choppy regimes) forms a "spine", wrapped in an EWMA-volatility envelope;
// price closing outside the envelope (for `confirmBars` consecutive bars)
// flips a persistent regime state machine between BULL(1)/BEAR(-1)/FLAT(0).
// FLAT is re-entered when price crosses back through the spine.
//
// NOTE (script quirk, confirmed by reading the Pine source, not a porting
// choice): the script also computes an "inner hysteresis band" (upperIn/
// lowerIn, driven by the `hysteresis` input) but NEVER references it in the
// actual regime state machine — only the outer upper/lower band and the
// spine cross are used. That hysteresis logic is dead code in the original
// script. This port leaves it out entirely rather than faithfully
// reproducing unused calculations — behavior is identical either way, this
// just skips computing values nothing reads.
//
// All the Pine `var` (persistent-across-bars) values — regime being the
// only one that matters for signals — are recomputed as a full forward
// pass over rawCandles each call, same convention as atrSeries()'s Wilder
// loop elsewhere in this file, rather than incrementally maintained in a
// closure. Returns an array aligned to rawCandles: null until the longest
// warmup (retLenL/slowLen/blendLen chain) is satisfied, then
// { spine, upper, lower, regime } where regime is 1 (bull) / -1 (bear) / 0 (flat).
function adaptiveTrendEnvelope(rawCandles, opts = {}) {
    const {
        fastLen     = 7,
        slowLen     = 34,
        blendLen    = 30,
        retLenS     = 20,
        retLenL     = 80,
        bandMult    = 1.9,
        ewmaAlpha   = 0.09,
        confirmBars = 1,
    } = opts;

    const n = rawCandles.length;
    const closes = rawCandles.map(cd => cd.close);
    const out = new Array(n).fill(null);
    if (n === 0) return out;

    // EMA over a null-padded array — this file's ema() assumes a clean
    // numeric array (it seeds off the first `len` values directly), so any
    // series with leading nulls (wRaw, spineRaw both start null until their
    // own inputs warm up) gets sliced to its first non-null value, run
    // through the normal ema(), then padded back to original alignment.
    // Existing ema() is left untouched — other live strategies depend on it.
    function emaSkipNulls(values, len) {
        const firstValid = values.findIndex(v => v !== null);
        if (firstValid === -1) return new Array(values.length).fill(null);
        const tail   = values.slice(firstValid);
        const tailMa = ema(tail, len);
        return new Array(firstValid).fill(null).concat(tailMa);
    }

    // Rolling population stdev (Pine's ta.stdev default is biased/
    // population, divide by `len` not `len-1`), null unless the full
    // trailing window is itself all non-null (a single na return, e.g. the
    // very first log-return, keeps every window that touches it na too —
    // matches Pine's na-propagation).
    function stdevSeries(values, len) {
        const res = new Array(values.length).fill(null);
        for (let i = len - 1; i < values.length; i++) {
            let sum = 0, ok = true;
            for (let j = i - len + 1; j <= i; j++) {
                if (values[j] === null) { ok = false; break; }
                sum += values[j];
            }
            if (!ok) continue;
            const mean = sum / len;
            let sq = 0;
            for (let j = i - len + 1; j <= i; j++) sq += (values[j] - mean) ** 2;
            res[i] = Math.sqrt(sq / len);
        }
        return res;
    }

    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

    const emaFast = ema(closes, fastLen);
    const emaSlow = ema(closes, slowLen);

    // Log returns — r[0] is null (no prior close), matching Pine's `r =
    // log(src/src[1])` being na on the first bar.
    const r = new Array(n).fill(null);
    for (let i = 1; i < n; i++) r[i] = Math.log(closes[i] / closes[i - 1]);

    const volS = stdevSeries(r, retLenS);
    const volL = stdevSeries(r, retLenL);

    const vr = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (volS[i] === null || volL[i] === null) continue;
        vr[i] = volL[i] === 0 ? 1.0 : volS[i] / volL[i];
    }

    const wRaw = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (vr[i] === null) continue;
        wRaw[i] = clamp(1.0 - (vr[i] - 0.7) / 0.9, 0.0, 1.0);
    }
    const w = emaSkipNulls(wRaw, blendLen);

    const spineRaw = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (w[i] === null || emaFast[i] === null || emaSlow[i] === null) continue;
        spineRaw[i] = w[i] * emaFast[i] + (1.0 - w[i]) * emaSlow[i];
    }
    const spine = emaSkipNulls(spineRaw, blendLen);

    // EWMA variance of returns (RiskMetrics-style), seeded at the first
    // valid log return — direct port of the script's `ewma_var()`:
    // v := na(v[1]) ? (x*x) : (1-alpha)*v[1] + alpha*x*x
    const v = new Array(n).fill(null);
    let prevV = null;
    for (let i = 0; i < n; i++) {
        if (r[i] === null) continue;
        prevV = prevV === null ? r[i] * r[i] : (1 - ewmaAlpha) * prevV + ewmaAlpha * r[i] * r[i];
        v[i] = prevV;
    }

    const upper = new Array(n).fill(null);
    const lower = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (spine[i] === null || v[i] === null) continue;
        const sig  = Math.sqrt(Math.max(v[i], 0));
        const band = spine[i] * sig * bandMult;
        upper[i] = spine[i] + band;
        lower[i] = spine[i] - band;
    }

    const bullBreak = new Array(n).fill(false);
    const bearBreak = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
        if (upper[i] === null) continue; // na comparison is falsy in Pine
        bullBreak[i] = closes[i] > upper[i];
        bearBreak[i] = closes[i] < lower[i];
    }

    // regime — persistent state machine, must walk forward sequentially
    // (each bar's value depends on the previous bar's), same as Pine's
    // `var int regime`. Sequential loop, not a vectorized pass.
    let regime = 0;
    for (let i = 0; i < n; i++) {
        let bullConf = confirmBars <= i + 1;
        if (bullConf) for (let j = i - confirmBars + 1; j <= i; j++) if (!bullBreak[j]) { bullConf = false; break; }
        let bearConf = confirmBars <= i + 1;
        if (bearConf) for (let j = i - confirmBars + 1; j <= i; j++) if (!bearBreak[j]) { bearConf = false; break; }

        if (bullConf) {
            regime = 1;
        } else if (bearConf) {
            regime = -1;
        } else {
            if (regime === 1 && spine[i] !== null && closes[i] < spine[i]) regime = 0;
            if (regime === -1 && spine[i] !== null && closes[i] > spine[i]) regime = 0;
        }

        if (spine[i] !== null) out[i] = { spine: spine[i], upper: upper[i], lower: lower[i], regime };
    }

    return out;
}


