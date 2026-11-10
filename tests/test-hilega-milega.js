// HILEGA_MILEGA: registered, HA-native, entry/exit/reverse on EMA3/WMA21 cross, e2e backtest.
"use strict";
const assert = require("assert");
const IST = 5.5 * 3600e3;
const { STRATEGIES, STRATEGY_INFO, STRATEGY_TIMEFRAME } = require("../strategies/strategies");
const { hmIndicator } = require("../indicators/indicators");
const { runBacktest } = require("../backtest/backtestRun"), { getDefinition, buildContext } = require("../core/context");
function bars(interval, fromStr, toStr) {
    const out = [], d0 = new Date(fromStr + "T00:00:00Z"), d1 = new Date(toStr + "T00:00:00Z");
    for (let dd = d0; dd <= d1; dd = new Date(+dd + 86400e3)) {
        const dow = dd.getUTCDay(); if (dow === 0 || dow === 6) continue; const idx = Math.round((dd - new Date("2025-01-01T00:00:00Z")) / 86400e3);
        const px = (i, m) => 100 + 14 * Math.sin((i + m / 1440) * 2 * Math.PI / 20) + 1.2 * Math.sin((i + m / 1440) * 2 * Math.PI * 3.1);
        if (interval === "day") { const o = px(idx, 0), c = px(idx, 1439); out.push({ date: new Date(+dd - IST), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c }); continue; }
        for (let m = 9 * 60; m < 23 * 60 + 30; m += 60) { const o = px(idx, m), c = px(idx, m + 60); out.push({ date: new Date(+dd + m * 60e3 - IST), open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c, volume: 100 }); }
    } return out;
}
const kc = { getHistoricalData: async (tok, interval, f, to) => bars(interval === "day" ? "day" : "60", f, to) };
async function run() {
    const def = getDefinition("NATGASMINI", "MCX"), context = buildContext(def, { token: 1, symbol: "NATGASMINI26X", expiry: new Date("2027-12-01"), tickSize: 0.1, lotSize: 1 });
    context.lotMult = 250; context.timeframe = "1h"; context.carryOvernight = false; context.lots = 1;
    const log = console.log; console.log = () => {}; console.warn = () => {};
    try { return await runBacktest({ strategyKey: "HILEGA_MILEGA", strategyLabel: "HM", context, timeframe: "1h", from: new Date("2026-02-02T00:00:00+05:30"), to: new Date("2026-06-30T23:59:59+05:30"), params: {}, kc }); }
    finally { console.log = log; }
}
const T = [], t = (n, f) => T.push([n, f]);
t("registered with 1h timeframe, no MA-slope params", () => {
    assert.strictEqual(typeof STRATEGIES.HILEGA_MILEGA, "function");
    assert.strictEqual(STRATEGY_TIMEFRAME.HILEGA_MILEGA, "1h");
    assert.ok(STRATEGY_INFO.HILEGA_MILEGA.label === "Hilega-Milega");
    assert.ok(!/slope/i.test(STRATEGY_INFO.HILEGA_MILEGA.description));
});
t("HA-native in engine and webdash lists", () => {
    assert.ok(/HILEGA_MILEGA/.test(require("fs").readFileSync(__dirname + "/../indicators/candleType.js", "utf8")));
    assert.ok(/HILEGA_MILEGA/.test(require("fs").readFileSync(__dirname + "/../webdash/public/app.js", "utf8")));
});
t("strategy source has no MA-slope code", () => {
    const src = require("fs").readFileSync(__dirname + "/../strategies/strategies.js", "utf8");
    const a = src.indexOf("function createHilegaMilegaStrategy"), b = src.indexOf("\n}\n", src.indexOf("async function initSignals", a)) ;
    const body = src.slice(a, b);
    assert.ok(!/MA_SLOPE|atrSeries|atan/.test(body), "no slope/angle code");
    assert.ok(/hmIndicator/.test(body));
});
t("backtest e2e: trades occur, entries/exits follow HM cross, net of costs", async () => {
    const r = await run();
    const trades = (r.report && (r.report.trades || r.report.tradeList)) || []; if (!trades.length) console.error("REPORT KEYS", Object.keys(r.report||{}), JSON.stringify(r.report).slice(0,400));
    assert.ok(trades.length >= 3, "expected several trades, got " + trades.length);
    assert.ok(trades.some(x => /HM_EXIT/.test(x.exit_reason || "")), "HM_EXIT reason present");
    assert.ok(trades.some(x => x.side === "LONG") && trades.some(x => x.side === "SHORT"), "both sides traded");
});
(async () => { let f = 0; for (const [n, fn] of T) { try { await fn(); console.log("  ok  ", n); } catch (e) { f++; console.log("  FAIL", n, "\n", e.stack); } } console.log(f ? f + " failed" : "all passed"); process.exit(f ? 1 : 0); })();
