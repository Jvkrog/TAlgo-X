"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TALGO X — X-EXEC (Dual Engine)
//
// Source: v3_nat.js (NatGas 15m SLOW+FAST engine)
// Runs:   Every 15m candle close
//
// Responsibilities:
//   - SLOW layer: ALMA(21/55) sets directional bias + conviction
//   - FAST layer: ALMA(9/21) generates execution signal
//   - Tick-level orderflow pressure (buyPressure / sellPressure)
//   - Stagnation probe detection
//
// Does NOT: place orders, manage position, evaluate risk.
// Output: exec object written to G.exec each candle.
// ─────────────────────────────────────────────────────────────────────────────

const { alma, calcATR, smoothATR } = require("../indicators/indicators");
const { G } = require("./state");

// ── Config ───────────────────────────────────────────────────────────────────
const SLOW_SHORT    = 21;
const SLOW_LONG     = 55;
const FAST_SHORT    = 9;
const FAST_LONG     = 21;
const ATR_HIST_LEN  = 20;
const ATR_SMOOTH    = 10;
const STAGNATION_LIM = 8;
const PRESSURE_THRESH = 6;

// ── Internal state ───────────────────────────────────────────────────────────
let slowPrevCross    = 0;
let slowPrevTrend    = 0;
let fastPrevCross    = 0;
let weakeningCount   = 0;
let candlesWithoutTrade = 0;

// SLOW bias (persists between 15m cycles)
let bias         = 0;
let conviction   = 0;
let biasSetTime  = 0;
let neutralTime  = 0;

// ATR tracking
let atrHistory   = [];
let prevATR      = 0;

// Tick pressure (written by WebSocket handler, read at candle boundary)
let buyPressure  = 0;
let sellPressure = 0;
let aggressiveBuy  = false;
let aggressiveSell = false;

// ── Tick handler — called from WebSocket on each price tick ─────────────────
function onTick(price) {
    if (G.livePrice === 0) { G.livePrice = price; return; }
    const last = G.livePrice;
    if (price > last) {
        buyPressure++;
        sellPressure = Math.max(0, sellPressure - 1);
    } else if (price < last) {
        sellPressure++;
        buyPressure = Math.max(0, buyPressure - 1);
    } else {
        buyPressure  = Math.max(0, buyPressure  - 1);
        sellPressure = Math.max(0, sellPressure - 1);
    }
    aggressiveBuy  = buyPressure  >= PRESSURE_THRESH;
    aggressiveSell = sellPressure >= PRESSURE_THRESH;
    G.livePrice = price;
}

// Snapshot pressure at candle boundary, then reset
function snapshotAndResetPressure() {
    const snap = { aggressiveBuy, aggressiveSell, buyPressure, sellPressure };
    buyPressure = sellPressure = 0;
    aggressiveBuy = aggressiveSell = false;
    return snap;
}

// ── SLOW layer — ALMA(21/55) bias engine ────────────────────────────────────

function runSlowLayer(candles, currentATR) {
    const closes = candles.map(c => c.close);
    const s = alma(closes, SLOW_SHORT).at(-1);
    const l = alma(closes, SLOW_LONG).at(-1);

    const cross      = s > l ? 1 : s < l ? -1 : 0;
    const freshCross = cross !== 0 && cross !== slowPrevCross;
    const trendStr   = Math.abs(s - l);

    const minTrendGap  = currentATR * 0.35;
    const minSlope     = currentATR * 0.05;
    const dirStable    = slowPrevTrend === 0 || trendStr > slowPrevTrend * 0.9;
    const strongTrend  = trendStr > currentATR * 0.3  && trendStr > minSlope;
    const earlyTrend   = trendStr > currentATR * 0.22 && trendStr <= currentATR * 0.35 && trendStr > minSlope && dirStable;
    const trendWeakening = slowPrevTrend > 0 && trendStr < slowPrevTrend * 0.6;

    const NEUTRAL_CD = 30 * 60 * 1000;
    const postNeutralBlocked = neutralTime > 0 && (Date.now() - neutralTime) < NEUTRAL_CD;

    // ── Set bias on fresh cross ──────────────────────────────────────────
    if (!postNeutralBlocked && freshCross && trendStr >= minTrendGap && (strongTrend || earlyTrend)) {
        const convictionOK = trendStr > currentATR * 0.4;
        if (convictionOK && cross !== bias) {
            bias       = cross;
            conviction = trendStr;
            biasSetTime = Date.now();
        }
    }

    // ── Clear bias on confirmed weakening ───────────────────────────────
    if (bias !== 0 && trendWeakening) {
        weakeningCount++;
        if (weakeningCount >= 2) {
            bias = 0; conviction = 0; weakeningCount = 0;
            neutralTime = Date.now();
        }
    } else {
        weakeningCount = 0;
    }

    // Update memory
    slowPrevTrend = slowPrevTrend === 0 ? trendStr : trendStr * 0.3 + slowPrevTrend * 0.7;
    slowPrevCross = cross;

    return { bias, conviction, biasSetTime, neutralTime, trendStr, cross, almaS: s, almaL: l };
}

// ── FAST layer — ALMA(9/21) execution signal ────────────────────────────────

function runFastLayer(candles, currentATR, slowData, pressure) {
    const closes     = candles.map(c => c.close);
    const s          = alma(closes, FAST_SHORT).at(-1);
    const l          = alma(closes, FAST_LONG).at(-1);
    const cross      = s > l ? 1 : s < l ? -1 : 0;
    const freshCross = cross !== 0 && cross !== fastPrevCross;
    const diff       = Math.abs(s - l);

    // Adaptive entry aggression: high conviction → lower threshold (enter earlier)
    const entryAggression = slowData.conviction > currentATR * 0.6 ? 1.3
                          : slowData.conviction < currentATR * 0.25 ? 0.7 : 1.0;
    const entryThresh  = currentATR * 0.3 / entryAggression;
    const isStrong     = diff > entryThresh;
    const isExplosive  = diff > currentATR * 0.6;
    const isWeak       = diff < currentATR * 0.15;

    const momentumCandle = candles.at(-1);
    const prevCandle     = candles.at(-2);
    const momentum       = Math.abs(momentumCandle.close - prevCandle.close);
    const momentumThresh = currentATR > 3 ? 0.25 : 0.18;
    const momentumOK     = momentum > currentATR * momentumThresh;

    // Signal: needs fresh cross, strength, bias alignment, and momentum
    let signal     = "NONE";
    let confidence = 0;

    if (bias !== 0 && freshCross && isStrong && cross === bias && momentumOK) {
        signal = cross === 1 ? "LONG" : "SHORT";
        confidence = Math.min(1.0, diff / (currentATR * 0.8));
        if (isExplosive) confidence = Math.min(1.0, confidence * 1.3);
        if (pressure.aggressiveBuy  && cross === 1)  confidence = Math.min(1.0, confidence + 0.15);
        if (pressure.aggressiveSell && cross === -1) confidence = Math.min(1.0, confidence + 0.15);
    }

    fastPrevCross = cross;

    return {
        signal,
        confidence,
        cross,
        freshCross,
        diff,
        isStrong,
        isExplosive,
        isWeak,
        momentum,
        momentumOK
    };
}

// ── Probe logic ──────────────────────────────────────────────────────────────
// After STAGNATION_LIM candles without a trade, fire a probe in bias direction.

function checkProbe(tradeState) {
    if (tradeState !== "WAIT") {
        candlesWithoutTrade = 0;
        return false;
    }
    candlesWithoutTrade++;
    if (candlesWithoutTrade >= STAGNATION_LIM && bias !== 0) {
        const NEUTRAL_CD = 30 * 60 * 1000;
        const blocked = neutralTime > 0 && (Date.now() - neutralTime) < NEUTRAL_CD;
        if (!blocked) {
            candlesWithoutTrade = 0;
            return true;
        }
    }
    return false;
}

// ── Main run function — called by data layer each 15m candle ────────────────

function runXExec(fastCandles, currentATR) {
    if (fastCandles.length < SLOW_LONG + 5) return null;

    // Snapshot tick pressure before reset
    const pressure = snapshotAndResetPressure();

    const slowData = runSlowLayer(fastCandles, currentATR);
    const fastData = runFastLayer(fastCandles, currentATR, slowData, pressure);
    const probe    = checkProbe(G.tradeState);

    const exec = {
        // SLOW output
        bias:        slowData.bias,
        conviction:  slowData.conviction,
        biasSetTime: slowData.biasSetTime,
        neutralTime: slowData.neutralTime,
        slowCross:   slowData.cross,
        slowAlmaS:   slowData.almaS,
        slowAlmaL:   slowData.almaL,

        // FAST output
        signal:      fastData.signal,
        confidence:  fastData.confidence,
        cross:       fastData.cross,
        freshCross:  fastData.freshCross,
        diff:        fastData.diff,
        isStrong:    fastData.isStrong,
        isExplosive: fastData.isExplosive,
        momentum:    fastData.momentum,
        momentumOK:  fastData.momentumOK,

        // Tick pressure
        aggressiveBuy:  pressure.aggressiveBuy,
        aggressiveSell: pressure.aggressiveSell,

        // Probe
        probe,

        ts: Date.now()
    };

    G.exec = exec;
    return exec;
}

module.exports = { runXExec, onTick };
