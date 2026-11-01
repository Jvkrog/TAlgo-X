// test-risk-portfolio.js — Phase 4: aggregate exposure, concentration, drawdown, correlation. Synthetic fixtures only.
"use strict";
const assert = require("assert");
const { aggregate, createDrawdownTracker, correlation, sharedRisk } = require("./riskObserver/portfolio/aggregate");
let passed = 0; const t = (n, f) => { f(); passed++; console.log("ok  -", n); };
const P = (o) => ({ engine: "ZINC", instrument: "ZINC", layer: "FAST", id: 1, side: "LONG", lastPrice: 100, perPoint: 10, pnl: 100, pnlSource: "broker", reliable: true, ...o });

t("multiple instruments: gross is the sum of absolute notionals; net is reported PER instrument, pooled net flagged not meaningful", () => {
    const a = aggregate([P({}), P({ instrument: "NG", engine: "NG", side: "SHORT", lastPrice: 200, perPoint: 5, id: 2, pnl: -20 })]);
    assert.strictEqual(a.gross.value, 1000 + 1000); assert.strictEqual(a.netPooled.meaningful, false); assert(a.netPooled.note);
    assert.deepStrictEqual(a.netByInstrument.map(x => [x.instrument, x.direction]).sort(), [["NG", "SHORT"], ["ZINC", "LONG"]]); assert.strictEqual(a.gross.provenance, "estimate");
});
t("multiple engines + FAST/SLOW layers aggregate separately and add up", () => {
    const a = aggregate([P({ layer: "FAST", id: 1 }), P({ layer: "SLOW", id: 2, side: "SHORT" }), P({ engine: "NG", instrument: "NG", layer: "FAST", id: 3, lastPrice: 50, perPoint: 20 })]);
    assert.strictEqual(a.byEngine.length, 2); assert.strictEqual(a.byLayer.find(l => l.key === "FAST").positions, 2); assert.strictEqual(a.byLayer.find(l => l.key === "SLOW").positions, 1);
    assert.strictEqual(a.byEngine.reduce((s, g) => s + g.gross, 0), a.gross.value);
});
t("same instrument LONG + SHORT: net is meaningful and offsets; gross does not", () => {
    const a = aggregate([P({ id: 1 }), P({ id: 2, side: "SHORT", layer: "SLOW" })]); assert.strictEqual(a.gross.value, 2000); assert.strictEqual(a.netPooled.value, 0); assert.strictEqual(a.netPooled.meaningful, true); assert.strictEqual(a.netByInstrument[0].direction, "FLAT");
});
t("concentration: single instrument = HIGH (HHI 1); diversified = LOW; shares sum to 1", () => {
    assert.strictEqual(aggregate([P({})]).concentration.level, "HIGH");
    const d = aggregate([P({}), P({ instrument: "NG", id: 2 }), P({ instrument: "USDINR", id: 3 }), P({ instrument: "X", id: 4 })]); assert.strictEqual(d.concentration.level, "LOW"); assert(Math.abs(d.byInstrument.reduce((s, g) => s + g.share, 0) - 1) < 1e-12);
});
t("duplicate position prevention: the same (engine, instrument, layer, id) is counted once and reported", () => {
    const a = aggregate([P({}), P({}), P({ id: 2 })]); assert.strictEqual(a.positions, 2); assert.strictEqual(a.duplicatesRejected.length, 1); assert.strictEqual(a.gross.value, 2000);
});
t("malformed / unreliable positions are excluded from totals and listed — never guessed", () => {
    const a = aggregate([P({}), P({ id: 2, lastPrice: null }), P({ id: 3, reliable: false }), { side: "SIDEWAYS" }, null]);
    assert.strictEqual(a.reliablePositions, 1); assert.strictEqual(a.unreliable.length, 2); assert.strictEqual(a.duplicatesRejected.filter(d => d.reason === "malformed").length, 2); assert.strictEqual(a.pnl.complete, false); assert.strictEqual(a.pnl.value, null);
});
t("provenance: broker-reported vs estimated P&L is labelled; capital utilisation only with a supplied capital", () => {
    assert.strictEqual(aggregate([P({})]).pnl.provenance, "broker"); assert.strictEqual(aggregate([P({ pnlSource: "estimate" })]).pnl.provenance, "estimate");
    assert.strictEqual(aggregate([P({})]).capitalUtilisation.value, null); const c = aggregate([P({})], { value: 10000, source: "configured" }).capitalUtilisation; assert.strictEqual(c.value, 0.1); assert.strictEqual(c.capitalSource, "configured");
});
t("empty portfolio is well-defined (zeros, UNKNOWN concentration, no NaN)", () => {
    const a = aggregate([]); assert.strictEqual(a.gross.value, 0); assert.strictEqual(a.concentration.level, "UNKNOWN"); assert(!/NaN|undefined/.test(JSON.stringify(a))); assert.doesNotThrow(() => aggregate(undefined));
});
t("aggregate drawdown: peak, current drawdown, max drawdown and engine contributions", () => {
    const d = createDrawdownTracker(); d.update(1, { pnl: 100, complete: true, contributions: { Z: 100 } }); d.update(2, { pnl: 400, complete: true, contributions: { Z: 300, N: 100 } }); const r = d.update(3, { pnl: 150, complete: true, contributions: { Z: 200, N: -50 } });
    assert.strictEqual(r.peak, 400); assert.strictEqual(r.drawdown, 250); const s = d.state(); assert.strictEqual(s.maxDrawdown, 250); assert.deepStrictEqual(s.current.contributions, { Z: 200, N: -50 });
    d.update(4, { pnl: 500, complete: true }); assert.strictEqual(d.state().current.drawdown, 0); assert.strictEqual(d.state().maxDrawdown, 250);
});
t("drawdown ignores unknown samples (no fake peak/recovery) and rejects out-of-order time", () => {
    const d = createDrawdownTracker(); d.update(1, { pnl: 100, complete: true }); d.update(2, { pnl: 9999, complete: false }); d.update(3, { pnl: null, complete: true });
    assert.strictEqual(d.state().peak, 100); assert.strictEqual(d.state().unknownSamples, 2); assert.strictEqual(d.update(1, { pnl: 1, complete: true }).accepted, false); assert.strictEqual(d.update(NaN, { pnl: 1, complete: true }).accepted, false);
});
const series = (n, f, skip = () => false) => { const o = []; for (let i = 0; i < n; i++) if (!skip(i)) o.push({ ts: i * 900000, close: f(i) }); return o; };
const wobble = i => 100 + Math.sin(i / 3) * 3 + Math.sin(i * 1.7) * 0.5;
t("correlation: identical movement ≈ +1, mirror ≈ -1, with overlap and a limitation note", () => {
    const a = series(80, wobble), b = series(80, i => 50 + (wobble(i) - 100) / 2), c = series(80, i => 200 - (wobble(i) - 100));
    const r1 = correlation(a, b), r2 = correlation(a, c); assert.strictEqual(r1.status, "OK"); assert(r1.value > 0.99, String(r1.value)); assert(r2.value < -0.9, String(r2.value)); assert(/causation/.test(r1.note)); assert(r1.overlap >= 79);
});
t("correlation with missing data: asynchronous / thin overlap => INSUFFICIENT, no invented value", () => {
    const a = series(80, wobble), b = series(80, wobble, i => i % 2 === 0); const r = correlation(a, b); assert.strictEqual(r.status, "INSUFFICIENT"); assert.strictEqual(r.value, undefined); assert(/asynchronous|missing/.test(r.reason));
    assert.strictEqual(correlation(series(10, wobble), series(10, wobble)).status, "INSUFFICIENT"); assert.strictEqual(correlation(null, undefined).status, "INSUFFICIENT"); assert.strictEqual(correlation(series(80, () => 5), series(80, wobble)).status, "INSUFFICIENT");
});
t("shared risk: strongly correlated same-way positions COMPOUND, opposite OFFSET, unmeasured pairs are UNKNOWN", () => {
    const rows = aggregate([P({}), P({ instrument: "NG", engine: "NG", id: 2 })]).byInstrument.length; assert.strictEqual(rows, 2);
    const mk = (side2) => { const a = aggregate([P({}), P({ instrument: "NG", engine: "NG", id: 2, side: side2 })]); return a; };
    const rowsOf = side2 => [{ instrument: "ZINC", sign: 1, notional: 1000 }, { instrument: "NG", sign: side2 === "LONG" ? 1 : -1, notional: 1000 }];
    const corr = { "ZINC|NG": { status: "OK", value: 0.9, overlap: 80, note: "n" } };
    assert.strictEqual(sharedRisk(rowsOf("LONG"), corr)[0].effect, "COMPOUNDING"); assert.strictEqual(sharedRisk(rowsOf("SHORT"), corr)[0].effect, "OFFSETTING");
    assert.strictEqual(sharedRisk(rowsOf("LONG"), {})[0].status, "UNKNOWN"); assert.strictEqual(sharedRisk(rowsOf("LONG"), { "ZINC|NG": { status: "OK", value: 0.2, overlap: 80 } }).length, 0);
    assert.strictEqual(sharedRisk(rowsOf("LONG"), { "NG|ZINC": { status: "INSUFFICIENT", reason: "thin" } })[0].status, "UNKNOWN"); void mk;
});
t("module is pure: no I/O or trading imports", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "riskObserver/portfolio/aggregate.js"), "utf8"); assert(!/require\(/.test(src), "portfolio module requires nothing"); assert(!/\b(fs|http|https|sqlite3?|child_process|process\.env|Date\.now|Math\.random)\b/.test(src.replace(/\/\/.*$/gm, "")), "I/O, clock or randomness in a pure module");
});
console.log(`\n${passed} portfolio scenarios passed`);
