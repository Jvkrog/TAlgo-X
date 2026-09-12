// backtestHedgePair.js — backtests the hedge-pair strategy (see
// hedgePairEngine.js's header for the full spec). Deliberately a
// SEPARATE runner from backtestRun.js, not a mode flag on it —
// backtestRun.js replays ONE instrument through a STRATEGIES/
// customStrategyRuntime.js factory; this replays TWO instruments (core +
// hedge) against hand-written simulation logic that mirrors
// hedgePairEngine.js's own live loop bar-for-bar, not a strategy factory
// at all. Reuses what genuinely is shared: contract/context resolution
// (hedgePairContext.js — the SAME resolver hedgePairEngine.js uses, so a
// backtest can never silently resolve a different contract/lotMult than
// live would), backtestLedger.js (PnL/trade bookkeeping), positions.js
// (PnL math + the close() flow), and indicators.js's toHA (same HA
// formula haCandleReader.js uses live).
//
// SIMULATION SHAPE (mirrors hedgePairEngine.js's tick() loop, replayed
// bar-by-bar instead of on a wall-clock poll):
//   - Core instrument's own 1h HA candles are the simulation's "clock" —
//     one iteration per completed 1h bar, in order.
//   - The FIRST 1h bar of each new IST calendar day is the core's entry
//     decision point (same "at/after market open, once per day" as live,
//     since a 1h bar's own start already can't be before session open).
//     Direction comes from the latest COMPLETED daily HA candle STRICTLY
//     BEFORE that day (today's own daily candle isn't closed yet at open
//     — same reasoning as haCandleReader.js dropping the still-forming
//     bar live). Fill price: that first bar's OPEN (closest analog to
//     "entered right at today's open" available at 1h granularity).
//   - Every bar after that, while the core is open: the CORE instrument's
//     OWN just-closed 1h HA candle is the hedge trigger/unwind signal —
//     exactly like live's hourlyReader.getLatest() reading the latest
//     completed bar the instant it closes. Hedge fills happen at the
//     HEDGE instrument's own close price at that SAME timestamp (falls
//     back to the most recent earlier hedge close if a bar is missing
//     from the hedge series — thinner mini-contract volume can produce
//     gaps the full-size contract's series doesn't have).
//   - EOD (context.eodHour/eodMinute, from defaultEodFor("1h", exchange)
//     via hedgePairContext.js) force-closes hedge then core, both at
//     that bar's own close — same as live's checkEod(), and same
//     backstop reasoning: the hedge leg is force-closed EVERY day
//     regardless of UNWIND_MODE, never left naked overnight in the replay
//     either.
//   - Anything still open when the data runs out is mark-to-market
//     closed at the last available bar's close (BACKTEST_END, same
//     convention backtestRun.js uses).
"use strict";

const fs = require("fs");
const { fetchHistoricalCandles, fetchDailyCandles } = require("./historicalFetch");
const { toHA } = require("./indicators");
const { createCsvRepository } = require("./csvRepository");
const { createInstrumentSource } = require("./instrumentSource");
const { createContractPinStore } = require("./contractPins");
const { resolveHedgePairLeg } = require("./hedgePairContext");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("./state");
const positions = require("./positions");
const { computeMetrics } = require("./backtestMetrics");
const { buildHedgePairReport, saveHedgePairReport } = require("./backtestHedgePairReport");
const engineConfig = require("./engineConfig");
const c = require("./c");

const LOOKBACK_DAYS = 15; // enough prior daily+hourly bars for the first simulated day to have a real prior daily HA color, and for HA's own seed-bar convergence

function istParts(date) {
    const istMs = date.getTime() + (5.5 * 60 * 60 * 1000);
    const ist = new Date(istMs);
    return { hours: ist.getUTCHours(), minutes: ist.getUTCMinutes() };
}
function dayKeyIST(date) {
    const istMs = date.getTime() + (5.5 * 60 * 60 * 1000);
    return new Date(istMs).toISOString().split("T")[0];
}

// runHedgePairBacktest({
//   coreUnderlying, hedgeUnderlying,   // e.g. "NATURALGAS" / "NATGASMINI"
//   exchange = "MCX",
//   coreLots = 1, hedgeLots = 5,
//   coreLotMultOverride, hedgeLotMultOverride,  // required unless the
//                                               // underlying already has
//                                               // a lotMult override in
//                                               // context.js
//   unwindMode = "HA_FLIP",            // "HA_FLIP" | "EOD_ONLY"
//   from, to,                          // Date objects — range to report on
//   kc,                                // authenticated KiteConnect instance
//   progress,                          // optional (processed, total) => void
// })
async function runHedgePairBacktest({
    coreUnderlying, hedgeUnderlying, exchange = "MCX",
    coreLots = 1, hedgeLots = 5, coreLotMultOverride, hedgeLotMultOverride,
    unwindMode = "HA_FLIP", from, to, kc, progress,
}) {
    unwindMode = (unwindMode || "HA_FLIP").toUpperCase();
    if (unwindMode !== "HA_FLIP" && unwindMode !== "EOD_ONLY") {
        throw new Error(`runHedgePairBacktest: unwindMode must be "HA_FLIP" or "EOD_ONLY" (got "${unwindMode}")`);
    }

    const csvFilePath = exchange === "NSE" ? engineConfig.NSE_INSTRUMENT_CSV_PATH : engineConfig.INSTRUMENT_CSV_PATH;
    const csvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({ filePath: csvFilePath, kc, exchange }).fetchRows,
    });
    await csvRepo.load();
    const pinStore = createContractPinStore();

    const core  = resolveHedgePairLeg({
        underlying: coreUnderlying, legLabel: "CORE", exchange, csvRepo, pinStore,
        lots: coreLots, lotMultOverride: coreLotMultOverride,
    });
    const hedge = resolveHedgePairLeg({
        underlying: hedgeUnderlying, legLabel: "HEDGE", exchange, csvRepo, pinStore,
        lots: hedgeLots, lotMultOverride: hedgeLotMultOverride,
    });

    const fetchFrom = new Date(from.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const [coreDailyRaw, coreHourlyRaw, hedgeHourlyRaw] = await Promise.all([
        fetchDailyCandles({ kc, token: core.context.token, from: fetchFrom, to }),
        fetchHistoricalCandles({ kc, token: core.context.token, timeframe: "1h", from: fetchFrom, to }),
        fetchHistoricalCandles({ kc, token: hedge.context.token, timeframe: "1h", from: fetchFrom, to }),
    ]);
    if (coreHourlyRaw.length === 0) {
        throw new Error("runHedgePairBacktest: no core 1h candles returned for this range — check the date range and market holidays");
    }
    if (hedgeHourlyRaw.length === 0) {
        throw new Error("runHedgePairBacktest: no hedge 1h candles returned for this range — check the date range and market holidays");
    }

    // Drop the last daily bar unconditionally — same "never trust the
    // still-forming last bar" convention every other candle consumer in
    // this codebase follows (htfGate.js, haCandleReader.js, preload.js),
    // harmless here even when every fetched day is already fully closed.
    const coreDailyHA = toHA(coreDailyRaw.slice(0, -1));
    // dailyHaByDayKey — for a lookup on trading day D, this needs the
    // LAST entry with dayKey < D (D's own daily candle isn't closed until
    // D ends) — kept as a sorted array and scanned with a monotonically
    // advancing pointer below (bars are already chronological).
    const dailyHaSorted = coreDailyHA.map(bar => ({ dayKey: dayKeyIST(bar.date), color: bar.close > bar.open ? "green" : bar.close < bar.open ? "red" : null }));

    const coreHourlyHA = toHA(coreHourlyRaw); // no bar dropped — every bar here already fully closed (it's the replay's own clock, not a live "still forming" read)

    // hedge close lookup, keyed by epoch ms — two-pointer advance below
    // assumes hedgeHourlyRaw is chronological (fetchHistoricalCandles
    // already sorts + de-dupes).
    let hedgePtr = 0;
    function hedgeCloseAt(targetDate) {
        const targetMs = targetDate.getTime();
        while (hedgePtr + 1 < hedgeHourlyRaw.length && hedgeHourlyRaw[hedgePtr + 1].date.getTime() <= targetMs) hedgePtr++;
        return hedgeHourlyRaw[hedgePtr] ? hedgeHourlyRaw[hedgePtr].close : null;
    }

    let dailyPtr = 0; // advances forward as the replay's day moves forward — dailyHaSorted[dailyPtr] is always "the last daily HA strictly before the current day", updated in dayKeyForCoreEntry() below
    function priorDailyColor(dayKey) {
        while (dailyPtr + 1 < dailyHaSorted.length && dailyHaSorted[dailyPtr + 1].dayKey < dayKey) dailyPtr++;
        const candidate = dailyHaSorted[dailyPtr];
        return (candidate && candidate.dayKey < dayKey) ? candidate.color : null;
    }

    const clockBox = { date: coreHourlyHA[0] ? coreHourlyHA[0].date : new Date() };
    const clock = { now: () => clockBox.date };

    const coreLedger  = createBacktestLedger({ clock });
    const hedgeLedger = createBacktestLedger({ clock });
    const coreState   = createState();
    const hedgeState  = createState();
    const tg = () => {};

    async function enterLeg(legCtx, legState, legLedger, side, price) {
        legState.position    = side;
        legState.entryPrice  = price;
        legState.openTradeId = await legLedger.insertOpenTrade(legCtx.tgPrefix, legCtx.symbol, side, legCtx.lots, price);
        legLedger.savePosition(legCtx.tgPrefix, legCtx.token, legCtx.symbol, side, price);
    }
    async function exitLeg(legCtx, legState, legLedger, price, reason) {
        if (!legState.position) return;
        await positions.close(legCtx, legState, legLedger, tg, price, reason);
        legLedger.savePosition(legCtx.tgPrefix, legCtx.token, legCtx.symbol, null, 0);
    }

    let coreDecidedForDate = null;
    let eodDoneForDate     = null;
    let lastCoreClose      = coreHourlyHA[coreHourlyHA.length - 1].close;
    let lastHedgeClose     = hedgeHourlyRaw[hedgeHourlyRaw.length - 1].close;

    const total = coreHourlyHA.length;
    for (let i = 0; i < coreHourlyHA.length; i++) {
        const bar    = coreHourlyHA[i];    // HA candle (open/close = HA values, date = raw bar's date)
        const rawBar = coreHourlyRaw[i];   // same-index raw candle — its OWN open/close are the real tradable prices
        clockBox.date = bar.date;
        const dayKey = dayKeyIST(bar.date);
        const { hours, minutes } = istParts(bar.date);

        // ─── CORE ENTRY — first bar of a new day only, once.
        if (coreDecidedForDate !== dayKey) {
            const priorColor = priorDailyColor(dayKey);
            if (priorColor) { // fails safe — no prior daily read yet (start of range): retry next bar, same day
                coreDecidedForDate = dayKey;
                if (!coreState.position) {
                    const side = priorColor === "green" ? "LONG" : "SHORT";
                    await enterLeg(core.context, coreState, coreLedger, side, rawBar.open);
                }
            }
        }

        // ─── HEDGE — triggered by the core's OWN just-closed 1h HA bar.
        if (coreState.position) {
            const barColor = bar.close > bar.open ? "green" : bar.close < bar.open ? "red" : null;
            if (barColor) {
                const coreSide  = coreState.position;
                const adverse   = (coreSide === "LONG" && barColor === "red")   || (coreSide === "SHORT" && barColor === "green");
                const favorable = (coreSide === "LONG" && barColor === "green") || (coreSide === "SHORT" && barColor === "red");
                const hedgePx   = hedgeCloseAt(bar.date);

                if (!hedgeState.position && adverse && hedgePx !== null) {
                    const hedgeSide = coreSide === "LONG" ? "SHORT" : "LONG";
                    await enterLeg(hedge.context, hedgeState, hedgeLedger, hedgeSide, hedgePx);
                } else if (hedgeState.position && unwindMode === "HA_FLIP" && favorable && hedgePx !== null) {
                    await exitLeg(hedge.context, hedgeState, hedgeLedger, hedgePx, "HTF_FLIP_UNWIND");
                }
            }
        }

        // ─── EOD — force-close both legs, unconditionally, once per day.
        const pastEod = hours > core.context.eodHour || (hours === core.context.eodHour && minutes >= core.context.eodMinute);
        if (pastEod && eodDoneForDate !== dayKey) {
            eodDoneForDate = dayKey;
            const hedgePx = hedgeCloseAt(bar.date);
            if (hedgeState.position && hedgePx !== null) await exitLeg(hedge.context, hedgeState, hedgeLedger, hedgePx, "EOD_FORCE");
            if (coreState.position) await exitLeg(core.context, coreState, coreLedger, rawBar.close, "EOD_FORCE");
        }

        if (progress && i % 100 === 0) progress(i, total);
    }
    if (progress) progress(total, total);

    // Mark-to-market anything still open when the data ran out.
    if (hedgeState.position) await exitLeg(hedge.context, hedgeState, hedgeLedger, lastHedgeClose, "BACKTEST_END");
    if (coreState.position)  await exitLeg(core.context,  coreState,  coreLedger,  lastCoreClose,  "BACKTEST_END");

    const coreTrades  = coreLedger.getAllTrades().filter(t => new Date(t.entry_time) >= from).map(t => ({ ...t, leg: "CORE" }));
    const hedgeTrades = hedgeLedger.getAllTrades().filter(t => new Date(t.entry_time) >= from).map(t => ({ ...t, leg: "HEDGE" }));
    const combinedTrades = [...coreTrades, ...hedgeTrades].sort((a, b) => new Date(a.exit_time || a.entry_time) - new Date(b.exit_time || b.entry_time));

    const metrics = {
        core:     computeMetrics(coreTrades),
        hedge:    computeMetrics(hedgeTrades),
        combined: computeMetrics(combinedTrades),
    };

    const report = buildHedgePairReport({
        core:  { underlying: coreUnderlying,  symbol: core.context.symbol,  lots: core.context.lots,  lotMult: core.context.lotMult },
        hedge: { underlying: hedgeUnderlying, symbol: hedge.context.symbol, lots: hedge.context.lots, lotMult: hedge.context.lotMult },
        unwindMode, range: { from, to }, runAt: new Date(),
        metrics, trades: combinedTrades,
    });
    const paths = saveHedgePairReport(report);
    return { report, paths };
}

module.exports = { runHedgePairBacktest };
