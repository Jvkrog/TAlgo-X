// riskObserver/sim/simulate.js — Phase 5: deterministic offline replay + stress simulation. PURE except for the injected inputs.
// Runs the SAME production pieces the live observer uses — riskState machine, DSB replay, Phase-3 assess() and event engine — over
// CLOSED 15m candles. Results are labelled: HISTORICAL_REPLAY (real candles, unmodified) or SIMULATED (scenario applied). A candle-close
// replay cannot reproduce intrabar/tick behaviour, so excursions are understated; every result carries that limitation.
// ISOLATION: this module imports only pure analysis modules. It has no access to a broker, order/position code, sockets or the
// observer's database, and test-risk-sim.js asserts that structurally.
"use strict";

const { newMachine, step } = require("../riskState");
const { dualReplay, relation } = require("../dsbMonitor");
const { analyseMarket } = require("../intel/marketCondition");
const { assess } = require("../intel/assess");
const { createRiskEventEngine } = require("../intel/riskEvents");
const { applyScenario } = require("./scenarios");
const { aggregate, createDrawdownTracker } = require("../portfolio/aggregate");
const { atr } = require("../../indicators");

const LIMITS = ["Candle-close replay: intrabar and tick behaviour are not reproduced, so adverse excursions and giveback are understated.", "No tick-level data: slippage and gaps are scenario ASSUMPTIONS, not observations.", "Results are not predictions of future performance."];
const inHealth = (ts, health) => health.find(h => ts >= h.fromTs && ts <= h.toTs) || null;

// pos: { side, entryPrice, entryTs, endTs, perPoint }; candles: closed 15m bars ascending; steps: [s1, s2] DSB steps
function runPipeline(pos, candlesIn, { steps, riskCfg, atrLen = 10, health = [], restarts = [], slippagePts = 0, assessCfg = {}, label }) {
    const candles = candlesIn, long = pos.side === "LONG", perPoint = pos.perPoint || 1;
    const rows = dualReplay(candles, steps[0], steps[1]);
    let m = newMachine(), ev = createRiskEventEngine({ clearAfter: 2 });
    const restartSet = new Set(restarts), out = { transitions: [], states: [], riskEvents: [], unknownBars: 0, restartsApplied: 0, evaluated: 0, maxAdversePts: 0, peakPnl: 0, maxGiveback: 0, maxPositionDrawdown: 0, pnlPath: [] };
    const entryFill = pos.entryPrice + (long ? slippagePts : -slippagePts);   // adverse fill
    let adverseStreak = 0, peakFav = 0, last = null;
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i]; if (c.ts < pos.entryTs || c.ts >= pos.endTs) continue;
        if (restartSet.has(c.ts)) { m = newMachine(); ev = createRiskEventEngine({ clearAfter: 2 }); out.restartsApplied++; adverseStreak = 0; }   // observer memory lost; nothing is carried over
        const unhealthy = inHealth(c.ts, health);
        const adv = long ? entryFill - c.close : c.close - entryFill, fav = -adv; if (fav > peakFav) peakFav = fav;
        const against = long ? c.close < c.open : c.close > c.open; adverseStreak = against ? adverseStreak + 1 : 0;
        const pnl = fav * perPoint, peakPnl = peakFav * perPoint, giveback = Math.max(0, peakPnl - pnl);
        out.pnlPath.push({ ts: c.ts, pnl }); out.peakPnl = Math.max(out.peakPnl, peakPnl); out.maxGiveback = Math.max(out.maxGiveback, giveback); out.maxAdversePts = Math.max(out.maxAdversePts, adv); out.maxPositionDrawdown = Math.max(out.maxPositionDrawdown, giveback);
        const a = i + 1 > atrLen ? atr(candles.slice(0, i + 1), atrLen) : null;
        const market = analyseMarket(candles.slice(Math.max(0, i + 1 - 120), i + 1));
        let dis = 0; for (let j = i; j >= 0; j--) { const r = rows[j]; if (r.c1 !== "none" && r.c2 !== "none" && r.c1 !== r.c2) dis++; else break; }
        const rel = relation(pos.side, rows[i].c1, rows[i].c2);
        const assessment = assess({ side: pos.side, nowMs: c.ts, market, metrics: { currentAdverse: Math.max(0, adv), peakPnl, giveback, adverseCandles: adverseStreak, perPoint }, dsb: { agreeAgainst: rel === "opposite", disagreeCandles: dis }, health: { reliable: !unhealthy, causes: unhealthy ? [unhealthy.cause] : [] }, completeness: { candle: "FULL", live: "FULL", origin: "observed_from_entry" } }, assessCfg);
        out.riskEvents.push(...ev.process("sim", assessment));
        if (unhealthy || !a || !(a > 0)) { out.unknownBars++; out.states.push({ ts: c.ts, state: "UNKNOWN" }); last = c; continue; }   // frozen & UNKNOWN: unreliable time is never credited to a state
        const r = step(m, { adverseAtr: Math.max(0, adv) / a, adverseCandles: adverseStreak, disagreeCandles: dis, oppositeAgree: rel === "opposite" }, riskCfg); m = r.machine; out.evaluated++;
        if (r.transition) out.transitions.push({ ts: c.ts, ...r.transition });
        out.states.push({ ts: c.ts, state: m.state, classification: assessment.classification }); last = c;
    }
    const finalPnl = last ? (long ? (last.close - entryFill) : (entryFill - last.close)) * perPoint - slippagePts * perPoint : null;   // exit slippage adverse too
    const rank = { NORMAL: 0, RECOVERY: 0, WATCH: 1, DANGER: 2 }; const worst = out.states.reduce((w, s) => (s.state !== "UNKNOWN" && rank[s.state] > rank[w] ? s.state : w), "NORMAL");
    return { label, worstState: worst, finalPnl, ...out, states: out.states, limitations: LIMITS };
}

// Baseline (candles untouched) vs scenario (same pipeline). Reports sensitivity deltas. The input candles are never modified.
function stressPosition(pos, candles, steps, scenarioSteps, opts) {
    const base = runPipeline(pos, candles, { ...opts, steps, label: "HISTORICAL_REPLAY" });
    const sc = applyScenario(candles, scenarioSteps, { side: pos.side });
    const sim = runPipeline(pos, sc.candles, { ...opts, steps, health: sc.health, restarts: sc.restarts, slippagePts: sc.slippagePts, label: "SIMULATED" });
    const d = (a, b) => (a === null || b === null ? null : b - a);
    return { label: "SIMULATED", scenario: sc.applied, baseline: base, simulated: sim, missingCandlesRemoved: sc.missingTs.length,
        sensitivity: { finalPnl: d(base.finalPnl, sim.finalPnl), maxAdversePts: sim.maxAdversePts - base.maxAdversePts, maxGiveback: sim.maxGiveback - base.maxGiveback, worstState: { baseline: base.worstState, simulated: sim.worstState }, unknownBars: sim.unknownBars - base.unknownBars, riskEvents: sim.riskEvents.length - base.riskEvents.length, transitions: sim.transitions.length - base.transitions.length },
        limitations: LIMITS };
}

// Portfolio stress: every position gets the same scenario; aggregate P&L and drawdown are rebuilt on the shared time axis.
function stressPortfolio(items, scenarioSteps, opts) {
    const per = items.map(it => ({ key: it.key, engine: it.engine, instrument: it.instrument, ...stressPosition(it.pos, it.candles, it.steps, scenarioSteps, opts) }));
    const axis = [...new Set(per.flatMap(p => p.simulated.pnlPath.map(x => x.ts)))].sort((a, b) => a - b);
    const mk = which => { const dd = createDrawdownTracker(), last = new Map(); for (const ts of axis) { let total = 0, complete = true; const contrib = {}; for (const p of per) { const pt = p[which].pnlPath.find(x => x.ts === ts); if (pt) last.set(p.key, pt.pnl); const v = last.get(p.key); if (v === undefined) { continue; } total += v; contrib[p.engine] = (contrib[p.engine] || 0) + v; } dd.update(ts, { pnl: total, complete, contributions: contrib }); } return dd.state(); };
    return { label: "SIMULATED", positions: per, portfolio: { baseline: mk("baseline"), simulated: mk("simulated") }, limitations: LIMITS };
}

// Deterministic chronological replay of a (loaded) observer history. Real candles, real positions, NO scenario: label HISTORICAL_REPLAY.
function replayHistory(history, { steps, riskCfg, from = -Infinity, to = Infinity, perPoint = 1, ...opts }) {
    const candles = (history.candles || []).slice().sort((a, b) => a.ts - b.ts);
    const healthIv = []; let open = null;   // unhealthy REST intervals preserved from recorded HEALTH events
    for (const e of (history.events || []).slice().sort((a, b) => a.ts - b.ts || a.id - b.id)) if (e.kind === "HEALTH" && e.detail && e.detail.dim === "rest") { if (e.to !== "HEALTHY" && !open) open = e.ts; else if (e.to === "HEALTHY" && open !== null) { healthIv.push({ fromTs: open, toTs: e.ts, cause: "rest" }); open = null; } }
    if (open !== null) healthIv.push({ fromTs: open, toTs: Infinity, cause: "rest" });
    const results = [];
    for (const p of (history.positions || []).slice().sort((a, b) => a.entryTs - b.entryTs || a.id - b.id)) {
        if (!(p.entryTs >= from && p.entryTs <= to)) continue;
        const endTs = p.closedAt ?? (candles.length ? candles[candles.length - 1].ts + 1 : p.entryTs);
        const partial = p.origin !== "observed_from_entry" && p.origin != null;
        results.push({ id: p.id, status: p.closedAt != null ? "CLOSED" : "OPEN", completeness: partial ? "PARTIAL" : "FULL", result: runPipeline({ side: p.side, entryPrice: p.entryPrice, entryTs: p.entryTs, endTs, perPoint: (p.metrics && p.metrics.perPoint) || perPoint }, candles, { ...opts, steps, riskCfg, health: healthIv, label: "HISTORICAL_REPLAY" }) });
    }
    return { label: "HISTORICAL_REPLAY", range: { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null }, positions: results, healthIntervals: healthIv.length, limitations: LIMITS };
}
module.exports = { runPipeline, stressPosition, stressPortfolio, replayHistory, LIMITS, aggregate };
