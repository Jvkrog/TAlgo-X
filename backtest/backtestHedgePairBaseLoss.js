// backtestHedgePairBaseLoss.js — backtest of the hedge-pair "base-loss" rule (hedgePairEngine.js HEDGE_RULE=BASE_LOSS): ONE instrument, ONE account.
//   - NRML core on the side YOU pick (LONG/SHORT, manual), taken at the first bar from 09:15 IST of every day (the live engine is deployed/restarted daily).
//   - Every checkMin minutes (clock-aligned, default 5): core P&L < -band  -> open the opposite MIS hedge (same contract, same lots);
//     core P&L > +band -> close the hedge. Evaluated at the open of the first 5m bar in each slot (== the live poll's LTP at slot start).
//   - holdCore (optional): the core is NOT closed at EOD but carried to the next day (only the MIS hedge is closed); it is re-taken only if flat.
//   - EOD (23:15 IST, or the day's last bar if the market closed earlier): hedge closed first, then the core.
// Separate file from backtestHedgePair.js on purpose (that one is the two-instrument DSB strategy). Reuses the same contract resolver
// (hedgePairContext.js), ledger, positions.close() and metrics/report shape.
"use strict";

const { fetchHistoricalCandles } = require("../data/historicalFetch");
const { createCsvRepository } = require("../data/csvRepository");
const { createInstrumentSource } = require("../data/instrumentSource");
const { createContractPinStore } = require("../data/contractPins");
const { resolveHedgePairLeg } = require("../hedge/hedgePairContext");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("../core/state");
const positions = require("../core/positions");
const { computeMetrics } = require("./backtestMetrics");
const { buildHedgePairReport, saveHedgePairReport } = require("./backtestHedgePairReport");
const engineConfig = require("../core/engineConfig");

const EOD_MIN_OF_DAY = 23 * 60 + 15;
const istOf = d => new Date(d.getTime() + 5.5 * 3600e3);
const dayKeyIST = d => istOf(d).toISOString().split("T")[0];
const minOfDay = d => { const i = istOf(d); return i.getUTCHours() * 60 + i.getUTCMinutes(); };

// Pure simulation over already-fetched 5m candles ({date, open, high, low, close}); exported for tests.
async function simulateBaseLoss({ bars, coreCtx, hedgeCtx, side, checkMin = 5, pnlBand = 0, holdCore = false, from, log = () => {} }) {
    side = String(side || "").toUpperCase();
    if (side !== "LONG" && side !== "SHORT") throw new Error('side must be "LONG" or "SHORT"');
    if (!(Number.isInteger(checkMin) && checkMin >= 1 && checkMin <= 60)) throw new Error("checkMin must be a whole number 1-60");
    if (!(pnlBand >= 0)) throw new Error("pnlBand must be >= 0");
    const clockBox = { date: bars[0].date };
    const clock = { now: () => clockBox.date };
    const coreLedger = createBacktestLedger({ clock }), hedgeLedger = createBacktestLedger({ clock });
    const coreState = createState(), hedgeState = createState();
    const tg = () => {};
    const dir = side === "LONG" ? 1 : -1;
    async function enter(ctx, st, led, s, price, label, reason) {
        st.position = s; st.entryPrice = price;
        st.openTradeId = await led.insertOpenTrade(ctx.tgPrefix, ctx.symbol, s, ctx.lots, price);
        led.savePosition(ctx.tgPrefix, ctx.token, ctx.symbol, s, price);
        log(`**${label} ENTRY**`); log(`[${ctx.tgPrefix}] ${s} @ price ${price.toFixed(2)}  |  ${reason}`);
    }
    async function exit(ctx, st, led, price, label, reason) {
        if (!st.position) return;
        log(`**${label} EXIT**`);
        await positions.close(ctx, st, led, tg, price, reason);
        led.savePosition(ctx.tgPrefix, ctx.token, ctx.symbol, null, 0);
    }
    let curDay = null, lastSlot = null, eodDone = false;
    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i]; clockBox.date = bar.date;
        if (bar.date < from) continue;
        const day = dayKeyIST(bar.date), mod = minOfDay(bar.date);
        if (day !== curDay) { curDay = day; lastSlot = null; eodDone = false; log(""); log(`**STARTING** ${day}`); }
        if (eodDone) continue;
        const lastBarOfDay = i === bars.length - 1 || dayKeyIST(bars[i + 1].date) !== day;
        const isEod = mod >= EOD_MIN_OF_DAY || lastBarOfDay;
        if (isEod) {
            const px = mod >= EOD_MIN_OF_DAY ? bar.open : bar.close;
            if (coreState.position || hedgeState.position) log("**EOD**");
            await exit(hedgeCtx, hedgeState, hedgeLedger, px, "HEDGE", "EOD_FORCE");
            if (!holdCore) await exit(coreCtx, coreState, coreLedger, px, "CORE", "EOD_FORCE");   // holdCore: the NRML core is carried to the next day
            coreState.pnl = 0; coreState.trades = 0; hedgeState.pnl = 0; hedgeState.trades = 0;
            eodDone = true; continue;
        }
        if (mod < 9 * 60 + 15) continue;   // day trading: no entry and no hedge before 09:15 IST
        if (!coreState.position) {   // deployed: the core goes in at the first bar of the day
            await enter(coreCtx, coreState, coreLedger, side, bar.open, "CORE", `manual ${side}`);
            lastSlot = Math.floor(mod / checkMin);
            continue;
        }
        const slot = Math.floor(mod / checkMin);
        if (slot === lastSlot) continue;
        lastSlot = slot;
        const px = bar.open, pts = dir * (px - coreState.entryPrice);
        if (pts < -pnlBand && !hedgeState.position) {
            await enter(hedgeCtx, hedgeState, hedgeLedger, side === "LONG" ? "SHORT" : "LONG", px, "HEDGE", `core P&L ${pts.toFixed(2)} pts below 0`);
        } else if (pts > pnlBand && hedgeState.position) {
            await exit(hedgeCtx, hedgeState, hedgeLedger, px, "HEDGE", "core back in profit");
        }
    }
    const last = bars[bars.length - 1];
    await exit(hedgeCtx, hedgeState, hedgeLedger, last.close, "HEDGE", "BACKTEST_END");
    await exit(coreCtx, coreState, coreLedger, last.close, "CORE", "BACKTEST_END");
    const coreTrades = coreLedger.getAllTrades().map(t => ({ ...t, leg: "CORE" }));
    const hedgeTrades = hedgeLedger.getAllTrades().map(t => ({ ...t, leg: "HEDGE" }));
    const combined = [...coreTrades, ...hedgeTrades].sort((a, b) => new Date(a.exit_time || a.entry_time) - new Date(b.exit_time || b.entry_time));
    return { coreTrades, hedgeTrades, combined };
}

// runHedgePairBaseLossBacktest({ underlying, exchange, side, lots, lotMultOverride, symbol, checkMin, pnlBand, from, to, kc, progress })
async function runHedgePairBaseLossBacktest({
    underlying, exchange = "MCX", side, lots = 1, lotMultOverride, symbol = null, checkMin = 5, pnlBand = 0, holdCore = false, from, to, kc, log = console.log,
}) {
    const csvFilePath = exchange === "NSE" ? engineConfig.NSE_INSTRUMENT_CSV_PATH : engineConfig.INSTRUMENT_CSV_PATH;
    const csvRepo = createCsvRepository({ fetchRows: createInstrumentSource({ filePath: csvFilePath, kc, exchange }).fetchRows });
    await csvRepo.load();
    const pinStore = createContractPinStore();
    const mk = label => resolveHedgePairLeg({ underlying, legLabel: label, exchange, csvRepo, pinStore, lots, lotMultOverride, carryOvernight: label === "CORE", symbolOverride: symbol, hedgeRule: "BASE_LOSS" });
    const core = mk("CORE"), hedge = mk("HEDGE");
    const bars = await fetchHistoricalCandles({ kc, token: core.context.token, timeframe: "5m", from, to });
    if (!bars.length) throw new Error("runHedgePairBaseLossBacktest: no 5m candles returned for this range — check the dates and market holidays");
    const r = await simulateBaseLoss({ bars, coreCtx: core.context, hedgeCtx: hedge.context, side, checkMin, pnlBand, holdCore, from, log });
    const inRange = t => new Date(t.entry_time) >= from;
    const coreTrades = r.coreTrades.filter(inRange), hedgeTrades = r.hedgeTrades.filter(inRange), combined = r.combined.filter(inRange);
    const metrics = { core: computeMetrics(coreTrades), hedge: computeMetrics(hedgeTrades), combined: computeMetrics(combined) };
    const report = buildHedgePairReport({
        core: { underlying, symbol: core.context.symbol, lots: core.context.lots, lotMult: core.context.lotMult },
        hedge: { underlying, symbol: hedge.context.symbol, lots: hedge.context.lots, lotMult: hedge.context.lotMult },
        unwindMode: `BASE_LOSS ${side} every ${checkMin}m band ${pnlBand}${holdCore ? " core carried overnight" : ""}`, carryOvernight: !!holdCore, range: { from, to }, runAt: new Date(), metrics, trades: combined,
    });
    return { report, paths: saveHedgePairReport(report) };
}

module.exports = { runHedgePairBaseLossBacktest, simulateBaseLoss };
