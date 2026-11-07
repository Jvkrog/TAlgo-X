// marketProfiler.js — turns a regimeIndicators.js snapshot into a Market
// Profile. Named "profiler," not "classifier," on purpose: it builds a
// multi-field description of the market (trend, volatility, participation,
// structure, confidence), not a single label. The old single-field regime
// idea still exists — it's just one field inside the profile now
// (structure.state), not the whole output.
//
// The one piece of real state this file owns: per-instrument hysteresis on
// structure.state specifically. Every other field (trend.score,
// volatility.score, etc.) updates every candle with whatever the indicators
// currently say — no debouncing, because those are continuous scores, not
// a label that needs to avoid flapping. structure.state is the one field
// that behaves like the old "regime" idea (a discrete label consumers key
// off of for "did anything change"), so it's the only one that gets the
// same debounce treatment this codebase already uses elsewhere (the old
// NatGas SLOW engine's 2-candle debounced regime gate) — a raw
// classification only becomes the PUBLISHED structure.state once it's held
// for `debounceCandles` candles in a row. `structure.rawState` is exposed
// alongside it, undebounced, for anyone who wants to see the instantaneous
// read (e.g. an Analytics consumer) without it being mistaken for the
// stable, published one.
"use strict";

const DEFAULT_DEBOUNCE_CANDLES = 3;

// Choppiness Index thresholds — same convention indicators.js's own header
// comment already documents (<=38.2 trending, >=61.8 ranging); reused here,
// not reinvented.
const CHOP_TRENDING_MAX = 38.2;
const CHOP_RANGING_MIN  = 61.8;

// Volatility ratio (current ATR vs its own rolling average) thresholds —
// first-pass heuristic, not tuned against real data yet. Easy to revisit
// once this is actually running against live/backtested instruments.
const VOL_EXPANDING_RATIO   = 1.15;
const VOL_CONTRACTING_RATIO = 0.85;

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

// Decides structure.state from the rest of the snapshot. Priority order,
// each one a deliberate choice:
//   1. Breakout — only checked when volatility is actually EXPANDING (a
//      price poking outside its recent range during a quiet, contracting
//      period is a much weaker signal than the same poke during expansion)
//   2. Choppiness-based trending/ranging — the clearest, most direct signal
//   3. Volatility extremes as a fallback label when chop is in its own
//      "neither clearly trending nor ranging" middle band
//   4. UNKNOWN — genuinely ambiguous, or chop data isn't available yet
function resolveRawStructureState(ind, volatility) {
    if (ind.chopVal == null) return "UNKNOWN";

    const isBreakout = volatility.state === "EXPANDING" && ind.priceHighN != null && ind.priceLowN != null &&
        (ind.closeVal > ind.priceHighN || ind.closeVal < ind.priceLowN);
    if (isBreakout) return "BREAKOUT";

    if (ind.chopVal <= CHOP_TRENDING_MAX) return "TRENDING";
    if (ind.chopVal >= CHOP_RANGING_MIN)  return "RANGING";

    if (volatility.score >= 75) return "HIGH_VOLATILITY";
    if (volatility.score <= 25) return "LOW_VOLATILITY";

    return "UNKNOWN";
}

// createMarketProfiler({ debounceCandles }) -> { profile(instrument, ind) }
//
// One instance is meant to live for the whole Scanner process's lifetime —
// it's the thing holding the per-instrument hysteresis state across calls,
// the same way state.js's created-once-per-instrument object holds a
// trading engine's own runtime state.
function createMarketProfiler({ debounceCandles = DEFAULT_DEBOUNCE_CANDLES } = {}) {
    const perInstrument = new Map(); // instrument -> { pendingState, pendingCount, publishedState }

    // profile(instrument, ind) -> { profile, changed } | null
    //   ind      — a regimeIndicators.js snapshot (or null if still warming up)
    //   changed  — true only on the candle where structure.state's PUBLISHED
    //              value actually flips — this is what a caller should use
    //              to decide whether to write a market_profile_history row
    function profile(instrument, ind) {
        if (!ind) return null;

        const trend = {
            score:     clamp(Math.round(ind.adxVal), 0, 100),
            direction: ind.stDir === 1 ? "UP" : ind.stDir === -1 ? "DOWN" : "FLAT",
        };

        const volRatio = (ind.atrAvg != null && ind.atrAvg > 0) ? ind.atrVal / ind.atrAvg : 1;
        const volatility = {
            score: clamp(Math.round(volRatio * 50), 0, 100),
            state: volRatio > VOL_EXPANDING_RATIO   ? "EXPANDING" :
                   volRatio < VOL_CONTRACTING_RATIO ? "CONTRACTING" : "STABLE",
        };

        // No fabricated number when there's no volume data — see
        // regimeIndicators.js's header comment for why that can happen.
        const participation = {
            score: (ind.volumeVal != null && ind.volumeAvg > 0)
                ? clamp(Math.round((ind.volumeVal / ind.volumeAvg) * 50), 0, 100)
                : null,
        };

        const rawState = resolveRawStructureState(ind, volatility);

        let entry = perInstrument.get(instrument);
        if (!entry) {
            // Cold start — accept the first read immediately rather than
            // making a freshly-watched instrument sit at "UNKNOWN" for
            // `debounceCandles` candles before it gets its first real label.
            entry = { pendingState: rawState, pendingCount: debounceCandles, publishedState: rawState };
            perInstrument.set(instrument, entry);
        } else if (rawState === entry.pendingState) {
            entry.pendingCount++;
        } else {
            entry.pendingState = rawState;
            entry.pendingCount = 1;
        }

        let changed = false;
        let previousState = null;
        if (entry.pendingCount >= debounceCandles && entry.publishedState !== entry.pendingState) {
            previousState = entry.publishedState;
            entry.publishedState = entry.pendingState;
            changed = true;
        }

        // Confidence — how decisively the two clearest signals (trend
        // strength via ADX, and chop's distance from its own neutral
        // midpoint) agree with the published structure. First-pass
        // heuristic, same caveat as the volatility thresholds above.
        const chopConfidence = ind.chopVal != null ? clamp(Math.round(Math.abs(ind.chopVal - 50) * 2), 0, 100) : 50;
        const confidence = clamp(Math.round((trend.score + chopConfidence) / 2), 0, 100);

        return {
            profile: {
                instrument,
                trend,
                volatility,
                participation,
                structure: { state: entry.publishedState, rawState },
                confidence,
                updatedAt: new Date().toISOString(),
            },
            changed,
            // The state structure.state transitioned FROM, only set on the
            // candle where `changed` is true — this is what
            // scannerService.js passes to marketStateStore.js's
            // logTransition(instrument, previousState, newState, ...) so
            // the history table records both sides of the transition, not
            // just the new one.
            previousState,
        };
    }

    return { profile };
}

module.exports = { createMarketProfiler };
