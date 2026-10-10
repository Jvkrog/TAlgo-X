// chartOverlay.js — the indicator lines the dashboard chart draws for an instrument's strategy.
// Pure function over the instrument-timeframe bars (oldest -> newest); mirrors what the
// strategy itself computes (same indicators.js functions / same band state machine), so the
// chart shows what the engine actually sees. Strategies without a price-space indicator
// return { note } and the chart says so instead of drawing something misleading.
"use strict";

const { toHA, alma, supertrend } = require("./indicators");
const { createBandStepper } = require("./dynamicBandReader");

const COLORS = { high: "#4de3ff", mid: "#eafff2", low: "#ffb347", a: "#4de3ff", b: "#ffb347" };

function rolling(values, len, fn) {
    const out = [];
    for (let i = len - 1; i < values.length; i++) out.push(fn(values.slice(i - len + 1, i + 1)));
    return out;   // aligned to bars from index len-1
}

// bars: [{ t(ms), open, high, low, close }]; ctx: { bandStep, almaFastLen }; cfg: engineConfig
function computeOverlay(strategy, bars, ctx, cfg) {
    const line = (name, color, vals, offset = 0) => ({
        name, color,
        points: vals.map((v, i) => [bars[i + offset].t, v]).filter(p => p[1] !== null && p[1] !== undefined),
    });

    if (strategy === "DYNAMIC_MID_COLOR") {
        const step = ctx.bandStep ?? cfg.BAND_STEP_DEFAULT;
        const st = createBandStepper(step);
        const src = ctx.candleType === "RAW" || ctx.candleType === "RANGE" ? bars : toHA(bars);   // Heikin-Ashi unless deployed on another type
        // Drawn the way the strategy's name says: ONE mid line, coloured by direction (green while
        // LONG / before the first breakout, red while SHORT) — not the high/low band edges.
        const pts = [];
        for (let i = 0; i < src.length; i++) {
            st.push(src[i]);
            const s = st.state();
            if (s) pts.push([bars[i].t, s.bandMid, s.color === "red" ? "#ff5266" : "#33ff88"]);
        }
        return { label: `Dynamic mid color (step ${step}) — green = long, red = short`, lines: [{ name: "mid", color: "#33ff88", width: 3, points: pts }] };
    }

    if (strategy === "ALMA_BAND") {
        const len = cfg.ALMA_LEN, ha = toHA(bars);
        const f = vs => alma(vs, len, cfg.ALMA_OFFSET, cfg.ALMA_SIGMA);
        return { label: `ALMA band (len ${len}, HA high/low)`, lines: [
            line("ALMA high", COLORS.high, rolling(ha.map(b => b.high), len, f), len - 1),
            line("ALMA low", COLORS.low, rolling(ha.map(b => b.low), len, f), len - 1),
        ] };
    }

    if (strategy === "ALMA_DSB") {
        const len = cfg.ALMA_LEN, ha = toHA(bars), step = ctx.bandStep ?? cfg.BAND_STEP_DEFAULT;
        const f = vs => alma(vs, len, cfg.ALMA_OFFSET, cfg.ALMA_SIGMA);
        const st = createBandStepper(step), pts = [];
        for (let i = 0; i < bars.length; i++) { st.push(ha[i]); const s = st.state(); if (s) pts.push([bars[i].t, s.bandMid, s.color === "red" ? "#ff5266" : "#33ff88"]); }
        return { label: `ALMA band (len ${len}) + Dynamic Step Band mid (step ${step}) — green = long bias, red = short bias`, lines: [
            line("ALMA high", COLORS.high, rolling(ha.map(b => b.high), len, f), len - 1),
            line("ALMA low", COLORS.low, rolling(ha.map(b => b.low), len, f), len - 1),
            { name: "DSB mid", color: "#33ff88", width: 3, points: pts },
        ] };
    }

    if (strategy === "ALMA_FAST") {
        const len = ctx.almaFastLen ?? cfg.ALMA_FAST_LEN, ha = toHA(bars);
        const f = vs => alma(vs, len, cfg.ALMA_FAST_OFFSET, cfg.ALMA_FAST_SIGMA);
        return { label: `ALMA fast (len ${len}, HA close)`, lines: [line("ALMA", COLORS.a, rolling(ha.map(b => b.close), len, f), len - 1)] };
    }

    if (strategy === "DUAL_ST_CHOP") {
        const ha = toHA(bars);
        const s1 = supertrend(ha, cfg.DST_ST1_ATR_LEN, cfg.DST_ST1_FACTOR), s2 = supertrend(ha, cfg.DST_ST2_ATR_LEN, cfg.DST_ST2_FACTOR);
        if (!s1 || !s2) return { note: "not enough bars for SuperTrend yet" };
        return { label: `SuperTrend ST1 ${cfg.DST_ST1_FACTOR} / ST2 ${cfg.DST_ST2_FACTOR}`, lines: [
            line("ST1", COLORS.a, s1.map(r => r ? r.trend : null)), line("ST2", COLORS.b, s2.map(r => r ? r.trend : null)),
        ] };
    }

    return { note: `no price-overlay indicator is drawn for ${strategy} yet` };
}

module.exports = { computeOverlay };
