// Backtest with a 10-year range on a contract that only has ~4 months of data: no 2000-day error, window starts at the first candle.
"use strict";
const assert = require("assert");
const IST = 5.5 * 3600e3;
const { runBacktest } = require("../backtest/backtestRun"), { getDefinition, buildContext } = require("../core/context");
const firstData = Date.parse("2026-06-01T00:00:00Z");
function bars(interval, f, to) {
    const out = [], d0 = new Date(Math.max(Date.parse(f), firstData)), d1 = new Date(to);
    for (let dd = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate())); dd <= d1; dd = new Date(+dd + 86400e3)) {
        if ([0, 6].includes(dd.getUTCDay())) continue; const idx = Math.round((dd - Date.UTC(2025, 0, 1)) / 86400e3);
        const px = (i, m) => 100 + 10 * Math.sin((i + m / 1440) * 2 * Math.PI / 20);
        if (interval === "day") { const o = px(idx, 0), c = px(idx, 1439); out.push({ date: new Date(+dd - IST), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c }); continue; }
        for (let m = 9 * 60; m < 23 * 60 + 30; m += 60) { const o = px(idx, m), c = px(idx, m + 60); out.push({ date: new Date(+dd + m * 60e3 - IST), open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c, volume: 100 }); }
    } return out;
}
const kc = { getHistoricalData: async (tok, iv, f, to) => { if (iv === "day" && (Date.parse(to) - Date.parse(f)) / 86400e3 > 2000) throw new Error("interval exceeds max limit: 2000 days"); return bars(iv === "day" ? "day" : "60", f, to); } };
(async () => {
    const real = global.setTimeout; global.setTimeout = fn => real(fn, 0);
    const def = getDefinition("NATGASMINI", "MCX"), context = buildContext(def, { token: 1, symbol: "NATGASMINI26X", expiry: new Date("2027-12-01"), tickSize: 0.1, lotSize: 1 });
    context.lotMult = 250; context.timeframe = "1h"; context.carryOvernight = false; context.lots = 1;
    const log = console.log; console.log = () => {}; console.warn = () => {};
    try {
        const to = new Date("2026-11-10T23:59:59+05:30");
        const r = await runBacktest({ strategyKey: "MACD", strategyLabel: "MACD", context, timeframe: "1h", from: new Date(+to - 3650 * 86400e3), to, params: {}, kc });
        console.log = log;
        assert.ok(new Date(r.report.from || r.report.summary?.from || firstData) >= new Date(firstData - 86400e3 * 5), "window starts at the first real candle");
        assert.ok((r.report.trades || []).length > 0, "ran over the real data");
        console.log("all passed"); process.exit(0);
    } finally { console.log = log; global.setTimeout = real; }
})().catch(e => { console.error(e.stack); process.exit(1); });
