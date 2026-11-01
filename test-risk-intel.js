// test-risk-intel.js — Phase 3: market-condition analysis, deterioration assessment, risk-event lifecycle.
// Synthetic fixtures only. Run: node test-risk-intel.js
"use strict";
const assert = require("assert");
const { analyseMarket } = require("./riskObserver/intel/marketCondition");
const { assess, KINDS } = require("./riskObserver/intel/assess");
const { createRiskEventEngine } = require("./riskObserver/intel/riskEvents");
let passed = 0; const t = (n, f) => { f(); passed++; console.log("ok  -", n); };
const TF = 900000;
function bars(n, fn) { const out = []; let p = 100; for (let i = 0; i < n; i++) { const r = fn(i, p); p = r.close; out.push({ ts: i * TF, ...r }); } return out; }
const calm = n => bars(n, (i, p) => { const c = p + Math.sin(i / 2) * 0.1; return { open: p, high: Math.max(p, c) + 0.2, low: Math.min(p, c) - 0.2, close: c }; });
const mk = (cs, over = {}) => ({ side: "LONG", nowMs: 1e12, market: analyseMarket(cs), metrics: {}, dsb: {}, health: { reliable: true, causes: [] }, completeness: { candle: "FULL", live: "FULL", origin: "observed_from_entry" }, ...over });
const kinds = a => a.events.map(e => e.kind);

t("calm market: LOW classification, no real risk events, explanation present", () => {
    const a = assess(mk(calm(80))); assert.strictEqual(a.classification, "LOW"); assert.deepStrictEqual(kinds(a), []); assert(a.explanation.length > 10); assert.strictEqual(a.evidenceQuality, "FULL"); assert.strictEqual(a.informational, true);
});
t("volatility expansion: sudden range growth raises VOLATILITY_EXPANSION with evidence", () => {
    const cs = calm(60).concat(bars(8, (i, p) => ({ open: p, high: p + 2.5, low: p - 2.5, close: p + (i % 2 ? 1.5 : -1.5) }))); for (let i = 60; i < cs.length; i++) cs[i].ts = i * TF;
    const m = analyseMarket(cs); assert(m.atrRatio > 1.5, "atrRatio " + m.atrRatio); const a = assess(mk(cs)); assert(kinds(a).includes("VOLATILITY_EXPANSION")); assert(a.events.find(e => e.kind === "VOLATILITY_EXPANSION").evidence.atrRatio > 1.5); assert.notStrictEqual(a.classification, "LOW");
});
t("abnormal single-candle move is flagged HIGH", () => {
    const cs = calm(60); const p = cs[59].close; cs.push({ ts: 60 * TF, open: p, high: p + 6, low: p - 0.2, close: p + 5.8 });
    const a = assess(mk(cs)); assert(kinds(a).includes("ABNORMAL_MARKET_MOVEMENT")); assert.strictEqual(a.classification, "HIGH");
});
t("trend deterioration: DSB agreeing against the position", () => {
    const a = assess(mk(calm(60), { dsb: { agreeAgainst: true, disagreeCandles: 0 } })); assert(kinds(a).includes("TREND_DETERIORATION")); assert.strictEqual(a.classification, "ELEVATED");
});
t("trend deterioration: consecutive closes against a LONG with real ADX", () => {
    const up = bars(50, (i, p) => ({ open: p, high: p + 0.6, low: p - 0.1, close: p + 0.5 })); const down = bars(10, (i, p) => ({ open: p, high: p + 0.1, low: p - 0.6, close: p - 0.5 })); const cs = up.concat(down.map((c, i) => c)); for (let i = 0; i < cs.length; i++) cs[i].ts = i * TF;
    for (let i = 50; i < cs.length; i++) { cs[i].open = cs[i - 1].close; cs[i].close = cs[i].open - 0.5; cs[i].high = cs[i].open + 0.1; cs[i].low = cs[i].close - 0.1; }
    const m = analyseMarket(cs); assert.strictEqual(m.persistence.runDir, "DOWN"); const a = assess(mk(cs)); assert(kinds(a).includes("TREND_DETERIORATION"), JSON.stringify(m.persistence) + " adx=" + m.adx);
    assert(!kinds(assess(mk(cs, { side: "SHORT" }))).includes("TREND_DETERIORATION"), "a SHORT must not see a down-run as deterioration");
});
t("trend exhaustion: stretched RSI in favour + falling ADX (and not for the wrong side)", () => {
    const market = { status: "OK", atr: 1, atrRatio: 1, rangeAtr: 1, adx: 32, adxChange: -5, chop: 40, rsi: 82, persistence: { runBars: 1, runDir: "UP" } };
    const a = assess({ ...mk(calm(60)), market }); assert(kinds(a).includes("TREND_EXHAUSTION")); assert(!kinds(assess({ ...mk(calm(60)), market, side: "SHORT" })).includes("TREND_EXHAUSTION"));
    assert(!kinds(assess({ ...mk(calm(60)), market: { ...market, adxChange: +2 } })).includes("TREND_EXHAUSTION"), "rising ADX is not exhaustion");
});
t("adverse movement needs BOTH magnitude and persistence", () => {
    const base = mk(calm(60)); const atr = base.market.atr;
    assert(kinds(assess({ ...base, metrics: { currentAdverse: 1.2 * atr, adverseCandles: 2 } })).includes("ADVERSE_MOVEMENT"));
    assert(!kinds(assess({ ...base, metrics: { currentAdverse: 1.2 * atr, adverseCandles: 1 } })).includes("ADVERSE_MOVEMENT"));
    assert.strictEqual(assess({ ...base, metrics: { currentAdverse: 2.5 * atr, adverseCandles: 3 } }).classification, "HIGH");
});
t("profit giveback event with fraction evidence; tiny peaks ignored", () => {
    const base = mk(calm(60)), atr = base.market.atr;
    const a = assess({ ...base, metrics: { peakPnl: 10 * atr, giveback: 6 * atr, perPoint: 1 } }); const e = a.events.find(x => x.kind === "PROFIT_GIVEBACK"); assert(e && Math.abs(e.evidence.givebackFraction - 0.6) < 1e-9);
    assert(!kinds(assess({ ...base, metrics: { peakPnl: 0.1 * atr, giveback: 0.09 * atr, perPoint: 1 } })).includes("PROFIT_GIVEBACK"));
});
t("insufficient evidence => UNKNOWN (never LOW), quality NONE, reason stated", () => {
    const a = assess(mk(calm(10))); assert.strictEqual(a.classification, "UNKNOWN"); assert.strictEqual(a.evidenceQuality, "NONE"); assert(/insufficient/.test(a.explanation));
    const m = analyseMarket(null); assert.strictEqual(m.status, "INSUFFICIENT");
    const bad = calm(60); bad[30].ts = bad[29].ts; assert.strictEqual(analyseMarket(bad).status, "INSUFFICIENT", "duplicate/disordered candles are rejected, not repaired");
    const nan = calm(60); nan[10].high = NaN; assert.strictEqual(analyseMarket(nan).status, "INSUFFICIENT");
});
t("data-health interruption => UNKNOWN + DATA_UNRELIABLE, and no risk events are fabricated from stale data", () => {
    const a = assess(mk(calm(60), { health: { reliable: false, causes: ["ltp"] }, metrics: { currentAdverse: 99, adverseCandles: 9 }, dsb: { agreeAgainst: true } }));
    assert.strictEqual(a.classification, "UNKNOWN"); assert.deepStrictEqual(kinds(a), ["DATA_UNRELIABLE"]); assert(/unreliable/.test(a.explanation));
});
t("partial position history is surfaced as POSITION_RECONCILIATION_WARNING and lowers evidence quality", () => {
    const a = assess(mk(calm(60), { completeness: { candle: "FULL", live: "PARTIAL", origin: "discovered_after_entry", notes: ["entered earlier"] } })); assert(kinds(a).includes("POSITION_RECONCILIATION_WARNING")); assert.strictEqual(a.evidenceQuality, "PARTIAL"); assert.strictEqual(a.classification, "LOW");
});
t("every emitted kind belongs to the defined event model; every event is informational", () => {
    const base = mk(calm(60)); const a = assess({ ...base, dsb: { agreeAgainst: true }, metrics: { currentAdverse: 3 * base.market.atr, adverseCandles: 4, peakPnl: 9, giveback: 8, perPoint: 1 }, completeness: { candle: "PARTIAL", live: "PARTIAL", origin: "uncertain" } });
    for (const e of a.events) { assert(KINDS.includes(e.kind)); assert.strictEqual(e.informational, true); assert(e.explanation && e.evidence); }
});
t("assess is pure/deterministic and never mutates its input", () => {
    const i = mk(calm(60), { metrics: { currentAdverse: 1, adverseCandles: 2 } }), snap = JSON.stringify(i); const a = assess(i), b = assess(i); assert.deepStrictEqual(a, b); assert.strictEqual(JSON.stringify(i), snap);
});

// ── lifecycle engine ──
const A = (ts, evs, cls = "ELEVATED") => ({ ts, classification: cls, events: evs.map(([kind, severity]) => ({ kind, severity, evidence: { x: 1 }, explanation: "e", informational: true })) });
t("deduplication: a persisting condition emits OPEN once, not on every evaluation", () => {
    const eng = createRiskEventEngine(), got = []; for (let i = 0; i < 6; i++) got.push(...eng.process("Z#1", A(i, [["ADVERSE_MOVEMENT", "WARNING"]])));
    assert.strictEqual(got.length, 1); assert.strictEqual(got[0].lifecycle, "OPEN"); assert.strictEqual(got[0].informational, true);
});
t("severity change emits UPDATE; clearing needs consecutive absence (hysteresis); then CLEAR once", () => {
    const eng = createRiskEventEngine({ clearAfter: 2 }); const g = [];
    g.push(...eng.process("Z#1", A(1, [["PROFIT_GIVEBACK", "WARNING"]]))); g.push(...eng.process("Z#1", A(2, [["PROFIT_GIVEBACK", "HIGH"]])));
    g.push(...eng.process("Z#1", A(3, [], "LOW"))); assert.deepStrictEqual(g.map(x => x.lifecycle), ["OPEN", "UPDATE"], "one absent evaluation must not clear");
    g.push(...eng.process("Z#1", A(4, [["PROFIT_GIVEBACK", "HIGH"]]))); g.push(...eng.process("Z#1", A(5, [], "LOW"))); g.push(...eng.process("Z#1", A(6, [], "LOW"))); g.push(...eng.process("Z#1", A(7, [], "LOW")));
    assert.deepStrictEqual(g.map(x => x.lifecycle), ["OPEN", "UPDATE", "CLEAR"]); assert.strictEqual(g[1].previousSeverity, "WARNING");
});
t("an UNKNOWN assessment neither confirms nor clears real risk events (no certainty from missing data)", () => {
    const eng = createRiskEventEngine({ clearAfter: 1 }); eng.process("Z#1", A(1, [["ADVERSE_MOVEMENT", "HIGH"]], "HIGH"));
    const g = []; for (let i = 2; i < 8; i++) g.push(...eng.process("Z#1", A(i, [["DATA_UNRELIABLE", "WARNING"]], "UNKNOWN")));
    assert(!g.some(x => x.kind === "ADVERSE_MOVEMENT"), "real event was cleared by missing data"); assert(eng.activeKinds("Z#1").includes("ADVERSE_MOVEMENT"));
});
t("events are per position and per kind; closing a position clears only its own events", () => {
    const eng = createRiskEventEngine(); eng.process("Z#1", A(1, [["ADVERSE_MOVEMENT", "WARNING"]])); eng.process("N#1", A(1, [["ADVERSE_MOVEMENT", "WARNING"]]));
    const c = eng.closePosition("Z#1", 5); assert.strictEqual(c.length, 1); assert.strictEqual(c[0].posKey, "Z#1"); assert.deepStrictEqual(eng.activeKinds("N#1"), ["ADVERSE_MOVEMENT"]);
});
t("persistence failures (sync throw or async reject) are contained and counted", async () => {
    let unhandled = 0; const h = () => unhandled++; process.on("unhandledRejection", h);
    const e1 = createRiskEventEngine({ persist: () => { throw new Error("disk"); } }); assert.doesNotThrow(() => e1.process("Z#1", A(1, [["ADVERSE_MOVEMENT", "WARNING"]]))); assert.strictEqual(e1.stats().persistErrors, 1);
    const e2 = createRiskEventEngine({ persist: () => Promise.reject(new Error("io")) }); e2.process("Z#1", A(1, [["ADVERSE_MOVEMENT", "WARNING"]])); setTimeout(() => { assert.strictEqual(e2.stats().persistErrors, 1); assert.strictEqual(unhandled, 0); process.removeListener("unhandledRejection", h); }, 20);
});
t("cooldown suppresses immediate re-open flapping", () => {
    const eng = createRiskEventEngine({ clearAfter: 1, cooldownMs: 10 }); const g = [];
    g.push(...eng.process("Z#1", A(1, [["VOLATILITY_EXPANSION", "WARNING"]]))); g.push(...eng.process("Z#1", A(2, [], "LOW"))); g.push(...eng.process("Z#1", A(3, [["VOLATILITY_EXPANSION", "WARNING"]]))); g.push(...eng.process("Z#1", A(20, [["VOLATILITY_EXPANSION", "WARNING"]])));
    assert.deepStrictEqual(g.map(x => x.lifecycle), ["OPEN", "CLEAR", "OPEN"]);
});
setTimeout(() => { console.log(`\n${passed} intelligence scenarios passed`); process.exit(0); }, 60);
