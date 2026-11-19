// Pure replay test of simulateBaseLoss (synthetic 5m bars): entry at first bar, hedge on loss, close on profit, EOD 23:15 flat, per-day re-entry.
"use strict";
const assert = require("assert");
process.env.INSTRUMENT_CSV_PATH = require("path").join(__dirname, "..", "MCX.csv");
const { simulateBaseLoss } = require("../backtest/backtestHedgePairBaseLoss");
const ctx = tg => ({ tgPrefix: tg, symbol: "X", token: 1, lots: 1, lotMult: 100, exchange: "MCX", product: "NRML", underlying: "NATGASMINI" });
const ist = (d, h, m) => new Date(Date.UTC(2026, 10, d, h, m) - 5.5 * 3600e3);
const mk = (d, h, m, o) => ({ date: ist(d, h, m), open: o, high: o, low: o, close: o });
(async () => {
    const bars = [mk(12, 9, 0, 50), mk(12, 9, 15, 100), mk(12, 9, 20, 95), mk(12, 9, 25, 95), mk(12, 9, 30, 105), mk(12, 23, 15, 110), mk(13, 9, 15, 110), mk(13, 9, 20, 111), mk(13, 23, 15, 112)];
    const r = await simulateBaseLoss({ bars, coreCtx: ctx("C_CORE"), hedgeCtx: ctx("C_HEDGE"), side: "LONG", checkMin: 5, from: bars[0].date });
    assert.strictEqual(r.coreTrades.length, 2, "one core per day");
    assert.strictEqual(r.coreTrades[0].entry_price, 100, "09:00 bar ignored: no entry before 09:15");
    assert.strictEqual(r.hedgeTrades.length, 1, "one hedge (loss at 09:10, closed at profit 09:20)");
    assert.ok(r.coreTrades.every(t => t.exit_time), "core flat each EOD");
    const s = await simulateBaseLoss({ bars, coreCtx: ctx("C_CORE"), hedgeCtx: ctx("C_HEDGE"), side: "SHORT", checkMin: 5, from: bars[0].date });
    assert.strictEqual(s.hedgeTrades.length, 2, "SHORT core: day1 105>100 loss -> hedge held to EOD; day2 111>110 loss -> hedge");
    // full runner with a fake Kite (contract resolution + fetch + report)
    process.env.TALGO_DB_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "hpblbt-"));
    const { runHedgePairBaseLossBacktest } = require("../backtest/backtestHedgePairBaseLoss");
    const kc = { getHistoricalData: async () => bars.map(b => ({ ...b, volume: 1 })), getInstruments: async () => [] };
    const out = await runHedgePairBaseLossBacktest({ underlying: "NATGASMINI", side: "LONG", lots: 1, lotMultOverride: 250, symbol: "NATGASMINI26OCTFUT", checkMin: 5, pnlBand: 0, from: bars[0].date, to: bars[bars.length - 1].date, kc, log: () => {} });
    assert.strictEqual(out.report.metrics.hedge.trades, 1);
    assert.strictEqual(out.report.metrics.core.trades, 2);
    assert.ok(require("fs").existsSync(out.paths.htmlPath));
    console.log("hedge-pair base-loss backtest passed"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
