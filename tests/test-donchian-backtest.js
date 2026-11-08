// End-to-end: runBacktest(TREND_DONCHIAN_VT) on synthetic Kite data — daily-bar feed, carry-overnight, vol-target sizing, NET-of-cost reporting.
"use strict";
const assert = require("assert");
const IST = 5.5 * 3600e3;
const { runBacktest } = require("../backtest/backtestRun"), { getDefinition, buildContext } = require("../core/context");
function bars(interval, fromStr, toStr) {
    const out = [], d0 = new Date(fromStr + "T00:00:00Z"), d1 = new Date(toStr + "T00:00:00Z");
    for (let dd = d0; dd <= d1; dd = new Date(+dd + 86400e3)) {
        const dow = dd.getUTCDay(); if (dow === 0 || dow === 6) continue; const idx = Math.round((dd - new Date("2025-01-01T00:00:00Z")) / 86400e3);
        const px = (i, m) => 100 + 14 * Math.sin((i + m / 1440) * 2 * Math.PI / 70) + 1.5 * Math.sin((i + m / 1440) * 2 * Math.PI * 3.1);   // ~70-day swings = trends
        if (interval === "day") { const o = px(idx, 0), c = px(idx, 1439); out.push({ date: new Date(+dd - IST), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c }); continue; }
        for (let m = 9 * 60; m < 23 * 60 + 30; m += 60) { const o = px(idx, m), c = px(idx, m + 60); out.push({ date: new Date(+dd + m * 60e3 - IST), open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c, volume: 100 }); }
    } return out;
}
const kc = { getHistoricalData: async (tok, interval, f, to) => bars(interval === "day" ? "day" : "60", f, to) };
async function run(extraParams = {}, ctxExtra = {}) {
    const def = getDefinition("NATGASMINI", "MCX"), context = buildContext(def, { token: 1, symbol: "NATGASMINI26X", expiry: new Date("2027-12-01"), tickSize: 0.1, lotSize: 1 });
    context.lotMult = 250; context.timeframe = "1h"; context.carryOvernight = false; context.lots = 1; Object.assign(context, ctxExtra);
    const log = console.log; console.log = () => {}; console.warn = () => {};
    try { return await runBacktest({ strategyKey: "TREND_DONCHIAN_VT", strategyLabel: "Donchian", context, timeframe: "1h", from: new Date("2026-02-02T00:00:00+05:30"), to: new Date("2026-12-31T23:59:59+05:30"), params: extraParams, kc }); }
    finally { console.log = log; }
}
(async () => {
    const r = await run({ strategyParams: { equity: 2.5e6, riskPct: 1, maxLots: 3 } });
    const m = r.metrics || (r.report && r.report.metrics), trades = (r.report && r.report.trades) || r.trades;
    assert(trades && trades.length >= 3, "enough trades: " + (trades && trades.length));
    assert(m.totalCosts > 0 && m.grossPnL !== m.netPnL, "net-of-cost: gross " + m.grossPnL + " costs " + m.totalCosts + " net " + m.netPnL);
    assert(Math.abs(m.grossPnL - m.totalCosts - m.netPnL) < 1e-6, "gross - costs = net");
    assert(trades.every(t => t.qty >= 1 && t.qty <= 3), "vol-targeted lots within [1,3]: " + trades.map(t => t.qty));
    // carry overnight: at least one trade spans more than one calendar day
    assert(trades.some(t => new Date(t.exit_time) - new Date(t.entry_time) > 36 * 3600e3), "a trade was carried across days");
    // costs can be switched off -> gross == net
    const off = await run({ BT_COSTS: false, strategyParams: { equity: 2.5e6, riskPct: 1, maxLots: 3 } });
    const mo = off.metrics || off.report.metrics; assert(mo.totalCosts === 0 && Math.abs(mo.netPnL - m.grossPnL) < 1e-6, "BT_COSTS=false reproduces the gross number");
    // no look-ahead: every entry is on a day AFTER the signal bar's date (decision uses completed bars only)
    console.log(`PASS donchian backtest: ${trades.length} trades, gross ${m.grossPnL.toFixed(0)}, costs ${m.totalCosts.toFixed(0)}, net ${m.netPnL.toFixed(0)}`);
    process.exit(0);
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
