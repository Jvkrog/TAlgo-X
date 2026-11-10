// dsbGrey.js — pure maths for DSB_GREY (Dynamic Step Band + MA-slope grey state). Port of the Pine
// "Dynamic Step Band [DSB] + Grey State": band mid starts at the first open and moves one `step` per
// closed-candle breakout; direction is +1/-1 only if that breakout happens while the ema(ohlc4)
// slope angle (vs ATR) is beyond the filter, and is forced to 0 (grey) whenever the slope is neutral.
"use strict";
const { ema, atrSeries } = require("../indicators/indicators");

// Per-candle slope flags. angle = atan((ma - ma[1]) / atr) in degrees; null inputs => neutral (Pine na => false).
function slopeFlags(candles, maLen, atrLen, top, bottom) {
    const ma = ema(candles.map(c => (c.open + c.high + c.low + c.close) / 4), maLen);
    const at = atrSeries(candles, atrLen);
    return candles.map((_, i) => {
        if (i === 0 || ma[i] == null || ma[i - 1] == null || !at[i]) return { strongUp: false, strongDown: false };
        const angle = (180 / Math.PI) * Math.atan((ma[i] - ma[i - 1]) / at[i]);
        return { strongUp: angle > top, strongDown: angle < bottom };
    });
}

function init(open) { return { mid: open, direction: 0 }; }

// One Pine bar. Returns a NEW state.
function step(st, close, flags, size) {
    let { mid, direction } = st;
    if (close > mid + size)      { mid += size; direction = flags.strongUp   ? 1  : 0; }
    else if (close < mid - size) { mid -= size; direction = flags.strongDown ? -1 : 0; }
    if (!flags.strongUp && !flags.strongDown) direction = 0;
    return { mid, direction };
}

// Whole series (the first candle seeds the band at its open, and is itself evaluated, like Pine).
function series(candles, size, flagsArr) {
    const out = []; let st = null;
    candles.forEach((cd, i) => { st = step(st || init(cd.open), cd.close, flagsArr[i], size); out.push(st); });
    return out;
}

module.exports = { slopeFlags, init, step, series };
