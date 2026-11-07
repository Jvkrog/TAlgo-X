"use strict";
// indicatorEngine.js — computes every indicator block in a custom strategy
// spec for BOTH the current candle window and the one-candle-back window,
// same trick createAlmaFastStrategy already uses (its a0/a1 pair) to
// classify slope/state. Computing "previous" generically is what lets
// conditionEvaluator.js's crosses_above/crosses_below/state_flips_to work
// for ANY indicator combination instead of each strategy hand-rolling its
// own lastDecisiveState.

const { toHA, alma, atr, atrSeries, adx, choppinessIndex, ema, dpi, getDPIState } = require("./indicators");

// MA_SLOPE and DYNAMIC_STEP_BAND are flagged in indicatorCatalog.js as not
// yet extracted from strategies.js into indicators.js. Throwing here (boot
// time, not mid-trade) is deliberate — a custom strategy referencing one of
// these should fail loudly, not silently produce nulls that read as "always
// false" conditions.
function computeOne(block, rawCandles, haCandles) {
    const { type, params } = block;
    switch (type) {
        case "ALMA": {
            const closes = haCandles.map(cd => cd.close);
            return { value: alma(closes, params.length, params.offset, params.sigma) };
        }
        case "EMA": {
            const closes = haCandles.map(cd => cd.close);
            const arr = ema(closes, params.length);
            return { value: arr.length ? arr[arr.length - 1] : null };
        }
        case "ATR":
            return { value: atr(rawCandles, params.period) };
        case "ADX": {
            const arr = adx(rawCandles, params.period);
            return { value: arr.length ? arr[arr.length - 1] : null };
        }
        case "CHOPPINESS": {
            const arr = choppinessIndex(rawCandles, params.period);
            return { value: arr.length ? arr[arr.length - 1] : null };
        }
        case "DPI":
        case "EFFICIENCY": {
            const atrArr = atrSeries(rawCandles, params.period);
            const r = dpi(haCandles, atrArr, params.period, params.streakMult, params.streakCap);
            if (!r) return { value: null, efficiency: null, state: null };
            const state = getDPIState(r.dpi, r.efficiency, {
                bullThresh: params.bullThresh,
                bearThresh: params.bearThresh,
                effThresh: params.effThresh,
            });
            return { value: r.dpi, efficiency: r.efficiency, state };
        }
        case "MA_SLOPE":
        case "DYNAMIC_STEP_BAND":
            throw new Error(`${type} not yet extracted into indicators.js — cannot run as a custom-strategy building block`);
        default:
            throw new Error(`unknown indicator type: ${type}`);
    }
}

// Returns { current, previous, warmup, activeCandles }.
// current/previous: { [blockId]: {value, efficiency?, state?} }
// activeCandles: raw or HA series per spec.candleType — used by the caller
// to resolve price.close/high/low against the same candle shape the
// indicators were computed on.
function computeIndicators(indicatorBlocks, rawCandles, candleType) {
    const haCandles     = toHA(rawCandles);
    const activeCandles = candleType === "ha" ? haCandles : rawCandles;

    const current = {}, previous = {};
    for (const block of indicatorBlocks) {
        current[block.id]  = computeOne(block, rawCandles, haCandles);
        previous[block.id] = rawCandles.length > 1
            ? computeOne(block, rawCandles.slice(0, -1), haCandles.slice(0, -1))
            : { value: null, efficiency: null, state: null };
    }

    // Warmup: longest lookback across selected indicators, +5 margin —
    // same buffer size your existing strategies already use before trusting
    // an indicator's output.
    const lookbacks = indicatorBlocks.map(b => b.params.period ?? b.params.length ?? 14);
    const warmup = (lookbacks.length ? Math.max(...lookbacks) : 14) + 5;

    return { current, previous, warmup, activeCandles };
}

module.exports = { computeIndicators };
