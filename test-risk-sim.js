// test-risk-sim.js — Phase 5: deterministic replay, stress scenarios, isolation. Synthetic fixtures only. Run: node test-risk-sim.js
"use strict";
const assert = require("assert"), fs = require("fs"), path = require("path");
const { applyScenario, SCENARIO_TYPES } = require("./riskObserver/sim/scenarios");
const { stressPosition, stressPortfolio, replayHistory, runPipeline } = require("./riskObserver/sim/simulate");
const base = require("./riskObserver/observer");
const cfg = base.resolveParams(require("./engineConfig"), {});
let passed = 0; const t = (n, f) => { f(); passed++; console.log("ok  -", n); };
const TF = 900000, T0 = Date.UTC(2026, 9, 26, 4, 0);
const series = (n, f = i => 100 + Math.sin(i / 4) * 0.6) => Array.from({ length: n }, (_, i) => { const o = i ? f(i - 1) : f(0), c = f(i); return { ts: T0 + i * TF, open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c }; });
const CS = series(120), steps = [0.5, 1], POS = { side: "LONG", entryPrice: 100, entryTs: T0 + 50 * TF, endTs: T0 + 110 * TF, perPoint: 10 };
const opts = { riskCfg: cfg.riskCfg || cfg, atrLen: 10 };
const rc = cfg.riskCfg || cfg;
const run = (sc, pos = POS, cs = CS) => stressPosition(pos, cs, steps, sc, { riskCfg: rc, atrLen: 10 });

t("deterministic replay: same input twice => byte-identical output; input candles are never mutated", () => {
    const snap = JSON.stringify(CS); const a = run([{ type: "adverse_gap", atIndex: 60, points: 3 }]), b = run([{ type: "adverse_gap", atIndex: 60, points: 3 }]);
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b)); assert.strictEqual(JSON.stringify(CS), snap);
});
t("chronological processing: states and P&L path are in strictly ascending time and stay inside [entry, end)", () => {
    const r = run([]).baseline; for (let i = 1; i < r.states.length; i++) assert(r.states[i].ts > r.states[i - 1].ts); assert(r.states[0].ts >= POS.entryTs && r.states[r.states.length - 1].ts < POS.endTs);
    for (let i = 1; i < r.pnlPath.length; i++) assert(r.pnlPath[i].ts > r.pnlPath[i - 1].ts);
});
t("results are labelled: baseline HISTORICAL_REPLAY, scenario SIMULATED, limitations present", () => {
    const r = run([{ type: "adverse_gap", atIndex: 60, points: 3 }]); assert.strictEqual(r.label, "SIMULATED"); assert.strictEqual(r.baseline.label, "HISTORICAL_REPLAY"); assert.strictEqual(r.simulated.label, "SIMULATED"); assert(r.limitations.some(l => /tick/.test(l)) && r.limitations.some(l => /Candle-close/.test(l)));
});
t("adverse gap: a LONG gapped down worsens max adverse / P&L and escalates risk; a SHORT is gapped UP (direction-aware)", () => {
    const r = run([{ type: "adverse_gap", atIndex: 60, points: 5 }]); assert(r.sensitivity.maxAdversePts >= 4.5, String(r.sensitivity.maxAdversePts)); assert(r.sensitivity.finalPnl < 0); assert(["WATCH", "DANGER"].includes(r.simulated.worstState), r.simulated.worstState);
    const s = run([{ type: "adverse_gap", atIndex: 60, points: 5 }], { ...POS, side: "SHORT" }); assert(s.sensitivity.maxAdversePts >= 4.5); const gapped = applyScenario(CS, [{ type: "adverse_gap", atIndex: 60, points: 5 }], { side: "SHORT" }).candles; assert(gapped[70].close > CS[70].close);
});
t("slippage: costs exactly 2x points x perPoint (entry and exit), changes nothing else", () => {
    const r = run([{ type: "slippage", points: 0.5 }]); assert(Math.abs(r.sensitivity.finalPnl - (-0.5 * 2 * POS.perPoint)) < 1e-9, String(r.sensitivity.finalPnl)); assert.strictEqual(r.sensitivity.unknownBars, 0);
});
t("volatility expansion raises Phase-3 risk events relative to baseline", () => {
    const r = run([{ type: "volatility_expansion", fromIndex: 70, factor: 4 }]); assert(r.sensitivity.riskEvents > 0 || r.simulated.riskEvents.some(e => e.kind === "VOLATILITY_EXPANSION" || e.kind === "ABNORMAL_MARKET_MOVEMENT"), JSON.stringify(r.simulated.riskEvents.map(e => e.kind)));
});
t("missing market data: delayed data / REST failure / WS interruption make bars UNKNOWN — frozen, never credited to a state", () => {
    for (const s of [{ type: "delayed_data", fromIndex: 70, bars: 10 }, { type: "rest_failure", fromIndex: 70, bars: 10 }, { type: "ws_interruption", fromIndex: 70, bars: 10 }]) {
        const r = run([s]); assert.strictEqual(r.sensitivity.unknownBars, 10, s.type); const u = r.simulated.states.filter(x => x.state === "UNKNOWN"); assert.strictEqual(u.length, 10); assert(r.simulated.riskEvents.some(e => e.kind === "DATA_UNRELIABLE" && e.lifecycle === "OPEN"));
    }
});
t("missing candles are removed from the series (gap in time), original series untouched", () => {
    const r = applyScenario(CS, [{ type: "missing_candles", indices: [60, 61, 62] }], {}); assert.strictEqual(r.candles.length, CS.length - 3); assert.strictEqual(r.missingTs.length, 3); assert.strictEqual(CS.length, 120); assert.doesNotThrow(() => run([{ type: "missing_candles", indices: [60, 61, 62] }]));
});
t("observer restart during an open position: machine memory resets, run completes, restart is counted", () => {
    const r = run([{ type: "adverse_gap", atIndex: 55, points: 4 }, { type: "observer_restart", atIndex: 75 }]); assert.strictEqual(r.simulated.restartsApplied, 1); assert(r.simulated.states.length > 0);
    const ts = CS[75].ts; const after = r.simulated.transitions.filter(x => x.ts >= ts); assert(!after.some(x => x.from !== "NORMAL" && x.ts === ts), "no carried-over state on the restart candle");
});
t("rapid reversal and sideways scenarios run and are direction-aware", () => {
    const a = run([{ type: "rapid_reversal", atIndex: 60, pointsPerBar: 1.5, length: 4 }]); assert(a.sensitivity.maxAdversePts > 3); const b = run([{ type: "sideways", fromIndex: 60, length: 20, amplitude: 0.3 }]); assert.strictEqual(b.label, "SIMULATED");
});
t("unknown scenario types are rejected loudly (no silent no-op)", () => { assert.throws(() => applyScenario(CS, [{ type: "moon_landing" }], {}), /unknown scenario/); assert(SCENARIO_TYPES.length >= 10); });
t("portfolio stress: aggregate P&L/drawdown rebuilt on the shared axis; simulated worse than baseline for a gap", () => {
    const items = [{ key: "Z#1", engine: "ZINC", instrument: "ZINC", pos: POS, candles: CS, steps }, { key: "N#1", engine: "NG", instrument: "NG", pos: { ...POS, perPoint: 5 }, candles: series(120, i => 200 + Math.cos(i / 5)), steps }];
    items[1].pos.entryPrice = 200;
    const r = stressPortfolio(items, [{ type: "adverse_gap", atIndex: 60, points: 4 }], { riskCfg: rc, atrLen: 10 }); assert.strictEqual(r.label, "SIMULATED"); assert.strictEqual(r.positions.length, 2); assert(r.portfolio.simulated.maxDrawdown > r.portfolio.baseline.maxDrawdown, JSON.stringify([r.portfolio.baseline.maxDrawdown, r.portfolio.simulated.maxDrawdown]));
});
t("replayHistory: real positions replayed chronologically within a date range; PARTIAL origin is flagged; health events preserved", () => {
    const hist = { candles: CS, positions: [{ id: 2, side: "LONG", entryPrice: 100, entryTs: T0 + 60 * TF, closedAt: T0 + 100 * TF, origin: "discovered_after_entry", metrics: { perPoint: 10 } }, { id: 1, side: "LONG", entryPrice: 100, entryTs: T0 + 30 * TF, closedAt: T0 + 50 * TF, origin: "observed_from_entry", metrics: { perPoint: 10 } }],
        events: [{ id: 1, ts: T0 + 35 * TF, kind: "HEALTH", to: "STALE", detail: { dim: "rest" } }, { id: 2, ts: T0 + 40 * TF, kind: "HEALTH", to: "HEALTHY", detail: { dim: "rest" } }] };
    const r = replayHistory(hist, { steps, riskCfg: rc, atrLen: 10 }); assert.deepStrictEqual(r.positions.map(p => p.id), [1, 2]); assert.strictEqual(r.positions[1].completeness, "PARTIAL"); assert.strictEqual(r.healthIntervals, 1); assert(r.positions[0].result.unknownBars >= 5, String(r.positions[0].result.unknownBars));
    const sub = replayHistory(hist, { steps, riskCfg: rc, atrLen: 10, from: T0 + 55 * TF }); assert.deepStrictEqual(sub.positions.map(p => p.id), [2]); assert.strictEqual(r.label, "HISTORICAL_REPLAY");
});
t("no future leakage: truncating the candles after a bar does not change any state at or before it", () => {
    const full = runPipeline(POS, CS, { steps, riskCfg: rc, label: "x" }), cut = CS.slice(0, 85), part = runPipeline({ ...POS, endTs: T0 + 85 * TF }, cut, { steps, riskCfg: rc, label: "x" });
    for (const s of part.states) assert.deepStrictEqual(full.states.find(x => x.ts === s.ts), s);
});
t("ISOLATION: simulation modules import only pure analysis code — no broker, orders, positions, sockets, sqlite, fs or env", () => {
    const dir = path.join(__dirname, "riskObserver/sim"); for (const f of fs.readdirSync(dir)) {
        const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\/.*$/gm, ""); const reqs = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
        for (const r of reqs) assert(/^\.\.?\/(\.\.\/indicators|riskState|dsbMonitor|intel\/|portfolio\/|scenarios|\.\.\/riskState|\.\.\/dsbMonitor|\.\.\/intel\/|\.\.\/portfolio\/)/.test(r) || r === "../../indicators", `${f} requires ${r}`);
        assert(!/\b(kiteconnect|KiteConnect|placeOrder|cancelOrder|modifyOrder|slStore|sqlite3?|child_process|process\.env|WebSocket|require\(\s*[\"']fs[\"']\s*\)|Date\.now|Math\.random)\b/.test(src.replace(/"[^"]*"/g, "")), `${f} references execution/IO`);
    }
});
console.log(`\n${passed} simulation scenarios passed`);
