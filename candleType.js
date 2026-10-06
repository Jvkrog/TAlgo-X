// candleType.js — which candle series an instrument's strategy runs on.
//
//   RAW    plain time-based OHLC candles (instrument timeframe)
//   HA     Heikin-Ashi version of those candles
//   RANGE  range bars (fixed high-low range, tick driven, not time based)
//
// Every strategy has a NATIVE candle type (what it was designed around). Deploying with the
// native type changes nothing (legacy behaviour). Choosing another type OVERRIDES the
// strategy: see resolveCandleMode().
"use strict";

const CANDLE_TYPES = ["RAW", "HA", "RANGE"];
const CANDLE_LABEL = { RAW: "Raw (time candles)", HA: "Heikin-Ashi", RANGE: "Range bars" };

// Strategies that convert to Heikin-Ashi internally (signals read HA) are HA-native.
const HA_NATIVE = new Set([
    "ALMA_BAND", "ALMA_FAST", "ALMA_DUAL_BAND_SMA5", "DUAL_ST_CHOP",
    "MA_SLOPE", "MA_SLOPE_SCALP", "MA_SLOPE_PURE", "MA_SLOPE_HM",
    "DPI_TREND_MEANREV", "DPI_MEANREV", "ALMA_TRI_BAND",
    "ALMA_PRO_FAST", "ALMA_PRO_SLOW", "PURE_HA",
]);

function nativeCandleType(strategy) { return HA_NATIVE.has(strategy) ? "HA" : "RAW"; }

function normalizeCandleType(v) {
    const u = String(v || "").trim().toUpperCase();
    if (u === "HEIKIN" || u === "HEIKIN-ASHI" || u === "HEIKINASHI") return "HA";
    if (u === "RANGEBARS" || u === "RANGE_BARS" || u === "RANGE-BARS") return "RANGE";
    return CANDLE_TYPES.includes(u) ? u : null;
}

// File-name suffix: always present, so the same instrument+strategy can run on different candles.
function candleSuffix(type) { return (normalizeCandleType(type) || "RAW").toLowerCase(); }

// How the engine must treat the series for (strategy, chosen type):
//   view          series handed to the strategy: "native" (untouched raw feed) | "HA" | "RANGE"
//   haPassthrough strategy-internal Heikin-Ashi conversions become no-ops (strategy runs on exactly
//                 the chosen series — only needed when an HA-native strategy is put on RAW/RANGE)
//   overridden    chosen type differs from the strategy's native one (warn the user)
function resolveCandleMode(strategy, chosen) {
    const type = normalizeCandleType(chosen) || nativeCandleType(strategy);
    const native = nativeCandleType(strategy);
    const overridden = type !== native;
    if (!overridden) return { type, native, overridden, view: "native", haPassthrough: false };
    if (type === "HA") return { type, native, overridden, view: "HA", haPassthrough: false };
    return { type, native, overridden, view: type === "RANGE" ? "RANGE" : "native", haPassthrough: native === "HA" };
}

function overrideWarning(strategy, chosen) {
    const m = resolveCandleMode(strategy, chosen);
    if (!m.overridden) return null;
    return `${strategy} is designed for ${CANDLE_LABEL[m.native]} — you chose ${CANDLE_LABEL[m.type]}, so the strategy will run on ${CANDLE_LABEL[m.type]} instead (its own candle handling is overridden; results will differ from the original design)`;
}

module.exports = { CANDLE_TYPES, CANDLE_LABEL, nativeCandleType, normalizeCandleType, candleSuffix, resolveCandleMode, overrideWarning };
