// Price-MA hedge backtest: the replay runs the live controller + signal over minute candles; end-to-end through runDualHedgeBacktest + report.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const IST = 5.5 * 3600e3;
const { replayPriceMaHedge } = require("../backtest/backtestPriceMaHedge");
const { renderDualHedgeHtml } = require("../backtest/backtestDualHedgeReport");
const { computeMetrics: cm } = require("../backtest/backtestMetrics");
const T = [], t = (n, f) => T.push([n, f]);
const ctx = (name) => ({ tgPrefix: name, symbol: "NATGASMINI26X", token: 1, exchange: "MCX", lots: 1, lotMult: 250, name, tgLabel: name, dbNoStrategy: true });
// two IST days of minute candles 09:00-23:30 with a slow sine so the minute proxy rises and falls
function minutes(dayStarts) {
    const out = [];
    for (const d of dayStarts) for (let m = 9 * 60; m < 23 * 60 + 30; m++) {
        const ms = Date.parse(d + "T00:00:00Z") + m * 60000 - IST, k = m + (d.endsWith("12") ? 0 : 400);
        const px = x => 300 + 5 * Math.sin(x / 45);
        const o = px(k), cl = px(k + 1);
        out.push({ date: new Date(ms), open: o, high: Math.max(o, cl) + 0.05, low: Math.min(o, cl) - 0.05, close: cl, volume: 1 });
    }
    return out;
}
const candles = minutes(["2026-11-11", "2026-11-12"]);
const run = o => replayPriceMaHedge({ longCtx: ctx("L"), shortCtx: ctx("S"), candles, tradeFromMs: candles[0].date.getTime(), baseHour: 9, baseMinute: 15, eodHour: 23, eodMinute: 15, verbose: false, ...o });
t("bases once a day, hedges follow the colour, everything flat at EOD each day", async () => {
    const r = await run({});
    const by = (leg, role) => r.trades.filter(x => x.leg === leg && x.role === role);
    assert.strictEqual(by("LONG", "BASE").length, 2); assert.strictEqual(by("SHORT", "BASE").length, 2);
    assert.ok(by("SHORT", "HEDGE").length >= 2 && by("LONG", "HEDGE").length >= 2, "both hedge accounts used as the market rises and falls");
    assert.ok(by("SHORT", "HEDGE").every(x => x.side === "LONG") && by("LONG", "HEDGE").every(x => x.side === "SHORT"), "hedge sides: SHORT account hedges LONG, LONG account hedges SHORT");
    assert.ok(r.trades.every(x => x.status === "CLOSED"), "nothing left open");
    assert.ok(r.trades.some(x => x.exit_reason === "EOD"), "EOD close");
    // never both hedges at once: sort hedge intervals and check no overlap
    const hs = r.trades.filter(x => x.role === "HEDGE").sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));
    for (let i = 1; i < hs.length; i++) assert.ok(new Date(hs[i].entry_time) >= new Date(hs[i - 1].exit_time), "hedges never overlap");
    assert.strictEqual(r.stats.baseEntries, 4);
});
t("no hedge or base before the base time; nothing opens after EOD", async () => {
    const r = await run({});
    for (const x of r.trades) { const mod = new Date(new Date(x.entry_time).getTime() + IST).getUTCHours() * 60 + new Date(new Date(x.entry_time).getTime() + IST).getUTCMinutes(); assert.ok(mod >= 9 * 60 + 15 && mod < 23 * 60 + 15, "entry within base..EOD: " + mod); }
});
t("slippage hurts and confirmMinutes / minSlope reduce hedge churn", async () => {
    const a = await run({}), b = await run({ slippagePoints: 0.5 }), c = await run({ confirmMinutes: 5 }), d = await run({ minSlope: 0.5 });
    assert.ok(b.mtm.finalEquity < a.mtm.finalEquity, "slippage lowers P&L");
    assert.ok(c.stats.hedgeEntries <= a.stats.hedgeEntries, "confirm 5 flips no more often");
    assert.ok(d.stats.hedgeEntries <= a.stats.hedgeEntries && d.stats.neutralMinutes > a.stats.neutralMinutes, "min slope makes more minutes neutral");
});
t("report renders with the PRICE_MA sections", async () => {
    const r = await run({});
    const html = renderDualHedgeHtml({ params: { strategy: "PRICE_MA", base: "09:15", eod: "23:15", minSlope: 0, confirmMinutes: 1, maProxy: "ohlc4", slippagePoints: 0, rangeStart: "x", anchor: "none" }, trades: r.trades, stats: r.stats, symbol: "NATGASMINI26X", longLots: 1, shortLots: 1, metrics: { long: cm(r.longTrades), short: cm(r.shortTrades), combined: cm(r.trades) }, mtm: r.mtm, range: { from: "a", to: "b" }, meta: { candles: candles.length, signalBars: r.signalBars, signalKind: r.signalKind }, runAt: new Date().toISOString(), lotMult: 250 });
    assert.ok(/Price-MA Hedge/.test(html) && /APPROXIMATION/.test(html) && /<th>Role<\/th>/.test(html));
});
(async () => { let f = 0; for (const [n, fn] of T) { try { await fn(); console.log("  ok  ", n); } catch (e) { f++; console.log("  FAIL", n, "\n", e.stack); } } console.log(f ? f + " failed" : "all passed"); process.exit(f ? 1 : 0); })();
