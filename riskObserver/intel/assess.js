// riskObserver/intel/assess.js — Phase 3: structured, explainable position-deterioration assessment. PURE.
// Every assessment carries: classification, supporting evidence, timestamp, evidence quality, data completeness and a
// plain-language explanation. There are NO price predictions; classifications describe CURRENT evidence only and are
// informational — never an execution command. Unreliable/insufficient input => classification UNKNOWN (never "LOW").
"use strict";

const SEVERITY = Object.freeze({ INFO: 1, WARNING: 2, HIGH: 3 });
const KINDS = Object.freeze(["VOLATILITY_EXPANSION", "TREND_DETERIORATION", "TREND_EXHAUSTION", "ADVERSE_MOVEMENT", "PROFIT_GIVEBACK", "DATA_UNRELIABLE", "POSITION_RECONCILIATION_WARNING", "ABNORMAL_MARKET_MOVEMENT"]);
const DEFAULT_CFG = Object.freeze({
    volExpansionRatio: 1.5, volExpansionHigh: 2.2, abnormalRangeAtr: 3, adverseWarnAtr: 1, adverseHighAtr: 2, adverseCandles: 2,
    givebackFrac: 0.5, givebackHighFrac: 0.75, givebackMinPeakAtr: 0.5, exhaustionRsiHi: 75, exhaustionRsiLo: 25, exhaustionAdxMin: 25, exhaustionAdxFall: 3,
    deteriorationAdxFall: 3, deteriorationAdxMin: 20,
});

// input: { side, nowMs, market (analyseMarket result), metrics { currentAdverse, peakPnl, giveback, adverseCandles, perPoint }, dsb { agreeAgainst, disagreeCandles },
//          health { reliable, causes[] }, completeness { candle, live, origin, notes[] } }
function assess(input, cfgIn = {}) {
    const cfg = { ...DEFAULT_CFG, ...cfgIn }, ev = [], cand = [];
    const m = input.market || { status: "INSUFFICIENT", reasons: ["no market analysis"] }, met = input.metrics || {}, hl = input.health || { reliable: false, causes: ["unspecified"] };
    const comp = input.completeness || { candle: "UNKNOWN", live: "UNKNOWN", origin: "uncertain", notes: [] };
    const long = input.side === "LONG", atr = m.atr;
    const add = (kind, severity, evidence, why) => cand.push({ kind, severity, evidence, explanation: why });

    if (!hl.reliable) add("DATA_UNRELIABLE", "WARNING", { causes: hl.causes || [] }, `Market data is unreliable (${(hl.causes || ["unspecified"]).join(", ")}); no risk classification is made from it.`);
    const partial = comp.candle !== "FULL" || comp.live !== "FULL" || comp.origin !== "observed_from_entry";
    if (partial) add("POSITION_RECONCILIATION_WARNING", "INFO", { candle: comp.candle, live: comp.live, origin: comp.origin, notes: comp.notes || [] }, `Position history is incomplete (origin ${comp.origin}, candle ${comp.candle}, live ${comp.live}); excursions may be understated.`);

    const marketOk = hl.reliable && m.status === "OK";
    if (marketOk) {
        if (m.atrRatio >= cfg.volExpansionRatio) add("VOLATILITY_EXPANSION", m.atrRatio >= cfg.volExpansionHigh ? "HIGH" : "WARNING", { atrRatio: m.atrRatio, atr: m.atr, baseline: m.atrBaseline }, `15m ATR is ${m.atrRatio.toFixed(2)}x its recent median.`);
        if (m.rangeAtr >= cfg.abnormalRangeAtr) add("ABNORMAL_MARKET_MOVEMENT", "HIGH", { rangeAtr: m.rangeAtr, lastRange: m.lastRange }, `Last completed candle range is ${m.rangeAtr.toFixed(2)} ATR (abnormal).`);
        const adv = Number.isFinite(met.currentAdverse) ? met.currentAdverse / atr : null;   // adverse in ATRs (points / ATR)
        if (adv !== null && adv >= cfg.adverseWarnAtr && (met.adverseCandles || 0) >= cfg.adverseCandles) add("ADVERSE_MOVEMENT", adv >= cfg.adverseHighAtr ? "HIGH" : "WARNING", { adverseAtr: adv, adverseCandles: met.adverseCandles }, `Price is ${adv.toFixed(2)} ATR against the position over ${met.adverseCandles} consecutive adverse candles.`);
        const against = m.persistence && ((long && m.persistence.runDir === "DOWN") || (!long && m.persistence.runDir === "UP"));
        const dsbBad = input.dsb && (input.dsb.agreeAgainst || (input.dsb.disagreeCandles || 0) >= 2);
        if (dsbBad) add("TREND_DETERIORATION", "WARNING", { dsb: input.dsb, adx: m.adx, adxChange: m.adxChange }, "15m DSB agreement has deteriorated against the position.");
        else if (against && m.persistence.runBars >= 3 && m.adx !== null && m.adx >= cfg.deteriorationAdxMin) add("TREND_DETERIORATION", "WARNING", { run: m.persistence, adx: m.adx }, `${m.persistence.runBars} consecutive closes against the position with ADX ${m.adx.toFixed(1)}.`);
        const stretched = m.rsi !== null && ((long && m.rsi >= cfg.exhaustionRsiHi) || (!long && m.rsi <= cfg.exhaustionRsiLo));
        if (stretched && m.adx !== null && m.adx >= cfg.exhaustionAdxMin && m.adxChange !== null && m.adxChange <= -cfg.exhaustionAdxFall) add("TREND_EXHAUSTION", "WARNING", { rsi: m.rsi, adx: m.adx, adxChange: m.adxChange }, `RSI ${m.rsi.toFixed(1)} is stretched in the position's favour while ADX (${m.adx.toFixed(1)}) is falling.`);
        const pk = met.peakPnl, perPt = met.perPoint || 1;
        if (Number.isFinite(pk) && pk > 0 && Number.isFinite(met.giveback) && pk / perPt >= cfg.givebackMinPeakAtr * atr) {
            const f = met.giveback / pk; if (f >= cfg.givebackFrac) add("PROFIT_GIVEBACK", f >= cfg.givebackHighFrac ? "HIGH" : "WARNING", { givebackFraction: f, peakPnl: pk, giveback: met.giveback }, `${(f * 100).toFixed(0)}% of peak unrealised profit has been given back.`);
        }
    }
    for (const c of cand) ev.push({ ...c, informational: true });   // events never command anything
    const real = ev.filter(e => !["DATA_UNRELIABLE", "POSITION_RECONCILIATION_WARNING"].includes(e.kind));
    const top = real.reduce((a, e) => Math.max(a, SEVERITY[e.severity]), 0);
    const classification = !marketOk ? "UNKNOWN" : top >= SEVERITY.HIGH ? "HIGH" : top >= SEVERITY.WARNING ? "ELEVATED" : "LOW";
    const reasonsUnknown = !hl.reliable ? `data unreliable (${(hl.causes || []).join(", ")})` : m.status !== "OK" ? `market analysis insufficient (${(m.reasons || []).join("; ")})` : null;
    const quality = !marketOk ? "NONE" : partial ? "PARTIAL" : "FULL";
    return {
        ts: input.nowMs, classification, evidenceQuality: quality, completeness: { candle: comp.candle, live: comp.live, origin: comp.origin }, events: ev,
        evidence: { market: marketOk ? { atrRatio: m.atrRatio, rangeAtr: m.rangeAtr, adx: m.adx, adxChange: m.adxChange, chop: m.chop, rsi: m.rsi, condition: m.condition } : null, metrics: { currentAdverse: met.currentAdverse ?? null, peakPnl: met.peakPnl ?? null, giveback: met.giveback ?? null } },
        explanation: classification === "UNKNOWN" ? `Cannot classify: ${reasonsUnknown}.` : real.length ? real.map(e => e.explanation).join(" ") : "No deterioration evidence in the current data.",
        informational: true,
    };
}
module.exports = { assess, KINDS, SEVERITY, DEFAULT_CFG };
