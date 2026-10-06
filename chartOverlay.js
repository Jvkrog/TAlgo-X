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
        const hi = [], mid = [], lo = [];
        for (const b of bars) {
            st.push(b);
            const s = st.state();
            hi.push(s ? s.bandHigh : null); mid.push(s ? s.bandMid : null); lo.push(s ? s.bandLow : null);
        }
        return { label: `Dynamic band (step ${step})`, lines: [line("band high", COLORS.high, hi), line("band mid", COLORS.mid, mid), line("band low", COLORS.low, lo)] };
    }

    if (strategy === "ALMA_BAND") {
        const len = cfg.ALMA_LEN, ha = toHA(bars);
        const f = vs => alma(vs, len, cfg.ALMA_OFFSET, cfg.ALMA_SIGMA);
        return { label: `ALMA band (len ${len}, HA high/low)`, lines: [
            line("ALMA high", COLORS.high, rolling(ha.map(b => b.high), len, f), len - 1),
            line("ALMA low", COLORS.low, rolling(ha.map(b => b.low), len, f), len - 1),
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
