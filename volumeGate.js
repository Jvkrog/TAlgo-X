"use strict";
// volumeGate.js — optional "only enter when current volume is above its
// own SMA" gate. Mirrors chopGate.js in shape and calling convention on
// purpose: a pure check (isVolumeBlocked) called from each strategy's own
// entry site, BEFORE orders.enter() — same paper-mode reasoning
// documented in chopGate.js's header (a block disguised as orders.enter's
// null return would be silently ignored by every strategy's own
// `if (engineConfig.LIVE_ORDERS && ordered === null)` commit check in
// paper mode, so the gate has to run upstream of orders.enter(), not
// around it).
//
// context.volumeFilterEnabled: default OFF (undefined/false/null) — opt-in
// via Edit Params/Risk Management, never a silent behavior change for
// anything already deployed.
// context.volumeSmaPeriod: default null, falls back to
// engineConfig.VOLUME_SMA_LEN_DEFAULT (9) below — same
// STRATEGY_PARAMS-backtest-tuning-safe pattern as chopPeriod/chopMax in
// chopGate.js.
//
// The SMA here is a PLAIN SMA of volume INCLUDING the current (just-
// closed) candle — standard indicator convention, deliberately different
// from indicators.js's relativeVolume() (which excludes the current bar
// from its own average on purpose, for a different reason tied to
// VOLUME_DELTA_CVD's own scoring). Insufficient warmup data (fewer than
// `period` candles buffered yet) or a zero/null average never blocks —
// same "don't block on insufficient data" convention chopGate.js follows.
const { sma } = require("./indicators");

function isVolumeBlocked(context, engineConfig, candles) {
    if (!context.volumeFilterEnabled) return false;
    const period = context.volumeSmaPeriod ?? engineConfig.VOLUME_SMA_LEN_DEFAULT;
    const rawCandles = candles.getRawCandles();
    if (!rawCandles || rawCandles.length < period) return false;

    const volumes = rawCandles.map(c => c.volume || 0);
    const smaArr = sma(volumes, period);
    const smaVal = smaArr[smaArr.length - 1];
    if (smaVal === null || smaVal === 0) return false;

    const currentVol = volumes[volumes.length - 1];
    return currentVol <= smaVal; // block unless volume is strictly ABOVE its SMA
}

module.exports = { isVolumeBlocked };
