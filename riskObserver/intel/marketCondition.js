// riskObserver/intel/marketCondition.js — Phase 3: market-condition analysis. PURE (no I/O, no clock, no globals).
// Reuses the platform's own indicators (indicators.js: atrSeries / adx / choppinessIndex / rsi) with EXPLICIT lengths — no
// parallel indicator implementations. Correlated indicators are NOT blended into a score: each is reported on its own and
// the assessment layer cites the specific ones it used. Returns UNKNOWN-style output (status "INSUFFICIENT") rather than
// guessing when there is not enough clean history.
"use strict";
const ind = require("../../indicators");

const DEFAULTS = Object.freeze({ atrLen: 14, adxLen: 14, chopLen: 14, rsiLen: 14, baselineBars: 20, minBars: 40, persistBars: 6, fallBars: 3 });
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const last = a => (a && a.length ? a[a.length - 1] : null);
const fin = v => (Number.isFinite(v) ? v : null);

// candles: CLOSED 15m bars [{ts,open,high,low,close}] in ascending order. Duplicates / disorder are rejected (not repaired).
function analyseMarket(candles, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const out = { status: "INSUFFICIENT", reasons: [], bars: Array.isArray(candles) ? candles.length : 0, lastTs: null };
    if (!Array.isArray(candles)) { out.reasons.push("no candles"); return out; }
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (!c || ![c.ts, c.open, c.high, c.low, c.close].every(Number.isFinite)) { out.reasons.push(`malformed candle at index ${i}`); return out; }
        if (i && c.ts <= candles[i - 1].ts) { out.reasons.push(`candles not strictly ascending at index ${i}`); return out; }
    }
    if (candles.length < o.minBars) { out.reasons.push(`only ${candles.length} bars (< ${o.minBars})`); return out; }
    let atrS, adxS, chopS, rsiS;
    try { atrS = ind.atrSeries(candles, o.atrLen); adxS = ind.adx(candles, o.adxLen); chopS = ind.choppinessIndex(candles, o.chopLen); rsiS = ind.rsi(candles.map(c => c.close), o.rsiLen); }
    catch (e) { out.reasons.push(`indicator failure: ${e.message}`); return out; }
    const n = candles.length, ranges = candles.map(c => c.high - c.low);
    const atrNow = fin(last(atrS)), atrBase = median(atrS.slice(n - 1 - o.baselineBars, n - 1));
    const lastRange = ranges[n - 1], avgRange = median(ranges.slice(n - 1 - o.baselineBars, n - 1));
    const adxNow = fin(last(adxS)), adxPrev = fin(adxS[n - 1 - o.fallBars]);
    // trend persistence: run length of consecutive same-direction CLOSES ending at the last bar
    let run = 0, dir = 0; for (let i = n - 1; i > 0; i--) { const d = Math.sign(candles[i].close - candles[i - 1].close); if (d === 0) break; if (!dir) dir = d; if (d !== dir) break; run++; }
    const win = candles.slice(-o.persistBars), ups = win.filter((c, i) => i && c.close > win[i - 1].close).length, downs = win.filter((c, i) => i && c.close < win[i - 1].close).length;
    Object.assign(out, {
        status: atrNow && atrBase ? "OK" : "INSUFFICIENT", lastTs: candles[n - 1].ts,
        atr: atrNow, atrBaseline: atrBase, atrRatio: atrNow && atrBase ? atrNow / atrBase : null,
        lastRange, rangeRatio: avgRange ? lastRange / avgRange : null, rangeAtr: atrNow ? lastRange / atrNow : null,
        adx: adxNow, adxChange: adxNow !== null && adxPrev !== null ? adxNow - adxPrev : null, chop: fin(last(chopS)), rsi: fin(last(rsiS)),
        persistence: { runBars: run, runDir: dir > 0 ? "UP" : dir < 0 ? "DOWN" : "FLAT", upBars: ups, downBars: downs, consistency: (win.length > 1) ? Math.max(ups, downs) / (win.length - 1) : null },
    });
    if (out.status !== "OK") out.reasons.push("ATR baseline unavailable");
    else out.condition = {
        volatility: out.atrRatio >= 1.5 ? "EXPANDING" : out.atrRatio <= 0.7 ? "CONTRACTING" : "NORMAL",
        trend: out.chop !== null && out.chop >= 61.8 ? "CHOPPY" : out.adx !== null && out.adx >= 25 ? "TRENDING" : "WEAK",
    };
    return out;
}
module.exports = { analyseMarket, DEFAULTS, median };
