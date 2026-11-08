"use strict";
const assert = require("assert");
const { roundTripCosts } = require("../backtest/mcxCosts");
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
// NATGASMINI-like: 1 lot x 250 MMBtu, LONG 300 -> 310. turnover entry 75,000 exit 77,500
let k = roundTripCosts({ side: "LONG", entryPrice: 300, exitPrice: 310, lots: 1, lotMult: 250, tickSize: 0.1, rates: { slippageTicks: 0 } });
near(k.brokerage, 20 + 20);               // 0.03% of 75,000 = 22.5 -> capped 20; of 77,500 = 23.25 -> 20
near(k.ctt, 0.0001 * 77500);              // LONG sells at exit
near(k.exchange, 0.000021 * 152500); near(k.sebi, 1e-6 * 152500);
near(k.gst, 0.18 * (k.brokerage + k.sebi + k.exchange));
near(k.stamp, 0.00002 * 75000);           // LONG buys at entry
near(k.total, k.brokerage + k.ctt + k.exchange + k.sebi + k.gst + k.stamp);
// SHORT: CTT on the entry leg, stamp on the exit leg
k = roundTripCosts({ side: "SHORT", entryPrice: 300, exitPrice: 310, lots: 1, lotMult: 250, rates: { slippageTicks: 0 } });
near(k.ctt, 0.0001 * 75000); near(k.stamp, 0.00002 * 77500);
// small order: percentage below the cap
k = roundTripCosts({ side: "LONG", entryPrice: 100, exitPrice: 100, lots: 1, lotMult: 100, rates: { slippageTicks: 0 } });
near(k.brokerage, 2 * 0.0003 * 10000);
// slippage: 1 tick/side, 2 sides
k = roundTripCosts({ side: "LONG", entryPrice: 300, exitPrice: 300, lots: 2, lotMult: 250, tickSize: 0.1, rates: { slippageTicks: 1 } });
near(k.slippage, 2 * 1 * 0.1 * 500);
// ledger integration: pnl becomes net
const { createBacktestLedger } = require("../backtest/backtestLedger");
const clock = { now: () => new Date("2026-01-01T10:00:00Z") };
(async () => {
    const l = createBacktestLedger({ clock, costModel: { lotMult: 250, tickSize: 0.1, rates: { slippageTicks: 0 } } });
    const id = await l.insertOpenTrade("E", "S", "LONG", 1, 300);
    await l.closeTrade(id, 310, 2500, "X");
    const t = l.getAllTrades ? (await l.getAllTrades())[0] : null;
    assert(t && t.gross_pnl === 2500 && t.pnl < 2500 && t.costs > 0, "ledger stores gross, costs, net");
    const { computeMetrics } = require("../backtest/backtestMetrics");
    const m = computeMetrics([t]); near(m.grossPnL, 2500); near(m.netPnL, t.pnl); near(m.totalCosts, t.costs);
    console.log("PASS mcx costs + ledger net pnl"); })().catch(e => { console.error("FAIL", e.message); process.exit(1); });
