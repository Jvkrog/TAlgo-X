#!/usr/bin/env node
// webdash/server.js — TAlgo-X web dashboard bridge server.
//
// Three jobs, one process:
//   1. WS endpoint /engine  — each running engine.js process (via
//      eventBridge.js) connects here and streams TICK/ENTRY/EXIT/MODE
//      events. Relayed straight through to every connected browser.
//   2. WS endpoint /ws      — browsers connect here for the live relay.
//   3. HTTP API             — instrument list (from PM2, same source
//      toolbox.js's main menu uses), per-engine state (read straight from
//      the same SQLite files db.js writes), and start/stop/restart
//      control (same PM2 calls toolbox.js makes).
//
// Deliberately read-only against the trading logic itself: this process
// never touches strategies.js/positions.js/orders.js, never writes to any
// .db file, and its only side effect on a running engine is the PM2
// lifecycle calls a human could otherwise make from toolbox.js directly.
"use strict";
const SCALP_NEXT_RE = /^(TARGET:\d*(\.\d+)?|SL:\d+(\.\d+)?)$/;   // post-scalp-hit rule: next target OR fixed stop, in rupees

const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const pm2 = require("pm2");
const sqlite3 = require("sqlite3").verbose();
const { KiteConnect } = require("kiteconnect");
const engineConfig = require("../engineConfig");
const { upsertEnvVar, readEnvVarFresh, ENV_PATH: ENV_FILE_PATH } = require("../envFile");
const { todayIST } = require("../istTime");
const { nativeCandleType, normalizeCandleType, candleSuffix } = require("../candleType");
const { DB_DIR } = require("../dbDir");

// ─── TOOLBOX PORT — same modules toolbox.js's Add Instrument / Backtest /
// Setup Credentials screens use, required directly rather than reaching
// into toolbox.js itself (that file owns readline/stdin, not reusable
// here) — see the three new /api/toolbox/* sections below.
const { createCsvRepository } = require("../csvRepository");
const { createInstrumentSource } = require("../instrumentSource");
const { createContractPinStore } = require("../contractPins");
const { resolveCurrent } = require("../instrumentResolution");
const { getDefinition, buildContext, defaultEodFor } = require("../context");
const { STRATEGIES, STRATEGY_INFO, STRATEGY_TIMEFRAME, DEFAULT_STRATEGY } = require("../strategies");
const { INDICATOR_CATALOG } = require("../indicatorCatalog");
const customStrategyDb = require("../customStrategyDb");
const { TIMEFRAME_TO_INTERVAL, TIMEFRAME_MINUTES, fetchDailyCandles, fetchHistoricalCandles } = require("../historicalFetch");
const { runBacktest } = require("../backtestRun");
const { runDualHedgeBacktest } = require("../backtestDualHedge");
const { SL_MODES: DH_SL_MODES, ATR_TIMEFRAMES: DH_ATR_TIMEFRAMES } = require("../dualHedgeAtr");
const { runHedgePairBacktest } = require("../backtestHedgePair");
const { STRATEGY_PARAMS } = require("../backtestFlow");
const { setEmitSuppressed } = require("../eventBridge");
const { computeOverlay } = require("../chartOverlay");
const { getShortName } = require("../shortNames");
const dualHedgeUsers = require("../dualHedgeUsers");
const { adx, atr: atrFn } = require("../indicators");
const { createMarketStateClient } = require("../marketStateClient");
const { createMarketWatchlist } = require("../marketWatchlist");

// ─── Same tuning figures + singleton scanner process name toolbox.js's
// Trending Instruments/Market Status screens use — kept in parity, not
// re-derived, since these are calibration values (Wilder's ADX defaults,
// rate-limit backoff) not architecture.
const TRENDING_LOOKBACK_DAYS = 90;
const ADX_LEN = 14;
const ADX_TREND_THRESH = 25;
// 25–30 = recommended, >30 = might be exhausted — both still count as
// "trending" by ADX_TREND_THRESH, this is a caution label on the upper
// part of that band, not a second filter that excludes anything.
const ADX_EXHAUSTED_THRESH = 30;
const SCAN_REQUEST_DELAY_MS = 350;
const RATE_LIMIT_MAX_RETRIES = 2;
const SCANNER_PROCESS_NAME = "MarketScanner";

const marketStateClient = createMarketStateClient();
const marketWatchlist = createMarketWatchlist();

// ─── withCapturedConsole — runs fn() while console.log/console.warn/
// console.error are captured instead of (only) going to this process's own
// stdout. Backtests run in-process here via runBacktest() and print exactly
// what toolbox.js's CLI backtest flow prints (per-day headers, per-candle
// tick lines, entries/exits, SKIP/QUALITY PASS notes) — previously those
// lines only ever reached the webdash server's own PM2 log, never the
// browser, so the web UI showed just the final summary card. This captures
// that same output so it can be shipped back in the API response, giving
// the web backtest the same log detail the CLI has always shown.
// ANSI color codes (see c.js) are stripped — this becomes a plain scrollable
// log block in the browser, not a terminal.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
async function withCapturedConsole(fn) {
    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args) => {
        const text = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        lines.push(text.replace(ANSI_RE, ""));
    };
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
        const result = await fn();
        return { result, lines };
    } finally {
        console.log = real.log;
        console.warn = real.warn;
        console.error = real.error;
    }
}

const ROOT = path.join(__dirname, "..");
const PORT = process.env.WEBDASH_PORT || 4790;

const pinStore = createContractPinStore(path.join(ROOT, "contractPins.json"));
let csvRepo = null;
let equityCsvRepo = null;

// Deliberately NOT memoized — .env's ACCESS_TOKEN gets refreshed daily by
// the token-exchange flow, and this server process stays up for days at a
// time (unlike a one-shot toolbox.js CLI invocation). Caching the client
// here meant every toolbox request after the day's first one kept using
// whichever token was current at server boot, failing with "Incorrect
// api_key or access_token" even once the day's new token was in .env —
// same construct-fresh-each-time pattern the token-exchange endpoint below
// already uses, now applied here too. engineConfig.getAccessToken() itself
// re-reads .env from disk on every call, not process.env's boot-time cache
// — that's what actually makes this safe to not memoize.
function ensureToolboxKite() {
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(engineConfig.getAccessToken());
    return kc;
}


async function ensureCsvLoaded() {
    if (csvRepo) return csvRepo;
    const kc = ensureToolboxKite();
    csvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({ filePath: engineConfig.INSTRUMENT_CSV_PATH, kc, exchange: "MCX" }).fetchRows,
    });
    await csvRepo.load();
    return csvRepo;
}

async function ensureEquityCsvLoaded() {
    if (equityCsvRepo) return equityCsvRepo;
    const kc = ensureToolboxKite();
    equityCsvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({ filePath: engineConfig.NSE_INSTRUMENT_CSV_PATH, kc, exchange: "NSE" }).fetchRows,
    });
    await equityCsvRepo.load();
    return equityCsvRepo;
}

// Same naming scheme as toolbox.js's toProcessName — short code + strategy
// short + "Engine" — must match exactly, since getEngineProcesses()
// identifies a duplicate by this same computed name.
const CANDLE_NAME_TAG = { RAW: "Raw", HA: "HA", RANGE: "Rng" };
function toProcessName(underlying, strategy, candleType) {
    const stratShort = (STRATEGY_INFO[strategy] || { short: strategy }).short;
    const ct = normalizeCandleType(candleType);
    const tag = ct && ct !== nativeCandleType(strategy) ? CANDLE_NAME_TAG[ct] : "";
    return `${getShortName(underlying)}${stratShort}${tag}Engine`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isRateLimitError(err) {
    const msg = (err.message || "").toLowerCase();
    return msg.includes("too many requests") || msg.includes("rate limit") || msg.includes("429");
}

// Headless port of toolbox.js's scanTrendingInstruments — same retry/
// backoff behavior, minus the console.log progress lines; reports progress
// via callback instead, so the route can stream it (see below).
async function scanUnderlyings(underlyings, repo, exchange, onProgress) {
    const kc = ensureToolboxKite();
    const to = new Date();
    const from = new Date(to.getTime() - TRENDING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const results = [];
    let done = 0;
    for (const underlying of underlyings) {
        let attempt = 0;
        while (true) {
            try {
                const def = getDefinition(underlying, exchange);
                const { contract } = resolveCurrent(underlying, def, repo, pinStore);
                const candles = await fetchDailyCandles({ kc, token: contract.token, from, to });
                const adxArr = adx(candles, ADX_LEN);
                let latest = null;
                for (let i = adxArr.length - 1; i >= 0; i--) { if (adxArr[i] !== null) { latest = adxArr[i]; break; } }
                if (latest !== null) {
                    const trending = latest >= ADX_TREND_THRESH;
                    results.push({
                        underlying, symbol: contract.symbol, adxVal: latest, trending,
                        category: trending ? (latest > ADX_EXHAUSTED_THRESH ? "exhausted" : "recommended") : null,
                    });
                }
                break;
            } catch (err) {
                if (isRateLimitError(err) && attempt < RATE_LIMIT_MAX_RETRIES) {
                    attempt++;
                    await sleep(attempt * 1000);
                    continue;
                }
                break; // non-transient error — skip this underlying
            }
        }
        done++;
        if (onProgress) onProgress(done, underlyings.length, underlying);
        await sleep(SCAN_REQUEST_DELAY_MS);
    }
    return results;
}

// ─── PIN-LOCK SESSION AUTH ──────────────────────────────────────────────────
// Real server-side auth, not just a client-side overlay — every API route
// and the /ws browser socket require a valid session cookie. WEBDASH_PIN is
// read from .env (same file as API_KEY/API_SECRET). If it's unset, auth is
// disabled entirely (fail-open) and a warning is logged — better than
// silently locking someone out of a dashboard they never configured a PIN
// for.
const crypto = require("crypto");
let WEBDASH_PIN = process.env.WEBDASH_PIN || null;   // CHANGED: was const — ensureWebdashPin() below can now set it
const SESSION_COOKIE = "webdash_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const sessions = new Map(); // token -> expiresAt

// CHANGED Sep 2026 (reported directly) — instead of just warning and
// running wide open, `webdash` now stops at boot and asks for a PIN right
// there in the terminal if .env doesn't have one yet, saves it straight to
// .env (upsertEnvVar), and continues — one run, no separate setup step, no
// restart needed since WEBDASH_PIN above is now a `let` this function can
// actually update. Only prompts once ever, the same way any other .env
// value works — set WEBDASH_PIN="" in .env and remove it if you deliberately
// want auth disabled again without being asked every time.
//
// askHidden() masks what's typed with `*` as it's typed — the plain
// rl.question() used everywhere else in this codebase is fine for
// underlying names and lot sizes, but a PIN (and, below, API_SECRET)
// echoing in plaintext to a terminal someone might be screen-sharing or
// recording defeats the point of having one. Falls back to a normal
// (visible) prompt when stdout isn't a real TTY (e.g. piped/redirected
// output) — the `_writeToOutput` override this relies on only makes sense
// against an actual terminal.
function askHidden(rl, query) {
    if (!process.stdout.isTTY) {
        return new Promise(resolve => rl.question(query, answer => resolve(answer.trim())));
    }
    return new Promise(resolve => {
        const originalWriteToOutput = rl._writeToOutput;
        rl._writeToOutput = function (stringToWrite) {
            // Let the prompt text itself and the final newline through
            // untouched; mask every other character typed as `*`.
            if (stringToWrite === query || stringToWrite === "\r\n" || stringToWrite === "\n") {
                originalWriteToOutput.call(rl, stringToWrite);
            } else {
                originalWriteToOutput.call(rl, "*");
            }
        };
        rl.question(query, answer => {
            rl._writeToOutput = originalWriteToOutput;
            resolve(answer.trim());
        });
    });
}

async function ensureWebdashPin(rl) {
    if (WEBDASH_PIN) return;
    console.log("webdash: no dashboard PIN configured yet — the dashboard would otherwise be open to anyone who reaches this port.");
    let pin = "";
    while (pin.length < 4) {
        pin = await askHidden(rl, "  set a PIN for the dashboard (4+ characters, or blank to skip and leave it disabled): ");
        if (pin === "") break; // explicit opt-out — don't loop forever on someone who really doesn't want one
        if (pin.length < 4) console.log("  PIN must be at least 4 characters — try again.");
    }
    if (pin === "") {
        console.log("webdash: continuing without a PIN — dashboard is restricted to this machine (127.0.0.1) until you set one.");
        return;
    }
    upsertEnvVar("WEBDASH_PIN", pin);
    WEBDASH_PIN = pin; // this same process picks it up immediately, no restart
    console.log("webdash: PIN saved — dashboard is now locked.");
}

// CHANGED Sep 2026 (reported directly) — API_KEY/API_SECRET missing used to
// just print a warning at boot and let every /api/token/* route 404/500
// the first time someone actually tried to use them. Now asked for right
// here too, same one-time-at-boot pattern as the PIN above, so "generate
// token" always has what it needs by the time anyone reaches that screen.
// engineConfig is required once and shared by reference across this whole
// process (never destructured into a separate local anywhere in this
// file) — mutating engineConfig.API_KEY/API_SECRET directly here is
// picked up immediately by every route that reads it, no restart needed,
// same reasoning as WEBDASH_PIN above.
async function ensureApiCredentials(rl) {
    let enteredNow = false;
    if (!engineConfig.API_KEY) {
        const key = (await new Promise(resolve => rl.question("webdash: Kite API key not configured yet — enter it now: ", a => resolve(a.trim())))) || "";
        if (key) {
            upsertEnvVar("API_KEY", key);
            engineConfig.API_KEY = key;
            enteredNow = true;
        }
    }
    if (!engineConfig.API_SECRET) {
        const secret = await askHidden(rl, "webdash: Kite API secret not configured yet — enter it now: ");
        if (secret) {
            upsertEnvVar("API_SECRET", secret);
            engineConfig.API_SECRET = secret;
            enteredNow = true;
        }
    }
    if (!engineConfig.API_KEY || !engineConfig.API_SECRET) {
        console.warn("webdash: Kite API credentials still not configured — /api/token/* routes will fail until they are (set them from Settings).");
    } else if (enteredNow) {
        // only when something was actually typed in and written to .env this boot — silent otherwise
        console.log("webdash: Kite API credentials saved.");
    }
}

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    header.split(";").forEach(part => {
        const idx = part.indexOf("=");
        if (idx === -1) return;
        out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    });
    return out;
}

function createSession() {
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
}

function isValidSession(token) {
    if (!token) return false;
    const exp = sessions.get(token);
    if (!exp) return false;
    if (Date.now() > exp) { sessions.delete(token); return false; }
    return true;
}

// Simple attempt throttling, in-memory, per-process (fine for a
// single-operator dashboard) — 5 wrong PINs locks further attempts out for
// 30s, mirroring the increasing-delay feel of iOS's own passcode screen
// without needing to track it per-IP with any real precision.
// CHANGED (security audit): tracked per remote address, not globally, so a
// stranger's wrong guesses no longer lock the operator out. (Behind a
// reverse proxy every client shares the proxy's address — same as before.)
const loginAttempts = new Map(); // ip -> { fails, lockedUntil, strikes }
function attemptsFor(req) {
    const ip = req.socket.remoteAddress || "?";
    let a = loginAttempts.get(ip);
    if (!a) { a = { fails: 0, lockedUntil: 0, strikes: 0 }; loginAttempts.set(ip, a); }
    if (loginAttempts.size > 500) { for (const [k, v] of loginAttempts) if (v.lockedUntil < Date.now() && !v.fails) loginAttempts.delete(k); }
    return a;
}

// Rejects cross-origin state-changing requests / socket upgrades: a browser
// always sends Origin on those, and it must match the Host it reached.
function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true; // non-browser client (curl, engines)
    try { return new URL(o).host === req.headers.host; } catch { return false; }
}
function secureAttr(req) {
    return (req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") ? "; Secure" : "";
}

function authRequired(req, res, next) {
    if (!WEBDASH_PIN) return next(); // auth disabled
    const cookies = parseCookies(req.headers.cookie);
    if (isValidSession(cookies[SESSION_COOKIE])) return next();
    res.status(401).json({ error: "Unauthorized" });
}

// Same parsing rule as toolbox.js's extractRequestToken — accepts either a
// raw request_token or the full redirect URL Kite sends it back in.
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
    return input; // assume raw token was pasted
}

// Kite sends `redirect_params` back as extra query params on the redirect URL,
// so the return trip carries WHICH account this login was for (account=NAME).
// Without it every redirect looked identical and could only ever be treated as
// the global account's — a second user's request_token was exchanged with the
// wrong API key/secret (or just ignored, landing on the dashboard).
function withAccountParam(loginUrl, account) {
    return `${loginUrl}${loginUrl.includes("?") ? "&" : "?"}redirect_params=${encodeURIComponent("account=" + account)}`;
}

// request_token -> access_token for one named dual-hedge user, with that
// user's own API key/secret. Shared by the paste-back route and the callback.
async function exchangeUserToken(name, rawInput) {
    const user = dualHedgeUsers.getUser(name);
    if (!user.apiKey || !user.apiSecret) {
        throw new Error(`${name} is missing an API key/secret — add credentials first`);
    }
    const requestToken = extractRequestToken(rawInput);
    const kc = new KiteConnect({ api_key: user.apiKey });
    const session = await kc.generateSession(requestToken, user.apiSecret);
    dualHedgeUsers.saveUserToken(user.name, session.access_token);
    return user.name;
}

async function exchangeToken(requestToken) {
    if (!engineConfig.API_SECRET) {
        throw new Error("Kite API secret not configured yet — set it from Settings before exchanging a request_token");
    }
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    const session = await kc.generateSession(requestToken, engineConfig.API_SECRET);
    // .env's ACCESS_TOKEN is the ONLY place this is written now — every
    // reader across the codebase calls engineConfig.getAccessToken(), which
    // re-reads .env fresh every time. No more access_code.txt mirror file
    // as of this change (see engineConfig.js). ACCESS_TOKEN_DATE written
    // alongside it — see engineConfig.js's isAccessTokenFresh() for why.
    upsertEnvVar("ACCESS_TOKEN", session.access_token);
    upsertEnvVar("ACCESS_TOKEN_DATE", todayIST());
    return session;
}

// ─── PM2 HELPERS (same shape as toolbox.js) ────────────────────────────────
function pm2Connect() { return new Promise((res, rej) => pm2.connect(e => e ? rej(e) : res())); }
function pm2List()    { return new Promise((res, rej) => pm2.list((e, l) => e ? rej(e) : res(l))); }
function pm2Start(opts){ return new Promise((res, rej) => pm2.start(opts, (e, p) => e ? rej(e) : res(p))); }
function pm2Stop(n)   { return new Promise((res, rej) => pm2.stop(n, e => e ? rej(e) : res())); }
function pm2Restart(n){ return new Promise((res, rej) => pm2.restart(n, e => e ? rej(e) : res())); }
function pm2Delete(n) { return new Promise((res, rej) => pm2.delete(n, e => e ? rej(e) : res())); }
// Same stop_exit_codes reasoning as toolbox.js's PM2_BASE_OPTS: EOD
// shutdown (lifecycle.js) exits 0 on purpose — without this, PM2's default
// autorestart would treat that clean exit as a crash and reopen trading.
const PM2_BASE_OPTS = { stop_exit_codes: [0] };
// Config-based restart (updateEnv + a full env object) — same shape
// toolbox.js's toggleMode/restartSelected use, distinct from the simple
// by-name pm2Restart above because changing LIVE_ORDERS_OVERRIDE etc.
// requires PM2 to actually apply a new env, not just bounce the process.
function pm2RestartWithConfig(opts) { return new Promise((res, rej) => pm2.restart(opts, e => e ? rej(e) : res())); }

async function getEngineProcesses() {
    const list = await pm2List();
    return list
        .filter(p => p.pm2_env.env?.UNDERLYING)
        .map(p => ({
            name:       p.name,
            underlying: p.pm2_env.env.UNDERLYING,
            status:     p.pm2_env.status,
            uptime:     p.pm2_env.status === "online" ? Date.now() - p.pm2_env.pm_uptime : null,
            lots:       p.pm2_env.env?.LOTS_OVERRIDE || "default",
            lotMult:    p.pm2_env.env?.LOTMULT_OVERRIDE || null,
            live:       p.pm2_env.env?.LIVE_ORDERS_OVERRIDE === "true",
            carryOvernight: p.pm2_env.env?.CARRY_OVERNIGHT_OVERRIDE === "true",
            strategy:   p.pm2_env.env?.STRATEGY_OVERRIDE || "DPI_TREND_MEANREV",
            timeframe:  p.pm2_env.env?.TIMEFRAME_OVERRIDE || null,
            exchange:   p.pm2_env.env?.EXCHANGE_OVERRIDE || "MCX",
            // null = no fixed target, same default as context.js's targetPoints
            targetPoints: p.pm2_env.env?.TARGET_POINTS_OVERRIDE !== undefined && p.pm2_env.env?.TARGET_POINTS_OVERRIDE !== ""
                ? p.pm2_env.env.TARGET_POINTS_OVERRIDE
                : null,
            // "fixed" default matches context.js's targetMode default — only
            // meaningful when targetPoints (above) is unset, same rule
            // engine.js/toolbox.js apply (a fixed points value always wins).
            targetMode: p.pm2_env.env?.TARGET_MODE_OVERRIDE === "adaptive" ? "adaptive" : "fixed",
            // null = use engineConfig.BAND_STEP_DEFAULT, same as
            // context.bandStep's own default-when-unset behavior
            bandStep: p.pm2_env.env?.BAND_STEP_OVERRIDE !== undefined && p.pm2_env.env?.BAND_STEP_OVERRIDE !== ""
                ? p.pm2_env.env.BAND_STEP_OVERRIDE
                : null,
            // DSB-family daily losing-reversal limit; null = off
            maxLosingSwitches: p.pm2_env.env?.MAX_LOSING_SWITCHES_OVERRIDE ? p.pm2_env.env.MAX_LOSING_SWITCHES_OVERRIDE : null,
            maxLosingTrades: p.pm2_env.env?.MAX_LOSING_TRADES_OVERRIDE ? p.pm2_env.env.MAX_LOSING_TRADES_OVERRIDE : null,
            // Choppiness entry filter: an unset env var means OFF at runtime, so report it as such (never silently turn it on).
            chopFilterEnabled: p.pm2_env.env?.CHOP_FILTER_OVERRIDE === "true",
            chopPeriod: p.pm2_env.env?.CHOP_PERIOD_OVERRIDE ? Number(p.pm2_env.env.CHOP_PERIOD_OVERRIDE) : null,
            chopMax: p.pm2_env.env?.CHOP_MAX_OVERRIDE ? Number(p.pm2_env.env.CHOP_MAX_OVERRIDE) : null,
            sessionTargetRupees: p.pm2_env.env?.SESSION_TARGET_OVERRIDE ? Number(p.pm2_env.env.SESSION_TARGET_OVERRIDE) : null,
            scalpStopDay: p.pm2_env.env?.SCALP_STOP_DAY_OVERRIDE === "1",
            scalpNext: p.pm2_env.env?.SCALP_NEXT_OVERRIDE ? p.pm2_env.env.SCALP_NEXT_OVERRIDE : null,
            dsbExitMode: p.pm2_env.env?.DSB_EXIT_MODE_OVERRIDE === "SL" ? "SL" : "FLIP",
            scalpTarget: p.pm2_env.env?.SCALP_TARGET_OVERRIDE ? p.pm2_env.env.SCALP_TARGET_OVERRIDE : null,
            // undefined (not false) when unset, so buildProcessEnv can tell
            // "never configured" apart from "explicitly turned off" and skip
            // the env var entirely rather than writing a wrong default
            greyExitEnabled: p.pm2_env.env?.GREY_EXIT_OVERRIDE !== undefined && p.pm2_env.env?.GREY_EXIT_OVERRIDE !== ""
                ? p.pm2_env.env.GREY_EXIT_OVERRIDE === "true"
                : undefined,
            // true (not undefined) when unset — ALMA band gate defaults ON,
            // ALMA_BAND_OVERRIDE only ever gets written when explicitly
            // turned off (see buildProcessEnv below).
            almaBandEnabled: p.pm2_env.env?.ALMA_BAND_OVERRIDE !== "false",
            almaFastLen: p.pm2_env.env?.ALMA_FAST_LEN_OVERRIDE ? Number(p.pm2_env.env.ALMA_FAST_LEN_OVERRIDE) : null,
            almaBandLen: p.pm2_env.env?.ALMA_BAND_LEN_OVERRIDE ? Number(p.pm2_env.env.ALMA_BAND_LEN_OVERRIDE) : null,
            almaChopFilterEnabled: p.pm2_env.env?.ALMA_CHOP_FILTER_OVERRIDE !== undefined ? p.pm2_env.env.ALMA_CHOP_FILTER_OVERRIDE === "true" : true,
            maxDailyLoss: p.pm2_env.env?.MAX_DAILY_LOSS_OVERRIDE ? Number(p.pm2_env.env.MAX_DAILY_LOSS_OVERRIDE) : null,
            disableDoubleOrders: p.pm2_env.env?.DISABLE_DOUBLE_ORDERS_OVERRIDE === "true",
            atrSlMult: p.pm2_env.env?.ATR_SL_MULT_OVERRIDE ? Number(p.pm2_env.env.ATR_SL_MULT_OVERRIDE) : null,
            hardSlRupees: p.pm2_env.env?.HARD_SL_RUPEES_OVERRIDE ? Number(p.pm2_env.env.HARD_SL_RUPEES_OVERRIDE) : null,
            flipConfirmCandles: p.pm2_env.env?.FLIP_CONFIRM_CANDLES_OVERRIDE ? Number(p.pm2_env.env.FLIP_CONFIRM_CANDLES_OVERRIDE) : null,
            candleType: normalizeCandleType(p.pm2_env.env?.CANDLE_TYPE_OVERRIDE) || null,
            rangeSize: p.pm2_env.env?.RANGE_SIZE_OVERRIDE ? Number(p.pm2_env.env.RANGE_SIZE_OVERRIDE) : null,
            dailyBiasEntryTime: p.pm2_env.env?.DAILY_BIAS_ENTRY_TIME_OVERRIDE || null,
            dailyBiasCandle: p.pm2_env.env?.DAILY_BIAS_CANDLE_OVERRIDE || null,
            entryTime: p.pm2_env.env?.ENTRY_TIME_OVERRIDE || null,
            volumeFilterEnabled: p.pm2_env.env?.VOLUME_FILTER_OVERRIDE === "true",
            volumeSmaPeriod: p.pm2_env.env?.VOLUME_SMA_PERIOD_OVERRIDE ? Number(p.pm2_env.env.VOLUME_SMA_PERIOD_OVERRIDE) : null,
            longCandleFilterEnabled: p.pm2_env.env?.LONG_CANDLE_FILTER_OVERRIDE !== undefined ? p.pm2_env.env.LONG_CANDLE_FILTER_OVERRIDE === "true" : true,
            longCandleAtrPeriod: p.pm2_env.env?.LONG_CANDLE_ATR_PERIOD_OVERRIDE ? Number(p.pm2_env.env.LONG_CANDLE_ATR_PERIOD_OVERRIDE) : null,
            longCandleAtrMult: p.pm2_env.env?.LONG_CANDLE_ATR_MULT_OVERRIDE ? Number(p.pm2_env.env.LONG_CANDLE_ATR_MULT_OVERRIDE) : null,
            longCandleCooldownCandles: p.pm2_env.env?.LONG_CANDLE_COOLDOWN_OVERRIDE !== undefined && p.pm2_env.env.LONG_CANDLE_COOLDOWN_OVERRIDE !== "" ? Number(p.pm2_env.env.LONG_CANDLE_COOLDOWN_OVERRIDE) : null,
            // Same opt-out posture as longCandleFilterEnabled above — HTF
            // gate defaults ON (context.htfGateEnabled), so undefined/unset
            // reads as true, only an explicit "false" override turns it off.
            htfGateEnabled: p.pm2_env.env?.HTF_GATE_ENABLED_OVERRIDE !== undefined ? p.pm2_env.env.HTF_GATE_ENABLED_OVERRIDE !== "false" : true,
            htfTimeframe: p.pm2_env.env?.HTF_TIMEFRAME_OVERRIDE || null,
            htfChopPeriod: p.pm2_env.env?.HTF_CHOP_PERIOD_OVERRIDE ? Number(p.pm2_env.env.HTF_CHOP_PERIOD_OVERRIDE) : null,
            htfChopMax: p.pm2_env.env?.HTF_CHOP_MAX_OVERRIDE ? Number(p.pm2_env.env.HTF_CHOP_MAX_OVERRIDE) : null,
            // Same opt-out posture/read convention as htfGateEnabled above.
            htfBandBlockEnabled: p.pm2_env.env?.HTF_BAND_BLOCK_ENABLED_OVERRIDE !== undefined ? p.pm2_env.env.HTF_BAND_BLOCK_ENABLED_OVERRIDE !== "false" : true,
            dailyHaGateEnabled: p.pm2_env.env?.DAILY_HA_GATE_ENABLED_OVERRIDE !== undefined ? p.pm2_env.env.DAILY_HA_GATE_ENABLED_OVERRIDE !== "false" : true,
            outLogPath: p.pm2_env.pm_out_log_path,
            errLogPath: p.pm2_env.pm_err_log_path,
        }));
}

// Same env-shape toolbox.js's toggleMode/restartSelected build before every
// pm2Restart — kept in exact parity so a mode switch from the web produces
// the identical process env an equivalent CLI action would.
// See toolbox.js's buildProcessEnv for why every field here is always
// written explicitly (a real value, or "" to clear) instead of
// conditionally omitted: pm2.restart(...,updateEnv:true) merges into the
// process's existing env rather than replacing it, so omitting a key never
// actually clears a stale value from an earlier restart.
function buildProcessEnv(p, overrides = {}) {
    const env = {
        UNDERLYING: p.underlying,
        LIVE_ORDERS_OVERRIDE: String(!!p.live),
        CARRY_OVERNIGHT_OVERRIDE: String(!!p.carryOvernight),
        STRATEGY_OVERRIDE: p.strategy || "DPI_TREND_MEANREV",
        TIMEFRAME_OVERRIDE: p.timeframe || "15m",
        EXCHANGE_OVERRIDE: p.exchange || "MCX",
    };
    env.LOTS_OVERRIDE = p.lots !== "default" ? String(p.lots) : "";
    env.LOTMULT_OVERRIDE = p.lotMult ? String(p.lotMult) : "";
    env.TARGET_POINTS_OVERRIDE = (p.targetPoints !== null && p.targetPoints !== undefined) ? String(p.targetPoints) : "";
    env.TARGET_MODE_OVERRIDE = p.targetMode === "adaptive" ? "adaptive" : "";
    env.BAND_STEP_OVERRIDE = (p.bandStep !== null && p.bandStep !== undefined) ? String(p.bandStep) : "";
    if (p.strategy !== "ALMA_PRO_FAST" && p.strategy !== "ALMA_PRO_SLOW") {
        // Written explicitly (true AND false): unset means OFF at runtime.
        env.CHOP_FILTER_OVERRIDE = p.chopFilterEnabled === true ? "true" : "false";
        env.CHOP_PERIOD_OVERRIDE = p.chopPeriod ? String(p.chopPeriod) : "";
        env.CHOP_MAX_OVERRIDE = p.chopMax ? String(p.chopMax) : "";
    }
    env.SESSION_TARGET_OVERRIDE = p.sessionTargetRupees ? String(p.sessionTargetRupees) : "";
    env.SCALP_STOP_DAY_OVERRIDE = (p.scalpStopDay && p.scalpTarget) ? "1" : "";
    env.SCALP_NEXT_OVERRIDE = (p.scalpTarget && !p.scalpStopDay && SCALP_NEXT_RE.test(p.scalpNext || "")) ? p.scalpNext : "";
    env.DSB_EXIT_MODE_OVERRIDE = (p.dsbExitMode === "SL" && ["DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(p.strategy)) ? "SL" : "";
    env.SCALP_TARGET_OVERRIDE = (p.scalpTarget !== null && p.scalpTarget !== undefined && p.scalpTarget !== "") ? String(p.scalpTarget) : "";
    env.MAX_LOSING_TRADES_OVERRIDE = (p.maxLosingTrades !== null && p.maxLosingTrades !== undefined && p.maxLosingTrades !== "") ? String(p.maxLosingTrades) : "";
    env.MAX_LOSING_SWITCHES_OVERRIDE = (p.maxLosingSwitches !== null && p.maxLosingSwitches !== undefined && p.maxLosingSwitches !== "") ? String(p.maxLosingSwitches) : "";
    env.GREY_EXIT_OVERRIDE = p.greyExitEnabled !== undefined ? String(!!p.greyExitEnabled) : "";
    env.ALMA_BAND_OVERRIDE = p.strategy === "ALMA_PRO_FAST" && p.almaBandEnabled === false ? "false" : "";
    env.ALMA_FAST_LEN_OVERRIDE = p.strategy === "ALMA_PRO_FAST" && p.almaFastLen ? String(p.almaFastLen) : "";
    env.ALMA_BAND_LEN_OVERRIDE = p.strategy === "ALMA_PRO_FAST" && p.almaBandLen ? String(p.almaBandLen) : "";
    env.ALMA_CHOP_FILTER_OVERRIDE = (p.strategy === "ALMA_PRO_FAST" || p.strategy === "ALMA_PRO_SLOW") && p.almaChopFilterEnabled === false ? "false" : "";
    env.MAX_DAILY_LOSS_OVERRIDE = p.maxDailyLoss ? String(p.maxDailyLoss) : "";
    // Always written explicitly (both true AND false) — same
    // write-asymmetry reasoning as ALMA_CHOP_FILTER_OVERRIDE above: an
    // unset env var means OFF at runtime, which would silently contradict
    // an explicit "disable" choice made in the edit form if only the
    // true case were written.
    env.DISABLE_DOUBLE_ORDERS_OVERRIDE = String(!!p.disableDoubleOrders);
    env.ATR_SL_MULT_OVERRIDE = p.atrSlMult ? String(p.atrSlMult) : "";
    env.HARD_SL_RUPEES_OVERRIDE = p.hardSlRupees ? String(p.hardSlRupees) : "";   // replaces the ATR stop when set
    env.FLIP_CONFIRM_CANDLES_OVERRIDE = p.flipConfirmCandles ? String(p.flipConfirmCandles) : "";
    // DAILY_HA_BIAS only (entry time, IST "HH:MM"); blank = default 10:00. Always written explicitly.
    env.CANDLE_TYPE_OVERRIDE = p.candleType || "";
    env.RANGE_SIZE_OVERRIDE = p.rangeSize ? String(p.rangeSize) : "";
    env.PROCESS_NAME = p.name;
    env.DAILY_BIAS_ENTRY_TIME_OVERRIDE = p.dailyBiasEntryTime || "";
    env.DAILY_BIAS_CANDLE_OVERRIDE = p.dailyBiasCandle || "";
    env.ENTRY_TIME_OVERRIDE = p.entryTime || "";
    env.VOLUME_FILTER_OVERRIDE = String(!!p.volumeFilterEnabled);
    env.VOLUME_SMA_PERIOD_OVERRIDE = p.volumeSmaPeriod ? String(p.volumeSmaPeriod) : "";
    env.LONG_CANDLE_FILTER_OVERRIDE = p.longCandleFilterEnabled === false ? "false" : "true";
    env.LONG_CANDLE_ATR_PERIOD_OVERRIDE = p.longCandleAtrPeriod ? String(p.longCandleAtrPeriod) : "";
    env.LONG_CANDLE_ATR_MULT_OVERRIDE = p.longCandleAtrMult ? String(p.longCandleAtrMult) : "";
    env.LONG_CANDLE_COOLDOWN_OVERRIDE = (p.longCandleCooldownCandles !== null && p.longCandleCooldownCandles !== undefined) ? String(p.longCandleCooldownCandles) : "";
    // Always written explicitly (both true AND false) — same
    // write-asymmetry reasoning as LONG_CANDLE_FILTER_OVERRIDE above.
    env.HTF_GATE_ENABLED_OVERRIDE = "false";
    env.HTF_TIMEFRAME_OVERRIDE = p.htfTimeframe ? String(p.htfTimeframe) : "";
    env.HTF_CHOP_PERIOD_OVERRIDE = p.htfChopPeriod ? String(p.htfChopPeriod) : "";
    env.HTF_CHOP_MAX_OVERRIDE = p.htfChopMax ? String(p.htfChopMax) : "";
    // Same write-asymmetry reasoning as HTF_GATE_ENABLED_OVERRIDE above.
    env.HTF_BAND_BLOCK_ENABLED_OVERRIDE = "false";
    env.DAILY_HA_GATE_ENABLED_OVERRIDE = p.dailyHaGateEnabled === false ? "false" : "true";
    return { ...env, ...overrides };
}

const N_LOG_LINES = 30;
// PM2's .log files are plain text (plainLog.js strips the colour codes); the coloured copy lives in a "-color.log"
// sidecar. Viewers read the sidecar when it is the more recently written one, so they keep their colours.
function colorLogFor(filePath) {
    try {
        if (!filePath) return filePath;
        const side = String(filePath).replace(/\.log$/, "") + "-color.log";
        if (fs.existsSync(side) && (!fs.existsSync(filePath) || fs.statSync(side).mtimeMs >= fs.statSync(filePath).mtimeMs - 2000)) return side;
    } catch { /* fall back to the plain file */ }
    return filePath;
}
function tailFile(filePath, n) {
    filePath = colorLogFor(filePath);
    if (!filePath || !fs.existsSync(filePath)) return [];
    try {
        const text = fs.readFileSync(filePath, "utf8");
        return text.split(/\r?\n/).filter(l => l.length > 0).slice(-n);
    } catch {
        return [];
    }
}

// ─── SQLITE — read-only per-engine state, same filename convention as db.js
function dbPathFor(underlying, strategy, candleType) {
    const base = `${underlying.toLowerCase().replace(/\s+/g, "")}_${strategy.toLowerCase().replace(/\s+/g, "")}`;
    const ct = normalizeCandleType(candleType) || nativeCandleType(strategy);
    const next = path.join(DB_DIR, `${base}_${candleSuffix(ct)}.db`);
    if (fs.existsSync(next)) return next;
    // engines not yet restarted on newer code still write older locations/names — read those until they do
    for (const f of [path.join(ROOT, `${base}_${candleSuffix(ct)}.db`), path.join(ROOT, `${base}.db`), path.join(DB_DIR, `${base}.db`)]) {
        if (fs.existsSync(f)) return f;
    }
    return next;
}

function readEngineState(underlying, strategy, candleType) {
    return new Promise(resolve => {
        const dbPath = dbPathFor(underlying, strategy, candleType);
        if (!fs.existsSync(dbPath)) return resolve({ position: null, trades: [], realizedToday: 0 });

        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, err => {
            if (err) return resolve({ position: null, trades: [], realizedToday: 0 });

            const today = new Date().toISOString().split("T")[0];
            db.get(
                "SELECT * FROM positions WHERE engine = ? ORDER BY updated_at DESC LIMIT 1",
                [underlying],
                (e1, posRow) => {
                    db.all(
                        "SELECT * FROM trades WHERE engine = ? AND trade_date = ? ORDER BY id DESC LIMIT 50",
                        [underlying, today],
                        (e2, trades) => {
                            const realizedToday = (trades || [])
                                .filter(t => t.status === "CLOSED")
                                .reduce((sum, t) => sum + (t.pnl || 0), 0);
                            db.close();
                            resolve({
                                position: (posRow && posRow.position) ? posRow : null,
                                trades: trades || [],
                                realizedToday,
                            });
                        }
                    );
                }
            );
        });
    });
}

// ─── EXPRESS APP ────────────────────────────────────────────────────────────
const app = express();
// Security headers: CSP blocks any injected inline script / event handler
// (the dashboard uses none), so an unescaped string can't become XSS.
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; " +
        "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
});
app.use(express.json());
// Same range-bar builder the engines use, served to the browser chart so history/live can't diverge.
app.get("/rangeBars.js", (req, res) => {
    res.type("application/javascript").send(`(function(){var module={exports:{}};${fs.readFileSync(path.join(ROOT, "rangeBars.js"), "utf8")}\nwindow.makeRangeBars=module.exports.makeRangeBars;})();`);
});
app.use(express.static(path.join(__dirname, "public")));

// CSRF defence in depth on top of SameSite=Lax: any state-changing /api call
// from a browser must come from this dashboard's own origin.
app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && !originOk(req)) return res.status(403).json({ error: "Cross-origin request blocked" });
    next();
});

// ── auth routes — must be registered BEFORE the blanket authRequired below
app.get("/api/auth/status", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const att = attemptsFor(req);
    const lockedUntil = att.lockedUntil;
    const locked = Date.now() < lockedUntil;
    res.json({
        enabled: !!WEBDASH_PIN,
        authenticated: !WEBDASH_PIN || isValidSession(cookies[SESSION_COOKIE]),
        pinLength: WEBDASH_PIN ? WEBDASH_PIN.length : 4,
        locked,
        lockedForMs: locked ? lockedUntil - Date.now() : 0,
    });
});

app.post("/api/auth/verify", (req, res) => {
    if (!WEBDASH_PIN) return res.json({ ok: true }); // auth disabled, nothing to verify

    const att = attemptsFor(req);
    const lockedUntil = att.lockedUntil;
    if (Date.now() < lockedUntil) {
        return res.status(429).json({ error: "Too many attempts", lockedForMs: lockedUntil - Date.now() });
    }

    const { pin } = req.body || {};
    // Constant-time-ish compare — this is a single-operator convenience
    // lock, not a cryptographic boundary, but no reason to make it a
    // trivial string-equality timing leak either.
    const match = typeof pin === "string" && pin.length === WEBDASH_PIN.length &&
        crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(WEBDASH_PIN));

    if (!match) {
        att.fails++;
        if (att.fails >= 5) {
            // exponential back-off per address: 30s, 60s, 2m ... capped at 1h
            const ms = Math.min(30000 * Math.pow(2, att.strikes), 3600000);
            att.strikes++;
            att.lockedUntil = Date.now() + ms;
            att.fails = 0;
            return res.status(429).json({ error: "Too many attempts", lockedForMs: ms });
        }
        return res.status(401).json({ error: "Incorrect pin", attemptsLeft: 5 - att.fails });
    }

    att.fails = 0; att.strikes = 0;
    const token = createSession();
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax${secureAttr(req)}`);
    res.json({ ok: true });
});

// Invalidates the current session server-side (real logout, not just a
// client-side UI change) — used by the frontend's inactivity auto-lock so
// a re-lock actually revokes API/WS access, not just re-shows the PIN
// screen while the old session quietly still works underneath it.
app.post("/api/auth/lock", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secureAttr(req)}`);
    res.json({ ok: true });
});

// everything else under /api requires a valid session (no-op if no PIN set)
app.use("/api", authRequired);

app.get("/api/instruments", async (req, res) => {
    try { res.json(await getEngineProcesses()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/state/:underlying/:strategy", async (req, res) => {
    try { res.json(await readEngineState(req.params.underlying, req.params.strategy, req.query.candle)); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/control", async (req, res) => {
    const { name, action } = req.body || {};
    if (!name || !["start", "stop", "restart"].includes(action)) {
        return res.status(400).json({ error: "Name and a valid action (start|stop|restart) are required" });
    }
    try {
        // "start" on an already-PM2-registered-but-stopped process is just
        // a restart of that registration — same as toolbox.js relies on;
        // this endpoint never registers a brand-new instrument (that's the
        // Add Instrument flow, still toolbox.js-only for now).
        if (action === "stop") await pm2Stop(name);
        else await pm2Restart(name);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── TOOLBOX — web port of toolbox.js's operator actions ───────────────────
// Add Instrument, Backtest, and Setup Credentials are now ported below,
// with the exact same guardrails the CLI enforces (lot-multiplier
// required-if-missing check, LIVE confirmation, duplicate-process-name
// check). Roll Contract and Trending Instruments/Market Status remain
// CLI-only — those touch contract-roll state and the scanner pipeline,
// still flagged as their own dedicated pass.

app.post("/api/toolbox/delete", async (req, res) => {
    const { names } = req.body || {};
    if (!Array.isArray(names) || names.length === 0) {
        return res.status(400).json({ error: "Names (array) is required" });
    }
    const results = {};
    for (const name of names) {
        try { await pm2Delete(name); results[name] = "ok"; }
        catch (err) { results[name] = err.message; }
    }
    res.json({ results });
});

app.get("/api/toolbox/logs/:name", async (req, res) => {
    try {
        const procs = await getEngineProcesses();
        const p = procs.find(x => x.name === req.params.name);
        if (!p) return res.status(404).json({ error: "Process not found" });
        const out = tailFile(p.outLogPath, N_LOG_LINES);
        const err = tailFile(p.errLogPath, N_LOG_LINES);
        res.json({ outLogPath: p.outLogPath || null, errLogPath: p.errLogPath || null, out, err });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Same rule toolbox.js enforces: going live requires typing the literal
// word "LIVE" — checked here server-side, not just in the browser, so a
// crafted request can't skip the confirmation the CLI never lets you skip.
app.post("/api/toolbox/mode", async (req, res) => {
    const { name, live, carryOvernight, confirmLive } = req.body || {};
    if (!name || typeof live !== "boolean") {
        return res.status(400).json({ error: "Name and live (boolean) are required" });
    }
    if (live && confirmLive !== "LIVE") {
        return res.status(400).json({ error: 'Switching to LIVE requires confirmLive: "LIVE" (typed, not assumed)' });
    }
    try {
        const procs = await getEngineProcesses();
        const p = procs.find(x => x.name === name);
        if (!p) return res.status(404).json({ error: "Process not found" });

        await pm2RestartWithConfig({
            script: "engine.js",
            name: p.name,
            cwd: ROOT,
            updateEnv: true,
            stop_exit_codes: [0],
            env: buildProcessEnv(p, {
                LIVE_ORDERS_OVERRIDE: String(!!live),
                CARRY_OVERNIGHT_OVERRIDE: String(!!carryOvernight),
            }),
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── EDIT INSTRUMENT PARAMS — web equivalent of toolbox.js's
// editInstrument(). Same restart-in-place mechanism as /api/toolbox/mode
// above: fetch the process's own current values as defaults via
// getEngineProcesses(), merge only the fields the client actually sent,
// rebuild the FULL env through buildProcessEnv (never a partial patch —
// see buildProcessEnv's own comment), pm2Restart. Only lots and the
// strategy-specific fields toolbox.js's editInstrument also exposes are
// accepted here — same scope, just reachable from the browser too.
// Switching live/paper stays on /api/toolbox/mode above (separate
// confirmLive requirement for going live — deliberately not folded in
// here, so this route never needs that extra safety prompt).
app.post("/api/toolbox/edit", async (req, res) => {
    const { name, lots, timeframe, lotMult, targetPoints, targetMode, bandStep, maxLosingSwitches, maxLosingTrades, scalpTarget, scalpStopDay, scalpNext, dsbExitMode, greyExitEnabled, almaBandEnabled, almaFastLen, almaBandLen, almaChopFilterEnabled, maxDailyLoss, disableDoubleOrders, atrSlMult, hardSlRupees, flipConfirmCandles, dailyBiasEntryTime, dailyBiasCandle, entryTime, volumeFilterEnabled, volumeSmaPeriod, longCandleFilterEnabled, longCandleAtrPeriod, longCandleAtrMult, longCandleCooldownCandles, htfGateEnabled, htfTimeframe, htfChopPeriod, htfChopMax, htfBandBlockEnabled, dailyHaGateEnabled, rangeSize, chopFilterEnabled, chopPeriod, chopMax, sessionTargetRupees, carryOvernight } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });

    try {
        const procs = await getEngineProcesses();
        const p = procs.find(x => x.name === name);
        if (!p) return res.status(404).json({ error: "Process not found" });

        const updated = { ...p };

        if (lots !== undefined && lots !== null && lots !== "") {
            const parsedLots = Number(lots);
            if (!Number.isFinite(parsedLots) || parsedLots <= 0) return res.status(400).json({ error: "Invalid lots value" });
            updated.lots = parsedLots;
        }
        if (timeframe !== undefined && timeframe !== null && timeframe !== "") {
            if (!TIMEFRAME_TO_INTERVAL[timeframe]) return res.status(400).json({ error: `Unsupported timeframe ${timeframe} (use ${Object.keys(TIMEFRAME_TO_INTERVAL).join(", ")})` });
            updated.timeframe = timeframe;
        }
        if (lotMult !== undefined && lotMult !== null && lotMult !== "") {
            const parsedMult = Number(lotMult);
            if (!Number.isFinite(parsedMult) || parsedMult <= 0) return res.status(400).json({ error: "Invalid lotMult value" });
            updated.lotMult = parsedMult;
        }

        // "0"/"clear" (string) resets to unset, same convention
        // toolbox.js's editInstrument prompts use for these fields.
        if (targetPoints !== undefined) {
            if (targetPoints === null || targetPoints === "" || targetPoints === "0" || targetPoints === "clear") {
                updated.targetPoints = null;
            } else {
                const parsedTarget = Number(targetPoints);
                if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) return res.status(400).json({ error: "Invalid targetPoints value" });
                updated.targetPoints = parsedTarget;
            }
        }
        if (targetMode !== undefined) updated.targetMode = targetMode === "adaptive" ? "adaptive" : "fixed";
        if (updated.targetPoints !== null) updated.targetMode = "fixed"; // fixed points always wins, same rule as toolbox.js

        if (bandStep !== undefined) {
            if (bandStep === null || bandStep === "" || bandStep === "0" || bandStep === "clear") {
                updated.bandStep = null;
            } else {
                const parsedStep = Number(bandStep);
                if (!Number.isFinite(parsedStep) || parsedStep <= 0) return res.status(400).json({ error: "Invalid bandStep value" });
                updated.bandStep = parsedStep;
            }
        }
        if (scalpStopDay !== undefined) updated.scalpStopDay = !!scalpStopDay;
        if (scalpNext !== undefined) {
            if (scalpNext === null || scalpNext === "") updated.scalpNext = null;
            else if (SCALP_NEXT_RE.test(String(scalpNext)) && (String(scalpNext).startsWith("TARGET") || Number(String(scalpNext).split(":")[1]) > 0)) updated.scalpNext = String(scalpNext);
            else return res.status(400).json({ error: "Invalid scalpNext (use TARGET:<rupees> or SL:<rupees>, or blank for off)" });
        }
        if (dsbExitMode !== undefined) {
            if (dsbExitMode !== "SL" && dsbExitMode !== "FLIP") return res.status(400).json({ error: "DsbExitMode must be FLIP or SL" });
            updated.dsbExitMode = dsbExitMode;
        }
        if (scalpTarget !== undefined) {
            if (scalpTarget === null || scalpTarget === "" || scalpTarget === "0" || scalpTarget === "clear") updated.scalpTarget = null;
            else {
                const n = Number(scalpTarget);
                if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "Invalid scalpTarget value (rupees > 0, or blank for off)" });
                updated.scalpTarget = n;
            }
        }
        if (maxLosingTrades !== undefined) {
            if (maxLosingTrades === null || maxLosingTrades === "" || maxLosingTrades === "0" || maxLosingTrades === "clear") updated.maxLosingTrades = null;
            else {
                const n = Number(maxLosingTrades);
                if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "Invalid maxLosingTrades value (whole number >= 1, or blank for off)" });
                updated.maxLosingTrades = n;
            }
        }
        if (maxLosingSwitches !== undefined) {
            if (maxLosingSwitches === null || maxLosingSwitches === "" || maxLosingSwitches === "0" || maxLosingSwitches === "clear") updated.maxLosingSwitches = null;
            else {
                const n = Number(maxLosingSwitches);
                if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "Invalid maxLosingSwitches value (whole number >= 1, or blank for off)" });
                updated.maxLosingSwitches = n;
            }
        }
        if (greyExitEnabled !== undefined) updated.greyExitEnabled = !!greyExitEnabled;
        if (almaBandEnabled !== undefined) updated.almaBandEnabled = !!almaBandEnabled;
        if (almaChopFilterEnabled !== undefined) updated.almaChopFilterEnabled = !!almaChopFilterEnabled;
        if (disableDoubleOrders !== undefined) updated.disableDoubleOrders = !!disableDoubleOrders;
        if (atrSlMult !== undefined) {
            if (atrSlMult === null || atrSlMult === "" || atrSlMult === "0" || atrSlMult === "clear") {
                updated.atrSlMult = null;
            } else {
                const parsedAtrMult = Number(atrSlMult);
                if (!Number.isFinite(parsedAtrMult) || parsedAtrMult <= 0) return res.status(400).json({ error: "Invalid atrSlMult value" });
                updated.atrSlMult = parsedAtrMult;
            }
        }
        if (hardSlRupees !== undefined) {
            if (hardSlRupees === null || hardSlRupees === "" || hardSlRupees === "0" || hardSlRupees === "clear") {
                updated.hardSlRupees = null;
            } else {
                const hv = Number(hardSlRupees);
                if (!Number.isFinite(hv) || hv <= 0) return res.status(400).json({ error: "Invalid hardSlRupees value" });
                updated.hardSlRupees = hv;
            }
        }
        if (flipConfirmCandles !== undefined) {
            if (flipConfirmCandles === null || flipConfirmCandles === "" || flipConfirmCandles === "0" || flipConfirmCandles === "clear") {
                updated.flipConfirmCandles = null;
            } else {
                const parsedConfirm = Number(flipConfirmCandles);
                if (!Number.isInteger(parsedConfirm) || parsedConfirm < 1) return res.status(400).json({ error: "Invalid flipConfirmCandles value" });
                updated.flipConfirmCandles = parsedConfirm;
            }
        }
        if (dailyBiasEntryTime !== undefined) {
            if (dailyBiasEntryTime === null || dailyBiasEntryTime === "" || dailyBiasEntryTime === "clear") {
                updated.dailyBiasEntryTime = null;
            } else {
                const t = normEntryTime(dailyBiasEntryTime);
                if (!t) return res.status(400).json({ error: "DailyBiasEntryTime must be HH:MM (IST)" });
                updated.dailyBiasEntryTime = t;
            }
        }
        if (entryTime !== undefined) {
            if (entryTime === null || entryTime === "" || entryTime === "clear") updated.entryTime = null;
            else {
                const t = normEntryTime(entryTime);
                if (!t) return res.status(400).json({ error: "EntryTime must be HH:MM (IST)" });
                updated.entryTime = t;
            }
        }
        if (dailyBiasCandle !== undefined) {
            if (dailyBiasCandle === null || dailyBiasCandle === "") updated.dailyBiasCandle = null;
            else {
                const v = String(dailyBiasCandle).toUpperCase();
                if (v !== "PREVIOUS" && v !== "CURRENT") return res.status(400).json({ error: "DailyBiasCandle must be PREVIOUS or CURRENT" });
                updated.dailyBiasCandle = v;
            }
        }
        if (volumeFilterEnabled !== undefined) updated.volumeFilterEnabled = !!volumeFilterEnabled;
        if (volumeSmaPeriod !== undefined) {
            if (volumeSmaPeriod === null || volumeSmaPeriod === "" || volumeSmaPeriod === "0" || volumeSmaPeriod === "clear") {
                updated.volumeSmaPeriod = null;
            } else {
                const parsedVolPeriod = Number(volumeSmaPeriod);
                if (!Number.isFinite(parsedVolPeriod) || parsedVolPeriod <= 0) return res.status(400).json({ error: "Invalid volumeSmaPeriod value" });
                updated.volumeSmaPeriod = parsedVolPeriod;
            }
        }
        if (longCandleFilterEnabled !== undefined) updated.longCandleFilterEnabled = !!longCandleFilterEnabled;
        if (longCandleAtrPeriod !== undefined) {
            if (longCandleAtrPeriod === null || longCandleAtrPeriod === "" || longCandleAtrPeriod === "0" || longCandleAtrPeriod === "clear") {
                updated.longCandleAtrPeriod = null;
            } else {
                const parsedLcPeriod = Number(longCandleAtrPeriod);
                if (!Number.isFinite(parsedLcPeriod) || parsedLcPeriod <= 0) return res.status(400).json({ error: "Invalid longCandleAtrPeriod value" });
                updated.longCandleAtrPeriod = parsedLcPeriod;
            }
        }
        if (longCandleAtrMult !== undefined) {
            if (longCandleAtrMult === null || longCandleAtrMult === "" || longCandleAtrMult === "0" || longCandleAtrMult === "clear") {
                updated.longCandleAtrMult = null;
            } else {
                const parsedLcMult = Number(longCandleAtrMult);
                if (!Number.isFinite(parsedLcMult) || parsedLcMult <= 0) return res.status(400).json({ error: "Invalid longCandleAtrMult value" });
                updated.longCandleAtrMult = parsedLcMult;
            }
        }
        if (longCandleCooldownCandles !== undefined) {
            if (longCandleCooldownCandles === null || longCandleCooldownCandles === "" || longCandleCooldownCandles === "clear") {
                updated.longCandleCooldownCandles = null;
            } else {
                const parsedLcCooldown = Number(longCandleCooldownCandles);
                if (!Number.isInteger(parsedLcCooldown) || parsedLcCooldown < 0) return res.status(400).json({ error: "Invalid longCandleCooldownCandles value" });
                updated.longCandleCooldownCandles = parsedLcCooldown;
            }
        }

        if (maxDailyLoss !== undefined) {
            if (maxDailyLoss === null || maxDailyLoss === "" || maxDailyLoss === "0" || maxDailyLoss === "clear") {
                updated.maxDailyLoss = null;
            } else {
                const parsedLoss = Number(maxDailyLoss);
                if (!Number.isFinite(parsedLoss) || parsedLoss <= 0) return res.status(400).json({ error: "Invalid maxDailyLoss value" });
                updated.maxDailyLoss = parsedLoss;
            }
        }

        if (chopFilterEnabled !== undefined) updated.chopFilterEnabled = !!chopFilterEnabled;
        if (carryOvernight !== undefined) updated.carryOvernight = !!carryOvernight;
        for (const [key, val, int] of [["chopPeriod", chopPeriod, true], ["chopMax", chopMax, false], ["sessionTargetRupees", sessionTargetRupees, false]]) {
            if (val === undefined) continue;
            if (val === null || val === "" || val === "0" || val === "clear") { updated[key] = null; continue; }
            const n = Number(val);
            if (!Number.isFinite(n) || n <= 0 || (int && !Number.isInteger(n))) return res.status(400).json({ error: `Invalid ${key} value` });
            updated[key] = n;
        }
        if (htfGateEnabled !== undefined) updated.htfGateEnabled = !!htfGateEnabled;
        if (htfTimeframe !== undefined) {
            if (htfTimeframe === null || htfTimeframe === "" || htfTimeframe === "clear") {
                updated.htfTimeframe = null;
            } else if (htfTimeframe !== "1h" && htfTimeframe !== "1d") {
                return res.status(400).json({ error: 'Invalid htfTimeframe value — must be "1h" or "1d"' });
            } else {
                updated.htfTimeframe = htfTimeframe;
            }
        }
        if (htfChopPeriod !== undefined) {
            if (htfChopPeriod === null || htfChopPeriod === "" || htfChopPeriod === "0" || htfChopPeriod === "clear") {
                updated.htfChopPeriod = null;
            } else {
                const parsedHtfPeriod = Number(htfChopPeriod);
                if (!Number.isFinite(parsedHtfPeriod) || parsedHtfPeriod <= 0) return res.status(400).json({ error: "Invalid htfChopPeriod value" });
                updated.htfChopPeriod = parsedHtfPeriod;
            }
        }
        if (htfChopMax !== undefined) {
            if (htfChopMax === null || htfChopMax === "" || htfChopMax === "0" || htfChopMax === "clear") {
                updated.htfChopMax = null;
            } else {
                const parsedHtfMax = Number(htfChopMax);
                if (!Number.isFinite(parsedHtfMax) || parsedHtfMax <= 0) return res.status(400).json({ error: "Invalid htfChopMax value" });
                updated.htfChopMax = parsedHtfMax;
            }
        }
        if (htfBandBlockEnabled !== undefined) updated.htfBandBlockEnabled = !!htfBandBlockEnabled;
        if (dailyHaGateEnabled !== undefined) updated.dailyHaGateEnabled = !!dailyHaGateEnabled;
        if (rangeSize !== undefined && updated.candleType === "RANGE") {
            const rs = Number(rangeSize);
            updated.rangeSize = rangeSize === null || rangeSize === "" ? null : (Number.isFinite(rs) && rs > 0 ? rs : updated.rangeSize);
        }

        if (almaFastLen !== undefined) {
            if (almaFastLen === null || almaFastLen === "" || almaFastLen === "0" || almaFastLen === "clear") {
                updated.almaFastLen = null;
            } else {
                const parsedFastLen = Number(almaFastLen);
                if (!Number.isFinite(parsedFastLen) || parsedFastLen <= 0) return res.status(400).json({ error: "Invalid almaFastLen value" });
                updated.almaFastLen = parsedFastLen;
            }
        }
        if (almaBandLen !== undefined) {
            if (almaBandLen === null || almaBandLen === "" || almaBandLen === "0" || almaBandLen === "clear") {
                updated.almaBandLen = null;
            } else {
                const parsedBandLen = Number(almaBandLen);
                if (!Number.isFinite(parsedBandLen) || parsedBandLen <= 0) return res.status(400).json({ error: "Invalid almaBandLen value" });
                updated.almaBandLen = parsedBandLen;
            }
        }

        await pm2RestartWithConfig({
            script: "engine.js",
            name: p.name,
            cwd: ROOT,
            updateEnv: true,
            stop_exit_codes: [0],
            env: buildProcessEnv(updated),
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── ADD INSTRUMENT — same discovery + resolve + start path as
// toolbox.js's addInstrument/configureAndStartInstrument. ──────────────────
// ─── LIVE CHART DATA — history half of the per-instrument chart (the live half is the
// engine's throttled LTP event, relayed over /ws). Returns the instrument's own
// timeframe bars (several days, so Heikin-Ashi can be seeded) plus 1-minute bars of the
// displayed day (used to build range bars). The browser draws raw / HA / range from this.
// BLOCK events (an entry gate refused a signal — see blockReport.js) are kept per engine for
// the last 3 IST days and persisted to chartBlocks.json so a dashboard restart doesn't lose
// today's markers. Chart "Filters" tab reads them.
const { parseBlocksFromLog } = require("./logBlocks");
const BLOCKS_FILE = path.join(ROOT, "chartBlocks.json");
let blockStore = {};
try { blockStore = JSON.parse(fs.readFileSync(BLOCKS_FILE, "utf8")) || {}; } catch { blockStore = {}; }
let blockSaveTimer = null;
function recordBlock(msg) {
    if (!msg || !msg.engine || !Array.isArray(msg.reasons)) return;
    const key = msg.proc || msg.engine;
    const list = (blockStore[key] = blockStore[key] || []);
    list.push({ ts: msg.ts || Date.now(), side: msg.side, price: msg.price, reasons: msg.reasons });
    const cutoff = Date.now() - 3 * 86400000;
    blockStore[key] = list.filter(b => b.ts >= cutoff).slice(-3000);
    if (!blockSaveTimer) blockSaveTimer = setTimeout(() => {
        blockSaveTimer = null;
        try { fs.writeFileSync(BLOCKS_FILE, JSON.stringify(blockStore)); } catch { /* best effort */ }
    }, 5000);
}
const IST_MS = 5.5 * 60 * 60 * 1000;
const istDayStr = ms => new Date(ms + IST_MS).toISOString().split("T")[0];
// Chart window: the previous month of candles (daily charts: ~5 months), plus 8 extra days fetched only as indicator warm-up.
function chartWindow(tf, now) {
    const span = tf === "1d" ? 150 : 30;
    const fromTs = Date.parse(istDayStr(now - span * 86400000) + "T00:00:00+05:30");
    return { fromTs, fetchFrom: new Date(tf === "1d" ? fromTs : fromTs - 8 * 86400000) };
}
// Overlay lines restricted to the displayed window (the extra warm-up bars before it are not drawn).
function chartOverlayFor(p, tfBars, fromTs) {
    try {
        const bars = tfBars.map(b => ({ t: b.date.getTime(), open: b.open, high: b.high, low: b.low, close: b.close }));
        const ov = computeOverlay(p.strategy, bars, { bandStep: p.bandStep ? Number(p.bandStep) : null, almaFastLen: p.almaFastLen || null, candleType: p.candleType || null }, engineConfig);
        if (ov.lines) ov.lines.forEach(l => { l.points = l.points.filter(pt => pt[0] >= fromTs); });
        return ov;
    } catch (err) {
        return { note: "indicator unavailable: " + err.message };
    }
}
// Colour the mid line by what the engine actually did: always-in-market strategies hold LONG (green) or SHORT (red), and
// the trade journal records every side change. The band stepper alone depends on which bar its history starts from, so
// its colours can disagree with the real position; where the journal covers a bar, its side wins (like a flip marker).
function journalSides(p) {
    return new Promise(resolve => {
        try {
            const dbPath = dbPathFor(p.underlying, p.strategy, p.candleType);
            if (!fs.existsSync(dbPath)) return resolve([]);
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, err => {
                if (err) return resolve([]);
                db.all("SELECT side, entry_time, exit_time FROM trades WHERE engine = ? ORDER BY id DESC LIMIT 400", [p.underlying], (e, rows) => {
                    db.close();
                    resolve((rows || []).map(r => ({ side: r.side, in: Date.parse(r.entry_time), out: r.exit_time ? Date.parse(r.exit_time) : null }))
                        .filter(r => Number.isFinite(r.in)).sort((a, b) => a.in - b.in));
                });
            });
        } catch { resolve([]); }
    });
}
async function applyJournalColors(p, ov, tfMinutes) {
    try {
        if (!ov || !ov.lines) return ov;
        const trades = await journalSides(p);
        if (!trades.length) return ov;
        const slack = 90 * 1000, barMs = tfMinutes * 60000;
        for (const l of ov.lines) {
            if (!l.points.length || l.points[0].length < 3) continue;   // only the colour-coded mid line
            l.points = l.points.map(pt => {
                const closeMs = pt[0] + barMs;
                let hit = null;
                for (const t of trades) { if (t.in <= closeMs + slack) hit = t; else break; }
                if (!hit || (hit.out !== null && hit.out < closeMs - slack)) return pt;   // not covered by the journal: keep the stepper colour
                return [pt[0], pt[1], hit.side === "SHORT" ? "#ff5266" : "#33ff88"];
            });
        }
        if (ov.label) ov.label += " · colours follow the engine's real position";
    } catch { /* keep the stepper colours */ }
    return ov;
}
// Stored BLOCK events + blocks parsed from the engine's PM2 log (covers the time before the
// engine emitted BLOCK events). Log-derived ones are dropped when a stored event already
// covers the same side within 30s.
function blocksForDay(engine, fromTs, outLogPath, procName) {
    const stored = (blockStore[procName] || blockStore[engine] || []).filter(b => b.ts >= fromTs);
    const fromLog = parseBlocksFromLog(outLogPath, istDayStr(fromTs), true)
        .filter(l => !stored.some(s => s.side === l.side && Math.abs(s.ts - l.ts) < 30000));
    return stored.concat(fromLog).sort((a, b) => a.ts - b.ts);
}

// Overlay + blocks only (refresh when a new bar opens, without re-fetching minute bars).
app.get("/api/chart/:name/overlay", async (req, res) => {
    try {
        const procs = await getEngineProcesses();
        const p = procs.find(x => x.name === req.params.name);
        if (!p) return res.status(404).json({ error: "Instrument not found" });
        const exchange = p.exchange || "MCX";
        const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
        const def = getDefinition(p.underlying, exchange);
        const { contract } = resolveCurrent(p.underlying, def, repo, pinStore);
        const tf = p.timeframe || STRATEGY_TIMEFRAME[p.strategy] || "15m";
        const now = Date.now();
        const win = chartWindow(tf, now);
        const tfBars = await fetchHistoricalCandles({ kc: ensureToolboxKite(), token: contract.token, timeframe: tf, from: win.fetchFrom, to: new Date(now) });
        res.json({ overlay: await applyJournalColors(p, chartOverlayFor(p, tfBars, win.fromTs), TIMEFRAME_MINUTES[tf]), blocks: blocksForDay(p.underlying, win.fromTs, p.outLogPath, p.name) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Market depth (the 5-level order book) for the chart's side panel. Kite's quote endpoint carries depth.buy/sell
// (price, quantity, orders), total buy/sell quantity, volume and OI. Polled by the open chart (~1.5s); cached 1s per
// instrument so several browsers / a fast poll never exceed Kite's 1 request/second quote limit.
const depthCache = new Map();
async function resolveDepthTarget(name) {
    const procs = await getEngineProcesses();
    const p = procs.find(x => x.name === name);
    if (!p) throw new Error("instrument not found");
    const exchange = p.exchange || "MCX";
    const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
    const { contract } = resolveCurrent(p.underlying, getDefinition(p.underlying, exchange), repo, pinStore);
    return { name, token: Number(contract.token), key: `${contract.exchange || exchange}:${contract.symbol}` };
}
const { createDepthHub } = require("./depthHub");
const depthHub = createDepthHub({ getCreds: () => ({ apiKey: engineConfig.API_KEY, accessToken: engineConfig.getAccessToken() }) });
// Previous-day close per instrument (what Kite's watchlist measures the day change against), one batched quote call,
// cached 30s. The dashboard combines it with the live price for the red / green colour and the points / percent change.
let dayChangeCache = { at: 0, data: {} };
app.get("/api/daychange", async (req, res) => {
    try {
        if (Date.now() - dayChangeCache.at < 30000) return res.json(dayChangeCache.data);
        const procs = await getEngineProcesses();
        const keyByName = {};
        for (const p of procs) {
            try {
                const exchange = p.exchange || "MCX";
                const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
                const { contract } = resolveCurrent(p.underlying, getDefinition(p.underlying, exchange), repo, pinStore);
                keyByName[p.name] = `${contract.exchange || exchange}:${contract.symbol}`;
            } catch { /* instrument not resolvable right now: no day change for it */ }
        }
        const keys = [...new Set(Object.values(keyByName))];
        const quotes = keys.length ? await ensureToolboxKite().getQuote(keys) : {};
        const data = {};
        for (const [name, key] of Object.entries(keyByName)) {
            const q = quotes[key];
            const prev = q && q.ohlc ? Number(q.ohlc.close) : NaN;
            if (Number.isFinite(prev) && prev > 0) data[name] = { prevClose: prev, open: q.ohlc.open != null ? Number(q.ohlc.open) : null };
        }
        dayChangeCache = { at: Date.now(), data };
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get("/api/depth/:name", async (req, res) => {
    try {
        const hit = depthCache.get(req.params.name);
        if (hit && Date.now() - hit.at < 1000) return res.json(hit.data);
        const procs = await getEngineProcesses();
        const p = procs.find(x => x.name === req.params.name);
        if (!p) return res.status(404).json({ error: "Instrument not found" });
        const exchange = p.exchange || "MCX";
        const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
        const def = getDefinition(p.underlying, exchange);
        const { contract } = resolveCurrent(p.underlying, def, repo, pinStore);
        const key = `${contract.exchange || exchange}:${contract.symbol}`;
        const q = (await ensureToolboxKite().getQuote([key]))[key];
        if (!q) return res.status(404).json({ error: `No quote returned for ${key}` });
        const lvl = l => ({ price: Number(l.price), qty: Number(l.quantity), orders: Number(l.orders) });
        const data = {
            symbol: key, ltp: q.last_price, volume: q.volume ?? null, oi: q.oi ?? null,
            totalBuy: q.buy_quantity ?? null, totalSell: q.sell_quantity ?? null,
            bids: ((q.depth && q.depth.buy) || []).map(lvl).filter(l => l.price > 0 || l.qty > 0),
            asks: ((q.depth && q.depth.sell) || []).map(lvl).filter(l => l.price > 0 || l.qty > 0),
            at: Date.now(),
        };
        depthCache.set(req.params.name, { at: Date.now(), data });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/chart/:name", async (req, res) => {
    try {
        const procs = await getEngineProcesses();
        const p = procs.find(x => x.name === req.params.name);
        if (!p) return res.status(404).json({ error: "Instrument not found" });
        const exchange = p.exchange || "MCX";
        const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
        const def = getDefinition(p.underlying, exchange);
        const { contract } = resolveCurrent(p.underlying, def, repo, pinStore);
        const tf = p.timeframe || STRATEGY_TIMEFRAME[p.strategy] || "15m";
        if (!TIMEFRAME_MINUTES[tf]) return res.status(400).json({ error: `Unsupported timeframe ${tf}` });
        const kc = ensureToolboxKite();
        const now = Date.now();
        const win = chartWindow(tf, now);
        const row = b => [new Date(b.date).getTime(), +b.open, +b.high, +b.low, +b.close];
        // 1-minute bars of the whole window feed the range-bar builder; sent only when asked (they are the heavy part).
        const loadMinutes = async () => {
            const out = [];
            for (let t = win.fromTs; t <= now; t += 25 * 86400000) {   // Kite caps 1-minute history per request
                const a = istDayStr(t), z = istDayStr(Math.min(t + 24 * 86400000, now));
                out.push(...((await kc.getHistoricalData(contract.token, "minute", `${a} 00:00:00`, `${z} 23:59:59`)) || []));
            }
            const seen = new Set();
            return out.filter(m => { const k = new Date(m.date).getTime(); if (seen.has(k)) return false; seen.add(k); return true; });
        };
        if (req.query.only === "minutes") return res.json({ minuteBars: (await loadMinutes()).map(row) });
        const tfBars = await fetchHistoricalCandles({ kc, token: contract.token, timeframe: tf, from: win.fetchFrom, to: new Date(now) });
        if (!tfBars.length) return res.status(404).json({ error: "No historical bars returned" });
        const day = istDayStr(tfBars[tfBars.length - 1].date.getTime());
        const mins = req.query.minutes === "1" ? await loadMinutes() : [];
        const a = atrFn(tfBars.map(b => ({ open: b.open, high: b.high, low: b.low, close: b.close })), engineConfig.ST_ATR_LEN);
        res.json({
            name: p.name, underlying: p.underlying, exchange, timeframe: tf, tfMinutes: TIMEFRAME_MINUTES[tf], day, fromTs: win.fromTs,
            strategy: p.strategy,
            overlay: await applyJournalColors(p, chartOverlayFor(p, tfBars, win.fromTs), TIMEFRAME_MINUTES[tf]),
            blocks: blocksForDay(p.underlying, win.fromTs, p.outLogPath, p.name),
            tfBars: tfBars.filter(b => b.date.getTime() >= win.fromTs - 8 * 86400000).map(row), minuteBars: mins.map(row),
            suggestedRange: a ? Math.max(0.05, Math.round(a * 20) / 20) : 1,
            bandStep: p.bandStep ? Number(p.bandStep) : null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/toolbox/strategies", async (req, res) => {
    // Merges hardcoded STRATEGIES with user-built strategies saved via the
    // strategy builder (custom_strategies.db) — same either/or resolution
    // signals.js's createSignals() does at deploy time. Only strategies
    // with entry conditions saved (steps 5+ done) are listed — an
    // in-progress custom strategy shouldn't show as deployable.
    const customStrategies = (await customStrategyDb.listStrategies()).filter(s => s.entryLong || s.entryShort);
    res.json({
        default: DEFAULT_STRATEGY,
        strategies: [
            ...Object.keys(STRATEGIES).map(key => ({
                key,
                label: (STRATEGY_INFO[key] || {}).label || key,
                description: (STRATEGY_INFO[key] || {}).description || "",
                timeframe: STRATEGY_TIMEFRAME[key] || "15m",
                nativeCandle: nativeCandleType(key),
                custom: false,
            })),
            ...customStrategies.map(s => ({
                key: s.name,
                label: s.name,
                description: `${s.candleType} \u00b7 ${s.timeframe} \u00b7 ${s.indicators.map(i => i.type).join("+")}`,
                timeframe: s.timeframe,
                custom: true,
            })),
        ],
        timeframes: Object.keys(TIMEFRAME_TO_INTERVAL),
    });
});

// ─── STRATEGY BUILDER — indicator catalog + CRUD for custom strategies,
// consumed by the builder wizard modal in public/strategyBuilder.js. Same
// custom_strategies.db the toolbox "U" wizard writes to — a strategy built
// in either place is deployable from both, since /api/toolbox/strategies
// above and toolbox.js's addInstrument() both read the same table. ────────
app.get("/api/strategy-builder/indicators", (req, res) => {
    res.json({ indicators: INDICATOR_CATALOG });
});

app.get("/api/strategy-builder/custom-strategies", async (req, res) => {
    try {
        res.json({ strategies: await customStrategyDb.listStrategies() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/strategy-builder/custom-strategies", async (req, res) => {
    const { name, candleType, timeframe, indicators, entryLong, entryShort, exitConfig } = req.body || {};
    if (!name || !candleType || !timeframe || !Array.isArray(indicators) || indicators.length === 0) {
        return res.status(400).json({ error: "Name, candleType, timeframe, and at least one indicator are required" });
    }
    try {
        const id = await customStrategyDb.saveStrategy({ name, candleType, timeframe, indicators, entryLong, entryShort, exitConfig });
        res.json({ id, name });
    } catch (err) {
        res.status(400).json({ error: err.message.includes("UNIQUE") ? "A strategy named that already exists" : err.message });
    }
});

app.get("/api/toolbox/instruments", async (req, res) => {
    const exchange = req.query.exchange === "NSE" ? "NSE" : "MCX";
    const q = (req.query.q || "").toLowerCase();
    try {
        const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
        const all = exchange === "NSE" ? repo.listEquitySymbols() : repo.listUnderlyings();
        const matches = q ? all.filter(u => u.toLowerCase().includes(q)) : all;
        res.json({ exchange, total: all.length, matches: matches.slice(0, 500), truncated: matches.length > 500 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Preview what an underlying would resolve to right now — same sanity
// check toolbox.js shows before asking for lots/mode, including the
// lot-multiplier-required warning (real PnL bug precedent, see toolbox.js).
app.get("/api/toolbox/instruments/:underlying/preview", async (req, res) => {
    const exchange = req.query.exchange === "NSE" ? "NSE" : "MCX";
    const underlying = req.params.underlying;
    try {
        const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
        const def = getDefinition(underlying, exchange);
        const { contract } = resolveCurrent(underlying, def, repo, pinStore);
        res.json({
            symbol: contract.symbol,
            expiry: contract.expiry ? contract.expiry.toISOString().split("T")[0] : null,
            brokerLotSize: contract.lotSize,
            lotMultRequired: def.lotMult === null,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/toolbox/instrument", async (req, res) => {
    const {
        underlying, exchange = "MCX", lots, lotMultOverride,
        live, confirmLive, carryOvernight,
        strategy, timeframe, targetPoints, targetMode, almaBandEnabled, almaFastLen, almaBandLen, almaChopFilterEnabled, bandStep, maxLosingSwitches, maxLosingTrades, scalpTarget, scalpStopDay, scalpNext, dsbExitMode, greyExitEnabled, maxDailyLoss, disableDoubleOrders, atrSlMult, hardSlRupees, flipConfirmCandles, dailyBiasEntryTime, dailyBiasCandle, entryTime, volumeFilterEnabled, volumeSmaPeriod, longCandleFilterEnabled, longCandleAtrPeriod, longCandleAtrMult, longCandleCooldownCandles, htfGateEnabled, htfTimeframe, htfChopPeriod, htfChopMax, htfBandBlockEnabled, dailyHaGateEnabled, candleType, rangeSize,
    } = req.body || {};

    if (!underlying) return res.status(400).json({ error: "Underlying is required" });
    if (!/^[A-Za-z0-9&_-]{1,30}$/.test(String(underlying))) return res.status(400).json({ error: "Underlying may only contain letters, digits, & _ -" });
    if (live && confirmLive !== "LIVE") {
        return res.status(400).json({ error: 'Switching to LIVE requires confirmLive: "LIVE" (typed, not assumed)' });
    }

    // CHANGED: strategy could now be a custom strategy name, not just a
    // STRATEGIES key — silently falling back to DEFAULT_STRATEGY on an
    // unrecognized-but-custom name would deploy the WRONG strategy without
    // any error, so this now checks customStrategyDb before deciding it's
    // actually unknown (as opposed to just "not hardcoded").
    let stratKey = DEFAULT_STRATEGY;
    let customStratTimeframe = null;
    if (strategy) {
        if (STRATEGIES[strategy]) {
            stratKey = strategy;
        } else {
            const custom = await customStrategyDb.getStrategyByName(strategy);
            if (custom && (custom.entryLong || custom.entryShort)) {
                stratKey = strategy;
                customStratTimeframe = custom.timeframe;
            } else {
                return res.status(400).json({ error: `Unknown strategy "${strategy}"` });
            }
        }
    }
    const tf = timeframe || customStratTimeframe || STRATEGY_TIMEFRAME[stratKey] || "15m";
    const lotsVal = lots !== undefined && lots !== null && lots !== "" ? Number(lots) : 1;
    if (!Number.isFinite(lotsVal) || lotsVal <= 0) return res.status(400).json({ error: "Invalid lots value" });

    try {
        const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
        const def = getDefinition(underlying, exchange);
        let resolved;
        try {
            resolved = resolveCurrent(underlying, def, repo, pinStore).contract;
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        let lotMult = null;
        if (def.lotMult === null) {
            const parsed = Number(lotMultOverride);
            if (!lotMultOverride || !Number.isFinite(parsed) || parsed <= 0) {
                return res.status(400).json({
                    error: `Lot multiplier required for ${underlying} — broker lot_size (${resolved.lotSize}) is a contract count, not the real price multiplier; provide lotMultOverride`,
                });
            }
            lotMult = parsed;
        }

        const chosenCandle = customStratTimeframe ? null : normalizeCandleType(candleType);
        const name = toProcessName(underlying, stratKey, chosenCandle);
        const existing = await getEngineProcesses();
        if (existing.some(p => p.name === name)) {
            return res.status(409).json({ error: `${underlying} is already running ${(STRATEGY_INFO[stratKey] || {}).label || stratKey} as ${name} — stop/remove it first, or pick a different strategy or candle type` });
        }

        const env = {
            UNDERLYING: underlying,
            EXCHANGE_OVERRIDE: exchange,
            LOTS_OVERRIDE: String(lotsVal),
            LIVE_ORDERS_OVERRIDE: String(!!live),
            CARRY_OVERNIGHT_OVERRIDE: String(!!carryOvernight),
            STRATEGY_OVERRIDE: stratKey,
            TIMEFRAME_OVERRIDE: tf,
            PROCESS_NAME: name,
        };
        if (chosenCandle) env.CANDLE_TYPE_OVERRIDE = chosenCandle;
        if (chosenCandle === "RANGE" && rangeSize !== undefined && rangeSize !== null && rangeSize !== "") {
            const parsedRange = Number(rangeSize);
            if (Number.isFinite(parsedRange) && parsedRange > 0) env.RANGE_SIZE_OVERRIDE = String(parsedRange);
        }
        if (lotMult !== null) env.LOTMULT_OVERRIDE = String(lotMult);
        if (targetPoints !== undefined && targetPoints !== null && targetPoints !== "") {
            const parsedTarget = Number(targetPoints);
            if (Number.isFinite(parsedTarget) && parsedTarget > 0) env.TARGET_POINTS_OVERRIDE = String(parsedTarget);
        } else if (targetMode === "adaptive") {
            env.TARGET_MODE_OVERRIDE = "adaptive";
        }
        if (stratKey === "ALMA_PRO_FAST" && almaBandEnabled === false) env.ALMA_BAND_OVERRIDE = "false";
        if (stratKey === "ALMA_PRO_FAST" && almaFastLen !== undefined && almaFastLen !== null && almaFastLen !== "") {
            const parsedFastLen = Number(almaFastLen);
            if (Number.isFinite(parsedFastLen) && parsedFastLen > 0) env.ALMA_FAST_LEN_OVERRIDE = String(parsedFastLen);
        }
        if (stratKey === "ALMA_PRO_FAST" && almaBandLen !== undefined && almaBandLen !== null && almaBandLen !== "") {
            const parsedBandLen = Number(almaBandLen);
            if (Number.isFinite(parsedBandLen) && parsedBandLen > 0) env.ALMA_BAND_LEN_OVERRIDE = String(parsedBandLen);
        }
        if ((stratKey === "ALMA_PRO_FAST" || stratKey === "ALMA_PRO_SLOW") && almaChopFilterEnabled === false) env.ALMA_CHOP_FILTER_OVERRIDE = "false";
        if (maxDailyLoss !== undefined && maxDailyLoss !== null && maxDailyLoss !== "") {
            const parsedLoss = Number(maxDailyLoss);
            if (Number.isFinite(parsedLoss) && parsedLoss > 0) env.MAX_DAILY_LOSS_OVERRIDE = String(parsedLoss);
        }
        if ((stratKey === "DYNAMIC_BAND" || stratKey === "DYNAMIC_MID_COLOR" || (stratKey === "DYNAMIC_MID_COLOR_HL" || stratKey === "ALMA_DSB")) && bandStep !== undefined && bandStep !== null && bandStep !== "") {
            const parsedStep = Number(bandStep);
            if (Number.isFinite(parsedStep) && parsedStep > 0) env.BAND_STEP_OVERRIDE = String(parsedStep);
        }
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(stratKey) && scalpStopDay && scalpTarget) env.SCALP_STOP_DAY_OVERRIDE = "1";
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(stratKey) && scalpTarget && !scalpStopDay && SCALP_NEXT_RE.test(scalpNext || "") && (scalpNext.startsWith("TARGET") || Number(scalpNext.split(":")[1]) > 0)) env.SCALP_NEXT_OVERRIDE = scalpNext;
        if (["DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(stratKey) && dsbExitMode === "SL") env.DSB_EXIT_MODE_OVERRIDE = "SL";
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(stratKey) && scalpTarget !== undefined && scalpTarget !== null && scalpTarget !== "") {
            const n = Number(scalpTarget);
            if (Number.isFinite(n) && n > 0) env.SCALP_TARGET_OVERRIDE = String(n);
        }
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(stratKey) && maxLosingTrades !== undefined && maxLosingTrades !== null && maxLosingTrades !== "") {
            const n = Number(maxLosingTrades);
            if (Number.isInteger(n) && n >= 1) env.MAX_LOSING_TRADES_OVERRIDE = String(n);
        }
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(stratKey) && maxLosingSwitches !== undefined && maxLosingSwitches !== null && maxLosingSwitches !== "") {
            const n = Number(maxLosingSwitches);
            if (Number.isInteger(n) && n >= 1) env.MAX_LOSING_SWITCHES_OVERRIDE = String(n);
        }
        if (stratKey === "ALMA_TRI_BAND" && greyExitEnabled !== undefined) env.GREY_EXIT_OVERRIDE = String(!!greyExitEnabled);
        // Always written explicitly (both true AND false), same
        // write-asymmetry reasoning as the other toggles above — unset
        // means OFF/allowed at runtime, which is also the correct default
        // here, but writing it explicitly avoids the same class of bug
        // "only write when non-default" would risk elsewhere.
        env.DISABLE_DOUBLE_ORDERS_OVERRIDE = String(!!disableDoubleOrders);
        if (atrSlMult !== undefined && atrSlMult !== null && atrSlMult !== "") {
            const parsedAtrMult = Number(atrSlMult);
            if (Number.isFinite(parsedAtrMult) && parsedAtrMult > 0) env.ATR_SL_MULT_OVERRIDE = String(parsedAtrMult);
        }
        if (hardSlRupees !== undefined && hardSlRupees !== null && hardSlRupees !== "") {
            const hv = Number(hardSlRupees);
            if (!Number.isFinite(hv) || hv <= 0) return res.status(400).json({ error: "HardSlRupees must be a positive number" });
            env.HARD_SL_RUPEES_OVERRIDE = String(hv);
        }
        if (stratKey === "DAILY_HA_BIAS" && dailyBiasEntryTime !== undefined && dailyBiasEntryTime !== null && dailyBiasEntryTime !== "") {
            const t = normEntryTime(dailyBiasEntryTime);
            if (!t) return res.status(400).json({ error: "DailyBiasEntryTime must be HH:MM (IST)" });
            env.DAILY_BIAS_ENTRY_TIME_OVERRIDE = t;
        }
        if (stratKey !== "DAILY_HA_BIAS" && entryTime !== undefined && entryTime !== null && entryTime !== "") {
            const t = normEntryTime(entryTime);
            if (!t) return res.status(400).json({ error: "EntryTime must be HH:MM (IST)" });
            env.ENTRY_TIME_OVERRIDE = t;
        }
        if (stratKey === "DAILY_HA_BIAS" && dailyBiasCandle !== undefined && dailyBiasCandle !== null && dailyBiasCandle !== "") {
            const v = String(dailyBiasCandle).toUpperCase();
            if (v !== "PREVIOUS" && v !== "CURRENT") return res.status(400).json({ error: "DailyBiasCandle must be PREVIOUS or CURRENT" });
            env.DAILY_BIAS_CANDLE_OVERRIDE = v;
        }
        if (stratKey === "PURE_HA" && flipConfirmCandles !== undefined && flipConfirmCandles !== null && flipConfirmCandles !== "") {
            const parsedConfirm = Number(flipConfirmCandles);
            if (Number.isInteger(parsedConfirm) && parsedConfirm >= 1) env.FLIP_CONFIRM_CANDLES_OVERRIDE = String(parsedConfirm);
        }
        env.VOLUME_FILTER_OVERRIDE = String(!!volumeFilterEnabled);
        if (volumeSmaPeriod !== undefined && volumeSmaPeriod !== null && volumeSmaPeriod !== "") {
            const parsedVolPeriod = Number(volumeSmaPeriod);
            if (Number.isFinite(parsedVolPeriod) && parsedVolPeriod > 0) env.VOLUME_SMA_PERIOD_OVERRIDE = String(parsedVolPeriod);
        }
        env.LONG_CANDLE_FILTER_OVERRIDE = longCandleFilterEnabled === false ? "false" : "true";
        if (longCandleAtrPeriod !== undefined && longCandleAtrPeriod !== null && longCandleAtrPeriod !== "") {
            const parsedLcPeriod = Number(longCandleAtrPeriod);
            if (Number.isFinite(parsedLcPeriod) && parsedLcPeriod > 0) env.LONG_CANDLE_ATR_PERIOD_OVERRIDE = String(parsedLcPeriod);
        }
        if (longCandleAtrMult !== undefined && longCandleAtrMult !== null && longCandleAtrMult !== "") {
            const parsedLcMult = Number(longCandleAtrMult);
            if (Number.isFinite(parsedLcMult) && parsedLcMult > 0) env.LONG_CANDLE_ATR_MULT_OVERRIDE = String(parsedLcMult);
        }
        if (longCandleCooldownCandles !== undefined && longCandleCooldownCandles !== null && longCandleCooldownCandles !== "") {
            const parsedLcCooldown = Number(longCandleCooldownCandles);
            if (Number.isInteger(parsedLcCooldown) && parsedLcCooldown >= 0) env.LONG_CANDLE_COOLDOWN_OVERRIDE = String(parsedLcCooldown);
        }
        // Always written explicitly (both true AND false), same
        // write-asymmetry reasoning as LONG_CANDLE_FILTER_OVERRIDE above.
        env.HTF_GATE_ENABLED_OVERRIDE = "false";
        if (htfTimeframe === "1h" || htfTimeframe === "1d") env.HTF_TIMEFRAME_OVERRIDE = htfTimeframe;
        if (htfChopPeriod !== undefined && htfChopPeriod !== null && htfChopPeriod !== "") {
            const parsedHtfPeriod = Number(htfChopPeriod);
            if (Number.isFinite(parsedHtfPeriod) && parsedHtfPeriod > 0) env.HTF_CHOP_PERIOD_OVERRIDE = String(parsedHtfPeriod);
        }
        if (htfChopMax !== undefined && htfChopMax !== null && htfChopMax !== "") {
            const parsedHtfMax = Number(htfChopMax);
            if (Number.isFinite(parsedHtfMax) && parsedHtfMax > 0) env.HTF_CHOP_MAX_OVERRIDE = String(parsedHtfMax);
        }
        // Always written explicitly (both true AND false), same
        // write-asymmetry reasoning as HTF_GATE_ENABLED_OVERRIDE above.
        env.HTF_BAND_BLOCK_ENABLED_OVERRIDE = "false";
        env.DAILY_HA_GATE_ENABLED_OVERRIDE = dailyHaGateEnabled === false ? "false" : "true";

        await pm2Start({ ...PM2_BASE_OPTS, script: "engine.js", name, cwd: ROOT, env });
        res.json({ ok: true, name, strategy: stratKey, timeframe: tf, live: !!live, carryOvernight: !!carryOvernight, lotMult });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── BACKTEST — same runBacktest() call backtestFlow.js's wizard makes,
// driven by a JSON body instead of a step-by-step prompt loop. ────────────
app.get("/api/toolbox/backtest/params/:strategy", async (req, res) => {
    const key = req.params.strategy;
    if (STRATEGIES[key]) {
        const paramDefs = STRATEGY_PARAMS[key] || [];
        return res.json(paramDefs.map(p => ({ key: p.key, label: p.label, default: engineConfig[p.key] })));
    }
    // Falls back to a custom strategy the same way runBacktest.js does —
    // no engine-config-tunable knobs for these (their logic lives in the
    // saved indicators/conditions), so an empty params list is correct,
    // not a 404, as long as the name actually exists and is backtestable.
    const custom = await customStrategyDb.getStrategyByName(key);
    if (!custom || (!custom.entryLong && !custom.entryShort)) return res.status(404).json({ error: "Unknown strategy" });
    res.json([]);
});

app.post("/api/toolbox/backtest", async (req, res) => {
    const {
        underlying, exchange = "MCX", strategy, timeframe,
        days, from: fromStr, to: toStr, params = {}, lotMultOverride,
        candleType: btCandleIn, rangeSize: btRangeIn,
        // Universal risk toggles — same fields backtestFlow.js's CLI Step 6
        // asks for and merges onto context/params, previously only
        // reachable from the CLI (reported directly: "add these present
        // in toolbox"). chopFilterEnabled/chopPeriod/chopMax route through
        // params (merged onto a per-run engineConfig by backtestRun.js,
        // same as the CLI's params.CHOP_GATE_ALWAYS_FORCE etc.) — everything
        // else mutates context directly, exactly like backtestFlow.js does.
        chopFilterEnabled, chopPeriod, chopMax, maxLosingSwitches, maxLosingTrades, targetPoints, targetMode, scalpTarget, scalpStopDay, scalpNext, dsbExitMode,
        longCandleFilterEnabled, longCandleAtrPeriod, longCandleAtrMult, longCandleCooldownCandles,
        disableDoubleOrders, atrSlMult, hardSlRupees, dailyBiasEntryTime, dailyBiasCandle, entryTime,
        volumeFilterEnabled, volumeSmaPeriod,
        carryOvernight, maxDailyLoss, sessionTargetRupees, dailyHaGateEnabled,
        htfGateEnabled, htfChopPeriod, htfChopMax, htfBandBlockEnabled,
    } = req.body || {};

    if (!underlying) return res.status(400).json({ error: "Underlying is required" });
    // Same fallback as Add Instrument (line ~890) and runBacktest.js — a
    // strategy name not in the hardcoded STRATEGIES registry might be a
    // user-built one saved via customStrategyDb; only reject if it's in
    // neither, closing the "custom strategies not wired to backtesting" gap.
    let strategyLabel = strategy;
    if (!strategy) return res.status(400).json({ error: "A valid strategy is required" });
    if (STRATEGIES[strategy]) {
        strategyLabel = (STRATEGY_INFO[strategy] || {}).label || strategy;
    } else {
        const custom = await customStrategyDb.getStrategyByName(strategy);
        if (!custom || (!custom.entryLong && !custom.entryShort)) {
            return res.status(400).json({ error: `Unknown strategy "${strategy}" — not in STRATEGIES, and no backtestable custom_strategies row by that name` });
        }
        strategyLabel = `${custom.name} (custom)`;
    }

    // Date-only picks (YYYY-MM-DD from the calendar) are IST days: from = 00:00 IST, to = 23:59:59 IST.
    const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
    const to = toStr ? new Date(isDay(toStr) ? `${toStr}T23:59:59+05:30` : toStr) : new Date();
    let from;
    if (fromStr) {
        from = new Date(isDay(fromStr) ? `${fromStr}T00:00:00+05:30` : fromStr);
    } else {
        const d = days ? Number(days) : 30;
        if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: "Invalid days value" });
        from = new Date(to.getTime() - d * 24 * 60 * 60 * 1000);
    }
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return res.status(400).json({ error: "Invalid date range" });

    try {
        const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
        const def = getDefinition(underlying, exchange);
        let resolvedContract;
        try {
            resolvedContract = resolveCurrent(underlying, def, repo, pinStore).contract;
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }
        const context = buildContext(def, resolvedContract);
        if (!context.lotMult) {
            const parsed = Number(lotMultOverride);
            if (!lotMultOverride || !Number.isFinite(parsed) || parsed <= 0) {
                return res.status(400).json({ error: `Lot multiplier required for ${underlying} — provide lotMultOverride` });
            }
            context.lotMult = parsed;
        }

        // Same recompute backtestFlow.js does: only re-derive EOD from the
        // picked timeframe if it wasn't already a hand-set override.
        const tf = timeframe || context.timeframe || "15m";
        const preTfPickDefault = defaultEodFor(context.timeframe, context.exchange);
        const eodWasDefault = context.eodHour === preTfPickDefault.eodHour && context.eodMinute === preTfPickDefault.eodMinute;
        context.timeframe = tf;
        if (eodWasDefault) {
            const newDefault = defaultEodFor(tf, context.exchange);
            context.eodHour = newDefault.eodHour;
            context.eodMinute = newDefault.eodMinute;
        }

        const parsedParams = {};
        for (const [k, v] of Object.entries(params || {})) {
            const n = Number(v);
            if (Number.isFinite(n)) parsedParams[k] = n;
        }
        // Chop gate — booleans must NOT go through the Number()-coercion
        // loop above: engineConfig.CHOP_GATE_ALWAYS_FORCE is read via
        // `!== false`, and Number(false) is 0, which is `!== false` too
        // (different types, strict comparison) — silently inverting an
        // explicit "off" back to "on". Set as real booleans/numbers here
        // instead, same fields backtestFlow.js's CLI passes through `params`.
        if (chopFilterEnabled !== undefined) parsedParams.CHOP_GATE_ALWAYS_FORCE = !!chopFilterEnabled;
        if (chopPeriod !== undefined && chopPeriod !== null && chopPeriod !== "") {
            const n = Number(chopPeriod);
            if (Number.isFinite(n) && n > 0) parsedParams.CHOP_LEN = n;
        }
        if (chopMax !== undefined && chopMax !== null && chopMax !== "") {
            const n = Number(chopMax);
            if (Number.isFinite(n) && n > 0) parsedParams.CHOP_GATE_MAX_DEFAULT = n;
        }

        // Everything else mutates context directly, exactly like
        // backtestFlow.js's CLI Step 6 does — runBacktest reads these
        // straight off the context object it's passed.
        if (longCandleFilterEnabled !== undefined) context.longCandleFilterEnabled = !!longCandleFilterEnabled;
        if (longCandleAtrPeriod !== undefined && longCandleAtrPeriod !== null && longCandleAtrPeriod !== "") {
            const n = Number(longCandleAtrPeriod);
            if (Number.isFinite(n) && n > 0) context.longCandleAtrPeriod = n;
        }
        if (longCandleAtrMult !== undefined && longCandleAtrMult !== null && longCandleAtrMult !== "") {
            const n = Number(longCandleAtrMult);
            if (Number.isFinite(n) && n > 0) context.longCandleAtrMult = n;
        }
        if (longCandleCooldownCandles !== undefined && longCandleCooldownCandles !== null && longCandleCooldownCandles !== "") {
            const n = Number(longCandleCooldownCandles);
            if (Number.isInteger(n) && n >= 0) context.longCandleCooldownCandles = n;
        }
        if (disableDoubleOrders !== undefined) context.disableDoubleOrders = !!disableDoubleOrders;
        // ATR stop-loss multiplier — same "unread by strategies with no ATR
        // trail" note as the CLI; harmless to still send for ALMA_BAND
        // (Sep 2026: that strategy's stop is the opposite band line, not
        // ATR-based, and simply never reads context.atrSlMult anymore) but
        // the frontend hides this field for ALMA_BAND so it's never sent.
        if (atrSlMult !== undefined && atrSlMult !== null && atrSlMult !== "") {
            const n = Number(atrSlMult);
            if (Number.isFinite(n) && n > 0) context.atrSlMult = n;
        }
        if (hardSlRupees !== undefined && hardSlRupees !== null && hardSlRupees !== "") {
            const hv = Number(hardSlRupees);
            if (Number.isFinite(hv) && hv > 0) context.hardSlRupees = hv;
        }
        // DAILY_HA_BIAS trade entry time (IST "HH:MM"), same field the live engine reads.
        if (dailyBiasEntryTime !== undefined && dailyBiasEntryTime !== null && dailyBiasEntryTime !== "") {
            const t = parseHHMM(dailyBiasEntryTime);
            if (!t) return res.status(400).json({ error: "DailyBiasEntryTime must be HH:MM (IST)" });
            context.dailyBiasEntryHour = t.hour; context.dailyBiasEntryMinute = t.minute;
        }
        if (entryTime !== undefined && entryTime !== null && entryTime !== "") {
            const t = parseHHMM(entryTime);
            if (!t) return res.status(400).json({ error: "EntryTime must be HH:MM (IST)" });
            context.entryTimeHour = t.hour; context.entryTimeMinute = t.minute;
        }
        if (dailyBiasCandle !== undefined && dailyBiasCandle !== null && dailyBiasCandle !== "") {
            const v = String(dailyBiasCandle).toUpperCase();
            if (v !== "PREVIOUS" && v !== "CURRENT") return res.status(400).json({ error: "DailyBiasCandle must be PREVIOUS or CURRENT" });
            context.dailyBiasCandle = v;
        }
        if (volumeFilterEnabled !== undefined) context.volumeFilterEnabled = !!volumeFilterEnabled;
        if (volumeSmaPeriod !== undefined && volumeSmaPeriod !== null && volumeSmaPeriod !== "") {
            const n = Number(volumeSmaPeriod);
            if (Number.isFinite(n) && n > 0) context.volumeSmaPeriod = n;
        }
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(strategy) && maxLosingSwitches !== undefined && maxLosingSwitches !== null && maxLosingSwitches !== "") {
            const n = Number(maxLosingSwitches);
            if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "MaxLosingSwitches must be a whole number >= 1 (blank = off)" });
            context.maxLosingSwitchesPerDay = n;
        }
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(strategy) && maxLosingTrades !== undefined && maxLosingTrades !== null && maxLosingTrades !== "") {
            const n = Number(maxLosingTrades);
            if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "MaxLosingTrades must be a whole number >= 1 (blank = off)" });
            context.maxLosingTradesPerDay = n;
        }
        // Take-profit in points, fixed or adaptive (any strategy). Fixed wins; adaptive is sized once at entry
        // (backtestSL.js). The scalp target below takes precedence over both when set, as live does.
        if (targetPoints !== undefined && targetPoints !== null && targetPoints !== "") {
            const n = Number(targetPoints);
            if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "TargetPoints must be a number > 0 (blank = none)" });
            context.targetPoints = n;
        } else if (targetMode === "adaptive") {
            context.targetMode = "adaptive";
        }
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(strategy) && scalpTarget !== undefined && scalpTarget !== null && scalpTarget !== "") {
            const n = Number(scalpTarget);
            if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "ScalpTarget must be a rupee amount > 0 (blank = off)" });
            context.scalpTargetRupees = n;
        }
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(strategy) && scalpStopDay && context.scalpTargetRupees) context.scalpStopForDay = true;
        if (["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(strategy) && context.scalpTargetRupees && !context.scalpStopForDay && SCALP_NEXT_RE.test(scalpNext || "")) {
            const [nm, nv] = scalpNext.split(":");
            if (nm === "TARGET" || Number(nv) > 0) { context.scalpNextMode = nm; context.scalpNextValue = Number(nv) || 0; }
        }
        if (["DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB"].includes(strategy) && dsbExitMode === "SL") context.dsbExitMode = "SL";
        if (carryOvernight !== undefined) context.carryOvernight = !!carryOvernight;
        if (maxDailyLoss !== undefined && maxDailyLoss !== null && maxDailyLoss !== "") {
            const n = Number(maxDailyLoss);
            if (Number.isFinite(n) && n > 0) context.maxDailyLoss = n;
        }
        if (sessionTargetRupees !== undefined && sessionTargetRupees !== null && sessionTargetRupees !== "") {
            const n = Number(sessionTargetRupees);
            if (Number.isFinite(n) && n > 0) context.sessionTargetRupees = n;
        }
        // dailyHaGate.js — genuinely enforced in backtestRun.js's replay
        // (unlike htfGateEnabled, which stays out of this form entirely:
        // its backtest stub always returns false, so exposing a toggle
        // for it here would be a no-op control).
        if (dailyHaGateEnabled !== undefined) context.dailyHaGateEnabled = !!dailyHaGateEnabled;
        // Higher-timeframe gate: replayed point-in-time from the candle buffer (htfGate.js evaluateHtf).
        if (htfGateEnabled !== undefined) context.htfGateEnabled = !!htfGateEnabled;
        if (htfBandBlockEnabled !== undefined) context.htfBandBlockEnabled = !!htfBandBlockEnabled;
        if (htfChopPeriod !== undefined && htfChopPeriod !== null && htfChopPeriod !== "" && Number(htfChopPeriod) > 0) context.htfChopPeriod = Number(htfChopPeriod);
        if (htfChopMax !== undefined && htfChopMax !== null && htfChopMax !== "" && Number(htfChopMax) > 0) context.htfChopMax = Number(htfChopMax);

        const btCandle = normalizeCandleType(btCandleIn);
        const btRange = Number(btRangeIn) > 0 ? Number(btRangeIn) : null;
        const kc = ensureToolboxKite();
        // Suppress the in-process event bridge for the duration of the
        // replay (see eventBridge.js's setEmitSuppressed) so the thousands
        // of TICK/ENTRY/EXIT events a backtest generates never reach the
        // /engine relay and bleed into the real Live Log panel — and
        // capture console output so the browser gets the same per-candle
        // detail toolbox.js's CLI backtest flow prints, not just the final
        // summary. try/finally so a thrown error still restores both.
        setEmitSuppressed(true);
        let result, logLines;
        try {
            ({ result, lines: logLines } = await withCapturedConsole(() =>
                runBacktest({ strategyKey: strategy, strategyLabel, context, timeframe: tf, from, to, params: parsedParams, kc, candleType: btCandle, rangeSize: btRange })
            ));
        } finally {
            setEmitSuppressed(false);
        }

        if (tf === "1d" && Array.isArray(logLines)) {
            // Daily bars carry no time of day — show the bar's date instead of a meaningless 00:00:00.
            let day = "";
            logLines = logLines.map(l => {
                const h = l.match(/(\d{1,2}\/\d{1,2}\/\d{4}), 00:00:00/);
                if (h) { day = h[1]; return l.replace(", 00:00:00", ""); }
                return day ? l.replace("] 00:00:00 ", `] ${day} `) : l;
            });
        }

        const m = result.report.metrics;
        res.json({
            ok: true,
            summary: {
                trades: m.trades,
                winRate: m.winRate,
                profitFactor: m.profitFactor,
                netPoints: m.netPoints,
                netPnL: m.netPnL,
                maxDrawdown: m.maxDrawdown,
                largestWin: m.largestWin,
                largestLoss: m.largestLoss,
                avgTrade: m.avgTrade,
            },
            reportUrl: `/api/toolbox/backtest/reports/${path.basename(result.paths.htmlPath)}`,
            jsonUrl: `/api/toolbox/backtest/reports/${path.basename(result.paths.jsonPath)}`,
            losingSwitch: result.report.losingSwitch || null,
            logLines,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serves the same HTML/JSON report files backtestReport.js writes under
// ROOT/backtests — already behind the blanket `/api` authRequired above.
app.use("/api/toolbox/backtest/reports", express.static(path.join(ROOT, "backtests")));

// ─── SETUP CREDENTIALS — same minimal .env read/write toolbox.js's
// setupCredentials uses (KEY=VALUE lines only, blank input keeps current
// value, secrets shown masked). ─────────────────────────────────────────
const ENV_PATH = path.join(ROOT, ".env");
const CREDENTIAL_FIELDS = ["API_KEY", "API_SECRET", "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "GEMINI_API_KEY"];

function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return { lines: [], values: {} };
    const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
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
    while (out.length && out[out.length - 1] === "") out.pop();
    for (const key of Object.keys(updates)) {
        if (!updatedKeys.has(key)) out.push(`${key}=${updates[key]}`);
    }
    fs.writeFileSync(ENV_PATH, out.join("\n") + "\n");
}

function maskSecret(val) {
    if (!val) return null;
    if (val.length <= 8) return "*".repeat(val.length);
    return val.slice(0, 4) + "*".repeat(val.length - 8) + val.slice(-4);
}

app.get("/api/toolbox/credentials", (req, res) => {
    const { values } = readEnvFile();
    res.json(CREDENTIAL_FIELDS.map(key => ({ key, masked: maskSecret(values[key]), set: !!values[key] })));
});

app.post("/api/toolbox/credentials", (req, res) => {
    const updates = {};
    for (const key of CREDENTIAL_FIELDS) {
        if (typeof req.body?.[key] === "string" && req.body[key].length > 0) {
            if (/[\r\n\0]/.test(req.body[key])) return res.status(400).json({ error: `${key}: line breaks are not allowed` });
            updates[key] = req.body[key].trim();
        }
    }
    if (Object.keys(updates).length === 0) return res.json({ ok: true, changed: 0 });
    writeEnvFile(updates);
    // engineConfig.js reads .env once at require() time — same caveat
    // toolbox.js's setupCredentials flags: this process (and any running
    // engine) needs an actual restart to pick up new values.
    res.json({ ok: true, changed: Object.keys(updates).length, note: "takes effect on next process restart" });
});

// ─── TALGO-AI — post-trade review (observer only; engines never call this) ──
const aiReview = require("../aiReview");
function geminiKeyFromEnvFile() {
    // Picks up a key saved from Settings without a restart.
    const k = readEnvFile().values.GEMINI_API_KEY;
    if (k) process.env.GEMINI_API_KEY = k;
    return !!process.env.GEMINI_API_KEY;
}
app.get("/api/ai/trades", async (req, res) => {
    try {
        const trades = await aiReview.listTrades(Math.min(Number(req.query.limit) || 60, 200));
        res.json({ keySet: geminiKeyFromEnvFile(), trades });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/ai/review", async (req, res) => {
    const { journal, id, force } = req.body || {};
    if (typeof journal !== "string" || !Number.isInteger(Number(id))) return res.status(400).json({ error: "Journal and id required" });
    if (!geminiKeyFromEnvFile()) return res.status(400).json({ error: "Gemini API key not set — add GEMINI_API_KEY in Settings" });
    try { res.json({ review: await aiReview.reviewTrade(journal, Number(id), !!force) }); }
    catch (err) { res.status(err.status || 502).json({ error: err.message }); }
});

const aiSummary = require("../aiSummary");
app.get("/api/ai/summary", async (req, res) => {
    try { res.json({ keySet: geminiKeyFromEnvFile(), summary: await aiSummary.buildSummary(Number(req.query.days) || 7) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/ai/summary/narrate", async (req, res) => {
    if (!geminiKeyFromEnvFile()) return res.status(400).json({ error: "Gemini API key not set — add GEMINI_API_KEY in Settings" });
    try {
        const summary = await aiSummary.buildSummary(Number((req.body || {}).days) || 7);
        if (summary.trades < 1) return res.status(400).json({ error: "No closed trades in that window to analyse" });
        res.json({ narration: await aiSummary.narrate(summary, !!(req.body || {}).force) });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
});

app.post("/api/ai/backtest", async (req, res) => {
    if (!geminiKeyFromEnvFile()) return res.status(400).json({ error: "Gemini API key not set — add GEMINI_API_KEY in Settings" });
    const file = path.basename(String((req.body || {}).file || ""));
    if (!/^[\w.\-]+\.json$/.test(file)) return res.status(400).json({ error: "A backtest .json report file is required" });
    let report;
    try { report = JSON.parse(fs.readFileSync(path.join(ROOT, "backtests", file), "utf8")); }
    catch { return res.status(404).json({ error: "Backtest report not found" }); }
    try { res.json({ narration: await aiSummary.narrateBacktest(report, !!(req.body || {}).force) }); }
    catch (err) { res.status(err.status || 502).json({ error: err.message }); }
});

// Auto-review: every minute, review recently closed trades that have no review yet (max 3 per cycle).
// Observer only — it reads journals and writes ai_reviews.db; a failure is recorded and never retried in a loop.
// Off with AI_AUTO_REVIEW=0 (or when no Gemini key is set).
const aiAuto = { enabled: process.env.AI_AUTO_REVIEW !== "0", lastRun: null, reviewed: 0, lastError: null, running: false };
async function aiAutoTick() {
    if (!aiAuto.enabled || aiAuto.running || !geminiKeyFromEnvFile()) return;
    aiAuto.running = true;
    try {
        const cutoff = Date.now() - 24 * 3600 * 1000;
        const retried = aiAuto.retried || (aiAuto.retried = new Set());
        const todo = (await aiReview.listTrades(40)).filter(t => {
            if (t.review || !t.facts.exitTime || new Date(t.facts.exitTime).getTime() < cutoff) return false;
            if (!t.reviewError) return true;
            // a failed review gets exactly one automatic retry (per server run) after 15 minutes
            const key = t.journal + "#" + t.id, age = Date.now() - new Date(String(t.failedAt).replace(" ", "T") + "Z").getTime();
            if (retried.has(key) || !(age > 15 * 60000)) return false;
            retried.add(key); return true;
        }).slice(0, 3);
        for (const t of todo) {
            try { await aiReview.reviewTrade(t.journal, t.id, false); aiAuto.reviewed++; aiAuto.lastError = null; }
            catch (err) { aiAuto.lastError = err.message; }
            await new Promise(r => setTimeout(r, 1500));
        }
        aiAuto.lastRun = new Date().toISOString();
    } catch (err) { aiAuto.lastError = err.message; }
    finally { aiAuto.running = false; }
}
setInterval(() => { aiAutoTick().catch(() => {}); }, 60000).unref();
app.get("/api/ai/status", (req, res) => res.json({ keySet: geminiKeyFromEnvFile(), autoReview: aiAuto.enabled, lastRun: aiAuto.lastRun, reviewedSinceStart: aiAuto.reviewed, lastError: aiAuto.lastError }));

// ─── TRENDING INSTRUMENTS — same ADX(14) daily-candle scan toolbox.js's
// trendingInstruments() runs, same already-running cross-check. Deploying a
// pick reuses POST /api/toolbox/instrument (the Add Instrument endpoint
// above) rather than a second start path — the client just opens that flow
// pre-filled with the chosen underlying.
app.post("/api/toolbox/trending/scan", async (req, res) => {
    const { exchange = "MCX", q = "", confirmAll } = req.body || {};

    // NDJSON stream, one JSON object per line — deliberately NOT one
    // buffered res.json() at the end. A full unfiltered scan can run for
    // minutes against the real Kite API (350ms pacing x N instruments +
    // real network latency each), and a connection that sits silent that
    // long is exactly what home routers' NAT tables and backgrounded mobile
    // tabs kill — which then surfaces client-side as an opaque "JSON.parse:
    // unexpected character" error with no indication of what actually went
    // wrong. Writing a line every underlying keeps real traffic flowing.
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    if (res.flushHeaders) res.flushHeaders();
    const send = obj => res.write(JSON.stringify(obj) + "\n");

    try {
        const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
        const all = exchange === "NSE" ? repo.listEquitySymbols() : repo.listUnderlyings();
        const matches = q ? all.filter(u => u.toLowerCase().includes(q.toLowerCase())) : all;

        if (matches.length === 0) {
            send({ type: "result", scanned: 0, exchange, trending: [], alreadyRunning: [] });
            return res.end();
        }
        if (matches.length > 30 && !q && !confirmAll) {
            send({
                type: "error",
                error: `${all.length} underlyings total — scanning all of them means one rate-limited historical-data call each and will take a while`,
                requiresConfirmAll: true,
                total: all.length,
            });
            return res.end();
        }

        const scanned = await scanUnderlyings(matches, repo, exchange, (done, total, underlying) => {
            send({ type: "progress", done, total, underlying });
        });
        const engineProcs = await getEngineProcesses();
        const runningByUnderlying = new Map();
        for (const p of engineProcs) {
            if (!runningByUnderlying.has(p.underlying)) runningByUnderlying.set(p.underlying, []);
            runningByUnderlying.get(p.underlying).push(p);
        }

        const trendingAll = scanned.filter(r => r.trending).sort((a, b) => b.adxVal - a.adxVal);
        const alreadyRunning = trendingAll
            .filter(r => runningByUnderlying.has(r.underlying))
            .map(r => ({ ...r, runningAs: runningByUnderlying.get(r.underlying).map(p => `${p.name}[${p.status}]`) }));
        const trending = trendingAll.filter(r => !runningByUnderlying.has(r.underlying));

        send({ type: "result", scanned: scanned.length, exchange, trending, alreadyRunning });
        res.end();
    } catch (err) {
        send({ type: "error", error: err.message });
        res.end();
    }
});

// ─── MARKET STATUS — reads marketStateStore.js via marketStateClient.js
// (same cheap, near-instant read the CLI screen does — the Scanner process
// does the actual continuous work), driven off the watchlist same as
// toolbox.js's marketStatusScreen so a freshly-watched instrument with no
// profile yet still shows up instead of being silently omitted.
app.get("/api/toolbox/watchlist", async (req, res) => {
    try {
        const entries = marketWatchlist.getAll();
        const profiles = await Promise.all(entries.map(e => marketStateClient.getProfile(e.underlying)));
        res.json(entries.map((e, i) => ({ ...e, profile: profiles[i] })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/toolbox/watchlist", (req, res) => {
    const { underlying, exchange = "MCX" } = req.body || {};
    if (!underlying) return res.status(400).json({ error: "Underlying is required" });
    if (!/^[A-Za-z0-9&_-]{1,30}$/.test(String(underlying))) return res.status(400).json({ error: "Invalid underlying" });
    marketWatchlist.add(underlying, exchange);
    res.json({ ok: true });
});

app.delete("/api/toolbox/watchlist/:underlying", (req, res) => {
    marketWatchlist.remove(req.params.underlying);
    res.json({ ok: true });
});

app.post("/api/toolbox/scanner/start", async (req, res) => {
    try {
        await pm2Start({ ...PM2_BASE_OPTS, script: "scannerService.js", name: SCANNER_PROCESS_NAME, cwd: ROOT });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/toolbox/scanner/stop", async (req, res) => {
    try {
        await pm2Stop(SCANNER_PROCESS_NAME);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: `Failed to stop scanner (is it running?): ${err.message}` });
    }
});

app.get("/api/toolbox/scanner/status", async (req, res) => {
    try {
        const list = await pm2List();
        const proc = list.find(p => p.name === SCANNER_PROCESS_NAME);
        res.json({ running: !!proc && proc.pm2_env.status === "online" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── HEDGE PAIR — deploy/manage hedgePairEngine.js processes. Its own
// small route group, not folded into /api/toolbox/instrument(s) —
// getEngineProcesses() there filters on a single UNDERLYING env var,
// which a hedge-pair process never sets (it sets CORE_UNDERLYING/
// HEDGE_UNDERLYING instead), so it never appears in that list or those
// routes' shape in the first place. Mirrors toolbox.js's own hedgePairScreen()/
// addHedgePair() — see that file's comments for the full reasoning.
async function getHedgePairProcesses() {
    const list = await pm2List();
    return list
        .filter(p => p.pm2_env.env?.CORE_UNDERLYING)
        .map(p => ({
            name:            p.name,
            coreUnderlying:  p.pm2_env.env.CORE_UNDERLYING,
            hedgeUnderlying: p.pm2_env.env.HEDGE_UNDERLYING,
            status:          p.pm2_env.status,
            uptime:          p.pm2_env.status === "online" ? Date.now() - p.pm2_env.pm_uptime : null,
            coreLots:        p.pm2_env.env?.CORE_LOTS_OVERRIDE || "1",
            hedgeLots:       p.pm2_env.env?.HEDGE_LOTS_OVERRIDE || "5",
            unwindMode:      p.pm2_env.env?.UNWIND_MODE_OVERRIDE || "HA_FLIP",
            live:            p.pm2_env.env?.LIVE_ORDERS_OVERRIDE === "true",
            exchange:        p.pm2_env.env?.EXCHANGE_OVERRIDE || "MCX",
            outLogPath:      p.pm2_env.pm_out_log_path,
            errLogPath:      p.pm2_env.pm_err_log_path,
        }));
}

app.get("/api/toolbox/hedgepairs", async (req, res) => {
    try {
        res.json({ pairs: await getHedgePairProcesses() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Same lotMult-required check configureAndStartInstrument()/toolbox.js's
// askLotMult() do — surfaced here so the UI can prompt for it before
// ever calling POST /api/toolbox/hedgepairs with a name that would just
// fail hedgePairContext.js's own refuse-to-boot guard.
app.get("/api/toolbox/hedgepairs/lotmult/:underlying", (req, res) => {
    try {
        const def = getDefinition(req.params.underlying, "MCX");
        res.json({ lotMultRequired: def.lotMult === null });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Hedge-pair backtest (backtestHedgePair.js) — market data only, global account.
app.post("/api/toolbox/hedgepairs/backtest", async (req, res) => {
    const b = req.body || {};
    try {
        const { coreUnderlying, hedgeUnderlying } = b;
        if (!coreUnderlying || !hedgeUnderlying) return res.status(400).json({ error: "CoreUnderlying and hedgeUnderlying are required" });
        if (coreUnderlying === hedgeUnderlying) return res.status(400).json({ error: "Core and hedge must be different underlyings" });
        const unwindMode = String(b.unwindMode || "HA_FLIP").toUpperCase();
        if (unwindMode !== "HA_FLIP" && unwindMode !== "EOD_ONLY") return res.status(400).json({ error: "UnwindMode must be HA_FLIP or EOD_ONLY" });
        const from = new Date(b.from), to = new Date(b.to);
        if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: "From and to must be YYYY-MM-DD" });
        if (to < from) return res.status(400).json({ error: "To must not be before from" });
        for (const [l, v] of [["coreLots", b.coreLots], ["hedgeLots", b.hedgeLots], ["coreLotMultOverride", b.coreLotMultOverride], ["hedgeLotMultOverride", b.hedgeLotMultOverride]]) {
            if (v !== undefined && v !== null && v !== "" && !(Number(v) > 0)) return res.status(400).json({ error: `${l} must be a positive number` });
        }
        for (const [u, ov] of [[coreUnderlying, b.coreLotMultOverride], [hedgeUnderlying, b.hedgeLotMultOverride]]) {
            if (getDefinition(u, "MCX").lotMult === null && !ov) return res.status(400).json({ error: `Lot multiplier is required for ${u} (no context.js override on file)` });
        }
        const kc = ensureDualHedgeBacktestKite();
        setEmitSuppressed(true);
        let out, lines;
        try {
            ({ result: out, lines } = await withCapturedConsole(() => runHedgePairBacktest({
                coreUnderlying, hedgeUnderlying, exchange: "MCX",
                coreLots: Number(b.coreLots) || 1, hedgeLots: Number(b.hedgeLots) || 5,
                coreLotMultOverride: b.coreLotMultOverride ? Number(b.coreLotMultOverride) : null,
                hedgeLotMultOverride: b.hedgeLotMultOverride ? Number(b.hedgeLotMultOverride) : null,
                unwindMode, from, to, kc,
            })));
        } finally {
            setEmitSuppressed(false);
        }
        const { report, paths } = out;
        res.json({
            ok: true, unwindMode,
            core: report.core, hedge: report.hedge, summary: report.metrics,
            reportUrl: `/api/toolbox/backtest/reports/${path.basename(paths.htmlPath)}`,
            jsonUrl: `/api/toolbox/backtest/reports/${path.basename(paths.jsonPath)}`,
            logLines: lines.slice(-5000),
        });
    } catch (err) {
        const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
        res.status(code).json({ error: err.message });
    }
});

app.post("/api/toolbox/hedgepairs", async (req, res) => {
    const {
        coreUnderlying, hedgeUnderlying, coreLots, hedgeLots,
        coreLotMultOverride, hedgeLotMultOverride, unwindMode,
        live, confirmLive,
    } = req.body || {};

    if (!coreUnderlying || !hedgeUnderlying) {
        return res.status(400).json({ error: "CoreUnderlying and hedgeUnderlying are both required" });
    }
    const resolvedUnwindMode = unwindMode === "EOD_ONLY" ? "EOD_ONLY" : "HA_FLIP";
    // Same rule toolbox.js/instrument mode enforce: going live requires the
    // literal word "LIVE" server-side too, not just a client-side checkbox.
    if (live && confirmLive !== "LIVE") {
        return res.status(400).json({ error: 'Going live requires confirmLive: "LIVE"' });
    }

    const coreDef  = getDefinition(coreUnderlying, "MCX");
    const hedgeDef = getDefinition(hedgeUnderlying, "MCX");
    if (coreDef.lotMult === null && !coreLotMultOverride) {
        return res.status(400).json({ error: `CoreLotMultOverride is required for ${coreUnderlying} (no context.js override on file)` });
    }
    if (hedgeDef.lotMult === null && !hedgeLotMultOverride) {
        return res.status(400).json({ error: `HedgeLotMultOverride is required for ${hedgeUnderlying} (no context.js override on file)` });
    }

    const name = `${getShortName(coreUnderlying)}${getShortName(hedgeUnderlying)}HedgePair`;
    const env = {
        CORE_UNDERLYING: coreUnderlying, HEDGE_UNDERLYING: hedgeUnderlying, EXCHANGE_OVERRIDE: "MCX",
        CORE_LOTS_OVERRIDE: String(coreLots || 1), HEDGE_LOTS_OVERRIDE: String(hedgeLots || 5),
        UNWIND_MODE_OVERRIDE: resolvedUnwindMode, LIVE_ORDERS_OVERRIDE: String(!!live),
    };
    if (coreLotMultOverride)  env.CORE_LOTMULT_OVERRIDE  = String(coreLotMultOverride);
    if (hedgeLotMultOverride) env.HEDGE_LOTMULT_OVERRIDE = String(hedgeLotMultOverride);

    try {
        await pm2Start({ ...PM2_BASE_OPTS, script: "hedgePairEngine.js", name, cwd: ROOT, env });
        res.json({ ok: true, name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/toolbox/hedgepairs/start", async (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });
    try {
        await pm2Start({ ...PM2_BASE_OPTS, script: "hedgePairEngine.js", name, cwd: ROOT });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/toolbox/hedgepairs/stop", async (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });
    try {
        await pm2Stop(name);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/toolbox/hedgepairs/:name", async (req, res) => {
    try {
        await pm2Delete(req.params.name);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/toolbox/hedgepairs/logs/:name", async (req, res) => {
    try {
        const pairs = await getHedgePairProcesses();
        const p = pairs.find(x => x.name === req.params.name);
        if (!p) return res.status(404).json({ error: "Process not found" });
        const out = tailFile(p.outLogPath, N_LOG_LINES);
        const err = tailFile(p.errLogPath, N_LOG_LINES);
        res.json({ outLogPath: p.outLogPath || null, errLogPath: p.errLogPath || null, out, err });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DUAL HEDGE — deploy/manage dualHedgeEngine.js processes. See that
// file's own header for the full spec. NOT the same thing as Hedge Pairs
// above (one account, two instruments) — this is two SEPARATE Kite
// accounts, one instrument, one LONG-only, the other SHORT-only. Mirrors
// toolbox.js's own dualHedgeScreen()/addDualHedge()/manageDualHedgeUsersScreen()
// — see that file's comments for the full reasoning behind each field.
const hhmmPad = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
// "HH:MM" -> zero-padded "HH:MM", or null when invalid (DAILY_HA_BIAS entry time).
function normEntryTime(v) {
    const t = parseHHMM(v);
    return t ? `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}` : null;
}
function parseHHMM(v, dflt) {
    const m = String(v || dflt).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return { hour: Number(m[1]), minute: Number(m[2]) };
}
const BIAS_BAND_TIMEFRAMES = ["5m", "15m", "30m", "1h"];

// Two ONLINE dual-hedge deployments must not share an account on the same
// underlying + exchange (they would fight over one broker position).
async function findAccountConflict(underlying, accounts, selfName) {
    const mine = new Set(accounts.map(a => dualHedgeUsers.sanitizeName(a)));
    const list = await getDualHedgeProcesses();
    for (const d of list) {
        if (d.name === selfName || d.status !== "online") continue;
        if (String(d.underlying).toUpperCase() !== String(underlying).toUpperCase()) continue;
        const used = [d.longUser, d.shortUser].filter(Boolean).map(a => dualHedgeUsers.sanitizeName(a));
        const hit = used.find(a => mine.has(a));
        if (hit) return `account "${hit}" is already running ${underlying} in ${d.name} \u2014 stop it first`;
    }
    return null;
}

async function getDualHedgeProcesses() {
    const list = await pm2List();
    return list
        .filter(p => p.pm2_env.env?.DH_UNDERLYING)
        .map(p => ({
            name:       p.name,
            underlying: p.pm2_env.env.DH_UNDERLYING,
            longUser:   p.pm2_env.env.DH_LONG_USER,
            shortUser:  p.pm2_env.env.DH_SHORT_USER,
            status:     p.pm2_env.status,
            uptime:     p.pm2_env.status === "online" ? Date.now() - p.pm2_env.pm_uptime : null,
            lots:       p.pm2_env.env?.DH_LOTS_OVERRIDE || "1",
            maxLoss:    p.pm2_env.env?.DH_MAX_LOSS_RUPEES_OVERRIDE || "3000",
            slMode:     (p.pm2_env.env?.DH_SL_MODE || "RUPEES").toUpperCase(),
            atrSlMult:  p.pm2_env.env?.DH_ATR_SL_MULT_OVERRIDE || String(engineConfig.ATR_SL_MULT),
            atrTimeframe: p.pm2_env.env?.DH_ATR_TIMEFRAME_OVERRIDE || "15m",
            takeProfit: p.pm2_env.env?.DH_TAKE_PROFIT_RUPEES_OVERRIDE || "3000",
            rangeSize:  p.pm2_env.env?.DH_RANGE_SIZE_OVERRIDE || "",
            gapCapture: p.pm2_env.env?.DH_GAP_CAPTURE === "true",
            gcEntry:    `${String(p.pm2_env.env?.DH_GC_HOUR_OVERRIDE ?? "23").padStart(2, "0")}:${String(p.pm2_env.env?.DH_GC_MINUTE_OVERRIDE ?? "20").padStart(2, "0")}`,
            gcExit:     `${String(p.pm2_env.env?.DH_GC_QUIT_HOUR_OVERRIDE ?? "23").padStart(2, "0")}:${String(p.pm2_env.env?.DH_GC_QUIT_MINUTE_OVERRIDE ?? "25").padStart(2, "0")}`,
            live:       p.pm2_env.env?.LIVE_ORDERS_OVERRIDE === "true",
            exchange:   p.pm2_env.env?.DH_EXCHANGE_OVERRIDE || "MCX",
            strategy:   (p.pm2_env.env?.DH_STRATEGY || "DUAL").toUpperCase(),
            unwindMode: p.pm2_env.env?.DH_UNWIND_MODE || "BAND_FLIP",
            bandTimeframe: p.pm2_env.env?.DH_BAND_TIMEFRAME || "15m",
            entryTime:  hhmmPad(p.pm2_env.env?.DH_ENTRY_HOUR_OVERRIDE ?? 10, p.pm2_env.env?.DH_ENTRY_MINUTE_OVERRIDE ?? 0),
            eodTime:    (p.pm2_env.env?.DH_EOD_HOUR_OVERRIDE !== undefined && p.pm2_env.env?.DH_EOD_HOUR_OVERRIDE !== "")
                ? hhmmPad(p.pm2_env.env.DH_EOD_HOUR_OVERRIDE, p.pm2_env.env.DH_EOD_MINUTE_OVERRIDE ?? 0) : null,
            outLogPath: p.pm2_env.pm_out_log_path,
            errLogPath: p.pm2_env.pm_err_log_path,
        }));
}

app.get("/api/toolbox/dualhedge", async (req, res) => {
    try {
        res.json({ deployments: await getDualHedgeProcesses() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/toolbox/dualhedge/lotmult/:underlying", (req, res) => {
    try {
        const def = getDefinition(req.params.underlying, "MCX");
        res.json({ lotMultRequired: def.lotMult === null });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Users sub-resource — named Kite accounts, stored in .env via
// dualHedgeUsers.js, independent of engineConfig's own single global
// account (see dualHedgeUsers.js's header). accessToken is never sent
// back to the client in full — only whether one is set — same posture
// engineConfig's own credential endpoints already take. tokenFresh/
// accessTokenDate ARE safe to send (dates, not secrets) and are what the
// unified token panel (see /api/token/status below + app.js's
// refreshTokenStatus()) uses to flag a per-user token as stale even
// though one is technically "set".
function redactUser(u) {
    return {
        name: u.name, hasApiKey: !!u.apiKey, hasApiSecret: !!u.apiSecret,
        hasAccessToken: !!u.accessToken, tokenFresh: u.tokenFresh, accessTokenDate: u.accessTokenDate || null,
    };
}

app.get("/api/toolbox/dualhedge/users", (req, res) => {
    try {
        res.json({ users: dualHedgeUsers.listUsers().map(redactUser) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/toolbox/dualhedge/users/:name/login-url", (req, res) => {
    // Same as the single-account /api/token/login-url above — kc.getLoginURL()
    // is a pure local string builder (no network call to Kite), so this is
    // safe to call synchronously and pre-fetch for every user up front (see
    // app.js's loadDualHedgeUserLoginUrls()) rather than only on click.
    try {
        const user = dualHedgeUsers.getUser(req.params.name);
        if (!user.apiKey) return res.status(400).json({ error: `${req.params.name} has no API key set` });
        const kc = new KiteConnect({ api_key: user.apiKey });
        res.json({ url: withAccountParam(kc.getLoginURL(), user.name) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/toolbox/dualhedge/users", (req, res) => {
    const { name, apiKey, apiSecret } = req.body || {};
    if (!name || !apiKey || !apiSecret) {
        return res.status(400).json({ error: "Name, apiKey and apiSecret are all required" });
    }
    try {
        const saved = dualHedgeUsers.saveUserCredentials(name, { apiKey, apiSecret });
        res.json({ ok: true, name: saved });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/toolbox/dualhedge/users/:name", (req, res) => {
    try {
        dualHedgeUsers.removeUser(req.params.name);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Same request_token -> access_token exchange as the single global
// account's own /api/toolbox/token route (exchangeToken() above), just
// scoped to one named dual-hedge user's own API key/secret instead of
// engineConfig's.
app.post("/api/toolbox/dualhedge/users/token", async (req, res) => {
    const { name, requestToken: rawInput } = req.body || {};
    if (!name || !rawInput) return res.status(400).json({ error: "Name and requestToken are both required" });
    try {
        await exchangeUserToken(name, rawInput);
        res.json({ ok: true });
    } catch (err) {
        res.status(err.message.includes("missing an API key") ? 400 : 500).json({ error: err.message });
    }
});

app.post("/api/toolbox/dualhedge", async (req, res) => {
    const {
        underlying, longUser, shortUser, lots, maxLossRupees, takeProfitRupees, rangeSize,
        slMode: slModeIn, atrSlMult, atrTimeframe: atrTfIn,
        lotMultOverride, bandStepOverride, live, confirmLive,
        gapCapture, gcEntry, gcExit,
        strategy: strategyIn, unwindMode: unwindIn, bandTimeframe: bandTfIn, entryTime, eodTime,
    } = req.body || {};

    const strategy = String(strategyIn || "DUAL").toUpperCase();
    if (strategy !== "DUAL" && strategy !== "BIAS") return res.status(400).json({ error: "Strategy must be DUAL or BIAS" });
    if (!underlying || !longUser || !shortUser) {
        return res.status(400).json({ error: "Underlying, longUser and shortUser are all required" });
    }
    if (longUser === shortUser) {
        return res.status(400).json({ error: "LongUser and shortUser must be different accounts" });
    }
    const users = dualHedgeUsers.listUsers();
    for (const [label, name] of [["longUser", longUser], ["shortUser", shortUser]]) {
        const u = users.find(x => x.name === dualHedgeUsers.sanitizeName(name));
        if (!u || !u.apiKey || !u.accessToken) {
            return res.status(400).json({ error: `${label} "${name}" is not a fully configured dual-hedge user (missing API key or access token)` });
        }
    }
    if (live && confirmLive !== "LIVE") {
        return res.status(400).json({ error: 'Going live requires confirmLive: "LIVE"' });
    }

    const def = getDefinition(underlying, "MCX");
    if (def.lotMult === null && !lotMultOverride) {
        return res.status(400).json({ error: `LotMultOverride is required for ${underlying} (no context.js override on file)` });
    }
    for (const [label, v] of [["takeProfitRupees", takeProfitRupees], ["rangeSize", rangeSize], ["bandStepOverride", bandStepOverride], ["atrSlMult", atrSlMult]]) {
        if (v !== undefined && v !== null && v !== "" && !(Number(v) > 0)) return res.status(400).json({ error: `${label} must be a positive number` });
    }
    // Stop-loss type (DUAL only) — rupees (default) or ATR multiple from entry, see dualHedgeAtr.js.
    const slMode = String(slModeIn || "RUPEES").toUpperCase();
    if (!DH_SL_MODES.includes(slMode)) return res.status(400).json({ error: `SlMode must be one of ${DH_SL_MODES.join("/")}` });
    const atrTimeframe = String(atrTfIn || "15m").toLowerCase();
    if (slMode === "ATR" && !DH_ATR_TIMEFRAMES.includes(atrTimeframe)) return res.status(400).json({ error: `AtrTimeframe must be one of ${DH_ATR_TIMEFRAMES.join("/")}` });

    const name = strategy === "BIAS" ? `${getShortName(underlying)}DualBias` : `${getShortName(underlying)}DualHedge`;
    const conflict = await findAccountConflict(underlying, [longUser, shortUser], name);
    if (conflict) return res.status(409).json({ error: conflict });

    const env = {
        DH_UNDERLYING: underlying, DH_LONG_USER: dualHedgeUsers.sanitizeName(longUser), DH_SHORT_USER: dualHedgeUsers.sanitizeName(shortUser),
        DH_EXCHANGE_OVERRIDE: "MCX", DH_LOTS_OVERRIDE: String(lots || 1),
        LIVE_ORDERS_OVERRIDE: String(!!live),
        // Always written explicitly (PM2 restart merges env, never clears it).
        DH_STRATEGY: strategy,
    };
    if (lotMultOverride)  env.DH_LOTMULT_OVERRIDE = String(lotMultOverride);
    if (bandStepOverride) env.DH_BAND_STEP_OVERRIDE = String(bandStepOverride);

    if (strategy === "BIAS") {
        const unwind = String(unwindIn || "BAND_FLIP").toUpperCase();
        if (unwind !== "BAND_FLIP" && unwind !== "EOD_ONLY") return res.status(400).json({ error: "UnwindMode must be BAND_FLIP or EOD_ONLY" });
        const tf = String(bandTfIn || "15m").toLowerCase();
        if (!BIAS_BAND_TIMEFRAMES.includes(tf)) return res.status(400).json({ error: `BandTimeframe must be one of ${BIAS_BAND_TIMEFRAMES.join("/")}` });
        if (gapCapture) return res.status(400).json({ error: "Gap capture is not available for the BIAS strategy (no overnight carry)" });
        const entry = parseHHMM(entryTime, "10:00");
        if (!entry) return res.status(400).json({ error: "EntryTime must be HH:MM (IST)" });
        const dEod = defaultEodFor(tf, "MCX");
        const eod = eodTime ? parseHHMM(eodTime) : { hour: dEod.eodHour, minute: dEod.eodMinute };
        if (!eod) return res.status(400).json({ error: "EodTime must be HH:MM (IST)" });
        if (eod.hour * 60 + eod.minute <= entry.hour * 60 + entry.minute) return res.status(400).json({ error: "EntryTime must be before EOD" });
        env.DH_UNWIND_MODE = unwind;
        env.DH_BAND_TIMEFRAME = tf;
        env.DH_ENTRY_HOUR_OVERRIDE = String(entry.hour); env.DH_ENTRY_MINUTE_OVERRIDE = String(entry.minute);
        env.DH_EOD_HOUR_OVERRIDE = String(eod.hour); env.DH_EOD_MINUTE_OVERRIDE = String(eod.minute);
    } else {
        let gcE = null, gcX = null;
        if (gapCapture) {
            gcE = parseHHMM(gcEntry, "23:20");
            gcX = parseHHMM(gcExit, "23:25");
            if (!gcE || !gcX) return res.status(400).json({ error: "Gap capture times must be HH:MM (IST)" });
            if (gcX.hour < gcE.hour || (gcX.hour === gcE.hour && gcX.minute <= gcE.minute)) {
                return res.status(400).json({ error: "Gap capture quit time must be after the gap capture time" });
            }
        }
        env.DH_MAX_LOSS_RUPEES_OVERRIDE = String(maxLossRupees || 3000);   // ATR mode: only the backstop while ATR isn't available
        env.DH_TAKE_PROFIT_RUPEES_OVERRIDE = String(takeProfitRupees || 3000);
        // Always written explicitly (PM2 restart merges env, never clears it).
        env.DH_SL_MODE = slMode;
        env.DH_ATR_SL_MULT_OVERRIDE = slMode === "ATR" && atrSlMult ? String(Number(atrSlMult)) : "";
        env.DH_ATR_TIMEFRAME_OVERRIDE = slMode === "ATR" ? atrTimeframe : "15m";
        env.DH_RANGE_SIZE_OVERRIDE = rangeSize ? String(rangeSize) : "";
        env.DH_GAP_CAPTURE = String(!!gapCapture);
        if (gapCapture) {
            env.DH_GC_HOUR_OVERRIDE = String(gcE.hour); env.DH_GC_MINUTE_OVERRIDE = String(gcE.minute);
            env.DH_GC_QUIT_HOUR_OVERRIDE  = String(gcX.hour); env.DH_GC_QUIT_MINUTE_OVERRIDE  = String(gcX.minute);
        }
    }

    try {
        await pm2Start({ ...PM2_BASE_OPTS, script: "dualHedgeEngine.js", name, cwd: ROOT, env });
        res.json({ ok: true, name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Backtest of either dual-hedge strategy (backtestDualHedge.js). Market data
// is account-agnostic: the global account, else the first configured dual user.
function ensureDualHedgeBacktestKite() {
    if (engineConfig.API_KEY && engineConfig.getAccessToken()) return ensureToolboxKite();
    const u = dualHedgeUsers.listUsers().find(x => x.apiKey && x.accessToken);
    if (!u) throw Object.assign(new Error("no Kite credentials available for market data"), { status: 400 });
    const kc = new KiteConnect({ api_key: u.apiKey });
    kc.setAccessToken(u.accessToken);
    return kc;
}

app.post("/api/toolbox/dualhedge/backtest", async (req, res) => {
    const b = req.body || {};
    try {
        const strategy = String(b.strategy || "DUAL").toUpperCase();
        if (strategy !== "DUAL" && strategy !== "BIAS") return res.status(400).json({ error: "Strategy must be DUAL or BIAS" });
        if (!b.underlying) return res.status(400).json({ error: "Underlying is required" });
        const from = new Date(b.from), to = new Date(b.to);
        if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: "From and to must be YYYY-MM-DD" });
        if (to < from) return res.status(400).json({ error: "To must not be before from" });
        const pos = (label, v) => { if (v !== undefined && v !== null && v !== "" && !(Number(v) > 0)) throw Object.assign(new Error(`${label} must be a positive number`), { status: 400 }); };
        for (const [l, v] of [["lots", b.lots], ["lotMultOverride", b.lotMultOverride], ["bandStepOverride", b.bandStepOverride], ["rangeSizeOverride", b.rangeSizeOverride], ["takeProfit", b.takeProfit], ["maxLoss", b.maxLoss], ["atrSlMult", b.atrSlMult]]) pos(l, v);
        const slip = b.slippagePoints === undefined || b.slippagePoints === "" ? 0 : Number(b.slippagePoints);
        if (!Number.isFinite(slip) || slip < 0) return res.status(400).json({ error: "SlippagePoints must be >= 0" });
        const exchange = "MCX";
        const def = getDefinition(b.underlying, exchange);
        if (def.lotMult === null && !b.lotMultOverride) return res.status(400).json({ error: `LotMultOverride is required for ${b.underlying}` });

        const opts = { strategy };
        if (strategy === "BIAS") {
            opts.unwindMode = String(b.unwindMode || "BAND_FLIP").toUpperCase();
            if (opts.unwindMode !== "BAND_FLIP" && opts.unwindMode !== "EOD_ONLY") return res.status(400).json({ error: "UnwindMode must be BAND_FLIP or EOD_ONLY" });
            opts.bandTimeframe = String(b.bandTimeframe || "15m").toLowerCase();
            if (!BIAS_BAND_TIMEFRAMES.includes(opts.bandTimeframe)) return res.status(400).json({ error: `BandTimeframe must be one of ${BIAS_BAND_TIMEFRAMES.join("/")}` });
            const entry = parseHHMM(b.entryTime, "10:00");
            if (!entry) return res.status(400).json({ error: "EntryTime must be HH:MM (IST)" });
            const dEod = defaultEodFor(opts.bandTimeframe, exchange);
            const eod = b.eodTime ? parseHHMM(b.eodTime) : { hour: dEod.eodHour, minute: dEod.eodMinute };
            if (!eod) return res.status(400).json({ error: "EodTime must be HH:MM (IST)" });
            if (eod.hour * 60 + eod.minute <= entry.hour * 60 + entry.minute) return res.status(400).json({ error: "EntryTime must be before EOD" });
            opts.entryHour = entry.hour; opts.entryMinute = entry.minute; opts.eodHour = eod.hour; opts.eodMinute = eod.minute;
            if (b.bandStepOverride) opts.bandStepOverride = Number(b.bandStepOverride);
        } else {
            opts.signalSource = String(b.signalSource || "HA").toUpperCase();
            if (opts.signalSource !== "RANGE" && opts.signalSource !== "HA") return res.status(400).json({ error: "SignalSource must be RANGE or HA" });
            if (opts.signalSource === "HA") {
                opts.haTimeframe = String(b.haTimeframe || "1h").toLowerCase();
                if (!["5m", "15m", "30m", "1h", "1d"].includes(opts.haTimeframe)) return res.status(400).json({ error: "HaTimeframe must be 5m/15m/30m/1h/1d" });
            } else {
                if (b.bandStepOverride) opts.bandStepOverride = Number(b.bandStepOverride);
                if (b.rangeSizeOverride) opts.rangeSizeOverride = Number(b.rangeSizeOverride);
            }
            opts.takeProfit = Number(b.takeProfit) || 3000;
            opts.maxLoss = Number(b.maxLoss) || 3000;
            opts.slMode = String(b.slMode || "RUPEES").toUpperCase();
            if (!DH_SL_MODES.includes(opts.slMode)) return res.status(400).json({ error: `SlMode must be one of ${DH_SL_MODES.join("/")}` });
            if (opts.slMode === "ATR") {
                opts.atrSlMult = b.atrSlMult ? Number(b.atrSlMult) : null;   // null -> engineConfig.ATR_SL_MULT
                opts.atrTimeframe = String(b.atrTimeframe || "15m").toLowerCase();
                if (!DH_ATR_TIMEFRAMES.includes(opts.atrTimeframe)) return res.status(400).json({ error: `AtrTimeframe must be one of ${DH_ATR_TIMEFRAMES.join("/")}` });
            }
            if (b.gapCapture) {
                const g = parseHHMM(b.gcEntry, "23:20"), q = parseHHMM(b.gcExit, "23:25");
                if (!g || !q) return res.status(400).json({ error: "Gap capture times must be HH:MM (IST)" });
                if (q.hour * 60 + q.minute <= g.hour * 60 + g.minute) return res.status(400).json({ error: "Gap capture quit time must be after the gap capture time" });
                opts.gapCapture = true; opts.gcHour = g.hour; opts.gcMinute = g.minute; opts.gcQuitHour = q.hour; opts.gcQuitMinute = q.minute;
            }
        }

        const kc = ensureDualHedgeBacktestKite();
        setEmitSuppressed(true);
        let out, lines;
        try {
            ({ result: out, lines } = await withCapturedConsole(() => runDualHedgeBacktest({
                underlying: b.underlying, exchange, lots: Number(b.lots) || 1,
                lotMultOverride: b.lotMultOverride ? Number(b.lotMultOverride) : null,
                slippagePoints: slip, from, to, kc, ...opts,
            })));
        } finally {
            setEmitSuppressed(false);
        }
        const { report, paths } = out;
        res.json({
            ok: true, strategy, params: report.params,
            summary: report.metrics, mtm: report.mtm, stats: report.stats,
            reportUrl: `/api/toolbox/backtest/reports/${path.basename(paths.htmlPath)}`,
            jsonUrl: `/api/toolbox/backtest/reports/${path.basename(paths.jsonPath)}`,
            logLines: lines.slice(-5000),
        });
    } catch (err) {
        // Kite exceptions carry status:"error" (a string) — only trust a real HTTP code.
        const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
        res.status(code).json({ error: err.message });
    }
});

app.post("/api/toolbox/dualhedge/start", async (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });
    try {
        await pm2Start({ ...PM2_BASE_OPTS, script: "dualHedgeEngine.js", name, cwd: ROOT });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/toolbox/dualhedge/stop", async (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });
    try {
        await pm2Stop(name);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/toolbox/dualhedge/:name", async (req, res) => {
    try {
        await pm2Delete(req.params.name);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/toolbox/dualhedge/logs/:name", async (req, res) => {
    try {
        const deployments = await getDualHedgeProcesses();
        const p = deployments.find(x => x.name === req.params.name);
        if (!p) return res.status(404).json({ error: "Process not found" });
        const out = tailFile(p.outLogPath, N_LOG_LINES);
        const err = tailFile(p.errLogPath, N_LOG_LINES);
        res.json({ outLogPath: p.outLogPath || null, errLogPath: p.errLogPath || null, out, err });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── ROLL CONTRACT — MCX futures only. NSE equities don't expire (see
// context.js's context.noRoll), so they're excluded from the candidate
// list up front rather than surfaced and then rejected. Same underlying-
// scoped pin (contractPins.json) toolbox.js's rollContract() writes, and
// the same sibling-process warning: the pin applies to every process
// running that underlying, not just the one picked, so a partial restart
// leaves processes split across two different contracts.
//
// CHANGED Sep 2026 (reported directly: "there is no contract roll for
// hedge pairs", then "in webdash too") — candidates/preview are keyed by
// UNDERLYING now, not a single process name, because a hedge pair leg
// (hedgePairEngine.js, a different PM2 script entirely from engine.js) has
// no equivalent standalone "process for this underlying" the way a plain
// instrument does; underlying is the one identity both share, and it's
// what pinStore itself is keyed on anyway. apply was already underlying-
// scoped from the start, so only candidates/preview needed the change —
// see toolbox.js's rollContract() for the CLI side of this same fix.
app.get("/api/toolbox/roll/candidates", async (req, res) => {
    try {
        const procs = (await getEngineProcesses()).filter(p => p.exchange !== "NSE");
        const hedgePairs = await getHedgePairProcesses();
        const dualHedges = await getDualHedgeProcesses();
    
        const byUnderlying = new Map(); // underlying -> { underlying, exchange, labels: [] }
        const addRef = (underlying, exchange, label) => {
            if (!byUnderlying.has(underlying)) byUnderlying.set(underlying, { underlying, exchange, labels: [] });
            byUnderlying.get(underlying).labels.push(label);
        };
        procs.forEach(p => addRef(p.underlying, p.exchange, (STRATEGY_INFO[p.strategy] || { label: p.strategy }).label));
        hedgePairs.forEach(p => {
            addRef(p.coreUnderlying,  p.exchange, `${p.name} (core leg)`);
            addRef(p.hedgeUnderlying, p.exchange, `${p.name} (hedge leg)`);
        });
        dualHedges.forEach(p => addRef(p.underlying, p.exchange, `${p.name} (dual hedge)`));

        res.json(Array.from(byUnderlying.values()));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/toolbox/roll/preview/:underlying", async (req, res) => {
    try {
        const underlying = req.params.underlying;
        const procs = await getEngineProcesses();
        const hedgePairs = await getHedgePairProcesses();
        const dualHedges = await getDualHedgeProcesses();
            const siblings = procs.filter(sib => sib.underlying === underlying);
        const affectedPairs = hedgePairs.filter(hp => hp.coreUnderlying === underlying || hp.hedgeUnderlying === underlying);
        const affectedDuals = dualHedges.filter(dh => dh.underlying === underlying);
        if (siblings.length === 0 && affectedPairs.length === 0 && affectedDuals.length === 0) return res.status(404).json({ error: `No running processes for ${underlying}` });

        const exchange = siblings[0]?.exchange || affectedPairs[0]?.exchange || affectedDuals[0]?.exchange;
        const def = getDefinition(underlying, exchange);
        if (def.noRoll) {
            return res.status(400).json({
                error: `${underlying} is an NSE equity, not a futures contract — it doesn't expire, so there's nothing to roll.`,
                noRoll: true,
            });
        }

        const repo = await ensureCsvLoaded();
        let current;
        try {
            current = resolveCurrent(underlying, def, repo, pinStore).contract;
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        const allFutures = repo.findFuturesFor(underlying);
        const currentIdx = allFutures.findIndex(f => f.token === current.token);
        const next = currentIdx >= 0 ? allFutures[currentIdx + 1] : null;

        res.json({
            underlying,
            current: { symbol: current.symbol, token: current.token, lotSize: current.lotSize, tickSize: current.tickSize },
            next: next ? { symbol: next.symbol, token: next.token, lotSize: next.lotSize } : null,
            manualEntryNeeded: !next,
            siblings: [
                ...siblings.map(s => ({ name: s.name, strategy: s.strategy })),
                ...affectedPairs.map(hp => ({ name: hp.name, strategy: `hedge pair (${hp.coreUnderlying === underlying ? "core" : "hedge"} leg)` })),
                ...affectedDuals.map(dh => ({ name: dh.name, strategy: "dual hedge" })),
            ],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/toolbox/roll/apply", async (req, res) => {
    const { underlying, manualEntry, restart } = req.body || {};
    if (!underlying) return res.status(400).json({ error: "Underlying is required" });

    try {
        const procs = await getEngineProcesses();
        const hedgePairs = await getHedgePairProcesses();
        const dualHedges = await getDualHedgeProcesses();
            const siblings = procs.filter(sib => sib.underlying === underlying);
        const affectedPairs = hedgePairs.filter(hp => hp.coreUnderlying === underlying || hp.hedgeUnderlying === underlying);
        const affectedDuals = dualHedges.filter(dh => dh.underlying === underlying);
        if (siblings.length === 0 && affectedPairs.length === 0 && affectedDuals.length === 0) return res.status(404).json({ error: `No running processes for ${underlying}` });

        const exchange = siblings[0]?.exchange || affectedPairs[0]?.exchange || affectedDuals[0]?.exchange;
        const def = getDefinition(underlying, exchange);
        if (def.noRoll) return res.status(400).json({ error: `${underlying} is an NSE equity — nothing to roll` });

        const repo = await ensureCsvLoaded();
        const current = resolveCurrent(underlying, def, repo, pinStore).contract;

        let next, isManual = false;
        if (manualEntry && manualEntry.symbol) {
            const token = Number(manualEntry.token);
            const lotSize = manualEntry.lotSize ? Number(manualEntry.lotSize) : current.lotSize;
            if (!Number.isFinite(token) || token <= 0) return res.status(400).json({ error: "Invalid manual token" });
            if (!Number.isFinite(lotSize) || lotSize <= 0) return res.status(400).json({ error: "Invalid manual lot size" });
            next = { symbol: manualEntry.symbol, token, lotSize, tickSize: current.tickSize };
            isManual = true;
        } else {
            const allFutures = repo.findFuturesFor(underlying);
            const currentIdx = allFutures.findIndex(f => f.token === current.token);
            next = currentIdx >= 0 ? allFutures[currentIdx + 1] : null;
            if (!next) return res.status(400).json({ error: "Next contract not found in the instrument dump — resubmit with manualEntry" });
        }

        const pin = isManual
            ? { symbol: next.symbol, token: next.token, lotSize: next.lotSize, tickSize: next.tickSize, manual: true }
            : { symbol: next.symbol };
        pinStore.setPin(underlying, pin);

        const result = { ok: true, oldSymbol: current.symbol, newSymbol: next.symbol, manual: isManual, restarted: [], restartFailed: [] };

        if (restart) {
            for (const target of siblings) {
                try {
                    await pm2RestartWithConfig({ ...PM2_BASE_OPTS, script: "engine.js", name: target.name, cwd: ROOT, updateEnv: true, env: buildProcessEnv(target) });
                    result.restarted.push(target.name);
                } catch (err) {
                    result.restartFailed.push({ name: target.name, error: err.message });
                }
            }
            for (const hp of affectedPairs) {
                try {
                    // No env rebuild here — pin lives in pinStore's own
                    // file, not a PM2 env var, so a plain restart is enough
                    // (see toolbox.js's rollContract() for the same call).
                    await pm2RestartWithConfig({ ...PM2_BASE_OPTS, script: "hedgePairEngine.js", name: hp.name, cwd: ROOT });
                    result.restarted.push(hp.name);
                } catch (err) {
                    result.restartFailed.push({ name: hp.name, error: err.message });
                }
            }
            for (const dh of affectedDuals) {
                try {
                    // Same reasoning as the hedge-pair restart above.
                    await pm2RestartWithConfig({ ...PM2_BASE_OPTS, script: "dualHedgeEngine.js", name: dh.name, cwd: ROOT });
                    result.restarted.push(dh.name);
                } catch (err) {
                    result.restartFailed.push({ name: dh.name, error: err.message });
                }
            }
        } else {
            const stillOn = [...siblings.map(s => s.name), ...affectedPairs.map(hp => hp.name), ...affectedDuals.map(dh => dh.name)];
            result.note = `pin saved but NOT applied yet — ${stillOn.join(", ")} still on ${current.symbol} until restarted`;
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── KITE ACCESS TOKEN ──────────────────────────────────────────────────────
// Same exchange this project's toolbox.js already does by hand every
// morning (kc.generateSession + upsertEnvVar("ACCESS_TOKEN", ...) into
// .env) — this just adds a browser-driven way to trigger it, either via the
// auto-capture callback (if you've pointed your Kite app's Redirect URL at
// GET /api/token/callback on this server) or via manual paste, same as the
// CLI's "paste the request_token" prompt. Neither path touches any engine
// process directly — same "restart to pick it up" caveat toolbox.js already
// has applies here too. (No more "API_KEY not set" warning here — superseded
// by ensureApiCredentials() prompting for it at boot, see above.)

app.get("/api/token/status", (req, res) => {
    try {
        const token = engineConfig.getAccessToken();
        // No per-key mtime once ACCESS_TOKEN lives inside .env alongside
        // everything else (unlike the old dedicated access_code.txt, whose
        // mtime WAS exactly "when the token last changed") — the whole
        // .env file's mtime is the closest available proxy. Slightly
        // over-reports (any unrelated .env edit bumps it too), but this
        // field is a rough "does this look stale" signal for a human
        // glancing at the dashboard, not something anything else depends
        // on for correctness. `fresh`/`tokenDate` below are the actual
        // signal now (see engineConfig.js's isAccessTokenFresh()) —
        // `updatedAt` is kept only for anyone already reading it.
        const stat = fs.existsSync(ENV_FILE_PATH) ? fs.statSync(ENV_FILE_PATH) : null;
        // Dual-hedge/gap-capture users share ONE registry (dualHedgeUsers.js
        // — see gapCaptureEngine.js's header for why it reuses it), so one
        // list here covers both engines' accounts. Bundled into this same
        // response (rather than a second round trip to
        // /api/toolbox/dualhedge/users) so the unified token panel in the
        // header — see app.js's refreshTokenStatus() — can render every
        // account's status, and the badge can reflect the worst of ALL of
        // them, from a single fetch.
        const users = dualHedgeUsers.listUsers().map(redactUser);
        const staleCount   = (token.length > 0 && !engineConfig.isAccessTokenFresh() ? 1 : 0)
                            + users.filter(u => u.hasAccessToken && !u.tokenFresh).length;
        const missingCount = (token.length > 0 ? 0 : 1) + users.filter(u => !u.hasAccessToken).length;
        res.json({
            set: token.length > 0,
            fresh: engineConfig.isAccessTokenFresh(),
            tokenDate: engineConfig.getAccessTokenDate() || null,
            updatedAt: stat ? stat.mtime : null,
            apiKeyConfigured: !!engineConfig.API_KEY,
            apiSecretConfigured: !!engineConfig.API_SECRET,
            users,
            staleCount,
            missingCount,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/token/login-url", (req, res) => {
    if (!engineConfig.API_KEY) return res.status(400).json({ error: "Kite API key not configured yet — set it from Settings" });
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    res.json({ url: withAccountParam(kc.getLoginURL(), "global") });
});

app.post("/api/token/exchange", async (req, res) => {
    const input = (req.body && req.body.input) || "";
    const requestToken = extractRequestToken(input);
    if (!requestToken) return res.status(400).json({ error: "No token found in that input" });
    try {
        const session = await exchangeToken(requestToken);
        res.json({ ok: true, userId: session.user_id || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET, not POST — this is what Kite itself redirects the browser to after
// login, so it has to be a plain link Kite can navigate to, carrying
// request_token as a query param. Only works if that URL is registered as
// this Kite app's Redirect URL in the Kite Developer Console — see
// webdash/README.md for exact setup steps.
app.get("/api/token/callback", async (req, res) => {
    const requestToken = req.query.request_token;
    const account = String(req.query.account || "global");
    if (!requestToken) {
        return res.redirect("/?token=error&msg=" + encodeURIComponent("no request_token in callback"));
    }
    try {
        if (account === "global") await exchangeToken(requestToken);
        else                      await exchangeUserToken(account, requestToken);
        res.redirect("/?token=ok&account=" + encodeURIComponent(account));
    } catch (err) {
        res.redirect("/?token=error&account=" + encodeURIComponent(account) + "&msg=" + encodeURIComponent(err.message));
    }
});

// ─── HTTP + WEBSOCKET SERVERS ──────────────────────────────────────────────
const server = http.createServer(app);
const engineWss = new WebSocketServer({ noServer: true });
const dashWss   = new WebSocketServer({ noServer: true });

// Engines must present ENGINE_WS_TOKEN (auto-generated into .env on first
// boot; eventBridge.js reads it fresh from .env on every connect) — without
// it anyone reaching the port could inject fake TICK/ENTRY/EXIT events.
function ensureEngineToken() {
    let t = readEnvVarFresh("ENGINE_WS_TOKEN");
    if (!t) { t = crypto.randomBytes(24).toString("hex"); upsertEnvVar("ENGINE_WS_TOKEN", t); }
    process.env.ENGINE_WS_TOKEN = t;
    return t;
}
const ENGINE_WS_TOKEN = ensureEngineToken();
function engineTokenOk(req) {
    const got = String(req.headers["x-engine-token"] || "");
    return got.length === ENGINE_WS_TOKEN.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(ENGINE_WS_TOKEN));
}

server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith("/engine")) {
        if (!engineTokenOk(req)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
        engineWss.handleUpgrade(req, socket, head, ws => engineWss.emit("connection", ws, req));
    } else if (req.url.startsWith("/ws")) {
        if (!originOk(req)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
        if (WEBDASH_PIN) {
            const cookies = parseCookies(req.headers.cookie);
            if (!isValidSession(cookies[SESSION_COOKIE])) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }
        }
        dashWss.handleUpgrade(req, socket, head, ws => dashWss.emit("connection", ws, req));
    } else {
        socket.destroy();
    }
});

// ─── EVENT RING BUFFER ──────────────────────────────────────────────────────
// In-memory only — cleared on server restart, but survives a browser page
// refresh (which is what actually prompted this: the log lives entirely in
// the page's JS memory, so reloading the page used to wipe it even though
// nothing on the server/engine side was ever lost). Not a durable history
// store — that's a separate, bigger change if it's ever wanted.
const RING_SIZE = 300;
const ringBuffer = [];

function pushToRing(raw) {
    ringBuffer.push(raw);
    if (ringBuffer.length > RING_SIZE) ringBuffer.shift();
}

function broadcastToBrowsers(raw) {
    dashWss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(raw);
    });
}

engineWss.on("connection", ws => {
    ws.on("message", raw => {
        const str = raw.toString();
        // High-rate LTP stream is live-only (chart): never replayed from the ring buffer.
        if (!str.includes('"type":"LTP"')) pushToRing(str);
        if (str.includes('"type":"BLOCK"')) { try { recordBlock(JSON.parse(str)); } catch { /* ignore */ } }
        broadcastToBrowsers(str);
    });
});

dashWss.on("connection", ws => {
    // Browser -> server: subscribe / unsubscribe the order-book stream for the open chart.
    ws.on("message", async raw => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "DEPTH_SUB" && msg.name) {
            try { depthHub.subscribe(ws, await resolveDepthTarget(String(msg.name))); }
            catch (err) { try { ws.send(JSON.stringify({ type: "DEPTH_ERR", name: msg.name, error: err.message })); } catch { /* gone */ } }
        } else if (msg.type === "DEPTH_UNSUB") {
            depthHub.dropSocket(ws);
        }
    });
    ws.on("close", () => depthHub.dropSocket(ws));
    ws.send(JSON.stringify({ type: "HELLO", ts: Date.now(), replaying: ringBuffer.length }));
    for (const raw of ringBuffer) {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
});

(async () => {
    // One shared readline interface for both boot-time prompts below,
    // closed right after — nothing later in this file needs stdin (every
    // other "ask a human something" path here goes through the browser).
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await ensureApiCredentials(rl);
    await ensureWebdashPin(rl);
    rl.close();
    try {
        await pm2Connect();
    } catch (err) {
        console.error("webdash: failed to connect to PM2 —", err.message);
        console.error("webdash: starting anyway (instrument list / controls will be unavailable until PM2 is reachable)");
    }
    // CHANGED (security audit): loopback only by default (use an SSH tunnel).
    // Set WEBDASH_HOST=0.0.0.0 in .env to expose it on all interfaces.
    const HOST = process.env.WEBDASH_HOST || "127.0.0.1";
    server.listen(PORT, HOST, () => {
        console.log(`webdash server listening on ${HOST}:${PORT}`);
        if (WEBDASH_PIN && HOST !== "127.0.0.1" && HOST !== "::1") console.warn("webdash: serving plain HTTP on a public interface — put HTTPS in front or set WEBDASH_HOST=127.0.0.1 and use an SSH tunnel.");
    });
})();
