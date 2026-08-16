// backtestFlow.js — the toolbox's [B] Backtest Strategy wizard.
//
// Deliberately takes toolbox.js's own ask()/pauseForReview()/ensureCsvLoaded()/
// pinStore/resolveCurrent/getDefinition/buildContext as injected dependencies
// rather than requiring toolbox.js back — avoids a circular require, and
// keeps this file a plain function toolbox.js can call, not a module that
// reaches back into toolbox.js's internals.
//
// Step 4 (candle close type) from the original spec is NOT a real picker
// here — neither DPI_TREND_MEANREV nor ALMA_BAND expose raw/HA as a
// configurable choice, both hardcode their own convention internally
// (DPI converts everything to HA; ALMA computes bands on raw candles but
// compares against HA close). Building a toggle that doesn't change
// anything would be misleading, so this step is shown as an informational
// line instead of a prompt.
"use strict";

const fs = require("fs");
const { KiteConnect } = require("kiteconnect");
const { STRATEGIES, STRATEGY_INFO, DEFAULT_STRATEGY } = require("./strategies");
const { TIMEFRAME_TO_INTERVAL } = require("./historicalFetch");
const { runBacktest } = require("./backtestRun");

const TIMEFRAMES = Object.keys(TIMEFRAME_TO_INTERVAL); // ["5m","15m","30m","1h"]

// Per-strategy tunable params exposed to Step 6. Not a folder-based
// metadata.js (that was explicitly declined) — just enough to drive a
// prompt loop without hardcoding a form per strategy in this file's body.
const STRATEGY_PARAMS = {
    DPI_TREND_MEANREV: [
        { key: "DPI_EFF_THRESH",   label: "DPI efficiency threshold (TREND/MEANREV split)" },
        { key: "MEANREV_RSI_BUY",  label: "MEANREV RSI buy level" },
        { key: "MEANREV_RSI_SELL", label: "MEANREV RSI sell level" },
        { key: "ST_ATR_LEN",       label: "SuperTrend ATR length" },
        { key: "ST_FACTOR",        label: "SuperTrend factor" },
        { key: "ATR_SL_MULT",      label: "ATR stop-loss multiplier" },
    ],
    ALMA_BAND: [
        { key: "ALMA_LEN",    label: "ALMA length" },
        { key: "ALMA_OFFSET", label: "ALMA offset" },
        { key: "ALMA_SIGMA",  label: "ALMA sigma" },
        { key: "ATR_SL_MULT", label: "ATR stop-loss multiplier" },
    ],
    ALMA_FAST: [
        { key: "ALMA_FAST_LEN",             label: "ALMA length" },
        { key: "ALMA_FAST_OFFSET",          label: "ALMA offset" },
        { key: "ALMA_FAST_SIGMA",           label: "ALMA sigma" },
        { key: "ALMA_FAST_DEADBAND_ATR_MULT", label: "Deadband (x ATR) \u2014 slope must clear this to count as a real direction" },
        { key: "ALMA_FAST_CHOP_MAX",        label: "Choppiness Index max (0-100) \u2014 above this blocks new entries" },
        { key: "ATR_SL_MULT",               label: "ATR stop-loss multiplier" },
    ],
    DPI_SMA5_EXIT: [
        { key: "DPI_BULL_THRESH",    label: "DPI bull threshold" },
        { key: "DPI_BEAR_THRESH",    label: "DPI bear threshold" },
        { key: "DPI_EFF_THRESH",     label: "DPI efficiency threshold" },
        { key: "DPI_SMA5_EXIT_LEN",  label: "SMA exit length" },
        { key: "ATR_SL_MULT",        label: "ATR stop-loss multiplier (this port's own addition \u2014 source script has no SL)" },
    ],
    ALMA_DUAL_BAND_SMA5: [
        { key: "ALMA_DUAL_SHORT_LEN", label: "ALMA short length" },
        { key: "ALMA_DUAL_LONG_LEN",  label: "ALMA long length" },
        { key: "ALMA_DUAL_OFFSET",   label: "ALMA offset (both lines)" },
        { key: "ALMA_DUAL_SIGMA",    label: "ALMA sigma (both lines)" },
        { key: "ALMA_DUAL_DIFF_PCT", label: "Short line's green/red threshold (% from long line)" },
        { key: "ALMA_LEN",           label: "Fallback band ALMA length (shared with ALMA_BAND)" },
        { key: "DPI_SMA5_EXIT_LEN",  label: "SMA exit length" },
        { key: "ATR_SL_MULT",        label: "ATR stop-loss multiplier (this port's own addition)" },
    ],
    MA_SLOPE: [
        { key: "MA_SLOPE_LEN",            label: "EMA length (on ohlc4)" },
        { key: "MA_SLOPE_ATR_LEN",        label: "ATR length used in the angle formula" },
        { key: "MA_SLOPE_FILTER_TOP",     label: "Angle threshold for decisive bull (degrees)" },
        { key: "MA_SLOPE_FILTER_BOTTOM",  label: "Angle threshold for decisive bear (degrees)" },
        { key: "ATR_SL_MULT",             label: "ATR stop-loss multiplier (this port's own addition \u2014 source script has no SL)" },
    ],
    // Same params as DPI_TREND_MEANREV — this is that same combo logic,
    // just registered under its own key now (see strategies.js).
    DPI_MEANREV: [
        { key: "DPI_EFF_THRESH",   label: "DPI efficiency threshold (TREND/MEANREV split)" },
        { key: "MEANREV_RSI_BUY",  label: "MEANREV RSI buy level" },
        { key: "MEANREV_RSI_SELL", label: "MEANREV RSI sell level" },
        { key: "ST_ATR_LEN",       label: "SuperTrend ATR length" },
        { key: "ST_FACTOR",        label: "SuperTrend factor" },
        { key: "ATR_SL_MULT",      label: "ATR stop-loss multiplier" },
    ],
    DYNAMIC_BAND: [
        { key: "BAND_STEP_DEFAULT", label: "Band step \u2014 fixed price distance between HIGH/MID/LOW (per-instrument override takes precedence live)" },
        // ST_ATR_LEN/ATR_SL_MULT deliberately NOT listed here — this
        // strategy has no ATR stop-loss (the reversal boundary is the
        // stop), so tuning them would be a no-op. Its sibling below does
        // use them.
    ],
    DYNAMIC_MID_COLOR: [
        { key: "BAND_STEP_DEFAULT", label: "Band step \u2014 fixed price distance between HIGH/MID/LOW (internal only, never plotted \u2014 per-instrument override takes precedence live)" },
        { key: "ST_ATR_LEN",        label: "ATR length (SL trail)" },
        { key: "ATR_SL_MULT",       label: "ATR stop-loss multiplier" },
    ],
    DYNAMIC_MID_COLOR_HL: [
        { key: "BAND_STEP_DEFAULT", label: "Band step \u2014 fixed price distance between HIGH/MID/LOW (internal only, never plotted \u2014 per-instrument override takes precedence live)" },
        { key: "ST_ATR_LEN",        label: "ATR length (SL trail)" },
        { key: "ATR_SL_MULT",       label: "ATR stop-loss multiplier" },
    ],
    ALMA_TRI_BAND: [
        { key: "ALMA_TRI_FAST_LEN",           label: "Fast ALMA length (HA close)" },
        { key: "ALMA_TRI_BAND_LEN",           label: "Band ALMA length (raw high/low)" },
        { key: "ALMA_TRI_ATR_LEN",            label: "ATR length (state thresholds only, not the SL trail)" },
        { key: "ALMA_TRI_COMPRESS_MULT",      label: "Compression multiplier (band-width sideways/grey filter)" },
        { key: "ALMA_TRI_SLOPE_MULT",         label: "Slope multiplier (decisive-direction threshold)" },
        { key: "ALMA_TRI_BIG_CANDLE_MULT",    label: "Big-candle multiplier (forces grey)" },
        { key: "ST_ATR_LEN",                  label: "ATR length (SL trail)" },
        { key: "ATR_SL_MULT",                 label: "ATR stop-loss multiplier" },
    ],
};

function fmtMoney(n) { return (n < 0 ? "-₹" : "₹") + Math.abs(n).toFixed(2); }

async function backtestFlow({ ask, pauseForReview, ensureCsvLoaded, pinStore, resolveCurrent, getDefinition, buildContext, defaultEodFor, c, engineConfig }) {
    // ── Step 1: Strategy ──────────────────────────────────────────────────
    const strategyKeys = Object.keys(STRATEGIES);
    console.log();
    console.log(c.bold("  Step 1/7 — Strategy"));
    strategyKeys.forEach((key, i) => {
        const info = STRATEGY_INFO[key] || { label: key, description: "" };
        console.log(`  ${String(i + 1).padStart(2)}. ${info.label}`);
        if (info.description) console.log(c.dim(`      ${info.description}`));
    });
    const stratInput = await ask("  select number: ");
    const strategyKey = strategyKeys[Number(stratInput) - 1];
    if (!strategyKey) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }
    const strategyLabel = (STRATEGY_INFO[strategyKey] || { label: strategyKey }).label;

    // ── Step 2: Instrument — same discovery Add Instrument uses ───────────
    console.log();
    console.log(c.bold("  Step 2/7 — Instrument"));
    const repo  = await ensureCsvLoaded();
    const all   = repo.listUnderlyings();
    const query = await ask("  search underlying (blank = show all): ");
    const matches = query ? all.filter(u => u.toLowerCase().includes(query.toLowerCase())) : all;
    if (matches.length === 0) { console.log(c.yellow("  no matches")); await pauseForReview(); return; }
    if (matches.length > 30 && query === "") {
        console.log(c.yellow(`  ${all.length} underlyings total — type part of a name to narrow it down`));
        await pauseForReview();
        return;
    }
    matches.forEach((u, i) => console.log(`  ${String(i + 1).padStart(2)}. ${u}`));
    const instPick = await ask("  select number: ");
    const underlying = matches[Number(instPick) - 1];
    if (!underlying) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }

    const def = getDefinition(underlying);
    let resolvedContract;
    try {
        resolvedContract = resolveCurrent(underlying, def, repo, pinStore).contract;
    } catch (err) {
        console.log(c.red(`  ${err.message}`));
        await pauseForReview();
        return;
    }
    const context = buildContext(def, resolvedContract);
    if (!context.lotMult) {
        console.log();
        console.log(c.yellow(`  ⚠ lot multiplier required for ${underlying}. The broker's lot_size field is a contract`));
        console.log(c.yellow(`    COUNT, not the real price multiplier, and can't be trusted as a default — this exact`));
        console.log(c.yellow(`    pattern (lot_size=1) already caused a real PnL bug once, on NatGas Mini (real multiplier`));
        console.log(c.yellow(`    was 250 MMBtu). Look up the actual contract spec before entering this.`));
        let lotMultOverride = null;
        do {
            const lotMultInput = await ask(`  lot multiplier — price move x this = PnL per lot (required, no default): `);
            if (!lotMultInput) { console.log(c.yellow("  required — enter the real contract multiplier, there's no safe default to fall back to")); continue; }
            const parsed = Number(lotMultInput);
            if (!Number.isFinite(parsed) || parsed <= 0) { console.log(c.yellow(`  "${lotMultInput}" isn't a valid positive number — try again`)); continue; }
            lotMultOverride = parsed;
        } while (lotMultOverride === null);
        context.lotMult = lotMultOverride;
    }
    console.log(c.dim(`  resolved: ${context.symbol} (token ${context.token})`));

    // ── Step 3: Timeframe ─────────────────────────────────────────────────
    console.log();
    console.log(c.bold("  Step 3/7 — Timeframe"));
    TIMEFRAMES.forEach((tf, i) => console.log(`  ${i + 1}. ${tf}`));
    const tfInput = await ask("  select number (default 15m): ");
    const timeframe = tfInput ? TIMEFRAMES[Number(tfInput) - 1] : "15m";
    if (!timeframe) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }

    // context.eodHour/eodMinute were derived from the STRATEGY's own
    // default timeframe (via getDefinition/buildContext above) — if the
    // person just picked a different timeframe for this backtest, EOD
    // needs to match THAT one instead, exactly like engine.js does for a
    // live TIMEFRAME_OVERRIDE. Only recompute if eodHour/eodMinute weren't
    // hand-overridden for this instrument in overrides.js (detected by
    // comparing against what the pre-pick default would have been) — an
    // explicit override still wins either way.
    const preTfPickDefault = defaultEodFor(context.timeframe, context.exchange);
    const eodWasDefault = context.eodHour === preTfPickDefault.eodHour && context.eodMinute === preTfPickDefault.eodMinute;
    context.timeframe = timeframe;
    if (eodWasDefault) {
        const newDefault  = defaultEodFor(timeframe, context.exchange);
        context.eodHour   = newDefault.eodHour;
        context.eodMinute = newDefault.eodMinute;
    }

    // ── Step 4: Candle close type — informational, see file header ───────
    console.log();
    console.log(c.bold("  Step 4/7 — Candle close type"));
    console.log(c.dim(`  ${strategyLabel} has its own fixed candle-type behavior (not user-selectable):`));
    const candleTypeNotes = {
        ALMA_BAND: "    bands and entry/exit signal both computed on Heikin-Ashi candles",
        ALMA_FAST: "    single ALMA computed entirely on Heikin-Ashi close, entry on its slope flipping",
        DPI_SMA5_EXIT: "    DPI and SMA5 exit both computed on RAW candles, not Heikin-Ashi \u2014 matches the source Pine script, which never converts to HA",
        ALMA_DUAL_BAND_SMA5: "    dual-ALMA trend lines + SMA5 exit on RAW candles; the ALMA_BAND fallback path specifically uses HA candles (same as the standalone ALMA_BAND strategy) \u2014 this one genuinely mixes both",
        MA_SLOPE: "    ema(ohlc4,56) and its angle both computed on RAW candles, not Heikin-Ashi \u2014 matches the source Pine script, which never converts to HA",
    };
    console.log(c.dim(candleTypeNotes[strategyKey] || "    all indicators (ST1/RSI/SMA9/DPI) run on Heikin-Ashi candles"));

    // ── Step 5: Historical range ──────────────────────────────────────────
    console.log();
    console.log(c.bold("  Step 5/7 — Historical range"));
    const rangeMode = (await ask("  [D] Days back (default)  [F] From/To dates: ")).trim().toUpperCase();
    let from, to;
    to = new Date();
    if (rangeMode === "F") {
        const fromStr = await ask("  from (YYYY-MM-DD): ");
        const toStr   = await ask("  to   (YYYY-MM-DD, blank = today): ");
        from = new Date(fromStr);
        if (toStr) to = new Date(toStr);
        if (isNaN(from.getTime()) || isNaN(to.getTime())) { console.log(c.yellow("  invalid date")); await pauseForReview(); return; }
    } else {
        const daysInput = await ask("  days back (default 30): ");
        const days = daysInput ? Number(daysInput) : 30;
        if (!Number.isFinite(days) || days <= 0) { console.log(c.yellow("  invalid days value")); await pauseForReview(); return; }
        from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    }

    // ── Step 6: Strategy parameters ───────────────────────────────────────
    console.log();
    console.log(c.bold("  Step 6/7 — Strategy parameters (blank = default)"));
    const paramDefs = STRATEGY_PARAMS[strategyKey] || [];
    const params = {};
    for (const p of paramDefs) {
        const defaultVal = engineConfig[p.key];
        const input = await ask(`  ${p.label} (default ${defaultVal}): `);
        if (input) {
            const parsed = Number(input);
            if (!Number.isFinite(parsed)) { console.log(c.yellow(`  invalid value for ${p.key}, using default`)); continue; }
            params[p.key] = parsed;
        }
    }

    // ── Step 7: Confirmation ───────────────────────────────────────────────
    console.log();
    console.log(c.bold("  Step 7/7 — Confirm"));
    console.log(`  Strategy:   ${strategyLabel}`);
    console.log(`  Instrument: ${underlying} (${context.symbol})`);
    console.log(`  Timeframe:  ${timeframe}`);
    console.log(`  Range:      ${from.toISOString().split("T")[0]} -> ${to.toISOString().split("T")[0]}`);
    console.log(`  Params:     ${Object.keys(params).length ? JSON.stringify(params) : "(all defaults)"}`);
    const confirm = (await ask("  Proceed? (Y/N): ")).trim().toUpperCase();
    if (confirm !== "Y") { console.log(c.dim("  cancelled")); await pauseForReview(); return; }

    // ── Run ────────────────────────────────────────────────────────────────
    const ACCESS_TOKEN = fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim();
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(ACCESS_TOKEN);

    console.log();
    console.log(c.dim("  fetching historical data + running replay..."));
    let result;
    try {
        result = await runBacktest({
            strategyKey, strategyLabel, context, timeframe, from, to, params, kc,
            progress: (done, total) => process.stdout.write(`\r  ${done}/${total} candles...`),
        });
    } catch (err) {
        console.log();
        console.log(c.red(`  backtest failed: ${err.message}`));
        await pauseForReview();
        return;
    }
    console.log();

    // ── Summary ────────────────────────────────────────────────────────────
    const m = result.report.metrics;
    console.log();
    console.log(c.bold("  ── Summary ──"));
    console.log(`  Trades:         ${m.trades}`);
    console.log(`  Win Rate:       ${(m.winRate * 100).toFixed(1)}%`);
    console.log(`  Profit Factor:  ${m.profitFactor === null ? "-" : m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}`);
    console.log(`  Net Points:     ${m.netPoints.toFixed(2)}`);
    console.log(`  Net PnL:        ${fmtMoney(m.netPnL)}`);
    console.log(`  Max Drawdown:   ${fmtMoney(m.maxDrawdown)}`);
    console.log(`  Largest Win:    ${fmtMoney(m.largestWin)}`);
    console.log(`  Largest Loss:   ${fmtMoney(m.largestLoss)}`);
    console.log(`  Avg Trade:      ${fmtMoney(m.avgTrade)}`);
    console.log();
    console.log(c.green(`  saved: ${result.paths.jsonPath}`));
    console.log(c.green(`         ${result.paths.htmlPath}`));

    await pauseForReview();
}

module.exports = { backtestFlow, STRATEGY_PARAMS };
