// MACD strategy: pure maths, confirm/buffer/zero-filter behaviour, strategy with fake deps, param validation, end-to-end backtest.
"use strict";
const assert = require("assert");
const IST = 5.5 * 3600e3;
const { macdSeries, rawSides, confirmedSides, createMacdStrategy } = require("../strategies/macd");
const { validateParams, resolveParams } = require("../strategies/strategyParams");
const { runBacktest } = require("../backtest/backtestRun"), { getDefinition, buildContext } = require("../core/context");
function bars(interval, fromStr, toStr) {
    const out = [], d0 = new Date(fromStr + "T00:00:00Z"), d1 = new Date(toStr + "T00:00:00Z");
    for (let dd = d0; dd <= d1; dd = new Date(+dd + 86400e3)) {
        const dow = dd.getUTCDay(); if (dow === 0 || dow === 6) continue; const idx = Math.round((dd - new Date("2025-01-01T00:00:00Z")) / 86400e3);
        const px = (i, m) => 100 + 14 * Math.sin((i + m / 1440) * 2 * Math.PI / 70) + 1.5 * Math.sin((i + m / 1440) * 2 * Math.PI * 3.1) + 0.6 * Math.sin((i + m / 1440) * 2 * Math.PI * 17.3);   // ~70-day swings = trends
        if (interval === "day") { const o = px(idx, 0), c = px(idx, 1439); out.push({ date: new Date(+dd - IST), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c }); continue; }
        for (let m = 9 * 60; m < 23 * 60 + 30; m += 60) { const o = px(idx, m), c = px(idx, m + 60); out.push({ date: new Date(+dd + m * 60e3 - IST), open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c, volume: 100 }); }
    } return out;
}
const kc = { getHistoricalData: async (tok, interval, f, to) => bars(interval === "day" ? "day" : "60", f, to) };
async function run(extraParams = {}, ctxExtra = {}) {
    const def = getDefinition("NATGASMINI", "MCX"), context = buildContext(def, { token: 1, symbol: "NATGASMINI26X", expiry: new Date("2027-12-01"), tickSize: 0.1, lotSize: 1 });
    context.lotMult = 250; context.timeframe = "1h"; context.carryOvernight = false; context.lots = 1; Object.assign(context, ctxExtra);
    const log = console.log; console.log = () => {}; console.warn = () => {};
    try { return await runBacktest({ strategyKey: "MACD", strategyLabel: "MACD", context, timeframe: "1h", from: new Date("2026-02-02T00:00:00+05:30"), to: new Date("2026-12-31T23:59:59+05:30"), params: extraParams, kc }); }
    finally { console.log = log; }
}

const T = [], t = (n, f) => T.push([n, f]);
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
t("macdSeries: matches a hand-computed MACD(3,5,2)", () => {
    const x = [10, 11, 12, 13, 12, 11, 12, 14, 15, 14], { macd, signal, hist } = macdSeries(x, 3, 5, 2);
    const ema = (v, n) => { const o = []; let p = null, s = 0; v.forEach((q, i) => { if (i < n - 1) { s += q; o.push(null); } else if (i === n - 1) { s += q; p = s / n; o.push(p); } else { p = q * 2 / (n + 1) + p * (1 - 2 / (n + 1)); o.push(p); } }); return o; };
    const ef = ema(x, 3), es = ema(x, 5), m = x.map((_, i) => es[i] == null ? null : ef[i] - es[i]);
    m.forEach((v, i) => v == null ? assert.strictEqual(macd[i], null) : assert.ok(near(macd[i], v)));
    const sg = ema(m.slice(4), 2); sg.forEach((v, i) => v == null ? assert.strictEqual(signal[4 + i], null) : assert.ok(near(signal[4 + i], v) && near(hist[4 + i], m[4 + i] - v)));
    assert.strictEqual(macd[0], null); assert.strictEqual(signal[4], null);
});
t("rawSides / confirmedSides: buffer, zero mode, confirm bars", () => {
    const P = { fast: 3, slow: 5, signal: 2, mode: "cross", histBuffer: 0, confirmBars: 1 };
    const up = Array.from({ length: 30 }, (_, i) => 100 + i), dn = Array.from({ length: 30 }, (_, i) => 130 - i), atrs = new Array(30).fill(2);
    assert.strictEqual(rawSides(up.concat(dn), new Array(60).fill(2), { ...P, mode: "zero" })[29], "LONG"); assert.strictEqual(rawSides(up.concat(dn), new Array(60).fill(2), { ...P, mode: "zero" })[59], "SHORT");
    assert.strictEqual(rawSides(up, atrs, { ...P, histBuffer: 50 })[29], null, "a huge buffer keeps it neutral");
    assert.deepStrictEqual(confirmedSides([null, "LONG", "LONG", "SHORT", "LONG", "LONG", "LONG"], 2), [null, null, "LONG", "LONG", "LONG", "LONG", "LONG"], "a one-candle SHORT never confirms at N=2");
    assert.deepStrictEqual(confirmedSides(["LONG", "SHORT", "SHORT", "SHORT"], 2), [null, null, "SHORT", "SHORT"]);
    assert.deepStrictEqual(confirmedSides(["LONG", "SHORT", "LONG"], 1), ["LONG", "SHORT", "LONG"]);
});
t("params: defaults, fast >= slow rejected, per-field skipCross", () => {
    assert.deepStrictEqual(resolveParams("MACD", {}).values, { fast: 12, slow: 26, signal: 9, mode: "cross", histBuffer: 0, confirmBars: 1, zeroFilter: "off", stopAtrMult: 0 });
    assert.ok(!validateParams("MACD", { fast: 30 }).ok, "30 >= default slow 26"); assert.ok(validateParams("MACD", { fast: 30 }, { skipCross: true }).ok);
    assert.ok(validateParams("MACD", { fast: 30, slow: 60 }).ok); assert.ok(!validateParams("MACD", { mode: "bogus" }).ok);
    const r = resolveParams("MACD", { fast: 40, slow: 20 }); assert.strictEqual(r.values.fast, 12); assert.ok(r.errors.length);
});
function harness(params, { orderFails = false, gateBlocks = false } = {}) {
    const log = { enters: [], exits: [], trail: null }; let raw = []; let live = null;
    const state = { position: null, pnl: 0 };
    const context = { tgPrefix: "T", lots: 1, strategyParams: params, token: 1, symbol: "X", name: "X" };
    const engineConfig = { ENGINE_ENABLED: true, LIVE_ORDERS: true, CHOP_GATE_ALWAYS_FORCE: false };
    const strat = createMacdStrategy({ context, engineConfig, state, db: { savePosition() {}, insertOpenTrade: async () => 1, loadPosition: async () => null, getRealizedPnlToday: async () => 0, getTradeCountToday: async () => 0, getOpenTrade: async () => null },
        candles: { getRawCandles: () => raw, getLivePrice: () => live },
        slStore: { setTrail: (v, d) => { log.trail = [v, d]; }, clearTrail: () => { log.trail = null; } }, targetStore: { setTarget() {}, clearTarget() {} },
        orders: { enter: async s => { log.enters.push(s); return orderFails ? null : "id"; }, exit: async s => { log.exits.push(s); return "id"; }, reconcile: async () => {} },
        positionsClose: async () => { state.position = null; return 0; }, positionsUnrealised: () => 0, lifecycle: { isShutdown: () => false }, tg() {},
        htf: { isBlocked: async () => gateBlocks }, dailyHa: { isBlocked: async () => false } });
    const push = async cl => { const prev = raw.length ? raw[raw.length - 1].close : cl; raw.push({ open: prev, high: Math.max(prev, cl) + 0.5, low: Math.min(prev, cl) - 0.5, close: cl, volume: 100, date: new Date(1e12 + raw.length * 3600e3) }); live = cl; const log0 = console.log; console.log = () => {}; try { await strat.processCandle(raw[raw.length - 1]); } finally { console.log = log0; } };
    return { push, log, state, raw: () => raw };
}
const rampUp = (n, from = 100) => Array.from({ length: n }, (_, i) => from + i * 0.8), rampDn = (s, n) => Array.from({ length: n }, (_, i) => s - i * 0.8);
const SMALL = { fast: 3, slow: 6, signal: 3 };
t("no entry on boot into an old trend; enters only on a FRESH cross; exit+reverse on the opposite", async () => {
    const h = harness(SMALL);
    for (const p of rampDn(130, 25)) await h.push(p);          // downtrend first (history)
    h.log.enters.length = 0;
    // first candles of the run: still an old SHORT trend -> a fresh run starts "flat" and must not enter just because side exists
    for (const p of rampDn(110, 3)) await h.push(p);
    assert.strictEqual(h.log.enters.length, 0, "no boot entry");
    for (const p of rampUp(25, rampDn(130, 25).pop() + 0.8)) await h.push(p);   // reversal up: a fresh LONG cross
    assert.strictEqual(h.log.enters[0], "LONG", "enters long on the fresh up-cross: " + JSON.stringify(h.log));
    for (const p of rampDn(rampUp(25, rampDn(130, 25).pop() + 0.8).pop() - 0.8, 30)) await h.push(p);          // reversal down
    assert.ok(h.log.exits.includes("LONG") && h.log.enters.includes("SHORT"), "reverses on the opposite cross: " + JSON.stringify(h.log));
});
t("stopAtrMult arms a fixed stop; 0 = none", async () => {
    for (const [mult, expectStop] of [[0, false], [2, true]]) {
        const h = harness({ ...SMALL, stopAtrMult: mult });
        for (const p of rampDn(130, 25)) await h.push(p); for (const p of rampUp(25, rampDn(130, 25).pop() + 0.8)) await h.push(p);
        assert.strictEqual(!!h.log.trail, expectStop, `stopAtrMult ${mult}`); if (expectStop) assert.ok(h.log.trail[0] < h.raw()[h.raw().length - 1].close && h.log.trail[1] === 1);
    }
});
t("zeroFilter on: a LONG cross below the zero line is not entered; the opposite signal still exits", async () => {
    const mk = on => { const h = harness({ ...SMALL, zeroFilter: on ? "on" : "off" }); return h; };
    for (const on of [false, true]) {
        const h = mk(on);
        for (const p of rampDn(150, 40)) await h.push(p);                         // deep downtrend: MACD far below zero
        for (const p of [rampDn(150, 40).pop() + 1.2, rampDn(150, 40).pop() + 2.4]) await h.push(p);   // small bounce: hist turns positive, MACD still < 0
        assert.strictEqual(h.log.enters.includes("LONG"), !on, `zeroFilter ${on ? "on" : "off"} -> LONG entered=${!on}`);
    }
});
t("a gate block on the trigger candle is retried while the confirmed side stands; failed order likewise", async () => {
    const h = harness(SMALL, { gateBlocks: true });
    for (const p of rampDn(130, 25)) await h.push(p); for (const p of rampUp(8, rampDn(130, 25).pop() + 0.8)) await h.push(p);
    assert.strictEqual(h.log.enters.length, 0, "HTF gate blocks");
    const g = harness(SMALL, { orderFails: true }); for (const p of rampDn(130, 25)) await g.push(p); for (const p of rampUp(8, rampDn(130, 25).pop() + 0.8)) await g.push(p);
    assert.ok(g.log.enters.length >= 2, "order failure retried on later candles: " + g.log.enters.length); assert.strictEqual(g.state.position, null);
});
t("backtest e2e: trades, net of costs, universal gates still apply, anti-whipsaw options cut trade count", async () => {
    const base = await run({ strategyParams: { fast: 12, slow: 26, signal: 9 } }), filt = await run({ strategyParams: { fast: 12, slow: 26, signal: 9, histBuffer: 0.3, confirmBars: 2, zeroFilter: "on" } });
    const get = r => ({ m: r.metrics || r.report.metrics, trades: r.report ? r.report.trades : r.trades });
    const a = get(base), b = get(filt);
    assert(a.trades.length > 20, "base trades: " + a.trades.length); assert(b.trades.length < a.trades.length, `filters reduce flip-flops: ${b.trades.length} < ${a.trades.length}`);
    assert(a.m.totalCosts > 0 && Math.abs(a.m.grossPnL - a.m.totalCosts - a.m.netPnL) < 1e-6, "net of costs");
    console.log("   backtest: base", a.trades.length, "trades net", a.m.netPnL.toFixed(0), "| filtered", b.trades.length, "trades net", b.m.netPnL.toFixed(0));
});
(async () => { let fail = 0; for (const [n, f] of T) { try { await f(); console.log("  ok   " + n); } catch (e) { fail++; console.log("  FAIL " + n + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } } console.log(fail ? fail + " FAILED" : "all passed"); process.exit(fail ? 1 : 0); })();
