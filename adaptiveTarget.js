// adaptiveTarget.js — regime-sized profit targets for TARGET_MODE=adaptive.
//
// Scope, deliberately narrow: this SIZES the target for a trade that's
// already happening. It never blocks, gates, or filters an entry — that
// stays entirely the strategy's job, upstream of this and untouched.
// Every valid (chop, efficiency) input classifies into exactly one of
// three regimes; there is no "reject" outcome.
//
// Inputs are deliberately just CHOP and |DPI efficiency| — no SuperTrend
// agreement, ADX, RSI, or other confirmation conditions. Classification
// boundaries reuse the EXACT same thresholds (CHOP_MAX, DPI_EFF_THRESH)
// the DPI strategies already use for their own entry filters/TREND-MEANREV
// split (see engineConfig.js) — one set of boundaries for these two
// indicators, not a second one invented for this feature.
//
// The three POINTS values below are an initial PAPER-TRADING experiment —
// NOT backtested or optimized (see engineConfig.js's ADAPTIVE_TARGET_*
// comment, which is the actual source of these numbers; nothing here is
// hardcoded).
"use strict";

// selectAdaptiveTarget({ chop, efficiency }, engineConfig)
//   chop       — latest Choppiness Index value (choppinessIndex() last bar)
//   efficiency — latest DPI efficiency, SIGNED (dpi()'s .efficiency) —
//                this function takes the absolute value itself; callers
//                should NOT pre-abs it, so the reason string can be built
//                consistently in one place.
//
// Returns { points, regime, reason } — never null, never a "blocked"
// outcome. regime is one of "CHOPPY" | "NORMAL" | "STRONG_TREND".
function selectAdaptiveTarget({ chop, efficiency }, engineConfig) {
    const haveChop = typeof chop === "number" && Number.isFinite(chop);
    const haveEff  = typeof efficiency === "number" && Number.isFinite(efficiency);
    const absEff   = haveEff ? Math.abs(efficiency) : null;

    // Defensive fallback only — by the time an entry signal has fired, the
    // strategy's own warmup gate has already guaranteed enough candles for
    // both CHOP_LEN and DPI_LEN, so this branch shouldn't be reachable in
    // practice. If it somehow is, NORMAL is the safe, non-blocking default —
    // never CHOPPY or STRONG_TREND on missing data.
    if (!haveChop || !haveEff) {
        return {
            points: engineConfig.ADAPTIVE_TARGET_NORMAL,
            regime: "NORMAL",
            reason: `chop/efficiency unavailable (chop=${chop}, efficiency=${efficiency}) — defaulting to NORMAL`,
        };
    }

    if (chop > engineConfig.CHOP_MAX) {
        return {
            points: engineConfig.ADAPTIVE_TARGET_CHOPPY,
            regime: "CHOPPY",
            reason: `chop ${chop.toFixed(1)} > ${engineConfig.CHOP_MAX} — sideways/choppy, smaller target`,
        };
    }

    if (absEff >= engineConfig.DPI_EFF_THRESH) {
        return {
            points: engineConfig.ADAPTIVE_TARGET_STRONG,
            regime: "STRONG_TREND",
            reason: `chop ${chop.toFixed(1)} <= ${engineConfig.CHOP_MAX}, |efficiency| ${absEff.toFixed(2)} >= ${engineConfig.DPI_EFF_THRESH} — clean directional move, larger target`,
        };
    }

    return {
        points: engineConfig.ADAPTIVE_TARGET_NORMAL,
        regime: "NORMAL",
        reason: `chop ${chop.toFixed(1)} <= ${engineConfig.CHOP_MAX}, |efficiency| ${absEff.toFixed(2)} < ${engineConfig.DPI_EFF_THRESH} — moderate conditions`,
    };
}

module.exports = { selectAdaptiveTarget };
