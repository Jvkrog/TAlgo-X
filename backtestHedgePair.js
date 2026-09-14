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
//     completed bar the instant it closes — CONFIRMED by the Dynamic Band
//     color (bandColorAt precompute below, same state machine as
//     createDynamicMidColorStrategy/dynamicBandReader.js) also agreeing,
//     so a single counter-colored HA candle that never actually broke the
//     band doesn't fire a false hedge/unwind on its own. Hedge fills happen at the
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
// Display-only IST formatting for the hourly log — istParts()/dayKeyIST()
// above do the actual date-math the simulation logic depends on; this is
// just how a timestamp is printed to console.
function istTimeStr(date) {
    return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
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

    // ─── DYNAMIC BAND COLOR — same step-band breakout state machine as
    // createDynamicMidColorStrategy in strategies.js (and dynamicBandReader.js's
    // live copy of it), replayed here bar-by-bar off the core's OWN raw
    // closes at the same index as coreHourlyHA/coreHourlyRaw. Used purely
    // as a hedge confirmation filter below — a lone counter-colored 1h HA
    // candle no longer triggers a false hedge/unwind unless price also
    // actually broke the band. bandColorAt[i] is the band's replayed color
    // as of bar i's own close (i.e. what a live read would show right
    // after bar i closes), computed once up front so the main loop below
    // can just look it up.
    const bandStep = core.context.bandStep ?? engineConfig.BAND_STEP_DEFAULT;
    const bandColorAt = new Array(coreHourlyRaw.length);
    {
        let mid = coreHourlyRaw[0].close;
        let high = mid + bandStep;
        let low = mid - bandStep;
        let position = null;
        bandColorAt[0] = "green"; // no breakout evaluated on the seed bar — "no white" default, same as replayHistory()
        for (let i = 1; i < coreHourlyRaw.length; i++) {
            const close = coreHourlyRaw[i].close;
            const breakHigh = close > high;
            const breakLow = close < low;
            if (position === "LONG") {
                if (breakHigh) { mid += bandStep; }
                else if (breakLow) { position = "SHORT"; mid -= bandStep; }
            } else if (position === "SHORT") {
                if (breakLow) { mid -= bandStep; }
                else if (breakHigh) { position = "LONG"; mid += bandStep; }
            } else {
                if (breakHigh) { position = "LONG"; mid += bandStep; }
                else if (breakLow) { position = "SHORT"; mid -= bandStep; }
            }
            high = mid + bandStep;
            low = mid - bandStep;
            bandColorAt[i] = position === "SHORT" ? "red" : "green";
        }
    }

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

    function legLabel(legCtx) { return legCtx.tgPrefix.endsWith("_CORE") ? "CORE" : "HEDGE"; }

    async function enterLeg(legCtx, legState, legLedger, side, price, reason) {
        legState.position    = side;
        legState.entryPrice  = price;
        legState.openTradeId = await legLedger.insertOpenTrade(legCtx.tgPrefix, legCtx.symbol, side, legCtx.lots, price);
        legLedger.savePosition(legCtx.tgPrefix, legCtx.token, legCtx.symbol, side, price);
        console.log(`**${legLabel(legCtx)} ENTRY**`);
        console.log(`[${legCtx.tgPrefix}] ${side} @ price ${price.toFixed(2)}  |  ${reason}`);
    }
    async function exitLeg(legCtx, legState, legLedger, price, reason) {
        if (!legState.position) return;
        console.log(`**${legLabel(legCtx)} EXIT**`);
        await positions.close(legCtx, legState, legLedger, tg, price, reason);
        legLedger.savePosition(legCtx.tgPrefix, legCtx.token, legCtx.symbol, null, 0);
    }

    let coreDecidedForDate = null;
    let lastLoggedDayKey   = null;
    let lastCoreClose      = coreHourlyHA[coreHourlyHA.length - 1].close;
    let lastHedgeClose     = hedgeHourlyRaw[hedgeHourlyRaw.length - 1].close;

    const total = coreHourlyHA.length;
    for (let i = 0; i < coreHourlyHA.length; i++) {
        const bar    = coreHourlyHA[i];    // HA candle (open/close = HA values, date = raw bar's date)
        const rawBar = coreHourlyRaw[i];   // same-index raw candle — its OWN open/close are the real tradable prices
        clockBox.date = bar.date;
        const dayKey = dayKeyIST(bar.date);
        const { hours, minutes } = istParts(bar.date);

        // ─── CORE ENTRY — fixed at 10:00 IST specifically for this
        // strategy (explicitly requested — NOT engineConfig.TRADE_START_HOUR/
        // MINUTE's 9:15, which is the general market-open constant every
        // other strategy uses; hardcoded here so changing it doesn't
        // touch anything else). 10:00 also lines up cleanly with real
        // hourly bar boundaries (9:00-10:00's close), unlike 9:15 which
        // falls mid-candle on an hourly series.
        const ENTRY_HOUR = 10, ENTRY_MINUTE = 0;
        const pastOpen = hours > ENTRY_HOUR || (hours === ENTRY_HOUR && minutes >= ENTRY_MINUTE);
        if (pastOpen && coreDecidedForDate !== dayKey) {
            const priorColor = priorDailyColor(dayKey);
            if (priorColor) { // fails safe — no prior daily read yet (start of range): retry next bar, same day
                coreDecidedForDate = dayKey;
                if (!coreState.position) {
                    const side = priorColor === "green" ? "LONG" : "SHORT";
                    await enterLeg(core.context, coreState, coreLedger, side, rawBar.open, `daily HA ${priorColor}`);
                }
            }
        }

        // ─── HEDGE — triggered by the core's OWN just-closed 1h HA bar,
        // CONFIRMED by the Dynamic Band color at this same bar also
        // agreeing (see the bandColorAt precompute above / dynamicBandReader.js's
        // header) — filters out a lone counter-colored HA candle that
        // never actually broke the band.
        if (coreState.position) {
            const barColor = bar.close > bar.open ? "green" : bar.close < bar.open ? "red" : null;
            if (barColor) {
                const coreSide   = coreState.position;
                const bandColor  = bandColorAt[i];
                const haAdverse    = (coreSide === "LONG" && barColor === "red")   || (coreSide === "SHORT" && barColor === "green");
                const haFavorable  = (coreSide === "LONG" && barColor === "green") || (coreSide === "SHORT" && barColor === "red");
                const bandAdverse  = (coreSide === "LONG" && bandColor === "red")   || (coreSide === "SHORT" && bandColor === "green");
                const bandFavorable = (coreSide === "LONG" && bandColor === "green") || (coreSide === "SHORT" && bandColor === "red");
                const adverse   = haAdverse && bandAdverse;
                const favorable = haFavorable && bandFavorable;
                const hedgePx   = hedgeCloseAt(bar.date);

                if (!hedgeState.position && adverse && hedgePx !== null) {
                    const hedgeSide = coreSide === "LONG" ? "SHORT" : "LONG";
                    await enterLeg(hedge.context, hedgeState, hedgeLedger, hedgeSide, hedgePx, `1h HA ${barColor} + band ${bandColor} against ${coreSide} core`);
                } else if (hedgeState.position && unwindMode === "HA_FLIP" && favorable && hedgePx !== null) {
                    await exitLeg(hedge.context, hedgeState, hedgeLedger, hedgePx, "HTF_FLIP_UNWIND");
                }
            }
        }

        // ─── EOD — force-close both legs. Two conditions, either one
        // fires it: past the configured eodHour:eodMinute threshold, OR
        // this is simply the LAST bar of the trading day (next bar
        // belongs to a different day, or there is no next bar at all).
        // The second condition is the one that actually matters in
        // practice and was the real bug here: real MCX hourly candles
        // land on the clock hour (23:00), never on a specific minute like
        // 23:15 — so a bar-quantized check for "hours===23 && minutes>=15"
        // can never be satisfied if no bar ever starts at or after 23:15,
        // and EOD silently never fired, letting the core ride the same
        // entry for the entire backtest (confirmed directly: a real run
        // showed the core entering once and reporting "0 trades" because
        // its only entry/exit pair spanned the ENTIRE range, closing only
        // at BACKTEST_END). Live doesn't have this problem — it polls
        // real wall-clock time every 60s, not bar-quantized — so this
        // fix is backtest-only.
        const pastEod = hours > core.context.eodHour || (hours === core.context.eodHour && minutes >= core.context.eodMinute);
        const isLastBarOfDay = (i === coreHourlyHA.length - 1) || dayKeyIST(coreHourlyHA[i + 1].date) !== dayKey;
        if ((pastEod || isLastBarOfDay) && (coreState.position || hedgeState.position)) {
            console.log("**EOD**");
            const hedgePx = hedgeCloseAt(bar.date);
            if (hedgeState.position && hedgePx !== null) await exitLeg(hedge.context, hedgeState, hedgeLedger, hedgePx, "EOD_FORCE");
            if (coreState.position) await exitLeg(core.context, coreState, coreLedger, rawBar.close, "EOD_FORCE");
        }
        // Reset each leg's "session" total once today is confirmed fully
        // closed out — same fix as hedgePairEngine.js live (Sep 2026):
        // createState() is created ONCE for the whole backtest range, not
        // per day, so without this reset every trade's "session:" line
        // would accumulate pnl across the ENTIRE backtest instead of just
        // that day, making daily performance in the log unreadable. The
        // report's own per-leg/combined metrics were never affected —
        // those come from computeMetrics() over each ledger's own trades,
        // not from this counter.
        if (!coreState.position && !hedgeState.position) {
            coreState.pnl  = 0; coreState.trades  = 0;
            hedgeState.pnl = 0; hedgeState.trades = 0;
        }

        // ─── HOURLY PnL log — one line per bar (this loop already IS
        // hourly), same shape/rule as hedgePairEngine.js live: core always
        // logged, hedge appended only while it actually has a position
        // open, using post-EOD state so a just-flattened day shows flat.
        // Skipped during the LOOKBACK_DAYS warmup window before `from` —
        // that period exists only to seed the daily/hourly HA reads, not
        // to be reported on.
        if (bar.date >= from) {
            // **STARTING** banner — one per new calendar day, same
            // reasoning as hedgePairEngine.js live: makes the log stream
            // easy to scan for where each session begins.
            if (lastLoggedDayKey !== dayKey) {
                lastLoggedDayKey = dayKey;
                console.log();
                console.log(`**STARTING** ${dayKey}`);
            }
            let line = `[HOURLY ${istTimeStr(bar.date)} IST] core ${core.context.symbol}: `;
            line += coreState.position
                ? `${coreState.position} uPnL ${positions.pnlStr(positions.unrealised(core.context, coreState, rawBar.close))}`
                : "flat";
            if (hedgeState.position) {
                const hedgePx = hedgeCloseAt(bar.date);
                line += `  |  hedge ${hedge.context.symbol}: ${hedgeState.position} uPnL ${hedgePx !== null ? positions.pnlStr(positions.unrealised(hedge.context, hedgeState, hedgePx)) : "-"}`;
            }
            console.log(line);
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
