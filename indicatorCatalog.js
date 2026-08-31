"use strict";
// indicatorCatalog.js — single source of truth for which indicators exist
// as custom-strategy building blocks, their configurable params, and what
// each one exposes for condition-building (indicatorEngine.js/conditionEvaluator.js
// key off `exposes`). Both toolbox.js and webdash/server.js read from this
// instead of maintaining their own copies of the list.
//
// requiresCandles is true for everything today because tick mode doesn't
// exist yet ("ignore ticks for now" — see chat). Once it does, the builder
// (toolbox step 3 / webdash step 3) filters this list by requiresCandles
// against the chosen data mode instead of showing everything unconditionally.

const INDICATOR_CATALOG = {
    ALMA: {
        label: "ALMA",
        requiresCandles: true,
        exposes: ["value"],
        params: [
            { key: "length", label: "Length", default: 20 },
            { key: "offset", label: "Offset", default: 0.85 },
            { key: "sigma",  label: "Sigma",  default: 6 },
        ],
    },
    EMA: {
        label: "EMA",
        requiresCandles: true,
        exposes: ["value"],
        params: [{ key: "length", label: "Length", default: 56 }],
    },
    MA_SLOPE: {
        label: "MA Slope",
        requiresCandles: true,
        // NOTE: not yet extracted into indicators.js — still embedded in
        // strategies.js's createMaSlopePureStrategy. indicatorEngine.js
        // throws if this type is selected, on purpose, rather than faking
        // a value. Pick ALMA/EMA slope via crosses_above/crosses_below on
        // price until this extraction happens.
        exposes: ["state"], // BULL | BEAR | NEUTRAL
        params: [
            { key: "length",   label: "MA Length",              default: 56 },
            { key: "atrLen",   label: "ATR Length (angle norm)", default: 14 },
            { key: "deadband", label: "Deadband (ATR mult)",     default: 0.1 },
        ],
    },
    DPI: {
        label: "DPI",
        requiresCandles: true,
        exposes: ["value", "efficiency", "state"],
        params: [
            { key: "period",     label: "Period",               default: 10 },
            { key: "streakMult", label: "Streak Mult",           default: 0.2 },
            { key: "streakCap",  label: "Streak Cap",            default: 1.0 },
            { key: "bullThresh", label: "Bull Threshold",        default: 3.0 },
            { key: "bearThresh", label: "Bear Threshold",        default: -3.0 },
            { key: "effThresh",  label: "Efficiency Threshold",  default: 0.6 },
        ],
    },
    EFFICIENCY: {
        // Same dpi() call as DPI — exists as its own catalog entry so a
        // user can pull in efficiency alone without wanting DPI's
        // value/state too. indicatorEngine.js computes dpi() once and
        // reuses it if both DPI and EFFICIENCY blocks share the same period.
        label: "Efficiency (Kaufman, via DPI)",
        requiresCandles: true,
        exposes: ["value"],
        params: [{ key: "period", label: "Period", default: 10 }],
    },
    ADX: {
        label: "ADX",
        requiresCandles: true,
        exposes: ["value"],
        params: [{ key: "period", label: "Period", default: 14 }],
    },
    CHOPPINESS: {
        label: "Choppiness Index",
        requiresCandles: true,
        exposes: ["value"],
        params: [{ key: "period", label: "Period", default: 14 }],
    },
    ATR: {
        label: "ATR",
        requiresCandles: true,
        exposes: ["value"],
        params: [{ key: "period", label: "Period", default: 10 }],
    },
    DYNAMIC_STEP_BAND: {
        label: "Dynamic Step Band",
        requiresCandles: true,
        // NOTE: same situation as MA_SLOPE — not yet extracted into
        // indicators.js. indicatorEngine.js throws on this type.
        exposes: ["state"], // HIGH | MID | LOW
        params: [{ key: "stepPoints", label: "Step (points)", default: 5 }],
    },
};

module.exports = { INDICATOR_CATALOG };
