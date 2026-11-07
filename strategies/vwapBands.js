// vwapBands.js — session VWAP with volume-weighted standard-deviation bands, plus the two "plays" read off them.
// Pure functions (no engine state), shared by strategies.js (VWAP_SD_BANDS) and its tests.
//
//   VWAP_t   = sum(tp * vol) / sum(vol)                    tp = (high + low + close) / 3, summed from the session's first candle
//   var_t    = sum(vol * (tp - VWAP_t)^2) / sum(vol)       volume-weighted variance of the typical price around VWAP
//   upper/lower = VWAP +/- mult * sqrt(var)
// When a session has no volume at all (some feeds), every candle gets weight 1 (time-weighted) so the bands still exist.
"use strict";

const typical = k => (k.high + k.low + k.close) / 3;

// One entry per candle: { vwap, sd, upper, lower } computed with running sums, so each bar's band is what the indicator showed AT that bar.
function vwapBandSeries(session, mult = 1) {
    const out = [];
    let sw = 0, swp = 0, swpp = 0;
    const noVol = !session.some(k => Number(k.volume) > 0);
    for (const k of session) {
        const w = noVol ? 1 : (Number(k.volume) || 0), tp = typical(k);
        sw += w; swp += w * tp; swpp += w * tp * tp;
        if (sw <= 0) { out.push({ vwap: null, sd: null, upper: null, lower: null }); continue; }
        const vwap = swp / sw, variance = Math.max(0, swpp / sw - vwap * vwap), sd = Math.sqrt(variance);
        out.push({ vwap, sd, upper: vwap + mult * sd, lower: vwap - mult * sd });
    }
    return out;
}

// Which play is on at the LAST candle of `session` (with its own bands in `bands`)?
//   BREAKOUT_LONG / BREAKOUT_SHORT — the last `confirm` closes are all outside their band (above upper / below lower)  -> RIDE IT, never fight it
//   FADE_LONG  — the candle's low reached the lower band but it closed back above it (edge rejected)                    -> buy the bottom
//   FADE_SHORT — the candle's high reached the upper band but it closed back below it                                   -> sell the top
//   null       — nothing
function classify(session, bands, confirm = 2) {
    const n = session.length;
    if (n === 0 || bands.length !== n) return null;
    const last = session[n - 1], b = bands[n - 1];
    if (b.vwap === null || !(b.sd > 0)) return null;
    if (n >= confirm) {
        let up = true, dn = true;
        for (let i = n - confirm; i < n; i++) {
            if (bands[i].upper === null || !(session[i].close > bands[i].upper)) up = false;
            if (bands[i].lower === null || !(session[i].close < bands[i].lower)) dn = false;
        }
        if (up) return "BREAKOUT_LONG";
        if (dn) return "BREAKOUT_SHORT";
    }
    if (last.low <= b.lower && last.close > b.lower) return "FADE_LONG";
    if (last.high >= b.upper && last.close < b.upper) return "FADE_SHORT";
    return null;
}

// Has the breakout in `side` ended? True when the last `confirm` closes are all back inside the band (LONG: not above upper; SHORT: not below lower).
function backInside(side, session, bands, confirm = 2) {
    const n = session.length; if (n < confirm) return false;
    for (let i = n - confirm; i < n; i++) {
        if (bands[i].upper === null) return false;
        if (side === "LONG" ? session[i].close > bands[i].upper : session[i].close < bands[i].lower) return false;
    }
    return true;
}

module.exports = { vwapBandSeries, classify, backInside };
