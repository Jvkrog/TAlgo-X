"use strict";
// absorption.js — configurable absorption detection.
//
// Absorption: large opposing-direction delta hits a level (support/
// resistance/VWAP/prior swing) but price fails to make meaningful
// progress in that delta's direction — i.e. the level is "absorbing" the
// aggressive flow. Bullish absorption = large SELL delta at/near a
// support/VWAP/prior-low level with limited downside follow-through and a
// close-of-candle rejection back up off the low; bearish is the mirror.
//
// This operates on ONE completed candle at a time (the just-closed one,
// paired with its candleDeltaBuffer.js delta entry) plus a reference level
// — it does not scan history itself; the caller (createVolumeDeltaCvdStrategy)
// decides which level (VWAP, prior swing low/high) to test against.

function detectAbsorption(candle, deltaEntry, referenceLevel, engineConfig) {
    if (!engineConfig.ABSORPTION_ENABLED) {
        return { bullish: false, bearish: false, reason: "absorption detection disabled" };
    }
    if (!candle || !deltaEntry || referenceLevel === null || referenceLevel === undefined) {
        return { bullish: false, bearish: false, reason: "insufficient data" };
    }

    const range = candle.high - candle.low;
    if (range <= 0) return { bullish: false, bearish: false, reason: "zero-range candle" };

    const totalVolume = (deltaEntry.buyVolume || 0) + (deltaEntry.sellVolume || 0);
    const relVol = totalVolume > 0 && engineConfig.ABSORPTION_MIN_VOLUME
        ? totalVolume / engineConfig.ABSORPTION_MIN_VOLUME
        : 0;

    // Bullish: large SELL delta, near/at the reference level from below,
    // but the low didn't progress far past it, and the candle closed back
    // toward the top of its own range (rejection off the low) rather than
    // closing on/near the low the sell pressure would imply.
    const nearLevelFromBelow = candle.low <= referenceLevel + engineConfig.ABSORPTION_LEVEL_TOLERANCE
                              && candle.low >= referenceLevel - engineConfig.ABSORPTION_MAX_PENETRATION;
    const closePositionInRange = (candle.close - candle.low) / range; // 0 = closed at low, 1 = closed at high
    const bullish =
        deltaEntry.delta <= -engineConfig.ABSORPTION_MIN_DELTA
        && totalVolume >= engineConfig.ABSORPTION_MIN_VOLUME
        && nearLevelFromBelow
        && closePositionInRange >= engineConfig.ABSORPTION_REJECTION_MIN;

    // Bearish: mirror — large BUY delta near the level from above, high
    // didn't progress far past it, closed back toward the bottom of range.
    const nearLevelFromAbove = candle.high >= referenceLevel - engineConfig.ABSORPTION_LEVEL_TOLERANCE
                              && candle.high <= referenceLevel + engineConfig.ABSORPTION_MAX_PENETRATION;
    const bearish =
        deltaEntry.delta >= engineConfig.ABSORPTION_MIN_DELTA
        && totalVolume >= engineConfig.ABSORPTION_MIN_VOLUME
        && nearLevelFromAbove
        && (1 - closePositionInRange) >= engineConfig.ABSORPTION_REJECTION_MIN;

    return {
        bullish, bearish,
        delta: deltaEntry.delta, totalVolume, relVol,
        closePositionInRange,
        reason: bullish ? "large sell delta absorbed at level, rejected up"
              : bearish ? "large buy delta absorbed at level, rejected down"
              : "no absorption pattern",
    };
}

module.exports = { detectAbsorption };
