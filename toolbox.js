#!/usr/bin/env node
// toolbox.js — TAlgo-X operator terminal.
//
// CHANGED: instrument selection is no longer a fixed pre-registered list.
// "Add instrument" now browses/searches the broker's own live instrument
// dump (same CSV Repository engine.js uses) — pick any underlying that
// actually exists, set lots, and it starts running immediately. The main
// menu's list of instruments is read straight from PM2 (filtered by the
// UNDERLYING env var each process was started with), not from a config
// file — PM2 itself is the source of truth for "what's currently set up
// to run." Process names are ShortCode+Engine (ZnEngine, NgEngine, ...) —
// see shortNames.js.
//
// Run: node toolbox.js
"use strict";

const readline        = require("readline");
const fs               = require("fs");
const path             = require("path");
const pm2              = require("pm2");
const { KiteConnect }  = require("kiteconnect");
const c                = require("./c");
const engineConfig     = require("./engineConfig");
const { createCsvRepository }    = require("./csvRepository");
const { createInstrumentSource } = require("./instrumentSource");
const { createContractPinStore } = require("./contractPins");
const { resolveCurrent }         = require("./instrumentResolution");
const { getDefinition, buildContext, defaultEodFor } = require("./context");
const { STRATEGIES, STRATEGY_INFO, STRATEGY_TIMEFRAME, DEFAULT_STRATEGY } = require("./strategies");
const { INDICATOR_CATALOG } = require("./indicatorCatalog");
const customStrategyDb = require("./customStrategyDb");
const { TIMEFRAME_TO_INTERVAL, fetchDailyCandles } = require("./historicalFetch");
const { adx } = require("./indicators");
const { backtestFlow } = require("./backtestFlow");
const { playBootAnimation, renderStaticBanner, animateBoxUpward } = require("./bootAnimation");

const { getShortName } = require("./shortNames");
const { createMarketStateClient } = require("./marketStateClient");
const { createMarketWatchlist }   = require("./marketWatchlist");
const pinStore        = createContractPinStore();

// EOD shutdown (lifecycle.js) calls process.exit(0) intentionally at end of
// day. PM2's default autorestart would otherwise treat that clean exit as a
// crash and immediately spin the process back up — reopening trading right
// after the engine deliberately shut itself down for the day. stop_exit_codes
// tells PM2 "exit code 0 means deliberate stop, don't restart" while still
// auto-restarting on any OTHER (nonzero/crash) exit code.
const PM2_BASE_OPTS = { stop_exit_codes: [0] };

// ─── STATE ──────────────────────────────────────────────────────────────────
const selected = new Set();     // underlying names currently checked, from the PM2-derived list
let csvRepo    = null;          // lazy-loaded on first "Add instrument"
let equityCsvRepo = null;       // lazy-loaded on first NSE "Add instrument" / "Trending"

// ─── MARKET STATE ENGINE — client is cheap (only opens the DB file on
// first real query, see marketStateClient.js), watchlist is a flat JSON
// file read fresh each call — neither needs lazy-init ceremony the way
// csvRepo above does (that one triggers a real network/CSV load).
const marketStateClient = createMarketStateClient();
const marketWatchlist   = createMarketWatchlist();
const SCANNER_PROCESS_NAME = "MarketScanner";

// ─── READLINE HELPERS ─────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(prompt) {
    return new Promise(resolve => rl.question(prompt, answer => resolve(answer.trim())));
}
// Every action function ends with this. The main loop calls console.clear()
// on its very next renderMenu(), so without an explicit pause here, any
// success/error message printed by an action gets wiped before it's
// readable — exactly what happened with the token screen.
function pauseForReview() {
    return ask(c.dim("  press enter to continue..."));
}

// ─── PM2 HELPERS — callback API wrapped as promises ──────────────────────────
function pm2Connect() {
    return new Promise((resolve, reject) => pm2.connect(err => err ? reject(err) : resolve()));
}
function pm2List() {
    return new Promise((resolve, reject) => pm2.list((err, list) => err ? reject(err) : resolve(list)));
}
function pm2Start(opts) {
    return new Promise((resolve, reject) => pm2.start(opts, (err, proc) => err ? reject(err) : resolve(proc)));
}
function pm2Stop(name) {
    return new Promise((resolve, reject) => pm2.stop(name, (err, proc) => err ? reject(err) : resolve(proc)));
}
function pm2Restart(opts) {
    return new Promise((resolve, reject) => pm2.restart(opts, (err, proc) => err ? reject(err) : resolve(proc)));
}
function pm2Delete(name) {
    return new Promise((resolve, reject) => pm2.delete(name, (err, proc) => err ? reject(err) : resolve(proc)));
}

function fmtUptime(ms) {
    if (!ms || ms < 0) return "-";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h${m}m` : `${m}m`;
}

// Process name <-> underlying. PM2 names must avoid spaces/special chars,
// underlying names from the broker dump already look like "NATGASMINI" —
// sanitize defensively in case a future underlying has odd characters.
// PM2 process name: short code + "Engine" (ZnEngine, NgEngine, ...) instead
// of a talgo- prefix. Since there's no shared prefix to filter on anymore,
// getEngineProcesses() below identifies "our" processes by the UNDERLYING
// env var instead — every process this toolbox starts always sets it.
// Includes the strategy so the SAME underlying can run as multiple
// independent PM2 processes (e.g. ZINCMINI on both DPI_TREND_MEANREV and
// ALMA_BAND at once) — this used to be underlying-only, which meant
// starting a second strategy on an instrument already running silently
// collided with (and restarted/overwrote) the first, since PM2 process
// names have to be unique.
function toProcessName(underlying, strategy) {
    const stratShort = (STRATEGY_INFO[strategy] || { short: strategy }).short;
    return `${getShortName(underlying)}${stratShort}Engine`;
}

async function getEngineProcesses() {
    const list = await pm2List();
    return list
        .filter(p => p.pm2_env.env?.UNDERLYING)
        .map(p => ({
            name:      p.name,
            underlying: p.pm2_env.env.UNDERLYING,
            status:    p.pm2_env.status,
            uptime:    p.pm2_env.status === "online" ? Date.now() - p.pm2_env.pm_uptime : null,
            lots:      p.pm2_env.env?.LOTS_OVERRIDE || "default",
            lotMult:   p.pm2_env.env?.LOTMULT_OVERRIDE || null,
            live:      p.pm2_env.env?.LIVE_ORDERS_OVERRIDE === "true",
            carryOvernight: p.pm2_env.env?.CARRY_OVERNIGHT_OVERRIDE === "true",
            targetPoints: p.pm2_env.env?.TARGET_POINTS_OVERRIDE ? Number(p.pm2_env.env.TARGET_POINTS_OVERRIDE) : null,
            targetMode: p.pm2_env.env?.TARGET_MODE_OVERRIDE === "adaptive" ? "adaptive" : "fixed",
            bandStep: p.pm2_env.env?.BAND_STEP_OVERRIDE ? Number(p.pm2_env.env.BAND_STEP_OVERRIDE) : null,
            greyExitEnabled: p.pm2_env.env?.GREY_EXIT_OVERRIDE !== undefined ? p.pm2_env.env.GREY_EXIT_OVERRIDE === "true" : null,
            almaBandEnabled: p.pm2_env.env?.ALMA_BAND_OVERRIDE !== undefined ? p.pm2_env.env.ALMA_BAND_OVERRIDE === "true" : true,
            almaFastLen: p.pm2_env.env?.ALMA_FAST_LEN_OVERRIDE ? Number(p.pm2_env.env.ALMA_FAST_LEN_OVERRIDE) : null,
            almaBandLen: p.pm2_env.env?.ALMA_BAND_LEN_OVERRIDE ? Number(p.pm2_env.env.ALMA_BAND_LEN_OVERRIDE) : null,
            almaChopFilterEnabled: p.pm2_env.env?.ALMA_CHOP_FILTER_OVERRIDE !== undefined ? p.pm2_env.env.ALMA_CHOP_FILTER_OVERRIDE === "true" : true,
            maxDailyLoss: p.pm2_env.env?.MAX_DAILY_LOSS_OVERRIDE ? Number(p.pm2_env.env.MAX_DAILY_LOSS_OVERRIDE) : null,
            sessionTargetRupees: p.pm2_env.env?.SESSION_TARGET_OVERRIDE ? Number(p.pm2_env.env.SESSION_TARGET_OVERRIDE) : null,
            chopFilterEnabled: p.pm2_env.env?.CHOP_FILTER_OVERRIDE !== undefined ? p.pm2_env.env.CHOP_FILTER_OVERRIDE === "true" : true,
            chopPeriod: p.pm2_env.env?.CHOP_PERIOD_OVERRIDE ? Number(p.pm2_env.env.CHOP_PERIOD_OVERRIDE) : null,
            chopMax: p.pm2_env.env?.CHOP_MAX_OVERRIDE ? Number(p.pm2_env.env.CHOP_MAX_OVERRIDE) : null,
            disableDoubleOrders: p.pm2_env.env?.DISABLE_DOUBLE_ORDERS_OVERRIDE === "true",
            flipConfirmCandles: p.pm2_env.env?.FLIP_CONFIRM_CANDLES_OVERRIDE ? Number(p.pm2_env.env.FLIP_CONFIRM_CANDLES_OVERRIDE) : null,
            atrSlMult: p.pm2_env.env?.ATR_SL_MULT_OVERRIDE ? Number(p.pm2_env.env.ATR_SL_MULT_OVERRIDE) : null,
            strategy:  p.pm2_env.env?.STRATEGY_OVERRIDE || DEFAULT_STRATEGY,
            timeframe: p.pm2_env.env?.TIMEFRAME_OVERRIDE || STRATEGY_TIMEFRAME[p.pm2_env.env?.STRATEGY_OVERRIDE || DEFAULT_STRATEGY] || "15m",
            exchange:  p.pm2_env.env?.EXCHANGE_OVERRIDE || "MCX",
            outLogPath: p.pm2_env.pm_out_log_path,
            errLogPath: p.pm2_env.pm_err_log_path,
        }));
}

// ─── KITE CONNECT — lazy, cached, authenticated instance. Shared by
// ensureCsvLoaded (instrument dump) and scanTrendingInstruments (historical
// candles for ADX) — both need the same authenticated client, no reason to
// read the access-token file and construct a new one twice.
let kiteClient = null;
function ensureKite() {
    if (kiteClient) return kiteClient;
    const ACCESS_TOKEN = fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim();
    kiteClient = new KiteConnect({ api_key: engineConfig.API_KEY });
    kiteClient.setAccessToken(ACCESS_TOKEN);
    return kiteClient;
}

// ─── CSV REPOSITORY — lazy load, reused across "Add instrument" calls ───────
async function ensureCsvLoaded() {
    if (csvRepo) return csvRepo;
    console.log(c.dim("  loading instrument dump..."));
    const kc = ensureKite();
    csvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({
            filePath: engineConfig.INSTRUMENT_CSV_PATH,
            kc,
            exchange: "MCX",
        }).fetchRows,
    });
    await csvRepo.load();
    console.log(c.dim(`  loaded ${csvRepo.listUnderlyings().length} underlyings`));
    return csvRepo;
}

// NSE equities — separate CSV dump, separate cache. Kept as its own
// function (not a parameter on ensureCsvLoaded) since the two repos hold
// fundamentally different row shapes (futures with expiry vs equities
// without — see csvRepository.js) and callers should always know which one
// they're asking for.
async function ensureEquityCsvLoaded() {
    if (equityCsvRepo) return equityCsvRepo;
    console.log(c.dim("  loading NSE equity dump..."));
    const kc = ensureKite();
    equityCsvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({
            filePath: engineConfig.NSE_INSTRUMENT_CSV_PATH,
            kc,
            exchange: "NSE",
        }).fetchRows,
    });
    await equityCsvRepo.load();
    console.log(c.dim(`  loaded ${equityCsvRepo.listEquitySymbols().length} equities`));
    return equityCsvRepo;
}

// ─── EXCHANGE PICKER — shared by Add Instrument and Trending Instruments so
// both offer the same choice the same way. `list` is either futures
// underlyings (MCX) or equity tradingsymbols (NSE); which repo/list method
// applies depends entirely on which exchange was picked.
async function pickExchangeAndRepo() {
    const choice = (await ask("  exchange — [1] MCX Futures (default)  [2] NSE Stocks: ")).trim();
    if (choice === "2") {
        const repo = await ensureEquityCsvLoaded();
        return { exchange: "NSE", repo, list: repo.listEquitySymbols() };
    }
    const repo = await ensureCsvLoaded();
    return { exchange: "MCX", repo, list: repo.listUnderlyings() };
}

// Word-wraps text to the terminal's actual width (falls back to 80 cols
// when not a TTY / width unknown) and returns pre-indented lines — used
// anywhere the source text is a full sentence long enough to hard-wrap
// mid-word with no indent on a narrow mobile SSH terminal otherwise (the
// strategy picker's descriptions are the main case, see configureAndStartInstrument).
function wrapText(text, indent = "      ") {
    const width = Math.max(20, (process.stdout.columns || 80) - indent.length);
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (next.length > width && line) {
            lines.push(line);
            line = word;
        } else {
            line = next;
        }
    }
    if (line) lines.push(line);
    return lines.map(l => indent + l);
}

// ─── SCREENS ──────────────────────────────────────────────────────────────────
const BOX_WIDTH = 63;
// Computed fresh on every call (not cached) so a mid-session terminal
// resize is picked up naturally rather than centering against stale
// dimensions. Gracefully degrades to 0 (flush-left, today's old behavior)
// on a terminal narrower than the box itself — never a negative pad.
function boxLeftPad() {
    const cols = process.stdout.columns || 80;
    return " ".repeat(Math.max(0, Math.floor((cols - BOX_WIDTH) / 2)));
}
// Return strings rather than print directly — renderMenu() collects a full
// screen's worth of lines first, so it can choose to print them all at once
// (every redraw after the first) or animate them in one at a time (only
// the very first render, right after the boot animation, so the box
// doesn't just instantly pop in under the smoothly-revealed banner above it).
function boxLine(text = "") {
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");   // strip ANSI codes for length math
    const pad   = Math.max(0, BOX_WIDTH - 4 - plain.length);
    return `${boxLeftPad()}│ ${text}${" ".repeat(pad)} │`;
}
function boxDivider(ch = "─") { return `${boxLeftPad()}├${ch.repeat(BOX_WIDTH - 2)}┤`; }
function boxTop()    { return `${boxLeftPad()}┌${"─".repeat(BOX_WIDTH - 2)}┐`; }
function boxBottom() { return `${boxLeftPad()}└${"─".repeat(BOX_WIDTH - 2)}┘`; }

// Real column alignment via padEnd, not hand-counted spaces — hand-spacing
// broke the moment two labels in the same column had different lengths
// (e.g. "start" vs "live/paper"), which is exactly what happened before.
const HELP_CELL_WIDTH = 14;
function helpCell(key, label) {
    if (!key) return "".padEnd(HELP_CELL_WIDTH);
    return (key.padEnd(4) + label).padEnd(HELP_CELL_WIDTH);
}
const HELP_ROWS = [
    [["A", "Add"], ["1-9", "Toggle"], ["S", "Start"], ["X", "Stop"]],
    [["R", "Restart"], ["D", "Remove"], ["C", "Roll"], ["M", "Live/Paper"]],
    [["L", "Logs"], ["T", "Token"], ["B", "Backtest"], ["N", "Trending"]],
    [["Q", "Quit"], ["E", "Creds"], ["K", "Market"], ["P", "Edit Params"]],
    [["U", "Custom Strategy"], ["V", "Risk Mgmt"]],
];
function renderMenuHelpLines() {
    return HELP_ROWS.map(row => {
        const line = row.map(cell => cell ? helpCell(cell[0], cell[1]) : helpCell(null)).join("");
        return boxLine(c.dim(`  ${line}`));
    });
}

// True only for the very first call after boot — reset is never needed
// since the process lives for one toolbox session.
let firstMenuRender = true;
// See renderMenu() below for the full reasoning — TALGOX_PLAIN=1 opts out
// of the in-place clear+redraw for terminals that don't handle it well.
const PLAIN_MODE = process.env.TALGOX_PLAIN === "1";

async function renderMenu() {
    const procs = await getEngineProcesses();

    const lines = [];
    lines.push(boxTop());
    lines.push(boxLine(c.bold("  T A L G O - X   T O O L B O X")));
    lines.push(boxDivider("═"));

    if (procs.length === 0) {
        lines.push(boxLine(c.dim("  no instruments running — press A to add one")));
    } else {
        // INSTRUMENT now shows underlying/strategy — necessary, not just
        // nice-to-have, now that the same underlying can run under more
        // than one strategy as separate processes (see toProcessName).
        // Built via padEnd rather than hand-counted spaces, matching
        // helpCell's own reasoning above: hand-spacing breaks the moment
        // two labels in the column have different lengths.
        const INST_COL_WIDTH = 18;
        lines.push(boxLine(c.dim(`  # ${"INSTRUMENT".padEnd(INST_COL_WIDTH)} LOTS   MULT   MODE     STATUS`)));
        lines.push(boxDivider());
        procs.forEach((p, i) => {
            const box  = selected.has(p.name) ? "x" : " ";
            const num  = String(i + 1).padStart(2);
            const stratShort = (STRATEGY_INFO[p.strategy] || { short: p.strategy }).short;
            const inst = `${p.underlying}/${stratShort}`.padEnd(INST_COL_WIDTH);
            const lots = String(p.lots).padEnd(6);
            const mult = String(p.lotMult ?? "-").padEnd(6);
            const mode = p.live ? c.red("LIVE ") : c.cyan("PAPER");

            let statusStr;
            if (p.status === "online") statusStr = c.green(`● ${fmtUptime(p.uptime)}`);
            else                        statusStr = c.red(`● ${p.status.toUpperCase()}`);

            lines.push(boxLine(`[${box}] ${num}. ${inst} ${lots} ${mult} ${mode}  ${statusStr}`));
        });
    }

    lines.push(boxDivider("═"));
    lines.push(...renderMenuHelpLines());
    lines.push(boxBottom());

    // Terminal capability toggle. Full console.clear() + redraw on every
    // render gives a proper in-place "dashboard" feel and is what almost
    // every terminal — including a normal desktop one — handles correctly.
    // One specific mobile SSH app was confirmed BROKEN under repeated
    // console.clear() calls (not from content overflowing the visible
    // rows — total content comfortably fit — the repeated clearing itself
    // misbehaved on that app specifically). That can't be reliably
    // auto-detected from here, so TALGOX_PLAIN=1 is an explicit opt-in
    // fallback to the safe "never clear, just scroll" mode for whichever
    // terminal actually needs it. Default (unset) is the in-place redraw.
    if (PLAIN_MODE) {
        if (firstMenuRender) {
            firstMenuRender = false;
            console.clear();
            renderStaticBanner({ topMargin: 2, bottomMargin: 1 });
            await animateBoxUpward(lines);
        } else {
            console.log();
            lines.forEach(line => console.log(line));
        }
    } else {
        console.clear();
        renderStaticBanner({ topMargin: 2, bottomMargin: 1 });
        if (firstMenuRender) {
            firstMenuRender = false;
            await animateBoxUpward(lines);
        } else {
            lines.forEach(line => console.log(line));
        }
    }
    console.log();

    return procs;
}

// pm2.restart(..., updateEnv:true, env:{...}) REPLACES the process's entire
// env with whatever's passed — it does not merge. Passing a partial env
// (e.g. only LIVE_ORDERS_OVERRIDE) silently wipes UNDERLYING and any other
// override, which is exactly what caused a toggled instrument to vanish
// from the menu and risked silently falling back to the default instrument.
// Every restart call rebuilds the FULL env from here, never a partial one.
function buildProcessEnv(p, overrides = {}) {
    const env = {
        UNDERLYING: p.underlying,
        LIVE_ORDERS_OVERRIDE: String(!!p.live),
        CARRY_OVERNIGHT_OVERRIDE: String(!!p.carryOvernight),
        STRATEGY_OVERRIDE: p.strategy || DEFAULT_STRATEGY,
        TIMEFRAME_OVERRIDE: p.timeframe || STRATEGY_TIMEFRAME[p.strategy || DEFAULT_STRATEGY] || "15m",
        // Was missing here — same bug class as the one found in webdash's
        // server.js port of this same function: getEngineProcesses() above
        // already reads EXCHANGE_OVERRIDE back off the running process, but
        // nothing wrote it into a REBUILT env, so any restart through
        // toggleMode() on an NSE instrument would silently fall back to
        // engine.js's own MCX default on the next boot. Fixed here at the
        // same time as adding BAND_STEP_OVERRIDE below, since I was already
        // touching this exact function.
        EXCHANGE_OVERRIDE: p.exchange || "MCX",
    };
    if (p.lots !== "default") env.LOTS_OVERRIDE = String(p.lots);
    if (p.lotMult) env.LOTMULT_OVERRIDE = String(p.lotMult);
    if (p.targetPoints) env.TARGET_POINTS_OVERRIDE = String(p.targetPoints);
    // Only meaningful when targetPoints is unset (adaptive picks its own
    // points per-position — see adaptiveTarget.js); still written whenever
    // set regardless, same as every other *_OVERRIDE here, so a restart
    // through toggleMode()/editInstrument() never silently drops it back
    // to engine.js's "fixed" default.
    if (p.targetMode === "adaptive") env.TARGET_MODE_OVERRIDE = "adaptive";
    if ((p.strategy === "DYNAMIC_BAND" || p.strategy === "DYNAMIC_MID_COLOR" || p.strategy === "DYNAMIC_MID_COLOR_HL") && p.bandStep) env.BAND_STEP_OVERRIDE = String(p.bandStep);
    if (p.strategy === "ALMA_TRI_BAND" && p.greyExitEnabled !== null && p.greyExitEnabled !== undefined) env.GREY_EXIT_OVERRIDE = String(p.greyExitEnabled);
    if (p.strategy === "ALMA_PRO_FAST" && p.almaBandEnabled === false) env.ALMA_BAND_OVERRIDE = "false";
    if (p.strategy === "ALMA_PRO_FAST" && p.almaFastLen) env.ALMA_FAST_LEN_OVERRIDE = String(p.almaFastLen);
    if (p.strategy === "ALMA_PRO_FAST" && p.almaBandLen) env.ALMA_BAND_LEN_OVERRIDE = String(p.almaBandLen);
    if ((p.strategy === "ALMA_PRO_FAST" || p.strategy === "ALMA_PRO_SLOW") && p.almaChopFilterEnabled === false) env.ALMA_CHOP_FILTER_OVERRIDE = "false";
    if (p.strategy !== "ALMA_PRO_FAST" && p.strategy !== "ALMA_PRO_SLOW") {
        // Always written explicitly (both true AND false), not just when
        // disabling — an unset env var means OFF at runtime (isChopBlocked
        // treats null as not-blocked, the safe default for anything never
        // touched by this toolbox flow), which would silently contradict
        // this prompt's own "default: Y" if a blank/Y answer just left the
        // env var unset instead of writing "true".
        env.CHOP_FILTER_OVERRIDE = p.chopFilterEnabled === false ? "false" : "true";
        if (p.chopPeriod) env.CHOP_PERIOD_OVERRIDE = String(p.chopPeriod);
        if (p.chopMax) env.CHOP_MAX_OVERRIDE = String(p.chopMax);
    }
    // Double-order gate — always written explicitly (both true AND false),
    // same "unset is ambiguous" reasoning as CHOP_FILTER_OVERRIDE above.
    // Default false = allowed, matching context.js's own default.
    env.DISABLE_DOUBLE_ORDERS_OVERRIDE = p.disableDoubleOrders === true ? "true" : "false";
    if (p.maxDailyLoss) env.MAX_DAILY_LOSS_OVERRIDE = String(p.maxDailyLoss);
    if (p.sessionTargetRupees) env.SESSION_TARGET_OVERRIDE = String(p.sessionTargetRupees);
    // Universal (unread by strategies with no ATR trail at all).
    if (p.atrSlMult) env.ATR_SL_MULT_OVERRIDE = String(p.atrSlMult);
    // PURE_HA only, but harmless to always write when set regardless of
    // p.strategy — every other strategy simply never reads it.
    if (p.flipConfirmCandles) env.FLIP_CONFIRM_CANDLES_OVERRIDE = String(p.flipConfirmCandles);
    return { ...env, ...overrides };
}

async function toggleMode(procs) {
    const targets = procs.filter(p => selected.has(p.name));
    if (targets.length === 0) { console.log(c.yellow("  nothing selected")); await pauseForReview(); return; }

    for (const p of targets) {
        const goingLive = !p.live;
        if (goingLive) {
            const confirmLive = (await ask(c.red(`  switch ${p.underlying} to LIVE — real orders. type "LIVE" to confirm: `))).trim();
            if (confirmLive !== "LIVE") { console.log(c.dim(`  ${p.underlying} left in paper mode`)); continue; }
        }
        // Carry-overnight — asked on every mode switch so it's never left
        // stale from before (e.g. going live shouldn't silently inherit a
        // carry setting picked back when this was paper). Shows current
        // value as the default (blank = keep).
        const carryDefault = !!p.carryOvernight;
        const carryInput = (await ask(`  carry position overnight? [y/N] (current: ${carryDefault ? "Y" : "N"}, blank = keep): `)).trim().toUpperCase();
        const carryOvernight = carryInput ? carryInput === "Y" : carryDefault;
        if (carryOvernight && !carryDefault) {
            console.log(c.yellow(`  ⚠ carry-overnight ON — entries will use NRML (not MIS), EOD will hold the position instead of closing it.`));
        }
        try {
            await pm2Restart({
                ...PM2_BASE_OPTS, script: "engine.js", name: p.name, cwd: __dirname, updateEnv: true,
                env: buildProcessEnv(p, { LIVE_ORDERS_OVERRIDE: String(goingLive), CARRY_OVERNIGHT_OVERRIDE: String(carryOvernight) }),
            });
            const carryTag = carryOvernight ? c.yellow(" CARRY") : "";
            console.log(c.green(`  ${p.underlying} -> ${goingLive ? c.red("LIVE") : c.cyan("PAPER")}${carryTag} (restarted)`));
        } catch (err) {
            console.log(c.red(`  failed to switch ${p.underlying}: ${err.message}`));
        }
    }
    await pauseForReview();
}

// ─── EDIT INSTRUMENT PARAMS — same restart-in-place pattern as toggleMode:
// take the running process's own values as defaults, ask only what changes,
// rebuild the FULL env through buildProcessEnv (never a partial patch — see
// the comment on buildProcessEnv about the bug that caused), pm2Restart.
// Exists so tuning a live instrument (target, lots, ...) doesn't require
// going through "Add instrument" and hitting the same-underlying-same-
// strategy duplicate block — that block is correct for preventing two
// processes racing the same underlying+strategy, but it also means "Add"
// can't be used to edit something already running. This is that edit path.
async function editInstrument(procs) {
    const targets = procs.filter(p => selected.has(p.name));
    if (targets.length === 0) { console.log(c.yellow("  nothing selected")); await pauseForReview(); return; }

    for (const p of targets) {
        console.log();
        console.log(c.dim(`  editing ${p.underlying} (${(STRATEGY_INFO[p.strategy] || { label: p.strategy }).label}) — blank keeps current value`));

        // Target points — mirrors configureAndStartInstrument's prompt.
        // "0" or "clear" removes an existing target (goes back to
        // strategy-only exits); blank keeps whatever's set now.
        const targetDefault = p.targetPoints !== null ? String(p.targetPoints) : "none";
        const targetInput = (await ask(`  profit target in points (current: ${targetDefault}, "0"/"clear" to remove, blank = keep): `)).trim();
        let targetPoints = p.targetPoints;
        if (targetInput) {
            if (targetInput === "0" || targetInput.toLowerCase() === "clear") {
                targetPoints = null;
            } else {
                const parsedTarget = Number(targetInput);
                if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
                    console.log(c.yellow(`  "${targetInput}" isn't a valid positive number — target left unchanged (${targetDefault})`));
                } else {
                    targetPoints = parsedTarget;
                }
            }
        }

        // Adaptive target mode — only asked when there's no fixed points
        // value in play (targetPoints wins outright when set, same rule as
        // the add-instrument prompt). Switching FIXED<->ADAPTIVE (or vice
        // versa) only takes effect for the NEXT position this instrument
        // opens — an already-open position keeps whatever target it already
        // armed (candlePoll.js's checkTarget only arms once, at entry).
        let targetMode = p.targetMode || "fixed";
        if (targetPoints === null) {
            const adaptiveDefault = targetMode === "adaptive" ? "Y" : "N";
            const adaptiveInput = (await ask(`  adaptive target sizing? [y/N] (current: ${adaptiveDefault}, blank = keep): `)).trim().toUpperCase();
            if (adaptiveInput) targetMode = adaptiveInput === "Y" ? "adaptive" : "fixed";
        } else {
            targetMode = "fixed"; // a fixed points value always wins — keep the two fields consistent
        }

        // Session target — mutually exclusive with targetPoints/targetMode
        // above (candlePoll.js's checkSessionTarget vs. checkTarget — see
        // context.js). Setting one here clears the other, keeping that
        // exclusivity intact through an edit the same way the add-instrument
        // wizard enforces it at creation.
        const sessionTargetDefault = p.sessionTargetRupees !== null ? String(p.sessionTargetRupees) : "none";
        const sessionTargetInput = (await ask(`  session profit ceiling in rupees, whole day (current: ${sessionTargetDefault}, "0"/"clear" to remove, blank = keep): `)).trim();
        let sessionTargetRupees = p.sessionTargetRupees;
        if (sessionTargetInput) {
            if (sessionTargetInput === "0" || sessionTargetInput.toLowerCase() === "clear") {
                sessionTargetRupees = null;
            } else {
                const parsedSessionTarget = Number(sessionTargetInput);
                if (!Number.isFinite(parsedSessionTarget) || parsedSessionTarget <= 0) {
                    console.log(c.yellow(`  "${sessionTargetInput}" isn't a valid positive number — session target left unchanged (${sessionTargetDefault})`));
                } else {
                    sessionTargetRupees = parsedSessionTarget;
                    if (targetPoints !== null || targetMode === "adaptive") {
                        console.log(c.dim(`  session target set — clearing the per-trade target (they're mutually exclusive)`));
                        targetPoints = null;
                        targetMode = "fixed";
                    }
                }
            }
        }
        if (sessionTargetRupees !== null && (targetPoints !== null || targetMode === "adaptive")) {
            // Only reachable if targetPoints/targetMode were just changed
            // ABOVE in this same edit pass while an old session target was
            // still in play from before — same tie-break, other direction.
            console.log(c.dim(`  per-trade target set — clearing the session target (they're mutually exclusive)`));
            sessionTargetRupees = null;
        }

        // Lots — same shape as the add-instrument prompt.
        const lotsDefault = p.lots === "default" ? "1" : p.lots;
        const lotsInput = (await ask(`  lots (current: ${lotsDefault}, blank = keep): `)).trim();
        let lots = p.lots;
        if (lotsInput) {
            const parsedLots = Number(lotsInput);
            if (!Number.isFinite(parsedLots) || parsedLots <= 0) {
                console.log(c.yellow(`  "${lotsInput}" isn't a valid positive number — lots left unchanged (${lotsDefault})`));
            } else {
                lots = String(parsedLots);
            }
        }

        // Strategy-specific fields — only asked for the strategy actually
        // running, same conditions as configureAndStartInstrument.
        let bandStep = p.bandStep;
        if (p.strategy === "DYNAMIC_BAND" || p.strategy === "DYNAMIC_MID_COLOR" || p.strategy === "DYNAMIC_MID_COLOR_HL") {
            const bandDefault = p.bandStep ?? engineConfig.BAND_STEP_DEFAULT;
            const bandInput = (await ask(`  band step in price points (current: ${bandDefault}, blank = keep): `)).trim();
            if (bandInput) {
                const parsedStep = Number(bandInput);
                if (!Number.isFinite(parsedStep) || parsedStep <= 0) {
                    console.log(c.yellow(`  "${bandInput}" isn't a valid positive number — band step left unchanged (${bandDefault})`));
                } else {
                    bandStep = parsedStep;
                }
            }
        }
        let greyExitEnabled = p.greyExitEnabled;
        if (p.strategy === "ALMA_TRI_BAND") {
            const greyDefault = p.greyExitEnabled ?? engineConfig.GREY_EXIT_DEFAULT;
            const greyInput = (await ask(`  exit on grey state? [y/N] (current: ${greyDefault ? "Y" : "N"}, blank = keep): `)).trim().toUpperCase();
            if (greyInput) greyExitEnabled = greyInput === "Y";
        }
        // ALMA band enable/disable — ALMA_PRO_FAST only. OFF drops the
        // band-compression/breakout gate entirely and trades on slope
        // alone (strong_up/strong_down, no aboveBand/belowBand check, no
        // forced-sideways-on-compression) — see createAlmaProFastStrategy
        // in strategies.js for exactly what each mode does.
        let almaBandEnabled = p.almaBandEnabled;
        if (p.strategy === "ALMA_PRO_FAST") {
            const bandDefault = p.almaBandEnabled !== false;
            const bandEnableInput = (await ask(`  use ALMA band gate? [Y/n] (current: ${bandDefault ? "Y" : "N"}, blank = keep): `)).trim().toUpperCase();
            if (bandEnableInput) almaBandEnabled = bandEnableInput !== "N";
        }
        // ALMA fast/band length — ALMA_PRO_FAST only. "0"/"clear" resets to
        // engineConfig's default (ALMA_PRO_FAST_LEN/ALMA_PRO_BAND_LEN);
        // blank keeps whatever's currently set.
        let almaFastLen = p.almaFastLen;
        let almaBandLen = p.almaBandLen;
        if (p.strategy === "ALMA_PRO_FAST") {
            const fastLenDefault = almaFastLen ?? `default (${engineConfig.ALMA_PRO_FAST_LEN})`;
            const fastLenInput = (await ask(`  fast ALMA length (current: ${fastLenDefault}, "0"/"clear" to reset, blank = keep): `)).trim();
            if (fastLenInput) {
                if (fastLenInput === "0" || fastLenInput.toLowerCase() === "clear") {
                    almaFastLen = null;
                } else {
                    const parsedFastLen = Number(fastLenInput);
                    if (!Number.isFinite(parsedFastLen) || parsedFastLen <= 0) {
                        console.log(c.yellow(`  "${fastLenInput}" isn't a valid positive number — fast length left unchanged`));
                    } else {
                        almaFastLen = parsedFastLen;
                    }
                }
            }
            if (almaBandEnabled) {
                const bandLenDefault = almaBandLen ?? `default (${engineConfig.ALMA_PRO_BAND_LEN})`;
                const bandLenInput = (await ask(`  band ALMA length (current: ${bandLenDefault}, "0"/"clear" to reset, blank = keep): `)).trim();
                if (bandLenInput) {
                    if (bandLenInput === "0" || bandLenInput.toLowerCase() === "clear") {
                        almaBandLen = null;
                    } else {
                        const parsedBandLen = Number(bandLenInput);
                        if (!Number.isFinite(parsedBandLen) || parsedBandLen <= 0) {
                            console.log(c.yellow(`  "${bandLenInput}" isn't a valid positive number — band length left unchanged`));
                        } else {
                            almaBandLen = parsedBandLen;
                        }
                    }
                }
            }
        }

        // Choppiness Index entry filter toggle — ALMA_PRO_FAST/ALMA_PRO_SLOW only.
        let almaChopFilterEnabled = p.almaChopFilterEnabled;
        if (p.strategy === "ALMA_PRO_FAST" || p.strategy === "ALMA_PRO_SLOW") {
            const chopFilterDefault = p.almaChopFilterEnabled !== false;
            const chopFilterInput = (await ask(`  use Choppiness Index entry filter? [Y/n] (current: ${chopFilterDefault ? "Y" : "N"}, blank = keep): `)).trim().toUpperCase();
            if (chopFilterInput) almaChopFilterEnabled = chopFilterInput !== "N";
        }

        // Choppiness Index entry filter — available for any strategy except
        // ALMA_PRO_FAST/SLOW (they keep their own dedicated, pre-existing
        // toggle above — almaChopFilterEnabled). This is the universal one
        // (chopGate.js's isChopBlocked, called from every other strategy's
        // own entry site) — configurable period + max threshold, not just
        // a toggle.
        let chopFilterEnabled = p.chopFilterEnabled;
        let chopPeriod = p.chopPeriod;
        let chopMax = p.chopMax;
        if (p.strategy !== "ALMA_PRO_FAST" && p.strategy !== "ALMA_PRO_SLOW") {
            const chopFilterDefault = p.chopFilterEnabled !== false;
            const chopFilterInput = (await ask(`  use Choppiness Index entry filter? [Y/n] (current: ${chopFilterDefault ? "Y" : "N"}, blank = keep): `)).trim().toUpperCase();
            if (chopFilterInput) chopFilterEnabled = chopFilterInput !== "N";

            if (chopFilterEnabled) {
                const periodDefault = chopPeriod !== null ? String(chopPeriod) : "14 (default)";
                const periodInput = (await ask(`  Choppiness Index period (current: ${periodDefault}, "0"/"clear" for default, blank = keep): `)).trim();
                if (periodInput) {
                    if (periodInput === "0" || periodInput.toLowerCase() === "clear") {
                        chopPeriod = null;
                    } else {
                        const parsedPeriod = Number(periodInput);
                        if (Number.isFinite(parsedPeriod) && parsedPeriod > 0) chopPeriod = parsedPeriod;
                        else console.log(c.yellow(`  "${periodInput}" isn't a valid positive number — period left unchanged`));
                    }
                }
                const maxDefault = chopMax !== null ? String(chopMax) : "50 (default)";
                const maxInput = (await ask(`  Choppiness Index max threshold (current: ${maxDefault}, "0"/"clear" for default, blank = keep): `)).trim();
                if (maxInput) {
                    if (maxInput === "0" || maxInput.toLowerCase() === "clear") {
                        chopMax = null;
                    } else {
                        const parsedMax = Number(maxInput);
                        if (Number.isFinite(parsedMax) && parsedMax > 0) chopMax = parsedMax;
                        else console.log(c.yellow(`  "${maxInput}" isn't a valid positive number — max threshold left unchanged`));
                    }
                }
            }
        }

        // Double-order gate — universal, opt-in, default OFF (allowed).
        // When double orders stay allowed, any 2nd+ entry that session
        // ALSO gets a forced Choppiness Index check regardless of the
        // chopFilterEnabled setting above — see chopGate.js's `force`
        // option and doubleOrderGate.js.
        const doubleOrderDefault = p.disableDoubleOrders === true;
        const doubleOrderInput = (await ask(`  disable double orders (max 1 entry/session)? [y/N] (current: ${doubleOrderDefault ? "Y" : "N"}, blank = keep): `)).trim().toUpperCase();
        let disableDoubleOrders = p.disableDoubleOrders;
        if (doubleOrderInput) disableDoubleOrders = doubleOrderInput === "Y";
        if (!disableDoubleOrders) {
            console.log(c.dim(`  double orders stay allowed — any 2nd+ entry this session will force a Choppiness Index check`));
        }

        // ATR stop-loss multiplier — universal, but only read by
        // strategies that call computeTrail() (not PURE_HA/DYNAMIC_BAND/
        // DYNAMIC_MID_COLOR(_HL)). "0"/"clear" reverts to the global
        // engineConfig.ATR_SL_MULT default; blank keeps whatever's set.
        const atrSlMultDefault = p.atrSlMult !== null ? String(p.atrSlMult) : `default (${engineConfig.ATR_SL_MULT})`;
        const atrSlMultInput = (await ask(`  ATR stop-loss multiplier (current: ${atrSlMultDefault}, "0"/"clear" for default, blank = keep): `)).trim();
        let atrSlMult = p.atrSlMult;
        if (atrSlMultInput) {
            if (atrSlMultInput === "0" || atrSlMultInput.toLowerCase() === "clear") {
                atrSlMult = null;
            } else {
                const parsedAtrMult = Number(atrSlMultInput);
                if (!Number.isFinite(parsedAtrMult) || parsedAtrMult <= 0) {
                    console.log(c.yellow(`  "${atrSlMultInput}" isn't a valid positive number — ATR multiplier left unchanged (${atrSlMultDefault})`));
                } else {
                    atrSlMult = parsedAtrMult;
                }
            }
        }

        // Anti-whipsaw flip confirmation — PURE_HA only. How many
        // CONSECUTIVE opposite-color HA candles are required before an
        // already-open position actually flips. "0"/"clear"/"1" all mean
        // immediate flip (today's original behavior).
        let flipConfirmCandles = p.flipConfirmCandles;
        if (p.strategy === "PURE_HA") {
            const flipDefault = p.flipConfirmCandles !== null ? String(p.flipConfirmCandles) : "1 (immediate flip)";
            const flipInput = (await ask(`  reversal candles required to flip, anti-whipsaw (current: ${flipDefault}, "0"/"clear" for immediate, blank = keep): `)).trim();
            if (flipInput) {
                if (flipInput === "0" || flipInput.toLowerCase() === "clear") {
                    flipConfirmCandles = null;
                } else {
                    const parsedConfirm = Number(flipInput);
                    if (!Number.isInteger(parsedConfirm) || parsedConfirm < 1) {
                        console.log(c.yellow(`  "${flipInput}" isn't a valid whole number >= 1 — left unchanged (${flipDefault})`));
                    } else {
                        flipConfirmCandles = parsedConfirm;
                    }
                }
            }
        }

        // Max daily loss circuit breaker — universal. "0"/"clear" removes
        // the floor entirely; blank keeps whatever's currently set.
        const maxDailyLossDefault = p.maxDailyLoss !== null ? String(p.maxDailyLoss) : "none";
        const maxDailyLossInput = (await ask(`  max daily loss in rupees (current: ${maxDailyLossDefault}, "0"/"clear" to remove, blank = keep): `)).trim();
        let maxDailyLoss = p.maxDailyLoss;
        if (maxDailyLossInput) {
            if (maxDailyLossInput === "0" || maxDailyLossInput.toLowerCase() === "clear") {
                maxDailyLoss = null;
            } else {
                const parsedLoss = Number(maxDailyLossInput);
                if (!Number.isFinite(parsedLoss) || parsedLoss <= 0) {
                    console.log(c.yellow(`  "${maxDailyLossInput}" isn't a valid positive number — daily loss floor left unchanged (${maxDailyLossDefault})`));
                } else {
                    maxDailyLoss = parsedLoss;
                }
            }
        }

        const updatedP = { ...p, lots, targetPoints, targetMode, bandStep, greyExitEnabled, almaBandEnabled, almaFastLen, almaBandLen, almaChopFilterEnabled, maxDailyLoss, sessionTargetRupees, chopFilterEnabled, chopPeriod, chopMax, disableDoubleOrders, atrSlMult, flipConfirmCandles };
        try {
            await pm2Restart({
                ...PM2_BASE_OPTS, script: "engine.js", name: p.name, cwd: __dirname, updateEnv: true,
                env: buildProcessEnv(updatedP),
            });
            const targetTag = targetPoints !== null ? c.yellow(` target:${targetPoints}pt`) : targetMode === "adaptive" ? c.yellow(" target:adaptive") : sessionTargetRupees !== null ? c.yellow(` target:session+₹${sessionTargetRupees}`) : c.dim(" target:none");
            const chopTag = p.strategy !== "ALMA_PRO_FAST" && p.strategy !== "ALMA_PRO_SLOW"
                ? (chopFilterEnabled ? c.dim(` chop:${chopPeriod ?? 14}/${chopMax ?? 50}`) : c.yellow(" chop:off"))
                : (p.strategy === "ALMA_PRO_FAST" || p.strategy === "ALMA_PRO_SLOW") && !almaChopFilterEnabled ? c.yellow(" chop:off") : "";
            console.log(c.green(`  ${p.underlying} updated${targetTag}${chopTag} lots:${lots === "default" ? "1" : lots} (restarted)`));
        } catch (err) {
            console.log(c.red(`  failed to update ${p.underlying}: ${err.message}`));
        }
    }
    await pauseForReview();
}

// ─── RISK MANAGEMENT — a consolidated view/edit of every risk-limiting
// setting in one place, instead of hunting for them scattered through
// editInstrument's full field list. Same targets (selected set), same
// buildProcessEnv() + pm2Restart() apply mechanism as editInstrument —
// this is a narrower prompt sequence over the exact same underlying
// fields, not a separate code path for applying them.
async function riskManagement(procs) {
    const targets = procs.filter(p => selected.has(p.name));
    if (targets.length === 0) { console.log(c.yellow("  nothing selected")); await pauseForReview(); return; }

    for (const p of targets) {
        console.log();
        console.log(c.dim(`  risk settings for ${p.underlying} (${(STRATEGY_INFO[p.strategy] || { label: p.strategy }).label}) — blank keeps current value`));

        // Choppiness Index entry filter toggle — ALMA_PRO_FAST/ALMA_PRO_SLOW only.
        let almaChopFilterEnabled = p.almaChopFilterEnabled;
        if (p.strategy === "ALMA_PRO_FAST" || p.strategy === "ALMA_PRO_SLOW") {
            const chopFilterDefault = p.almaChopFilterEnabled !== false;
            const chopFilterInput = (await ask(`  use Choppiness Index entry filter? [Y/n] (current: ${chopFilterDefault ? "Y" : "N"}, blank = keep): `)).trim().toUpperCase();
            if (chopFilterInput) almaChopFilterEnabled = chopFilterInput !== "N";
        }

        // Choppiness Index entry filter — universal (every other strategy).
        let chopFilterEnabled = p.chopFilterEnabled;
        let chopPeriod = p.chopPeriod;
        let chopMax = p.chopMax;
        if (p.strategy !== "ALMA_PRO_FAST" && p.strategy !== "ALMA_PRO_SLOW") {
            const chopFilterDefault = p.chopFilterEnabled !== false;
            const chopFilterInput = (await ask(`  use Choppiness Index entry filter? [Y/n] (current: ${chopFilterDefault ? "Y" : "N"}, blank = keep): `)).trim().toUpperCase();
            if (chopFilterInput) chopFilterEnabled = chopFilterInput !== "N";

            if (chopFilterEnabled) {
                const periodDefault = chopPeriod !== null ? String(chopPeriod) : "14 (default)";
                const periodInput = (await ask(`  Choppiness Index period (current: ${periodDefault}, "0"/"clear" for default, blank = keep): `)).trim();
                if (periodInput) {
                    if (periodInput === "0" || periodInput.toLowerCase() === "clear") {
                        chopPeriod = null;
                    } else {
                        const parsedPeriod = Number(periodInput);
                        if (Number.isFinite(parsedPeriod) && parsedPeriod > 0) chopPeriod = parsedPeriod;
                        else console.log(c.yellow(`  "${periodInput}" isn't a valid positive number — period left unchanged`));
                    }
                }
                const maxDefault = chopMax !== null ? String(chopMax) : "50 (default)";
                const maxInput = (await ask(`  Choppiness Index max threshold (current: ${maxDefault}, "0"/"clear" for default, blank = keep): `)).trim();
                if (maxInput) {
                    if (maxInput === "0" || maxInput.toLowerCase() === "clear") {
                        chopMax = null;
                    } else {
                        const parsedMax = Number(maxInput);
                        if (Number.isFinite(parsedMax) && parsedMax > 0) chopMax = parsedMax;
                        else console.log(c.yellow(`  "${maxInput}" isn't a valid positive number — max threshold left unchanged`));
                    }
                }
            }
        }

        // Double-order gate — universal, opt-in, default OFF (allowed).
        const doubleOrderDefault = p.disableDoubleOrders === true;
        const doubleOrderInput = (await ask(`  disable double orders (max 1 entry/session)? [y/N] (current: ${doubleOrderDefault ? "Y" : "N"}, blank = keep): `)).trim().toUpperCase();
        let disableDoubleOrders = p.disableDoubleOrders;
        if (doubleOrderInput) disableDoubleOrders = doubleOrderInput === "Y";
        if (!disableDoubleOrders) {
            console.log(c.dim(`  double orders stay allowed — any 2nd+ entry this session will force a Choppiness Index check`));
        }

        // ATR stop-loss multiplier — universal, but only read by
        // strategies that call computeTrail() (not PURE_HA/DYNAMIC_BAND/
        // DYNAMIC_MID_COLOR(_HL)).
        const atrSlMultDefault = p.atrSlMult !== null ? String(p.atrSlMult) : `default (${engineConfig.ATR_SL_MULT})`;
        const atrSlMultInput = (await ask(`  ATR stop-loss multiplier (current: ${atrSlMultDefault}, "0"/"clear" for default, blank = keep): `)).trim();
        let atrSlMult = p.atrSlMult;
        if (atrSlMultInput) {
            if (atrSlMultInput === "0" || atrSlMultInput.toLowerCase() === "clear") {
                atrSlMult = null;
            } else {
                const parsedAtrMult = Number(atrSlMultInput);
                if (!Number.isFinite(parsedAtrMult) || parsedAtrMult <= 0) {
                    console.log(c.yellow(`  "${atrSlMultInput}" isn't a valid positive number — ATR multiplier left unchanged (${atrSlMultDefault})`));
                } else {
                    atrSlMult = parsedAtrMult;
                }
            }
        }

        // Anti-whipsaw flip confirmation — PURE_HA only.
        let flipConfirmCandles = p.flipConfirmCandles;
        if (p.strategy === "PURE_HA") {
            const flipDefault = p.flipConfirmCandles !== null ? String(p.flipConfirmCandles) : "1 (immediate flip)";
            const flipInput = (await ask(`  reversal candles required to flip, anti-whipsaw (current: ${flipDefault}, "0"/"clear" for immediate, blank = keep): `)).trim();
            if (flipInput) {
                if (flipInput === "0" || flipInput.toLowerCase() === "clear") {
                    flipConfirmCandles = null;
                } else {
                    const parsedConfirm = Number(flipInput);
                    if (!Number.isInteger(parsedConfirm) || parsedConfirm < 1) {
                        console.log(c.yellow(`  "${flipInput}" isn't a valid whole number >= 1 — left unchanged (${flipDefault})`));
                    } else {
                        flipConfirmCandles = parsedConfirm;
                    }
                }
            }
        }

        // Max daily loss circuit breaker — universal, every strategy.
        const maxDailyLossDefault = p.maxDailyLoss !== null ? String(p.maxDailyLoss) : "none";
        const maxDailyLossInput = (await ask(`  max daily loss in rupees (current: ${maxDailyLossDefault}, "0"/"clear" to remove, blank = keep): `)).trim();
        let maxDailyLoss = p.maxDailyLoss;
        if (maxDailyLossInput) {
            if (maxDailyLossInput === "0" || maxDailyLossInput.toLowerCase() === "clear") {
                maxDailyLoss = null;
            } else {
                const parsedLoss = Number(maxDailyLossInput);
                if (!Number.isFinite(parsedLoss) || parsedLoss <= 0) {
                    console.log(c.yellow(`  "${maxDailyLossInput}" isn't a valid positive number — daily loss floor left unchanged (${maxDailyLossDefault})`));
                } else {
                    maxDailyLoss = parsedLoss;
                }
            }
        }

        const updatedP = { ...p, almaChopFilterEnabled, chopFilterEnabled, chopPeriod, chopMax, disableDoubleOrders, atrSlMult, flipConfirmCandles, maxDailyLoss };
        try {
            await pm2Restart({
                ...PM2_BASE_OPTS, script: "engine.js", name: p.name, cwd: __dirname, updateEnv: true,
                env: buildProcessEnv(updatedP),
            });
            const chopTag = p.strategy !== "ALMA_PRO_FAST" && p.strategy !== "ALMA_PRO_SLOW"
                ? (chopFilterEnabled ? c.dim(` chop:${chopPeriod ?? 14}/${chopMax ?? 50}`) : c.yellow(" chop:off"))
                : (p.strategy === "ALMA_PRO_FAST" || p.strategy === "ALMA_PRO_SLOW") && !almaChopFilterEnabled ? c.yellow(" chop:off") : "";
            const doubleTag = disableDoubleOrders ? c.yellow(" double:off") : c.dim(" double:on");
            const atrTag = atrSlMult !== null ? c.dim(` atr:${atrSlMult}x`) : "";
            const flipTag = p.strategy === "PURE_HA" ? c.dim(` flip:${flipConfirmCandles ?? 1}`) : "";
            const lossTag = maxDailyLoss !== null ? c.dim(` maxloss:-₹${maxDailyLoss}`) : "";
            console.log(c.green(`  ${p.underlying} risk settings updated${chopTag}${doubleTag}${atrTag}${flipTag}${lossTag} (restarted)`));
        } catch (err) {
            console.log(c.red(`  failed to update ${p.underlying}: ${err.message}`));
        }
    }
    await pauseForReview();
}

// ─── CONFIGURE & START — shared by "Add instrument" (after search/pick) and
// "Trending instruments" (after ADX scan/pick). Same validated path either
// way: resolve current contract, require a real lot multiplier if unset,
// pick lots/mode/strategy/timeframe, duplicate-check, PM2 start. Ends with
// pauseForReview() itself so both callers can just `return` right after.
async function configureAndStartInstrument(underlying, repo, exchange = "MCX") {
    // Show the actual contract that would be resolved right now, so the
    // person can sanity-check before starting a live process on it.
    const def = getDefinition(underlying, exchange);
    let resolved;
    try {
        const result = resolveCurrent(underlying, def, repo, pinStore);
        resolved = result.contract;
    } catch (err) {
        console.log(c.red(`  ${err.message}`));
        await pauseForReview();
        return;
    }
    const previewExpiry = resolved.expiry ? resolved.expiry.toISOString().split("T")[0] : "n/a (equity, no roll)";
    console.log(c.dim(`  would resolve to: ${resolved.symbol}  (expiry ${previewExpiry}, broker lot_size ${resolved.lotSize} — not used, see below)`));

    let lotMultOverride = null;
    if (def.lotMult === null) {
        console.log();
        console.log(c.yellow(`  ⚠ lot multiplier required for ${underlying}. The broker's lot_size field is a contract`));
        console.log(c.yellow(`    COUNT, not the real price multiplier, and can't be trusted as a default — this exact`));
        console.log(c.yellow(`    pattern (lot_size=1) already caused a real PnL bug once, on NatGas Mini (real multiplier`));
        console.log(c.yellow(`    was 250 MMBtu). Look up the actual contract spec before entering this.`));
        do {
            const lotMultInput = await ask(`  lot multiplier — price move x this = PnL per lot (required, no default): `);
            if (!lotMultInput) { console.log(c.yellow("  required — enter the real contract multiplier, there's no safe default to fall back to")); continue; }
            const parsed = Number(lotMultInput);
            if (!Number.isFinite(parsed) || parsed <= 0) { console.log(c.yellow(`  "${lotMultInput}" isn't a valid positive number — try again`)); continue; }
            lotMultOverride = parsed;
        } while (lotMultOverride === null);
    }

    const lotsInput = await ask(`  lots (default 1): `);
    const lots = lotsInput ? Number(lotsInput) : 1;
    if (!Number.isFinite(lots) || lots <= 0) { console.log(c.yellow("  invalid lots value")); await pauseForReview(); return; }

    const modeInput = (await ask(`  [L] Live  [P] Paper (default Paper): `)).trim().toUpperCase();
    let isLive = modeInput === "L";
    if (isLive) {
        const confirmLive = (await ask(c.red(`  this will place REAL orders. type "LIVE" to confirm: `))).trim();
        if (confirmLive !== "LIVE") {
            console.log(c.dim("  not confirmed — starting in paper mode instead"));
            isLive = false;
        }
    }

    // Carry-overnight — asked regardless of live/paper, since paper mode
    // should still simulate the same restore-across-days behavior a live
    // carry would have. Default is NO (MIS, EOD force-close) — carrying
    // overnight is a deliberate opt-in, not the safe default.
    const carryInput = (await ask(`  carry position overnight instead of EOD close? [y/N] (default: N): `)).trim().toUpperCase();
    const carryOvernight = carryInput === "Y";
    if (carryOvernight) {
        console.log(c.yellow(`  ⚠ carry-overnight ON — entries will use NRML (not MIS), EOD will hold the position instead of closing it.`));
        console.log(c.yellow(`    Overnight/margin risk is real: MCX can gap against an open position between sessions. Your call.`));
    }

    // Strategy picker — merges the hardcoded STRATEGIES registry with
    // user-built strategies saved via the "U" custom-strategy wizard
    // (custom_strategies.db). A custom entry only shows here once it has
    // entry conditions saved (steps 5+) — createSignals() would reject a
    // deploy attempt on an unfinished one anyway, but filtering here saves
    // the round trip. Default still matches context.js's own fallback, so
    // leaving this blank changes nothing about today's behavior.
    const customStrategies = (await customStrategyDb.listStrategies()).filter(s => s.entryLong || s.entryShort);
    const strategyKeys = [...Object.keys(STRATEGIES), ...customStrategies.map(s => s.name)];
    console.log();
    console.log(c.dim(`  strategy:`));
    strategyKeys.forEach((key, i) => {
        const custom = customStrategies.find(s => s.name === key);
        if (custom) {
            console.log(`  ${String(i + 1).padStart(2)}. ${key} ${c.dim("(custom)")}`);
            console.log(c.dim(`      ${custom.candleType} \u00b7 ${custom.timeframe} \u00b7 ${custom.indicators.map(ind => ind.type).join("+")}`));
        } else {
            const info = STRATEGY_INFO[key] || { label: key, description: "" };
            const defTag = key === DEFAULT_STRATEGY ? c.dim(" (default)") : "";
            console.log(`  ${String(i + 1).padStart(2)}. ${info.label}${defTag}`);
            if (info.description) wrapText(info.description, "      ").forEach(line => console.log(c.dim(line)));
        }
    });
    console.log();
    const stratInput = await ask(`  select number (blank = default): `);
    let strategy = DEFAULT_STRATEGY;
    if (stratInput) {
        const picked = strategyKeys[Number(stratInput) - 1];
        if (!picked) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }
        strategy = picked;
    }

    // Timeframe picker — defaults to the selected strategy's own fixed
    // cadence. Hardcoded strategies get it from STRATEGY_TIMEFRAME; custom
    // strategies carry their own timeframe from the builder (step 2) —
    // same "designed cadence" concept, different source. Can still be
    // overridden per-instrument same as before.
    const timeframes = Object.keys(TIMEFRAME_TO_INTERVAL);
    const customPicked = customStrategies.find(s => s.name === strategy);
    const defaultTimeframe = customPicked ? customPicked.timeframe : (STRATEGY_TIMEFRAME[strategy] || "15m");
    console.log();
    console.log(c.dim(`  timeframe (default: ${defaultTimeframe}, this strategy's own cadence):`));
    timeframes.forEach((tf, i) => {
        const defTag = tf === defaultTimeframe ? c.dim(" (default)") : "";
        console.log(`  ${i + 1}. ${tf}${defTag}`);
    });
    const tfInput = await ask(`  select number (blank = default): `);
    let timeframe = defaultTimeframe;
    if (tfInput) {
        const picked = timeframes[Number(tfInput) - 1];
        if (!picked) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }
        timeframe = picked;
        if (timeframe !== defaultTimeframe) {
            console.log(c.yellow(`  ⚠ overriding ${strategy}'s default ${defaultTimeframe} cadence — its lookback params were tuned assuming ${defaultTimeframe} candles`));
        }
    }

    // Target points — optional, asked after strategy is picked so it's
    // clear this is a per-instrument choice, not a strategy setting. Blank
    // = no fixed take-profit (strategy's own exits are the only way out,
    // today's default). A positive number arms a tick-monitored favorable-
    // exit level at entryPrice ± this many points, same for LONG/SHORT —
    // checked on every WebSocket tick (candlePoll.js's checkTarget), applies
    // regardless of which strategy is running.
    // Target type — mutually exclusive choice between a per-trade points
    // target (existing behavior, unchanged) and a whole-session rupee
    // ceiling (new — candlePoll.js's checkSessionTarget, fires on the
    // combined realized+unrealised total crossing the ceiling regardless
    // of any interim losing trade, unlike the per-trade target which only
    // ever looks at one trade's own entry/exit).
    console.log(c.dim("  target type:"));
    console.log("  1. Trade-level (points, tick-monitored, per trade)");
    console.log("  2. Session-level (rupees, whole day, irrespective of interim losses)");
    console.log("  3. None");
    const targetTypeInput = (await ask("  select number (blank = none): ")).trim();

    let targetPoints = null;
    let targetMode = "fixed";
    let sessionTargetRupees = null;

    if (targetTypeInput === "1") {
        // Blank = no fixed take-profit (strategy's own exits are the only
        // way out). A positive number arms a tick-monitored favorable-exit
        // level at entryPrice ± this many points, same for LONG/SHORT —
        // checked on every WebSocket tick (candlePoll.js's checkTarget),
        // applies regardless of which strategy is running.
        const targetInput = await ask(`  profit target in points (blank = adaptive sizing instead): `);
        if (targetInput) {
            const parsedTarget = Number(targetInput);
            if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
                console.log(c.yellow(`  "${targetInput}" isn't a valid positive number — using adaptive sizing instead`));
            } else {
                targetPoints = parsedTarget;
            }
        }
        // Adaptive target mode — only offered when no fixed target was just
        // entered above (targetPoints wins outright when set, see context.js/
        // engine.js). Sizes the target itself from CHOP + |DPI efficiency|
        // once per position instead of one fixed distance every trade — see
        // adaptiveTarget.js.
        if (targetPoints === null) {
            const adaptiveInput = (await ask(`  use adaptive target sizing (CHOP + DPI efficiency)? [Y/n] (default: Y): `)).trim().toUpperCase();
            targetMode = adaptiveInput === "N" ? "fixed" : "adaptive";
        }
    } else if (targetTypeInput === "2") {
        const sessionTargetInput = await ask(`  session profit ceiling in rupees, quits for the day once reached: `);
        const parsedSessionTarget = Number(sessionTargetInput);
        if (!Number.isFinite(parsedSessionTarget) || parsedSessionTarget <= 0) {
            console.log(c.yellow(`  "${sessionTargetInput}" isn't a valid positive number — starting with no target instead`));
        } else {
            sessionTargetRupees = parsedSessionTarget;
        }
    }

    // ALMA band gate toggle — ALMA_PRO_FAST only. Default ON (matches the
    // ported Pine script's own logic — band compression forces sideways,
    // breakout past the band confirms entries). OFF trades on slope alone
    // (strong_up/strong_down), no band/breakout involved at all — see
    // createAlmaProFastStrategy in strategies.js for exactly what each
    // mode checks.
    let almaBandEnabled = true;
    if (strategy === "ALMA_PRO_FAST") {
        const almaBandInput = (await ask(`  use ALMA band gate? [Y/n] (default: Y): `)).trim().toUpperCase();
        almaBandEnabled = almaBandInput !== "N";
    }

    // ALMA fast/band length config — ALMA_PRO_FAST only. Blank = use
    // engineConfig.ALMA_PRO_FAST_LEN/ALMA_PRO_BAND_LEN (the Pine script's
    // own defaults, 20/50). No other ALMA strategy exposes its lengths
    // per-instrument today — every other one is engineConfig-only, tunable
    // via the backtest wizard's STRATEGY_PARAMS but not live per-instrument.
    let almaFastLen = null;
    let almaBandLen = null;
    if (strategy === "ALMA_PRO_FAST") {
        const fastLenInput = (await ask(`  fast ALMA length (default: ${engineConfig.ALMA_PRO_FAST_LEN}): `)).trim();
        if (fastLenInput) {
            const parsedFastLen = Number(fastLenInput);
            if (!Number.isFinite(parsedFastLen) || parsedFastLen <= 0) {
                console.log(c.yellow(`  "${fastLenInput}" isn't a valid positive number — using default ${engineConfig.ALMA_PRO_FAST_LEN}`));
            } else {
                almaFastLen = parsedFastLen;
            }
        }
        if (almaBandEnabled) {
            const bandLenInput = (await ask(`  band ALMA length (default: ${engineConfig.ALMA_PRO_BAND_LEN}): `)).trim();
            if (bandLenInput) {
                const parsedBandLen = Number(bandLenInput);
                if (!Number.isFinite(parsedBandLen) || parsedBandLen <= 0) {
                    console.log(c.yellow(`  "${bandLenInput}" isn't a valid positive number — using default ${engineConfig.ALMA_PRO_BAND_LEN}`));
                } else {
                    almaBandLen = parsedBandLen;
                }
            }
        }
    }

    // Choppiness Index entry filter toggle — ALMA_PRO_FAST/ALMA_PRO_SLOW
    // only. Default ON (matches both strategies' engineConfig default).
    // OFF removes the chop gate entirely — every other entry condition
    // (band/slope for FAST, slope-level for SLOW) still applies unchanged.
    let almaChopFilterEnabled = true;
    if (strategy === "ALMA_PRO_FAST" || strategy === "ALMA_PRO_SLOW") {
        const chopFilterInput = (await ask(`  use Choppiness Index entry filter? [Y/n] (default: Y): `)).trim().toUpperCase();
        almaChopFilterEnabled = chopFilterInput !== "N";
    }

    // Choppiness Index entry filter — available for any strategy except
    // ALMA_PRO_FAST/SLOW (they keep their own dedicated, pre-existing
    // toggle — almaChopFilterEnabled, unchanged). This is the universal
    // one (chopGate.js's isChopBlocked, called from every other strategy's
    // own entry site) — configurable period + max threshold, not just a
    // toggle, unlike ALMA_PRO's fixed engineConfig threshold.
    // Default ON, period 14 (engineConfig.CHOP_LEN), max 50 — same 50
    // every other chop filter in this codebase uses.
    let chopFilterEnabled = true;
    let chopPeriod = null;
    let chopMax = null;
    if (strategy !== "ALMA_PRO_FAST" && strategy !== "ALMA_PRO_SLOW") {
        const chopFilterInput = (await ask(`  use Choppiness Index entry filter? [Y/n] (default: Y): `)).trim().toUpperCase();
        chopFilterEnabled = chopFilterInput !== "N";
        if (chopFilterEnabled) {
            const periodInput = await ask(`  Choppiness Index period (blank = 14): `);
            if (periodInput) {
                const parsedPeriod = Number(periodInput);
                chopPeriod = Number.isFinite(parsedPeriod) && parsedPeriod > 0 ? parsedPeriod : null;
                if (chopPeriod === null) console.log(c.yellow(`  "${periodInput}" isn't a valid positive number — using default (14)`));
            }
            const maxInput = await ask(`  Choppiness Index max threshold, blocks entries above this (blank = 50): `);
            if (maxInput) {
                const parsedMax = Number(maxInput);
                chopMax = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null;
                if (chopMax === null) console.log(c.yellow(`  "${maxInput}" isn't a valid positive number — using default (50)`));
            }
        }
    }

    // Double-order gate — universal, every strategy, opt-in. Default N
    // (allowed — today's original behavior, unlimited re-entries per
    // session). When double orders stay allowed, any 2nd+ entry that
    // session ALSO gets a forced Choppiness Index check regardless of the
    // chop filter setting above — see chopGate.js's `force` option and
    // doubleOrderGate.js.
    const doubleOrderInput = (await ask(`  disable double orders (max 1 entry/session)? [y/N] (default: N): `)).trim().toUpperCase();
    const disableDoubleOrders = doubleOrderInput === "Y";
    if (!disableDoubleOrders) {
        console.log(c.dim(`  double orders stay allowed — any 2nd+ entry this session will force a Choppiness Index check`));
    }

    // ATR stop-loss multiplier — universal prompt, but only read by
    // strategies that call computeTrail() (not PURE_HA/DYNAMIC_BAND/
    // DYNAMIC_MID_COLOR(_HL)). Blank = use the global engineConfig.ATR_SL_MULT.
    let atrSlMult = null;
    const atrSlMultInput = (await ask(`  ATR stop-loss multiplier (blank = default ${engineConfig.ATR_SL_MULT}): `)).trim();
    if (atrSlMultInput) {
        const parsedAtrMult = Number(atrSlMultInput);
        if (!Number.isFinite(parsedAtrMult) || parsedAtrMult <= 0) {
            console.log(c.yellow(`  "${atrSlMultInput}" isn't a valid positive number — using default (${engineConfig.ATR_SL_MULT}) instead`));
        } else {
            atrSlMult = parsedAtrMult;
        }
    }

    // Anti-whipsaw flip confirmation — PURE_HA only. How many CONSECUTIVE
    // opposite-color HA candles are required before an already-open
    // position actually flips. Blank = 1 (immediate flip).
    let flipConfirmCandles = null;
    if (strategy === "PURE_HA") {
        const flipInput = (await ask(`  reversal candles required to flip, anti-whipsaw (blank = 1, immediate): `)).trim();
        if (flipInput) {
            const parsedConfirm = Number(flipInput);
            if (!Number.isInteger(parsedConfirm) || parsedConfirm < 1) {
                console.log(c.yellow(`  "${flipInput}" isn't a valid whole number >= 1 — using default (1, immediate flip) instead`));
            } else {
                flipConfirmCandles = parsedConfirm;
            }
        }
    }

    // Max daily loss circuit breaker — universal, every strategy. Blank =
    // disabled, no floor (today's original behavior). Once today's
    // cumulative realized P&L drops to or below -this amount, candlePoll.js's
    // checkDailyLoss() force-closes any open position and quits for the
    // day — independent of target hits, fires on ANY exit reason that
    // pushes the day past the floor (SL, target, reversal).
    let maxDailyLoss = null;
    const maxDailyLossInput = (await ask(`  max daily loss in rupees, quits for the day if breached (blank = no floor): `)).trim();
    if (maxDailyLossInput) {
        const parsedLoss = Number(maxDailyLossInput);
        if (!Number.isFinite(parsedLoss) || parsedLoss <= 0) {
            console.log(c.yellow(`  "${maxDailyLossInput}" isn't a valid positive number — starting with no daily loss floor instead`));
        } else {
            maxDailyLoss = parsedLoss;
        }
    }

    // Band step — only meaningful for DYNAMIC_BAND / DYNAMIC_MID_COLOR,
    // only asked when one of those is the strategy picked. Fixed PRICE
    // distance, not ATR-derived — see createDynamicBandStrategy /
    // createDynamicMidColorStrategy in strategies.js. Blank falls back to
    // engineConfig.BAND_STEP_DEFAULT.
    let bandStep = null;
    if ((strategy === "DYNAMIC_BAND" || strategy === "DYNAMIC_MID_COLOR" || strategy === "DYNAMIC_MID_COLOR_HL")) {
        const bandStepInput = await ask(`  band step in price points (blank = default ${engineConfig.BAND_STEP_DEFAULT}): `);
        if (bandStepInput) {
            const parsedStep = Number(bandStepInput);
            if (!Number.isFinite(parsedStep) || parsedStep <= 0) {
                console.log(c.yellow(`  "${bandStepInput}" isn't a valid positive number — using default ${engineConfig.BAND_STEP_DEFAULT} instead`));
            } else {
                bandStep = parsedStep;
            }
        }
    }

    // Grey-state behavior — only meaningful for ALMA_TRI_BAND, only asked
    // when that's the strategy picked. Default HOLD (blank = N), matches
    // ALMA_FAST's/MA_SLOPE's existing convention of holding through a
    // neutral reading rather than exiting on it.
    let greyExitEnabled = null;
    if (strategy === "ALMA_TRI_BAND") {
        const greyExitInput = (await ask(`  exit on grey state instead of holding through it? [y/N] (default: N): `)).trim().toUpperCase();
        greyExitEnabled = greyExitInput === "Y";
    }

    const name = toProcessName(underlying, strategy);

    // Exact duplicate check — same underlying AND same strategy produces
    // the same process name, which would still silently collide even with
    // the per-strategy naming above. Running the same underlying under a
    // DIFFERENT strategy is fine (that's the whole point of this naming
    // scheme) and isn't blocked here.
    const existingProcs = await getEngineProcesses();
    if (existingProcs.some(p => p.name === name)) {
        console.log(c.yellow(`  ⚠ ${underlying} is already running ${(STRATEGY_INFO[strategy] || { label: strategy }).label} as ${name} — stop/remove it first, or pick a different strategy.`));
        await pauseForReview();
        return;
    }

    // ALMA_PRO_FAST / ALMA_PRO_SLOW same-underlying block — per instruction,
    // these two are meant to run as a genuine dual-engine pair on DIFFERENT
    // underlyings (e.g. fast on a mini contract, slow on the full-lot one),
    // never both pointed at the exact same underlying (that would just be
    // two independent strategies doubling exposure on one identical
    // contract). Deliberately checks the exact underlying string only —
    // NOT "is this a mini vs full pair of the same commodity" — see this
    // file's own note near the top on why a hand-maintained mini/full
    // commodity-tier table wasn't built (real contract facts, easy to get
    // wrong; shortNames.js already shows gold/silver alone have 3+ lot
    // tiers, not a clean mini/full pair). "Disable" one engine simply means
    // not starting its process at all — nothing else to configure for that.
    if (strategy === "ALMA_PRO_FAST" || strategy === "ALMA_PRO_SLOW") {
        const otherEngine = strategy === "ALMA_PRO_FAST" ? "ALMA_PRO_SLOW" : "ALMA_PRO_FAST";
        const conflict = existingProcs.find(p => p.underlying === underlying && p.strategy === otherEngine);
        if (conflict) {
            console.log(c.yellow(`  ⚠ ${underlying} is already running ${(STRATEGY_INFO[otherEngine] || { label: otherEngine }).label} as ${conflict.name}.`));
            console.log(c.yellow(`    ALMA_PRO_FAST and ALMA_PRO_SLOW are meant to run on DIFFERENT underlyings (e.g. one on the`));
            console.log(c.yellow(`    mini contract, the other on the full-lot one) — pick a different underlying for this engine,`));
            console.log(c.yellow(`    or leave it disabled by not starting it.`));
            await pauseForReview();
            return;
        }
    }

    const env  = { UNDERLYING: underlying, EXCHANGE_OVERRIDE: exchange, LOTS_OVERRIDE: String(lots), LIVE_ORDERS_OVERRIDE: String(isLive), CARRY_OVERNIGHT_OVERRIDE: String(carryOvernight), STRATEGY_OVERRIDE: strategy, TIMEFRAME_OVERRIDE: timeframe };
    if (lotMultOverride !== null) env.LOTMULT_OVERRIDE = String(lotMultOverride);
    if (targetPoints !== null) env.TARGET_POINTS_OVERRIDE = String(targetPoints);
    if (targetMode === "adaptive") env.TARGET_MODE_OVERRIDE = "adaptive";
    if (sessionTargetRupees !== null) env.SESSION_TARGET_OVERRIDE = String(sessionTargetRupees);
    if (strategy === "ALMA_PRO_FAST" && !almaBandEnabled) env.ALMA_BAND_OVERRIDE = "false";
    if (strategy === "ALMA_PRO_FAST" && almaFastLen !== null) env.ALMA_FAST_LEN_OVERRIDE = String(almaFastLen);
    if (strategy === "ALMA_PRO_FAST" && almaBandLen !== null) env.ALMA_BAND_LEN_OVERRIDE = String(almaBandLen);
    if ((strategy === "ALMA_PRO_FAST" || strategy === "ALMA_PRO_SLOW") && !almaChopFilterEnabled) env.ALMA_CHOP_FILTER_OVERRIDE = "false";
    if (strategy !== "ALMA_PRO_FAST" && strategy !== "ALMA_PRO_SLOW") {
        // Always written explicitly — see the matching comment in
        // buildProcessEnv (editInstrument's restart-env builder) for why
        // "only write when disabling" would leave a blank/Y answer here
        // silently unwritten, defaulting to OFF at runtime and
        // contradicting this prompt's own "default: Y".
        env.CHOP_FILTER_OVERRIDE = chopFilterEnabled ? "true" : "false";
        if (chopPeriod !== null) env.CHOP_PERIOD_OVERRIDE = String(chopPeriod);
        if (chopMax !== null) env.CHOP_MAX_OVERRIDE = String(chopMax);
    }
    // Double-order gate — always written explicitly, same reasoning.
    env.DISABLE_DOUBLE_ORDERS_OVERRIDE = disableDoubleOrders ? "true" : "false";
    if (atrSlMult !== null) env.ATR_SL_MULT_OVERRIDE = String(atrSlMult);
    if (strategy === "PURE_HA" && flipConfirmCandles !== null) env.FLIP_CONFIRM_CANDLES_OVERRIDE = String(flipConfirmCandles);
    if ((strategy === "DYNAMIC_BAND" || strategy === "DYNAMIC_MID_COLOR" || strategy === "DYNAMIC_MID_COLOR_HL") && bandStep !== null) env.BAND_STEP_OVERRIDE = String(bandStep);
    if (strategy === "ALMA_TRI_BAND" && greyExitEnabled !== null) env.GREY_EXIT_OVERRIDE = String(greyExitEnabled);
    if (maxDailyLoss !== null) env.MAX_DAILY_LOSS_OVERRIDE = String(maxDailyLoss);
    try {
        await pm2Start({ ...PM2_BASE_OPTS, script: "engine.js", name, cwd: __dirname, env });
        const modeTag = isLive ? c.red("LIVE") : c.cyan("PAPER");
        const carryTag = carryOvernight ? c.yellow(" CARRY") : "";
        const stratLabel = (STRATEGY_INFO[strategy] || { label: strategy }).label;
        const targetTag = targetPoints !== null ? c.yellow(` +${targetPoints}pt target`) : targetMode === "adaptive" ? c.yellow(" adaptive target") : sessionTargetRupees !== null ? c.yellow(` session target:+₹${sessionTargetRupees}`) : "";
        const almaBandTag = strategy === "ALMA_PRO_FAST" && !almaBandEnabled ? c.yellow(" band:off") : "";
        const almaLenTag = strategy === "ALMA_PRO_FAST" && (almaFastLen !== null || almaBandLen !== null)
            ? c.yellow(` alma:${almaFastLen ?? engineConfig.ALMA_PRO_FAST_LEN}/${almaBandLen ?? engineConfig.ALMA_PRO_BAND_LEN}`)
            : "";
        const almaChopTag = (strategy === "ALMA_PRO_FAST" || strategy === "ALMA_PRO_SLOW") && !almaChopFilterEnabled ? c.yellow(" chop:off") : "";
        const vdChopTag = strategy !== "ALMA_PRO_FAST" && strategy !== "ALMA_PRO_SLOW" ? (chopFilterEnabled ? c.dim(` chop:${chopPeriod ?? 14}/${chopMax ?? 50}`) : c.yellow(" chop:off")) : "";
        const bandStepTag = (strategy === "DYNAMIC_BAND" || strategy === "DYNAMIC_MID_COLOR" || strategy === "DYNAMIC_MID_COLOR_HL") ? c.yellow(` step:${bandStep ?? engineConfig.BAND_STEP_DEFAULT}`) : "";
        const greyExitTag = strategy === "ALMA_TRI_BAND" ? c.yellow(` grey:${(greyExitEnabled ?? engineConfig.GREY_EXIT_DEFAULT) ? "exit" : "hold"}`) : "";
        const maxLossTag = maxDailyLoss !== null ? c.yellow(` maxLoss:-₹${maxDailyLoss}`) : "";
        console.log(c.green(`  started ${name} (${lots} lot${lots > 1 ? "s" : ""}${lotMultOverride !== null ? `, lotMult ${lotMultOverride}` : ""}) — ${modeTag}${carryTag} — ${stratLabel} @ ${timeframe}${targetTag}${almaBandTag}${almaLenTag}${almaChopTag}${vdChopTag}${bandStepTag}${greyExitTag}${maxLossTag}`));
    } catch (err) {
        console.log(c.red(`  failed to start ${name}: ${err.message}`));
    }
    await pauseForReview();
}

// ─── ADD INSTRUMENT — browse/search the broker's live dump ─────────────────
async function addInstrument() {
    const { exchange, repo, list: all } = await pickExchangeAndRepo();

    const query   = await ask("  search underlying (blank = show all): ");
    const matches = query
        ? all.filter(u => u.toLowerCase().includes(query.toLowerCase()))
        : all;

    if (matches.length === 0) { console.log(c.yellow("  no matches")); await pauseForReview(); return; }
    if (matches.length > 30 && query === "") {
        console.log(c.yellow(`  ${all.length} underlyings total — type part of a name to narrow it down`));
        await pauseForReview();
        return;
    }

    console.log();
    matches.forEach((u, i) => console.log(`  ${String(i + 1).padStart(2)}. ${u}`));
    console.log();

    const pick = await ask("  select number (blank to cancel): ");
    if (!pick) return;
    const underlying = matches[Number(pick) - 1];
    if (!underlying) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }

    await configureAndStartInstrument(underlying, repo, exchange);
}

// ─── TRENDING INSTRUMENTS — scan the broker's live dump, classify each
// underlying's current contract as trending or not via ADX (Wilder's DMI),
// then deploy any picked one through the exact same configure/start path
// as "Add instrument".
//
// ADX_LEN=14 and ADX_TREND_THRESH=25 are Wilder's own textbook figures for
// "trending" (>25, vs "no clear trend" below ~20) — not numbers specific to
// this strategy suite; tune ADX_TREND_THRESH here if that bar should be
// stricter/looser. Classification runs on DAILY candles (steadier signal,
// less noise than intraday) via fetchDailyCandles — see historicalFetch.js.
// TRENDING_LOOKBACK_DAYS is CALENDAR days: adx() needs len*2+1 = 29 candles
// minimum, and daily candles only land on trading days (~5/week, fewer with
// holidays) — 90 calendar days comfortably clears that with room to spare,
// not just the bare minimum.
//
// ADX_EXHAUSTED_THRESH splits the trending band itself: 25–30 is flagged
// "recommended" (a trend that's established but still has room), above 30
// "might be exhausted" (a trend already extended enough that a reversal or
// stall is a real risk, not necessarily still the best entry). Both are
// still trending by the ADX_TREND_THRESH definition and both are still
// listed/deployable — this is a caution label, not a second filter.
const TRENDING_LOOKBACK_DAYS = 90;
const ADX_LEN                = 14;
const ADX_TREND_THRESH       = 25;
const ADX_EXHAUSTED_THRESH   = 30;

// Fetches daily candles + ADX for each underlying, one at a time — kept
// sequential (not parallel) to stay easy on Kite's historical-data rate
// limit. A bad/illiquid underlying (no recent contract, no history) is
// skipped with a reason rather than aborting the whole scan.
// Same ~3 req/sec historical-data rate limit every other caller of this
// endpoint already respects (historicalFetch.js's CHUNK_DELAY_MS,
// marketFeed.js's INTER_INSTRUMENT_DELAY_MS) — this loop was the one place
// that never got the same throttle, and it was visibly failing for it
// (real "Too many requests" errors skipping legitimate instruments, like
// NATGASMINI, out of a scan for no reason related to their actual ADX).
const SCAN_REQUEST_DELAY_MS = 350;
const RATE_LIMIT_MAX_RETRIES = 2;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isRateLimitError(err) {
    const msg = (err.message || "").toLowerCase();
    return msg.includes("too many requests") || msg.includes("rate limit") || msg.includes("429");
}

async function scanTrendingInstruments(underlyings, repo, exchange) {
    const kc   = ensureKite();
    const to   = new Date();
    const from = new Date(to.getTime() - TRENDING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const results = [];
    for (const underlying of underlyings) {
        process.stdout.write(c.dim(`  scanning ${underlying}...`));

        let attempt = 0;
        while (true) {
            try {
                const def = getDefinition(underlying, exchange);
                const { contract } = resolveCurrent(underlying, def, repo, pinStore);
                const candles = await fetchDailyCandles({ kc, token: contract.token, from, to });
                const adxArr  = adx(candles, ADX_LEN);
                let latest = null;
                for (let i = adxArr.length - 1; i >= 0; i--) { if (adxArr[i] !== null) { latest = adxArr[i]; break; } }
                process.stdout.write(`\r\x1b[2K`);
                if (latest === null) {
                    console.log(c.dim(`  ${underlying.padEnd(18)} — not enough candle history yet, skipped`));
                } else {
                    const trending = latest >= ADX_TREND_THRESH;
                    results.push({
                        underlying, contract, adxVal: latest, trending,
                        category: trending ? (latest > ADX_EXHAUSTED_THRESH ? "exhausted" : "recommended") : null,
                    });
                }
                break; // success (or a real "not enough history" case) — move to the next underlying
            } catch (err) {
                // Rate-limit errors are transient — worth a couple of
                // backed-off retries rather than immediately giving up on
                // an otherwise-perfectly-scannable instrument. Anything
                // else (no futures found, all contracts expired, etc.) is
                // NOT transient — retrying those would just waste time for
                // the same eventual result, so those still skip immediately.
                if (isRateLimitError(err) && attempt < RATE_LIMIT_MAX_RETRIES) {
                    attempt++;
                    process.stdout.write(`\r\x1b[2K`);
                    console.log(c.dim(`  ${underlying.padEnd(18)} — rate limited, retrying in ${attempt}s...`));
                    await sleep(attempt * 1000);
                    process.stdout.write(c.dim(`  scanning ${underlying}...`));
                    continue;
                }
                process.stdout.write(`\r\x1b[2K`);
                console.log(c.dim(`  ${underlying.padEnd(18)} — skipped (${err.message})`));
                break;
            }
        }

        await sleep(SCAN_REQUEST_DELAY_MS);
    }
    return results;
}

// ─── MARKET STATUS SCREEN ───────────────────────────────────────────────────
// Reads only — every profile shown here comes from marketStateClient.js,
// never a live computation the way trendingInstruments() below does its own
// ADX scan on demand. The Market Scanner (a separate PM2 process, started/
// stopped from this same screen) does the actual continuous work; this
// screen is just a cheap, near-instant read of whatever it last published.
//
// Driven off the WATCHLIST, not off marketStateClient.getAllProfiles() —
// deliberately. An instrument just added to the watchlist (or one the
// Scanner hasn't gotten to yet) has no row in the store at all yet, and
// getAllProfiles() would simply omit it — which would make a freshly-added
// instrument invisible instead of showing "no data yet." Iterating the
// watchlist and calling getProfile() per entry means every watched
// instrument always shows up, with marketStateClient.js's own graceful
// UNKNOWN/stale handling covering the rest.
function structureStateColor(state) {
    if (state === "TRENDING" || state === "BREAKOUT")  return c.green;
    if (state === "RANGING")                            return c.yellow;
    if (state === "HIGH_VOLATILITY")                     return c.red;
    return c.dim; // LOW_VOLATILITY, UNKNOWN
}

async function marketStatusScreen() {
    let running = true;
    while (running) {
        const entries = marketWatchlist.getAll();

        console.log();
        console.log(c.bold("  ── Market Status ──"));

        if (entries.length === 0) {
            console.log(c.dim("  watchlist is empty — press A to add an instrument"));
        } else {
            const profiles = await Promise.all(entries.map(e => marketStateClient.getProfile(e.underlying)));

            console.log(c.dim(`  #  ${"INSTRUMENT".padEnd(16)}${"STATE".padEnd(17)}CONF   ${"TREND".padEnd(13)}${"VOLATILITY".padEnd(15)}UPDATED`));
            entries.forEach((entry, i) => {
                const p    = profiles[i];
                const num  = String(i + 1).padStart(2);
                const inst = entry.underlying.padEnd(16);
                const state = structureStateColor(p.structure.state)(p.structure.state.padEnd(17));
                const conf  = (p.confidence != null ? `${p.confidence}%` : "-").padEnd(7);
                const trend = (p.trend.score != null ? `${p.trend.direction} ${p.trend.score}` : "-").padEnd(13);
                const vol   = (p.volatility.score != null ? `${p.volatility.state} ${p.volatility.score}` : "-").padEnd(15);
                const updated = p.updatedAt
                    ? new Date(p.updatedAt).toLocaleTimeString("en-IN", { hour12: false })
                    : c.dim(p.unavailableReason || "no data");
                console.log(`  ${num}. ${inst}${state}${conf}${trend}${vol}${updated}`);
            });
        }

        console.log();
        console.log(c.dim("  [A] add   [R] remove   [S] start scanner   [X] stop scanner   [B] back"));
        const input = (await ask("  > ")).trim().toUpperCase();

        if (input === "A")       await addToWatchlist();
        else if (input === "R")  await removeFromWatchlist(entries);
        else if (input === "S")  await startScanner();
        else if (input === "X")  await stopScanner();
        else if (input === "B" || input === "") running = false;
        else                      console.log(c.yellow("  unrecognized option"));
    }
}

// Deliberately NOT the full CSV-search flow Add Instrument uses — the
// watchlist doesn't need immediate contract resolution the way starting a
// live engine does (that happens lazily, inside scannerService.js, at the
// Scanner's own boot).
//
// Two sourcing paths, not a free-text prompt: [1] pick from whatever's
// already PM2-managed (getEngineProcesses() — same list the main menu's
// instrument table is built from) so watching an instrument you're already
// trading is a single pick, no risk of a typo'd underlying name that
// doesn't match anything real; [2] the exact same browse-and-select flow
// addInstrument() uses (pickExchangeAndRepo() + search + numbered pick) —
// this is how you'd add something to WATCH that you aren't necessarily
// running yet, which is the whole point of a separate watchlist (see
// marketWatchlist.js's header comment) — reuses real broker data instead
// of trusting a hand-typed name.
async function addToWatchlist() {
    const choice = (await ask("  add from — [1] currently PM2-managed instruments  [2] browse MCX/NSE (default 2): ")).trim();

    if (choice === "1") {
        const procs = await getEngineProcesses();
        if (procs.length === 0) {
            console.log(c.yellow("  no PM2-managed instruments running — try [2] to browse MCX/NSE instead"));
            await pauseForReview();
            return;
        }

        console.log();
        procs.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.underlying.padEnd(16)} (${p.exchange})  ${p.name} [${p.status}]`));
        console.log();

        const pick = await ask("  select number (blank to cancel): ");
        if (!pick) return;
        const proc = procs[Number(pick) - 1];
        if (!proc) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }

        marketWatchlist.add(proc.underlying, proc.exchange);
        console.log(c.green(`  added ${proc.underlying} (${proc.exchange}) to watchlist`));
        await pauseForReview();
        return;
    }

    // Default / [2] — identical search-and-select UX to addInstrument(),
    // just writes to the watchlist instead of calling
    // configureAndStartInstrument() at the end.
    const { exchange, list: all } = await pickExchangeAndRepo();

    const query   = await ask("  search underlying (blank = show all): ");
    const matches = query
        ? all.filter(u => u.toLowerCase().includes(query.toLowerCase()))
        : all;

    if (matches.length === 0) { console.log(c.yellow("  no matches")); await pauseForReview(); return; }
    if (matches.length > 30 && query === "") {
        console.log(c.yellow(`  ${all.length} underlyings total — type part of a name to narrow it down`));
        await pauseForReview();
        return;
    }

    console.log();
    matches.forEach((u, i) => console.log(`  ${String(i + 1).padStart(2)}. ${u}`));
    console.log();

    const pick = await ask("  select number (blank to cancel): ");
    if (!pick) return;
    const underlying = matches[Number(pick) - 1];
    if (!underlying) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }

    marketWatchlist.add(underlying, exchange);
    console.log(c.green(`  added ${underlying} (${exchange}) to watchlist`));
    await pauseForReview();
}

async function removeFromWatchlist(entries) {
    if (entries.length === 0) { console.log(c.yellow("  watchlist is empty")); await pauseForReview(); return; }

    const input = await ask("  remove which number: ");
    const entry = entries[Number(input) - 1];
    if (!entry) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }

    marketWatchlist.remove(entry.underlying);
    console.log(c.green(`  removed ${entry.underlying}`));
    await pauseForReview();
}

// Scanner is a SINGLETON process, unlike engine.js's one-process-per-
// instrument model — no UNDERLYING/STRATEGY_OVERRIDE env vars to set, which
// is also why it never shows up in getEngineProcesses()'s list (that
// function filters on p.pm2_env.env?.UNDERLYING specifically).
async function startScanner() {
    try {
        await pm2Start({ ...PM2_BASE_OPTS, script: "scannerService.js", name: SCANNER_PROCESS_NAME, cwd: __dirname });
        console.log(c.green(`  ${SCANNER_PROCESS_NAME} started`));
    } catch (err) {
        console.log(c.red(`  failed to start scanner: ${err.message}`));
    }
    await pauseForReview();
}

async function stopScanner() {
    try {
        await pm2Stop(SCANNER_PROCESS_NAME);
        console.log(c.green(`  ${SCANNER_PROCESS_NAME} stopped`));
    } catch (err) {
        console.log(c.red(`  failed to stop scanner (is it running?): ${err.message}`));
    }
    await pauseForReview();
}

async function trendingInstruments() {
    const { exchange, repo, list: all } = await pickExchangeAndRepo();

    const query   = await ask("  search underlying to scan (blank = scan all): ");
    const matches = query
        ? all.filter(u => u.toLowerCase().includes(query.toLowerCase()))
        : all;

    if (matches.length === 0) { console.log(c.yellow("  no matches")); await pauseForReview(); return; }
    if (matches.length > 30 && query === "") {
        console.log(c.yellow(`  ${all.length} underlyings total — scanning all of them means one historical-data`));
        console.log(c.yellow(`  call each (rate-limited, so this will take a while) — type part of a name to narrow it`));
        console.log(c.yellow(`  down, or confirm below to scan everything.`));
        const confirm = (await ask(`  scan all ${all.length} anyway? [Y/N]: `)).trim().toUpperCase();
        if (confirm !== "Y") return;
    }

    console.log();
    console.log(c.dim(`  scanning ${matches.length} instrument(s) — ADX(${ADX_LEN}) on daily candles (${TRENDING_LOOKBACK_DAYS}d lookback), ≥${ADX_TREND_THRESH} = trending:`));
    console.log();
    const scanned = await scanTrendingInstruments(matches, repo, exchange);

    // Cross-check against what's already PM2-managed — RIGHT here, before
    // anything gets displayed, not just as a duplicate-check at deploy time
    // (configureAndStartInstrument's own check only catches an EXACT
    // underlying+strategy match, and only after you've already picked a
    // number). The scan's whole job is to surface NEW opportunities — an
    // instrument that's trending but already has a live PM2 process on it
    // isn't a new opportunity, it's just confirmation the existing one is
    // in the right place. Grouped by underlying (not by underlying+strategy)
    // deliberately: "already running" here means "at all", regardless of
    // which strategy — re-running the same underlying under a second
    // strategy is a real, supported thing (see toProcessName's comment),
    // but it's a deliberate choice to make elsewhere (Add Instrument),
    // not something a trend scan should recommend by default.
    const engineProcs = await getEngineProcesses();
    const runningByUnderlying = new Map();
    for (const p of engineProcs) {
        if (!runningByUnderlying.has(p.underlying)) runningByUnderlying.set(p.underlying, []);
        runningByUnderlying.get(p.underlying).push(p);
    }

    const trendingAll   = scanned.filter(r => r.trending).sort((a, b) => b.adxVal - a.adxVal);
    const alreadyRunning = trendingAll.filter(r => runningByUnderlying.has(r.underlying));
    const trending       = trendingAll.filter(r => !runningByUnderlying.has(r.underlying));

    if (trendingAll.length === 0) {
        console.log(c.yellow(`  nothing trending right now (${scanned.length} scanned, none ≥ ADX ${ADX_TREND_THRESH})`));
        await pauseForReview();
        return;
    }

    if (alreadyRunning.length > 0) {
        console.log(c.dim(`  trending but already running — not recommended again:`));
        alreadyRunning.forEach(r => {
            const procs = runningByUnderlying.get(r.underlying)
                .map(p => `${p.name}[${p.status}${(STRATEGY_INFO[p.strategy] || { label: p.strategy }).label ? `/${(STRATEGY_INFO[p.strategy] || { label: p.strategy }).label}` : ""}]`)
                .join(", ");
            const tag = r.category === "exhausted" ? " (might be exhausted)" : "";
            console.log(c.dim(`      ${r.underlying.padEnd(18)} ADX ${r.adxVal.toFixed(1)}${tag}   running as ${procs}`));
        });
        console.log();
    }

    if (trending.length === 0) {
        console.log(c.yellow(`  nothing new to recommend — every trending instrument is already running under PM2`));
        await pauseForReview();
        return;
    }

    // Single numbered list (so the "deploy number" picker below stays
    // simple) but split visually into two labeled groups by category —
    // both are still trending and both are still deployable, this is a
    // caution label on the second group, not a second filter excluding it.
    const recommended = trending.filter(r => r.category === "recommended");
    const exhausted    = trending.filter(r => r.category === "exhausted");

    console.log();
    if (recommended.length > 0) {
        console.log(c.bold(`  RECOMMENDED (ADX ${ADX_TREND_THRESH}\u2013${ADX_EXHAUSTED_THRESH}, not already running)`));
        recommended.forEach((r) => {
            const i = trending.indexOf(r);
            console.log(c.green(`  ${String(i + 1).padStart(2)}. ${r.underlying.padEnd(18)} ADX ${r.adxVal.toFixed(1)}   ${r.contract.symbol}`));
        });
        console.log();
    }
    if (exhausted.length > 0) {
        console.log(c.bold(`  MIGHT BE EXHAUSTED (ADX > ${ADX_EXHAUSTED_THRESH}, not already running)`));
        exhausted.forEach((r) => {
            const i = trending.indexOf(r);
            console.log(c.yellow(`  ${String(i + 1).padStart(2)}. ${r.underlying.padEnd(18)} ADX ${r.adxVal.toFixed(1)}   ${r.contract.symbol}`));
        });
        console.log();
    }

    // One at a time, same interaction as Add Instrument — lets the person
    // deploy several picks in a row without re-running the scan for each.
    let picking = true;
    while (picking) {
        const pick = await ask("  deploy number (blank to finish): ");
        if (!pick) { picking = false; break; }
        const chosen = trending[Number(pick) - 1];
        if (!chosen) { console.log(c.yellow("  invalid selection")); continue; }
        await configureAndStartInstrument(chosen.underlying, repo, exchange);
    }
}

async function toggleInstrument(input, procs) {
    const idx = Number(input) - 1;
    const p   = procs[idx];
    if (!p) { console.log(c.yellow("  no such instrument number")); await pauseForReview(); return; }
    if (selected.has(p.name)) selected.delete(p.name); else selected.add(p.name);
    // No pause here on the success path — this is pure navigation (just
    // flips a checkbox), and the redrawn menu on the next loop already
    // shows the result. Only the error case above needs one.
}

async function startSelected(procs) {
    const targets = procs.filter(p => selected.has(p.name));
    if (targets.length === 0) { console.log(c.yellow("  nothing selected")); await pauseForReview(); return; }
    for (const p of targets) {
        try { await pm2Start({ ...PM2_BASE_OPTS, script: "engine.js", name: p.name, cwd: __dirname }); console.log(c.green(`  started ${p.name}`)); }
        catch (err) { console.log(c.red(`  failed to start ${p.name}: ${err.message}`)); }
    }
    await pauseForReview();
}

async function stopSelected(procs) {
    const targets = procs.filter(p => selected.has(p.name));
    if (targets.length === 0) { console.log(c.yellow("  nothing selected")); await pauseForReview(); return; }
    for (const p of targets) {
        try { await pm2Stop(p.name); console.log(c.green(`  stopped ${p.name}`)); }
        catch (err) { console.log(c.red(`  failed to stop ${p.name}: ${err.message}`)); }
    }
    await pauseForReview();
}

async function restartSelected(procs) {
    const targets = procs.filter(p => selected.has(p.name));
    if (targets.length === 0) { console.log(c.yellow("  nothing selected")); await pauseForReview(); return; }
    for (const p of targets) {
        try {
            await pm2Restart({ ...PM2_BASE_OPTS, script: "engine.js", name: p.name, cwd: __dirname, updateEnv: true, env: buildProcessEnv(p) });
            console.log(c.green(`  restarted ${p.name}`));
        } catch (err) {
            console.log(c.red(`  failed to restart ${p.name}: ${err.message}`));
        }
    }
    await pauseForReview();
}

async function deleteSelected(procs) {
    const targets = procs.filter(p => selected.has(p.name));
    if (targets.length === 0) { console.log(c.yellow("  nothing selected")); await pauseForReview(); return; }
    for (const p of targets) {
        try { await pm2Delete(p.name); selected.delete(p.name); console.log(c.green(`  removed ${p.name}`)); }
        catch (err) { console.log(c.red(`  failed to remove ${p.name}: ${err.message}`)); }
    }
    await pauseForReview();
}

// ─── VIEW LOGS — reads straight from PM2's own tracked log file paths ─────
const N_LOG_LINES = 30;

function tailFile(filePath, n) {
    if (!filePath || !fs.existsSync(filePath)) return [c.dim(`(no log file yet: ${filePath || "unknown path"})`)];
    try {
        const text  = fs.readFileSync(filePath, "utf8");
        const lines = text.split(/\r?\n/).filter(l => l.length > 0);
        return lines.slice(-n);
    } catch (err) {
        return [c.red(`(failed to read log: ${err.message})`)];
    }
}

async function viewLogs(procs) {
    if (procs.length === 0) { console.log(c.yellow("  no instruments running")); return; }

    procs.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.underlying}/${(STRATEGY_INFO[p.strategy] || { short: p.strategy }).short}`));
    const pick = await ask("  select instrument (blank to cancel): ");
    if (!pick) return;
    const p = procs[Number(pick) - 1];
    if (!p) { console.log(c.yellow("  invalid selection")); return; }

    console.log();
    console.log(c.bold(`  ${p.name} — last ${N_LOG_LINES} lines (stdout)`));
    console.log(c.dim(`  ${p.outLogPath || "path unknown"}`));
    console.log();
    tailFile(p.outLogPath, N_LOG_LINES).forEach(line => console.log(line));

    const errLines     = tailFile(p.errLogPath, N_LOG_LINES);
    const hasRealErrors = p.errLogPath && fs.existsSync(p.errLogPath) && errLines.some(l => l.trim().length > 0);
    if (hasRealErrors) {
        console.log();
        console.log(c.red(`  ${p.name} — last ${N_LOG_LINES} lines (stderr)`));
        console.log(c.dim(`  ${p.errLogPath}`));
        console.log();
        errLines.forEach(line => console.log(c.red(line)));
    }

    console.log();
    await ask("  press enter to return to menu: ");
}

// ─── VIEW LOGS end ──────────────────────────────────────────────────────────

// ─── ROLL CONTRACT — manual roll, matches the confirm-before-commit flow ────
async function rollContract(procs) {
    if (procs.length === 0) { console.log(c.yellow("  no instruments running to roll")); await pauseForReview(); return; }

    procs.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.underlying}/${(STRATEGY_INFO[p.strategy] || { short: p.strategy }).short}`));
    const pick = await ask("  select instrument to roll (blank to cancel): ");
    if (!pick) return;
    const p = procs[Number(pick) - 1];
    if (!p) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }

    const def = getDefinition(p.underlying, p.exchange);
    if (def.noRoll) {
        console.log();
        console.log(c.dim(`  ${p.underlying} is an NSE equity, not a futures contract — it doesn't expire, so there's`));
        console.log(c.dim(`  nothing to roll. It just keeps running on the same instrument indefinitely.`));
        await pauseForReview();
        return;
    }

    const repo = await ensureCsvLoaded();

    let current;
    try {
        current = resolveCurrent(p.underlying, def, repo, pinStore).contract;
    } catch (err) {
        console.log(c.red(`  ${err.message}`));
        await pauseForReview();
        return;
    }

    const allFutures = repo.findFuturesFor(p.underlying);   // already sorted by expiry asc
    const currentIdx = allFutures.findIndex(f => f.token === current.token);
    let next          = currentIdx >= 0 ? allFutures[currentIdx + 1] : null;

    // Not found in the CSV — broker hasn't listed it yet, or the local file
    // is stale. Rather than block the roll, collect it manually so the
    // person isn't stuck waiting on a file refresh to move forward.
    let manualEntry = false;
    if (!next) {
        console.log();
        console.log(c.yellow(`  next contract for ${p.underlying} not found in the instrument dump.`));
        console.log(c.yellow(`  enter it manually (you'll see it above as "Not found" for reference):`));
        console.log();
        const symbol   = await ask("  new symbol: ");
        if (!symbol) { console.log(c.dim("  cancelled")); await pauseForReview(); return; }
        const tokenIn  = await ask("  new token: ");
        const token    = Number(tokenIn);
        if (!Number.isFinite(token) || token <= 0) { console.log(c.yellow("  invalid token")); await pauseForReview(); return; }
        const lotIn    = await ask(`  new lot size (blank = same as current, ${current.lotSize}): `);
        const lotSize  = lotIn ? Number(lotIn) : current.lotSize;
        if (!Number.isFinite(lotSize) || lotSize <= 0) { console.log(c.yellow("  invalid lot size")); await pauseForReview(); return; }

        next = { symbol, token, lotSize, tickSize: current.tickSize, expiry: null };
        manualEntry = true;
    }

    console.log();
    console.log(c.bold("═══════════════════════════════════════════════"));
    console.log(c.bold("           ROLL CONTRACT"));
    console.log(c.bold("═══════════════════════════════════════════════"));
    console.log();
    console.log(`  Instrument : ${def.name}`);
    console.log();
    console.log(`  Current : ${current.symbol}`);
    console.log(`  Next    : ${manualEntry ? c.yellow("Not found") : next.symbol}`);
    console.log();
    console.log(`  Token`);
    console.log(`  Old : ${current.token}`);
    console.log(`  New : ${next.token}`);
    console.log();
    console.log(`  Lot Size`);
    console.log(`  Old : ${current.lotSize}`);
    console.log(`  New : ${next.lotSize}`);
    console.log();

    const confirm = (await ask("  Proceed? [Y] Yes  [N] No: ")).trim().toUpperCase();
    if (confirm !== "Y") { console.log(c.dim("  cancelled")); await pauseForReview(); return; }

    const pin = manualEntry
        ? { symbol: next.symbol, token: next.token, lotSize: next.lotSize, tickSize: next.tickSize, manual: true }
        : { symbol: next.symbol };
    pinStore.setPin(p.underlying, pin);

    console.log();
    console.log(c.green("  ✓ Context Updated"));
    console.log();
    console.log(`  Old Contract : ${current.symbol}`);
    console.log(`  New Contract : ${manualEntry ? next.symbol + " (manual)" : next.symbol}`);
    console.log();
    console.log(c.green("  ✓ Token Updated"));
    console.log(c.green("  ✓ Symbol Updated"));
    console.log(c.green("  ✓ Context Saved"));
    if (manualEntry) {
        console.log(c.yellow("  ⚠ saved as a manual pin — not CSV-validated. Once the broker/local file"));
        console.log(c.yellow("    lists this contract for real, re-run the roll to replace it with a"));
        console.log(c.yellow("    normal (self-healing) pin."));
    }
    console.log();

    // The pin just saved is scoped to the UNDERLYING, not this one process
    // — any sibling process running a different strategy on the same
    // underlying reads that same pin. Restarting only the picked process
    // would leave siblings silently trading the OLD contract until their
    // own next restart, which is exactly the kind of split-contract state
    // that becomes possible now that one underlying can run more than one
    // strategy at once (see toProcessName). All of them need to move to
    // the new contract together.
    const siblings = procs.filter(sib => sib.underlying === p.underlying);
    if (siblings.length > 1) {
        console.log(c.yellow(`  ⚠ ${siblings.length} processes run ${p.underlying} (${siblings.map(s => (STRATEGY_INFO[s.strategy] || { short: s.strategy }).short).join(", ")}) — all of them need this restart, not just the one picked, or they'll end up split across two different contracts.`));
    }

    const restart = (await ask(`  Restart engine${siblings.length > 1 ? "s" : ""}? [Y/N]: `)).trim().toUpperCase();
    if (restart === "Y") {
        for (const target of siblings) {
            try {
                await pm2Restart({ ...PM2_BASE_OPTS, script: "engine.js", name: target.name, cwd: __dirname, updateEnv: true, env: buildProcessEnv(target) });
                console.log(c.green(`  restarted ${target.name} — now running on ${next.symbol}`));
            } catch (err) {
                console.log(c.red(`  restart failed for ${target.name}: ${err.message} — pin is saved, restart manually when ready`));
            }
        }
    } else {
        console.log(c.yellow(`  pin saved but NOT applied yet — ${siblings.map(s => s.name).join(", ")} still on ${current.symbol} until restarted`));
    }
    await pauseForReview();
}

// ─── ACCESS TOKEN REFRESH ──────────────────────────────────────────────────────
function extractRequestToken(input) {
    if (input.includes("request_token=")) {
        try {
            const url = new URL(input.includes("://") ? input : `https://x?${input}`);
            const fromQuery = url.searchParams.get("request_token");
            if (fromQuery) return fromQuery;
        } catch {
            const m = input.match(/request_token=([^&\s]+)/);
            if (m) return m[1];
        }
    }
    return input;   // assume raw token was pasted
}

// ─── ENV FILE — minimal read/write, KEY=VALUE lines only. Not a general
// .env parser (no quoting, no multiline values) — matches exactly what
// this project's own .env actually contains. Preserves any line this flow
// doesn't manage, so anything added by hand survives, and updates existing
// keys in place rather than duplicating them further down the file.
const ENV_PATH = path.join(__dirname, ".env");

function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return { lines: [], values: {} };
    const lines  = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
    const values = {};
    for (const line of lines) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) values[m[1]] = m[2];
    }
    return { lines, values };
}

function writeEnvFile(updates) {
    const { lines } = readEnvFile();
    const updatedKeys = new Set();

    const out = lines.map(line => {
        const m = line.match(/^([A-Z0-9_]+)=/);
        if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
            updatedKeys.add(m[1]);
            return `${m[1]}=${updates[m[1]]}`;
        }
        return line;
    });

    // Trim trailing blank lines BEFORE appending anything new — otherwise a
    // pre-existing trailing newline in the file leaves a stray blank line
    // sitting between the old content and whatever gets appended below.
    while (out.length && out[out.length - 1] === "") out.pop();

    // Anything new (key wasn't already a line in the file) gets appended.
    for (const key of Object.keys(updates)) {
        if (!updatedKeys.has(key)) out.push(`${key}=${updates[key]}`);
    }

    fs.writeFileSync(ENV_PATH, out.join("\n") + "\n");
}

// Shows enough of a secret to recognize it without exposing the whole
// thing on screen (this is a phone SSH terminal, easy to shoulder-surf,
// and terminal scrollback isn't secure storage).
function maskSecret(val) {
    if (!val) return c.dim("(not set)");
    if (val.length <= 8) return c.dim("*".repeat(val.length));
    return c.dim(val.slice(0, 4) + "*".repeat(val.length - 8) + val.slice(-4));
}

// ─── CREDENTIALS — interactive .env setup, so API keys/tokens never need
// hand-editing a file over SSH. Blank input at any prompt keeps the
// current value unchanged (shown masked above each prompt) — an update
// flow, not a forced re-entry of everything every time this runs.
async function setupCredentials() {
    const { values: current } = readEnvFile();

    console.log();
    console.log(c.bold("  CREDENTIALS"));
    console.log(c.dim(`  file: ${ENV_PATH}`));
    console.log(c.dim("  blank = keep current value"));
    console.log();

    const fields = [
        { key: "API_KEY",          label: "Kite API key" },
        { key: "API_SECRET",       label: "Kite API secret" },
        { key: "TELEGRAM_TOKEN",   label: "Telegram bot token" },
        { key: "TELEGRAM_CHAT_ID", label: "Telegram chat ID" },
    ];

    const updates = {};
    for (const f of fields) {
        console.log(`  ${f.label}: ${maskSecret(current[f.key])}`);
        const input = await ask(`  new value (blank = keep): `);
        if (input) updates[f.key] = input;
        console.log();
    }

    if (Object.keys(updates).length === 0) {
        console.log(c.dim("  nothing changed"));
        await pauseForReview();
        return;
    }

    writeEnvFile(updates);
    console.log(c.green(`  saved ${Object.keys(updates).length} value(s) to .env`));
    // engineConfig.js reads these at require() time, once, into a frozen
    // module cache — this process (and any already-running engine) already
    // has the OLD values loaded in memory and won't see the new ones until
    // it's actually restarted, same reasoning as updateAccessToken() below.
    console.log(c.yellow("  this only takes effect on the NEXT run — restart the toolbox (Ctrl+C, run"));
    console.log(c.yellow("  talgox again) and restart any running engines to pick it up."));
    await pauseForReview();
}

async function updateAccessToken() {
    if (!engineConfig.API_SECRET) {
        console.log(c.red("  API_SECRET not set in .env — required to exchange request_token for access_token"));
        await pauseForReview();
        return;
    }

    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    console.log();
    console.log(c.dim("  paste the request_token from your Kite mobile app login (raw token or full redirect URL):"));
    const input = await ask("  request_token: ");
    const requestToken = extractRequestToken(input);
    if (!requestToken) {
        console.log(c.red("  no token found in that input"));
        await pauseForReview();
        return;
    }

    try {
        const session = await kc.generateSession(requestToken, engineConfig.API_SECRET);
        fs.writeFileSync(engineConfig.ACCESS_TOKEN_FILE, session.access_token);
        console.log(c.green(`  access token updated -> ${engineConfig.ACCESS_TOKEN_FILE}`));
        console.log(c.yellow("  restart any running processes to pick up the new token."));
        csvRepo       = null;   // force a fresh instrument-dump load next time it's needed
        equityCsvRepo = null;   // same, for the NSE equity dump
        kiteClient    = null;   // was authenticated with the now-stale token
    } catch (err) {
        console.log(c.red(`  token exchange failed: ${err.message}`));
    }
    await pauseForReview();
}

// ─── CUSTOM STRATEGY BUILDER ────────────────────────────────────────────────
// "Create Your Own Strategy" wizard — steps 1-7 per the locked design.
// Nested AND/OR was deliberately skipped for v1: a flat AND-list per entry
// side and a flat OR-list for conditionExit covers every example strategy
// discussed, and a real nested-tree builder in a terminal is a bad UX fight
// worth avoiding until something actually needs it. conditionEvaluator.js
// itself already supports real nesting if a spec is authored some other way.

// Given "indicatorId.field" and the list of indicator blocks configured in
// this wizard session, finds that block's catalog entry and returns its
// `states` list if the field is "state" and the catalog defines one — null
// otherwise (wrong field, or an indicator with no states defined yet, e.g.
// ADX/ALMA/EMA which only expose "value"). Mirrors webdash's
// strategyBuilder.js's csbLookupStates so both wizards color the same way.
function toolboxLookupStates(operandRef, indicators) {
    if (!operandRef || operandRef.startsWith("price.")) return null;
    const [id, field] = operandRef.split(".");
    if (field !== "state") return null;
    const block = indicators.find(ind => ind.id === id);
    if (!block) return null;
    return INDICATOR_CATALOG[block.type].states || null;
}

async function pickOperand(indicators, promptLabel) {
    const options = [];
    indicators.forEach(ind => {
        const def = INDICATOR_CATALOG[ind.type];
        def.exposes.forEach(field => options.push(`${ind.id}.${field}`));
    });
    ["price.close", "price.high", "price.low", "constant"].forEach(o => options.push(o));

    console.log(c.dim(`  ${promptLabel}:`));
    options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
    const sel = await ask("  select number: ");
    const choice = options[Number(sel) - 1];
    if (!choice) return null;
    if (choice === "constant") {
        const val = await ask("    value: ");
        const num = Number(val);
        return Number.isFinite(num) ? num : null;
    }
    return choice;
}

async function buildConditionList(indicators, label, side = null) {
    const conditions = [];
    console.log();
    console.log(c.dim(`  ${label} — add conditions (blank left operand to finish):`));
    while (true) {
        console.log();
        const left = await pickOperand(indicators, `condition ${conditions.length + 1} — left operand`);
        if (left === null) break;

        console.log(c.dim("  operator:"));
        const OPS = [">", "<", ">=", "<=", "==", "crosses_above", "crosses_below", "state_flips_to"];
        OPS.forEach((o, i) => console.log(`  ${i + 1}. ${o}${o === "state_flips_to" ? c.dim("  (slope/regime change)") : ""}`));
        const opSel = OPS[Number(await ask("  select number: ")) - 1];
        if (!opSel) { console.log(c.yellow("  invalid operator, skipping condition")); continue; }

        if (opSel === "state_flips_to") {
            // Tab-implied color: on the LONG side, a slope/regime condition
            // only ever means "flips to a bullish (green) state"; on SHORT,
            // only "flips to a bearish (red) state". Per request, don't ask
            // for a color/label here — it's implied by which side is being
            // built, so there's nothing to disable, it's just never shown.
            // Falls back to the full picker for indicators with no states
            // defined, or when side is null (exit conditions aren't
            // long/short-scoped).
            const states = toolboxLookupStates(left, indicators);
            const impliedColor = side === "long" ? "green" : side === "short" ? "red" : null;
            const autoMatches = states && impliedColor ? states.filter(s => s.color === impliedColor) : [];

            if (states && autoMatches.length > 0) {
                console.log(c.dim(`  auto: `) + c[impliedColor](impliedColor.toUpperCase()) + c.dim(` (${side} entry) \u2014 ${autoMatches.map(s => s.value).join(" or ")}`));
                if (autoMatches.length === 1) {
                    conditions.push({ left, operator: opSel, right: autoMatches[0].value });
                } else {
                    conditions.push({ op: "OR", conditions: autoMatches.map(s => ({ left, operator: opSel, right: s.value })) });
                }
            } else {
                let right;
                if (states) {
                    console.log(c.dim("  target state:"));
                    states.forEach((s, i) => console.log(`  ${i + 1}. ${c[s.color] ? c[s.color](s.value) : s.value}`));
                    console.log(`  ${states.length + 1}. ${c.dim("custom...")}`);
                    const stSel = await ask("  select number: ");
                    const idx = Number(stSel) - 1;
                    if (idx >= 0 && idx < states.length) right = states[idx].value;
                    else if (idx === states.length) right = await ask("    target state: ");
                    else right = null;
                } else {
                    right = await ask("    target state (e.g. STRONG_BULL): ");
                }
                if (!right) { console.log(c.yellow("  state label required, skipping condition")); continue; }
                conditions.push({ left, operator: opSel, right });
            }
        } else {
            const right = await pickOperand(indicators, "right operand");
            if (right === null) { console.log(c.yellow("  invalid right operand, skipping condition")); continue; }
            conditions.push({ left, operator: opSel, right });
        }

        const more = await ask("  add another condition? (y/N): ");
        if (more.toLowerCase() !== "y") break;
    }
    return conditions.length ? { op: "AND", conditions } : null;
}

async function buildExitConfig(indicators) {
    console.log();
    console.log(c.dim("  EXIT / TARGET / RISK"));

    const reversalAns = await ask("  exit on opposite entry signal? (Y/n): ");
    const reversalExit = reversalAns.toLowerCase() !== "n";

    const wantCondExit = await ask("  add an explicit exit condition too? (y/N): ");
    let conditionExit = null;
    if (wantCondExit.toLowerCase() === "y") {
        const list = await buildConditionList(indicators, "EXIT CONDITION (any true = exit)");
        conditionExit = list ? { op: "OR", conditions: list.conditions } : null;
    }

    console.log(c.dim("  target type: 1. points  2. none"));
    const targetType = await ask("  select number: ");
    let target = null;
    if (targetType === "1") {
        const val = await ask("    target points: ");
        const num = Number(val);
        if (Number.isFinite(num) && num > 0) target = { type: "points", value: num };
        else console.log(c.yellow("  invalid target, leaving unset"));
    }

    console.log(c.dim("  stop-loss type: 1. ATR  2. points  3. none"));
    const slType = await ask("  select number: ");
    let stopLoss = null;
    if (slType === "1") {
        const atrBlocks = indicators.filter(i => i.type === "ATR");
        if (!atrBlocks.length) {
            console.log(c.yellow("  no ATR indicator configured — pick 'points' instead, or go back and add one"));
        } else {
            const mult = Number(await ask("    ATR multiplier: "));
            const atrRef = atrBlocks.length === 1
                ? `${atrBlocks[0].id}.value`
                : `${(await ask(`    which ATR id? (${atrBlocks.map(b => b.id).join(", ")}): `)).trim()}.value`;
            if (Number.isFinite(mult) && mult > 0) stopLoss = { type: "atr", mult, atrRef };
            else console.log(c.yellow("  invalid multiplier, leaving stop unset"));
        }
    } else if (slType === "2") {
        const val = Number(await ask("    stop points: "));
        if (Number.isFinite(val) && val > 0) stopLoss = { type: "points", value: val };
        else console.log(c.yellow("  invalid value, leaving stop unset"));
    }

    return { reversalExit, conditionExit, target, stopLoss };
}

async function createCustomStrategy() {
    console.log();
    console.log(c.dim("  CREATE YOUR OWN STRATEGY"));
    console.log();

    // Step 1 — Candle Type
    console.log(c.dim("  candle type:"));
    console.log("  1. Raw");
    console.log("  2. Heikin-Ashi");
    const candleInput = await ask("  select number: ");
    const candleType = candleInput === "2" ? "ha" : candleInput === "1" ? "raw" : null;
    if (!candleType) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }

    // Step 2 — Time Frame (tick mode intentionally excluded for now — see
    // chat: "ignore ticks for now". requiresCandles filtering below is a
    // no-op until tick mode exists, kept here so step 3 already reads from
    // the same gate it'll need later instead of a second pass being required.)
    const TIMEFRAMES = ["5m", "15m", "30m", "1h"];
    console.log();
    console.log(c.dim("  time frame:"));
    TIMEFRAMES.forEach((tf, i) => console.log(`  ${i + 1}. ${tf}`));
    const tfInput = await ask("  select number: ");
    const timeframe = TIMEFRAMES[Number(tfInput) - 1];
    if (!timeframe) { console.log(c.yellow("  invalid selection")); await pauseForReview(); return; }

    // Step 3 — Indicators (multi-select, comma-separated numbers)
    const indicatorKeys = Object.keys(INDICATOR_CATALOG).filter(key => INDICATOR_CATALOG[key].requiresCandles);
    console.log();
    console.log(c.dim("  indicators (comma-separated numbers, e.g. 1,3,4):"));
    indicatorKeys.forEach((key, i) => console.log(`  ${i + 1}. ${INDICATOR_CATALOG[key].label}`));
    const indInput = await ask("  select: ");
    const chosenKeys = indInput.split(",").map(s => s.trim()).filter(Boolean)
        .map(n => indicatorKeys[Number(n) - 1]).filter(Boolean);
    if (chosenKeys.length === 0) { console.log(c.yellow("  pick at least one indicator")); await pauseForReview(); return; }

    // Step 4 — Configure each selected indicator
    const indicators = [];
    for (const key of chosenKeys) {
        const def = INDICATOR_CATALOG[key];
        console.log();
        console.log(c.dim(`  configure ${def.label}:`));
        const idInput = await ask(`  id (blank = ${key.toLowerCase()}_1): `);
        const id = idInput || `${key.toLowerCase()}_1`;
        if (indicators.some(ind => ind.id === id)) {
            console.log(c.yellow(`  id "${id}" already used in this strategy — skipping ${def.label}`));
            continue;
        }
        const params = {};
        for (const p of def.params) {
            const val = await ask(`    ${p.label} (default ${p.default}): `);
            const num = Number(val);
            params[p.key] = val && Number.isFinite(num) ? num : p.default;
        }
        indicators.push({ id, type: key, params });
    }
    if (indicators.length === 0) { console.log(c.yellow("  no indicators configured")); await pauseForReview(); return; }

    // Step 5 — Entry Conditions
    const entryLong  = await buildConditionList(indicators, "ENTRY \u2014 LONG", "long");
    const entryShort = await buildConditionList(indicators, "ENTRY \u2014 SHORT", "short");
    if (!entryLong && !entryShort) { console.log(c.yellow("  need at least one entry side")); await pauseForReview(); return; }

    // Step 6 — Exit / Target / Risk
    const exitConfig = await buildExitConfig(indicators);

    // Step 7 — Preview + Deploy (save; actual instrument deployment happens
    // through "Add instrument", which now lists saved custom strategies
    // alongside the hardcoded ones)
    console.log();
    console.log(c.dim("  PREVIEW"));
    console.log(`  candle: ${candleType}   timeframe: ${timeframe}`);
    console.log(`  indicators: ${indicators.map(i => `${i.id}(${i.type})`).join(", ")}`);
    console.log(`  entry long:  ${entryLong  ? JSON.stringify(entryLong)  : "(none)"}`);
    console.log(`  entry short: ${entryShort ? JSON.stringify(entryShort) : "(none)"}`);
    console.log(`  exit: ${JSON.stringify(exitConfig)}`);
    const confirm = await ask("  save this strategy? (Y/n): ");
    if (confirm.toLowerCase() === "n") { console.log(c.yellow("  discarded")); await pauseForReview(); return; }

    const name = await ask("  strategy name: ");
    if (!name) { console.log(c.yellow("  name required")); await pauseForReview(); return; }
    try {
        await customStrategyDb.saveStrategy({ name, candleType, timeframe, indicators, entryLong, entryShort, exitConfig });
        console.log(c.green(`  saved "${name}" \u2014 deploy it via "Add instrument", it now shows alongside the prebuilt list.`));
    } catch (err) {
        console.log(c.yellow(`  save failed: ${err.message.includes("UNIQUE") ? "a strategy named that already exists" : err.message}`));
    }
    await pauseForReview();
}

// ─── MAIN LOOP ──────────────────────────────────────────────────────────────
async function main() {
    await playBootAnimation({ pm2Connect });

    let running = true;
    let procs   = await renderMenu();
    while (running) {
        const input  = (await ask("> ")).trim().toUpperCase();
        let redraw   = true;

        if (/^[1-9]$/.test(input))       await toggleInstrument(input, procs);
        else if (input === "A")           await addInstrument();
        else if (input === "S")           await startSelected(procs);
        else if (input === "X")           await stopSelected(procs);
        else if (input === "R")           await restartSelected(procs);
        else if (input === "D")           await deleteSelected(procs);
        else if (input === "C")           await rollContract(procs);
        else if (input === "M")           await toggleMode(procs);
        else if (input === "P")           await editInstrument(procs);
        else if (input === "L")           await viewLogs(procs);
        else if (input === "T")           await updateAccessToken();
        else if (input === "B")           await backtestFlow({ ask, pauseForReview, ensureCsvLoaded, pinStore, resolveCurrent, getDefinition, buildContext, defaultEodFor, c, engineConfig });
        else if (input === "N")           await trendingInstruments();
        else if (input === "E")           await setupCredentials();
        else if (input === "K")           await marketStatusScreen();
        else if (input === "U")           await createCustomStrategy();
        else if (input === "V")           await riskManagement(procs);
        else if (input === "Q")           { running = false; redraw = false; }
        else                               { console.log(c.yellow("  unrecognized option")); redraw = false; }

        if (running && redraw) procs = await renderMenu();
    }

    pm2.disconnect();
    rl.close();
    console.log(c.dim("  bye."));
    // Without this, the process only exits if nothing else in the whole
    // codebase has left a timer/handle open — true today, but fragile:
    // one stray setInterval anywhere (a future feature, a leftover from
    // debugging) silently turns "quit" into a hang, exactly like this.
    // A user-initiated quit should be unconditional.
    process.exit(0);
}

main().catch(err => {
    console.error(c.red("toolbox crashed:"), err);
    try { pm2.disconnect(); } catch {}
    process.exit(1);
});
