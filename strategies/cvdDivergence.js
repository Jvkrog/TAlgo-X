"use strict";
// cvdDivergence.js — price vs. CVD divergence off CONFIRMED swing points.
//
// "Confirmed" is the whole no-repainting/no-look-ahead requirement: a
// swing low/high at index i is only accepted once `swingLookback` candles
// on BOTH sides of it are already known (standard fractal-style swing
// confirmation) — so a swing is never flagged until swingLookback candles
// AFTER it actually happened, and never revised once flagged. This
// function is called once per completed candle with the full closed-candle
// history + the parallel deltaHistory (candleDeltaBuffer.js's CVD series,
// same index alignment) and only ever looks backward from the current end
// of both arrays.

// Finds the most recent CONFIRMED swing low and swing high in candles,
// each requiring swingLookback bars of higher lows / lower highs on both
// sides. Returns {lowIndex, highIndex} (either may be null if none
// confirmed yet in the available history).
function findConfirmedSwings(candles, swingLookback) {
    let lowIndex = null, highIndex = null;
    // Latest possible confirmed index is length-1-swingLookback (needs
    // swingLookback bars AFTER it too) — search backward from there so the
    // MOST RECENT confirmed swing wins.
    const latestConfirmable = candles.length - 1 - swingLookback;
    for (let i = latestConfirmable; i >= swingLookback; i--) {
        if (lowIndex === null) {
            let isLow = true;
            for (let k = i - swingLookback; k <= i + swingLookback; k++) {
                if (k === i) continue;
                if (candles[k].low <= candles[i].low) { isLow = false; break; }
            }
            if (isLow) lowIndex = i;
        }
        if (highIndex === null) {
            let isHigh = true;
            for (let k = i - swingLookback; k <= i + swingLookback; k++) {
                if (k === i) continue;
                if (candles[k].high >= candles[i].high) { isHigh = false; break; }
            }
            if (isHigh) highIndex = i;
        }
        if (lowIndex !== null && highIndex !== null) break;
    }
    return { lowIndex, highIndex };
}

// Compares the two most recent confirmed swing lows (bullish case) or
// swing highs (bearish case) against CVD at those same indices.
function detectDivergence(candles, deltaHistory, engineConfig) {
    if (!engineConfig.DIVERGENCE_ENABLED) {
        return { bullish: false, bearish: false, reason: "divergence detection disabled" };
    }
    const swingLookback = engineConfig.SWING_LOOKBACK;
    const minLen = swingLookback * 2 + 3; // need at least two confirmable swings' worth of room
    if (!candles || candles.length < minLen || !deltaHistory || deltaHistory.length < minLen) {
        return { bullish: false, bearish: false, reason: "insufficient history" };
    }

    // Find the most recent confirmed swing, then the one before it, for
    // lows and highs independently.
    const recent = findConfirmedSwings(candles, swingLookback);
    if (recent.lowIndex === null && recent.highIndex === null) {
        return { bullish: false, bearish: false, reason: "no confirmed swing yet" };
    }

    let bullish = false, bearish = false, detail = null;

    if (recent.lowIndex !== null && recent.lowIndex - swingLookback - 1 >= swingLookback) {
        const priorWindowCandles = candles.slice(0, recent.lowIndex - swingLookback);
        const prior = findConfirmedSwings(priorWindowCandles, swingLookback);
        if (prior.lowIndex !== null) {
            const priceLowerLow = candles[recent.lowIndex].low < candles[prior.lowIndex].low;
            const cvdHigherLow  = deltaHistory[recent.lowIndex]?.cvd > deltaHistory[prior.lowIndex]?.cvd;
            if (priceLowerLow && cvdHigherLow) {
                bullish = true;
                detail = { priorLowIndex: prior.lowIndex, recentLowIndex: recent.lowIndex };
            }
        }
    }

    if (recent.highIndex !== null && recent.highIndex - swingLookback - 1 >= swingLookback) {
        const priorWindowCandles = candles.slice(0, recent.highIndex - swingLookback);
        const prior = findConfirmedSwings(priorWindowCandles, swingLookback);
        if (prior.highIndex !== null) {
            const priceHigherHigh = candles[recent.highIndex].high > candles[prior.highIndex].high;
            const cvdLowerHigh    = deltaHistory[recent.highIndex]?.cvd < deltaHistory[prior.highIndex]?.cvd;
            if (priceHigherHigh && cvdLowerHigh) {
                bearish = true;
                detail = { ...(detail || {}), priorHighIndex: prior.highIndex, recentHighIndex: recent.highIndex };
            }
        }
    }

    return {
        bullish, bearish, detail,
        reason: bullish ? "price lower low, CVD higher low"
              : bearish ? "price higher high, CVD lower high"
              : "no divergence",
    };
}

module.exports = { findConfirmedSwings, detectDivergence };
