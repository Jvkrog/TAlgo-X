// indicators.js
"use strict";

const config = require("./config");

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
// Returns array of ADX values aligned to candle index (null until warmed up).
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
// Returns array of RSI values aligned to candle index (null until warmed up).
// Uses Wilder smoothing (RMA): alpha = 1/len.
// Input: array of price values (use HA closes for consistency with other indicators).
function rsi(values, len = 14) {
    const n = values.length;
    if (n < len + 1) return new Array(n).fill(null);

    const result = new Array(n).fill(null);

    // Seed: simple average of first `len` gains and losses
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

    // Wilder smooth for remaining values
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

module.exports = { toHA, alma, atr, supertrend, adx, rsi };
