// mcxCosts.js — round-trip transaction costs for MCX futures on Zerodha (Kite), so a backtest reports NET results.
// Rates verified against https://zerodha.com/charge-list on 2026-11-08 ("Commodity" table); they are plain config
// (override any key via the `rates` argument) because exchanges/brokers change them. Not modelled: margin/interest,
// DP charges (none for futures), rollover spread cost, partial fills.
//
//   brokerage  min(0.03% of turnover, ₹20) per executed order
//   CTT        0.01% on the SELL side, non-agri
//   exchange   MCX transaction charge 0.0021% of turnover, both sides
//   SEBI       ₹10 / crore of turnover (non-agri), both sides
//   GST        18% on (brokerage + SEBI + exchange charges)
//   stamp      0.002% on the BUY side
//   slippage   slippageTicks x tickSize x lotMult x lots per fill (adverse), 2 fills per round trip
"use strict";

const DEFAULT_RATES = {
    brokeragePct: 0.0003, brokerageCapPerOrder: 20,
    cttSellPct: 0.0001, exchangePct: 0.000021, sebiPerCrore: 10, gstPct: 0.18, stampBuyPct: 0.00002,
    slippageTicks: 1,
};

// side = the TRADE's direction (LONG: buys at entry, sells at exit; SHORT: the reverse).
function roundTripCosts({ side, entryPrice, exitPrice, lots, lotMult, tickSize = 0, rates = {} }) {
    const r = { ...DEFAULT_RATES, ...rates };
    const units = (Number(lots) || 0) * (Number(lotMult) || 0);
    const entryTurn = Math.abs(entryPrice) * units, exitTurn = Math.abs(exitPrice) * units;
    const buyTurn = side === "LONG" ? entryTurn : exitTurn, sellTurn = side === "LONG" ? exitTurn : entryTurn;
    const brokerage = [entryTurn, exitTurn].reduce((s, t) => s + Math.min(r.brokeragePct * t, r.brokerageCapPerOrder), 0);
    const ctt = r.cttSellPct * sellTurn;
    const exchange = r.exchangePct * (entryTurn + exitTurn);
    const sebi = (r.sebiPerCrore / 1e7) * (entryTurn + exitTurn);
    const gst = r.gstPct * (brokerage + sebi + exchange);
    const stamp = r.stampBuyPct * buyTurn;
    const slippage = 2 * (r.slippageTicks || 0) * (tickSize || 0) * units;
    const total = brokerage + ctt + exchange + sebi + gst + stamp + slippage;
    return { brokerage, ctt, exchange, sebi, gst, stamp, slippage, total };
}

module.exports = { roundTripCosts, DEFAULT_RATES };
