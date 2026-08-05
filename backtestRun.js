// backtestRun.js — orchestrates one full backtest end-to-end. This is the
// exact same wiring pattern proven out manually earlier: real strategy
// factory + backtestLedger/backtestBroker/backtestCandleFeed/backtestSL +
// UNMODIFIED state.js/sl.js/positions.js, driven by a replay loop instead
// of candlePoll's live tick/poll cycle.
"use strict";

const { STRATEGIES }              = require("./strategies");
const { createBacktestLedger }    = require("./backtestLedger");
const { createBacktestBroker }    = require("./backtestBroker");
const { createBacktestCandleFeed } = require("./backtestCandleFeed");
const { createBacktestSL }        = require("./backtestSL");
const { createState }             = require("./state");
const { createSLStore }           = require("./sl");
const positions                    = require("./positions");
const engineConfigDefaults        = require("./engineConfig");
const { computeMetrics }          = require("./backtestMetrics");
const { buildReport, saveReport } = require("./backtestReport");
const { fetchHistoricalCandles }  = require("./historicalFetch");
const c = require("./c");

// runBacktest({
//   strategyKey,      // e.g. "ALMA_BAND" — must exist in strategies.js's STRATEGIES
//   strategyLabel,    // display label for the report (STRATEGY_INFO's .label)
//   context,          // resolved instrument context — needs at minimum
//                     // { name/tgPrefix, token, symbol, exchange, lots, lotMult }
//                     // from the SAME resolution path Add Instrument uses
//   timeframe,        // "5m" | "15m" | "30m" | "1h"
//   from, to,         // Date objects — the historical range to replay
//   params = {},      // strategy-specific engineConfig overrides (ALMA_LEN etc.)
//   kc,                // authenticated KiteConnect instance, for the historical fetch
//   progress,         // optional (processed, total) => void, called every 100 candles
// })
async function runBacktest({ strategyKey, strategyLabel, context, timeframe, from, to, params = {}, kc, progress }) {
    const factory = STRATEGIES[strategyKey];
    if (!factory) {
        throw new Error(`runBacktest: unknown strategy "${strategyKey}" (known: ${Object.keys(STRATEGIES).join(", ")})`);
    }

    // A backtest never places real orders and never uses the trend-following
    // gates in a way that depends on wall-clock trading-window state beyond
    // what the injected clock already handles — LIVE_ORDERS forced off is
    // the one override that's non-negotiable here, everything else in
    // `params` is the strategy's own tunable knobs (ALMA_LEN, DPI_EFF_THRESH,
    // etc.), applied as a plain override on top of the real defaults.
    const engineConfig = Object.assign({}, engineConfigDefaults, params, {
        LIVE_ORDERS: false,
        ENGINE_ENABLED: true,
    });

    // Fetch extra calendar days BEFORE the requested `from` so the strategy's
    // indicator warmup (~25 candles for both current strategies) happens
    // against real prior data instead of eating into the range the person
    // actually asked to see results for — this is exactly what live does by
    // backfilling history on boot before it starts trading "for real."
    // 10 calendar days comfortably covers every current strategy's
    // candle-based warmup at any supported timeframe (even 1h, worst case),
    // including weekends/holidays in between. Trades opened during this
    // lookback window are filtered out of the final report below — they're
    // warmup context, not something the person asked to backtest.
    const WARMUP_LOOKBACK_DAYS = 10;
    const fetchFrom = new Date(from.getTime() - WARMUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const historicalCandles = await fetchHistoricalCandles({ kc, token: context.token, timeframe, from: fetchFrom, to });
    if (historicalCandles.length === 0) {
        throw new Error("runBacktest: no historical candles returned for this range — check the date range and market holidays");
    }

    const state   = createState();
    const slStore = createSLStore();
    const feed    = createBacktestCandleFeed(historicalCandles);

    // clock reads whichever candle the replay loop is currently on — this
    // is what makes canEnter()'s trading-window check and every trade
    // timestamp reflect backtest time instead of wall-clock time.
    let currentCandle = null;
    const clock = { now: () => currentCandle ? new Date(currentCandle.date) : new Date() };

    const ledger = createBacktestLedger({ clock });
    const broker = createBacktestBroker();
    // Silent — telegram.js's real fallback (when unconfigured) console.logs
    // every message, which would spam stdout across a year-long replay.
    const tg = () => {};
    const lifecycle = { isShutdown: () => false };

    const positionsClose      = (price, reason) => positions.close(context, state, ledger, tg, price, reason);
    const positionsUnrealised = (price) => positions.unrealised(context, state, price);

    const slCheck = createBacktestSL({ context, engineConfig, state, slStore, orders: broker, positionsClose, db: ledger, tg });

    const strategy = factory({
        context, engineConfig, state, db: ledger, candles: feed, slStore,
        orders: broker, positionsClose, positionsUnrealised, lifecycle, tg, clock,
    });

    await strategy.initSignals(); // ledger.loadPosition() always resolves null — always starts flat

    // Mirrors lifecycle.js's live EOD force-close (context.eodHour/eodMinute,
    // default 23:15) — same reason it exists live: MIS positions must not
    // carry overnight, and each day's PnL gets realized at EOD, not carried
    // as an open position into the next day's replay.
    //
    // Live gets this "no more decisions after EOD" property for free —
    // lifecycle.js calls process.exit() shortly after force-closing, so the
    // process is simply dead for the rest of the day. A backtest replay is
    // one continuous loop across many days, so it needs an explicit
    // blackout: once EOD fires for a day, processCandle() is skipped
    // entirely for any remaining candles that day (MCX often still has a
    // few candles trading between 23:15 and end-of-session ~23:30) —
    // otherwise a fresh entry could open in that window with nothing left
    // to close it before the loop rolls into the next day's 9:15 candle.
    // The blackout lifts the moment a new calendar day's candle arrives.
    //
    // IMPORTANT: uses an explicit UTC+5:30 offset, NOT candleDate.getHours()
    // — .getHours() reads the Node PROCESS's local timezone, not IST. On a
    // server not explicitly set to Asia/Kolkata (this sandbox defaults to
    // UTC, for instance), .getHours() would silently read the wrong hour
    // and this check would never fire — confirmed by testing it broken
    // exactly that way before this fix. candlePoll.js already has to do
    // this same explicit conversion for its own slot-boundary math, for
    // the identical reason.
    function istParts(date) {
        const istMs = date.getTime() + (5.5 * 60 * 60 * 1000);
        const ist = new Date(istMs);
        return { hours: ist.getUTCHours(), minutes: ist.getUTCMinutes() };
    }
    let lastEodDate     = null;
    let postEodBlackout = false;
    let lastSeenDay     = null;   // tracks day rollover for the state.pnl reset below, independent of the EOD blackout's own day-tracking

    let processed = 0;
    while (feed.hasNext()) {
        currentCandle = feed.advance();

        const candleDate = new Date(currentCandle.date);
        const dayKey = candleDate.toISOString().split("T")[0];

        // New calendar day — reset the session PnL accumulator. Live gets
        // this for free: lifecycle.js exits the process after EOD, and
        // tomorrow's boot reloads state.pnl from db.getRealizedPnlToday()
        // (today's trades only, by date). A backtest replay never restarts
        // — it's one continuous loop across the whole range — so without
        // this, state.pnl (a plain += accumulator, see positions.js) just
        // keeps growing across every day in the range instead of each day
        // starting fresh, same as it would running live.
        if (dayKey !== lastSeenDay) {
            state.pnl  = 0;
            lastSeenDay = dayKey;

            // Same "--- NAME  date/time ---" header engine.js prints once
            // at live boot — printed here on EVERY day the replay crosses,
            // purely as a visual barrier in the console output. A
            // multi-month backtest is one long, undifferentiated stream of
            // per-candle log lines otherwise; this is the same reason the
            // request for this came from watching that live header and
            // wanting the same "day starts here" cue in a replay.
            console.log();
            console.log(c.bold(`--- ${(context.name || context.tgPrefix || "").padEnd(12)} ${candleDate.toLocaleString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" })} ---`));
        }

        // New calendar day — lift yesterday's blackout so the strategy can
        // make decisions again starting from this candle.
        if (postEodBlackout && dayKey !== lastEodDate) {
            postEodBlackout = false;
        }

        if (!postEodBlackout) {
            await strategy.processCandle(currentCandle);
            await slCheck.checkSL(currentCandle);
        }

        const { hours, minutes } = istParts(candleDate);
        const pastEod = hours > context.eodHour || (hours === context.eodHour && minutes >= context.eodMinute);

        if (pastEod && !postEodBlackout) {
            postEodBlackout = true;
            lastEodDate     = dayKey;
            if (state.position) {
                await positionsClose(currentCandle.close, "EOD_FORCE");
                slStore.clearTrail();
            }
        }

        processed++;
        if (progress && processed % 100 === 0) progress(processed, feed.totalCandles());
    }
    if (progress) progress(processed, feed.totalCandles());

    // Mark-to-market close anything still open at the end of the range —
    // standard practice so the report reflects a complete, closed trade set
    // rather than an unrealized position with no exit recorded.
    if (state.position) {
        const lastClose = historicalCandles[historicalCandles.length - 1].close;
        await positionsClose(lastClose, "BACKTEST_END");
    }

    // Everything before `from` was warmup lookback, not part of what was
    // actually requested — a trade opened during it (however unlikely,
    // given how short the lookback window is relative to a real backtest
    // range) doesn't belong in the report the person asked for.
    const allTrades = ledger.getAllTrades();
    const trades    = allTrades.filter(t => new Date(t.entry_time) >= from);
    const metrics   = computeMetrics(trades);

    const report = buildReport({
        strategyKey, strategyLabel,
        underlying: context.name || context.tgPrefix,
        timeframe, from, to, params,
        metrics, trades, runAt: new Date(),
    });

    const paths = saveReport(report);
    return { report, paths };
}

module.exports = { runBacktest };
