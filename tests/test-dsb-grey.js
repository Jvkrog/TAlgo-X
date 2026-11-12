// DSB_GREY: Pine-port maths (band, grey forcing), registration, e2e backtest.
"use strict";
const assert = require("assert");
const IST = 5.5 * 3600e3;
const dsbg = require("../strategies/dsbGrey");
const { STRATEGIES, STRATEGY_INFO, STRATEGY_TIMEFRAME } = require("../strategies/strategies");
const { runBacktest } = require("../backtest/backtestRun"), { getDefinition, buildContext } = require("../core/context");
const T = [], t = (n, f) => T.push([n, f]);
const UP = { strongUp: true, strongDown: false }, DN = { strongUp: false, strongDown: true }, NE = { strongUp: false, strongDown: false };

t("step: breakout with strong slope sets colour, weak slope breakout is grey, neutral forces grey", () => {
    let s = dsbg.init(100);
    s = dsbg.step(s, 100.5, UP, 1); assert.deepStrictEqual(s, { mid: 100, direction: 0 }, "inside band: no change, direction stays 0");
    s = dsbg.step(s, 101.5, UP, 1); assert.deepStrictEqual(s, { mid: 101, direction: 1 });
    s = dsbg.step(s, 101.4, UP, 1); assert.strictEqual(s.direction, 1, "colour persists without a breakout");
    s = dsbg.step(s, 101.4, NE, 1); assert.strictEqual(s.direction, 0, "neutral slope forces grey");
    s = dsbg.step(s, 101.4, UP, 1); assert.strictEqual(s.direction, 0, "stays grey until a fresh breakout (Pine behaviour)");
    s = dsbg.step(s, 102.5, NE, 1); assert.deepStrictEqual(s, { mid: 102, direction: 0 }, "weak-slope breakout moves band, grey");
    s = dsbg.step(s, 100.9, DN, 1); assert.deepStrictEqual(s, { mid: 101, direction: -1 }, "down breakout w/ strong down slope");
    s = dsbg.step(s, 99.5, UP, 1); assert.deepStrictEqual(s, { mid: 100, direction: 0 }, "down breakout but slope not strong down -> grey");
});
t("slopeFlags: nulls are neutral, steady uptrend is strongUp, flat is neutral", () => {
    const mk = f => Array.from({ length: 120 }, (_, i) => { const p = f(i); return { open: p, high: p + 0.2, low: p - 0.2, close: p }; });
    const up = dsbg.slopeFlags(mk(i => 100 + i * 2), 10, 14, 2, -2), flat = dsbg.slopeFlags(mk(() => 100), 10, 14, 2, -2);
    assert.deepStrictEqual(up[0], NE); assert.ok(up[119].strongUp && !up[119].strongDown);
    assert.ok(flat.every(f => !f.strongUp && !f.strongDown));
});
t("registered, 1h, DSB-family candle handling and band-step wiring", () => {
    assert.strictEqual(typeof STRATEGIES.DSB_GREY, "function"); assert.strictEqual(STRATEGY_TIMEFRAME.DSB_GREY, "1h"); assert.ok(STRATEGY_INFO.DSB_GREY);
    const fs = require("fs"), r = f => fs.readFileSync(__dirname + "/../" + f, "utf8");
    for (const f of ["toolbox.js", "webdash/server.js", "webdash/public/app.js", "engine.js", "indicators/candleType.js"]) assert.ok(/DSB_GREY/.test(r(f)), f);
});
function bars(interval, fromStr, toStr) {
    const out = [], d0 = new Date(fromStr + "T00:00:00Z"), d1 = new Date(toStr + "T00:00:00Z");
    for (let dd = d0; dd <= d1; dd = new Date(+dd + 86400e3)) {
        const dow = dd.getUTCDay(); if (dow === 0 || dow === 6) continue; const idx = Math.round((dd - new Date("2025-01-01T00:00:00Z")) / 86400e3);
        const px = (i, m) => 100 + 14 * Math.sin((i + m / 1440) * 2 * Math.PI / 40) + 0.6 * Math.sin((i + m / 1440) * 2 * Math.PI * 3.1);
        if (interval === "day") { const o = px(idx, 0), c = px(idx, 1439); out.push({ date: new Date(+dd - IST), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c }); continue; }
        for (let m = 9 * 60; m < 23 * 60 + 30; m += 60) { const o = px(idx, m), c = px(idx, m + 60); out.push({ date: new Date(+dd + m * 60e3 - IST), open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c, volume: 100 }); }
    } return out;
}
const kc = { getHistoricalData: async (tok, interval, f, to) => bars(interval === "day" ? "day" : "60", f, to) };
t("backtest e2e: trades both sides, GREY EXIT / flip exits occur, no errors", async () => {
    const def = getDefinition("NATGASMINI", "MCX"), context = buildContext(def, { token: 1, symbol: "NATGASMINI26X", expiry: new Date("2027-12-01"), tickSize: 0.1, lotSize: 1 });
    context.lotMult = 250; context.timeframe = "1h"; context.carryOvernight = false; context.lots = 1; context.bandStep = 1;
    const log = console.log; console.log = () => {}; console.warn = () => {};
    let r; try { r = await runBacktest({ strategyKey: "DSB_GREY", strategyLabel: "DSBG", context, timeframe: "1h", from: new Date("2026-02-02T00:00:00+05:30"), to: new Date("2026-06-30T23:59:59+05:30"), params: {}, kc }); } finally { console.log = log; }
    const tr = r.report.trades || []; assert.ok(tr.length >= 3, "trades: " + tr.length);
    assert.ok(tr.some(x => x.side === "LONG") && tr.some(x => x.side === "SHORT"), "both sides");
    const reasons = new Set(tr.map(x => x.exit_reason)); console.error("   exit reasons:", [...reasons].join(","));
    assert.ok(reasons.has("GREY EXIT") || reasons.has("DSB FLIP EXIT"), "a signal exit occurred");
});
t("settings: spec validates and per-instrument params change the backtest (not engine-wide config)", async () => {
    const { validateParams, resolveParams } = require("../strategies/strategyParams");
    assert.ok(STRATEGY_INFO.DSB_GREY.params === true);
    assert.deepStrictEqual(resolveParams("DSB_GREY", null).values, { maLen: 56, maAtrLen: 14, filterTop: 2, filterBottom: -2, slAtrLen: 10 });
    assert.ok(validateParams("DSB_GREY", { filterTop: 1, filterBottom: 3 }).errors.length, "bottom must be below top");
    const run2 = async sp => {
        const def = getDefinition("NATGASMINI", "MCX"), context = buildContext(def, { token: 1, symbol: "NATGASMINI26X", expiry: new Date("2027-12-01"), tickSize: 0.1, lotSize: 1 });
        context.lotMult = 250; context.timeframe = "1h"; context.carryOvernight = false; context.lots = 1; context.bandStep = 1;
        const log = console.log; console.log = () => {}; console.warn = () => {};
        try { return (await runBacktest({ strategyKey: "DSB_GREY", strategyLabel: "DSBG", context, timeframe: "1h", from: new Date("2026-02-02T00:00:00+05:30"), to: new Date("2026-06-30T23:59:59+05:30"), params: sp ? { strategyParams: sp } : {}, kc })).report.trades.length; } finally { console.log = log; }
    };
    const base = await run2(null), tuned = await run2({ maLen: 12, filterTop: 0.2, filterBottom: -0.2 });
    assert.ok(base !== tuned, `tuned slope settings must change the result (base ${base}, tuned ${tuned})`);
});
(async () => { let f = 0; for (const [n, fn] of T) { try { await fn(); console.log("  ok  ", n); } catch (e) { f++; console.log("  FAIL", n, "\n", e.stack); } } console.log(f ? f + " failed" : "all passed"); process.exit(f ? 1 : 0); })();
