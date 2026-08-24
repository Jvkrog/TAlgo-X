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

const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const pm2 = require("pm2");
const sqlite3 = require("sqlite3").verbose();
const { KiteConnect } = require("kiteconnect");
const engineConfig = require("../engineConfig");

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
const { TIMEFRAME_TO_INTERVAL, fetchDailyCandles } = require("../historicalFetch");
const { runBacktest } = require("../backtestRun");
const { STRATEGY_PARAMS } = require("../backtestFlow");
const { setEmitSuppressed } = require("../eventBridge");
const { getShortName } = require("../shortNames");
const { adx } = require("../indicators");
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

// Deliberately NOT memoized — engineConfig.ACCESS_TOKEN_FILE gets rewritten
// daily by the accesscode generator, and this server process stays up for
// days at a time (unlike a one-shot toolbox.js CLI invocation). Caching the
// client here meant every toolbox request after the day's first one kept
// using whichever token was on disk at server boot, failing with "Incorrect
// api_key or access_token" even once the on-disk file was current again —
// same construct-fresh-each-time pattern the token-exchange endpoint below
// already uses, now applied here too.
function ensureToolboxKite() {
    const ACCESS_TOKEN = fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim();
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(ACCESS_TOKEN);
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
function toProcessName(underlying, strategy) {
    const stratShort = (STRATEGY_INFO[strategy] || { short: strategy }).short;
    return `${getShortName(underlying)}${stratShort}Engine`;
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
const WEBDASH_PIN = process.env.WEBDASH_PIN || null;
const SESSION_COOKIE = "webdash_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const sessions = new Map(); // token -> expiresAt

if (!WEBDASH_PIN) {
    console.warn("webdash: WEBDASH_PIN not set in .env — PIN lock is DISABLED, dashboard is open to anyone who reaches this port");
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
let failCount = 0;
let lockedUntil = 0;

function authRequired(req, res, next) {
    if (!WEBDASH_PIN) return next(); // auth disabled
    const cookies = parseCookies(req.headers.cookie);
    if (isValidSession(cookies[SESSION_COOKIE])) return next();
    res.status(401).json({ error: "unauthorized" });
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

async function exchangeToken(requestToken) {
    if (!engineConfig.API_SECRET) {
        throw new Error("API_SECRET not set in .env — required to exchange request_token for access_token");
    }
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    const session = await kc.generateSession(requestToken, engineConfig.API_SECRET);
    fs.writeFileSync(engineConfig.ACCESS_TOKEN_FILE, session.access_token);
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
            // null = use engineConfig.BAND_STEP_DEFAULT, same as
            // context.bandStep's own default-when-unset behavior
            bandStep: p.pm2_env.env?.BAND_STEP_OVERRIDE !== undefined && p.pm2_env.env?.BAND_STEP_OVERRIDE !== ""
                ? p.pm2_env.env.BAND_STEP_OVERRIDE
                : null,
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
            outLogPath: p.pm2_env.pm_out_log_path,
            errLogPath: p.pm2_env.pm_err_log_path,
        }));
}

// Same env-shape toolbox.js's toggleMode/restartSelected build before every
// pm2Restart — kept in exact parity so a mode switch from the web produces
// the identical process env an equivalent CLI action would.
function buildProcessEnv(p, overrides = {}) {
    const env = {
        UNDERLYING: p.underlying,
        LIVE_ORDERS_OVERRIDE: String(!!p.live),
        CARRY_OVERNIGHT_OVERRIDE: String(!!p.carryOvernight),
        STRATEGY_OVERRIDE: p.strategy || "DPI_TREND_MEANREV",
        TIMEFRAME_OVERRIDE: p.timeframe || "15m",
        EXCHANGE_OVERRIDE: p.exchange || "MCX",
    };
    if (p.lots !== "default") env.LOTS_OVERRIDE = String(p.lots);
    if (p.lotMult) env.LOTMULT_OVERRIDE = String(p.lotMult);
    if (p.targetPoints !== null && p.targetPoints !== undefined) env.TARGET_POINTS_OVERRIDE = String(p.targetPoints);
    if (p.bandStep !== null && p.bandStep !== undefined) env.BAND_STEP_OVERRIDE = String(p.bandStep);
    if (p.greyExitEnabled !== undefined) env.GREY_EXIT_OVERRIDE = String(!!p.greyExitEnabled);
    if (p.strategy === "ALMA_PRO_FAST" && p.almaBandEnabled === false) env.ALMA_BAND_OVERRIDE = "false";
    return { ...env, ...overrides };
}

const N_LOG_LINES = 30;
function tailFile(filePath, n) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    try {
        const text = fs.readFileSync(filePath, "utf8");
        return text.split(/\r?\n/).filter(l => l.length > 0).slice(-n);
    } catch {
        return [];
    }
}

// ─── SQLITE — read-only per-engine state, same filename convention as db.js
function dbPathFor(underlying, strategy) {
    const name = `${underlying.toLowerCase().replace(/\s+/g, "")}_${strategy.toLowerCase().replace(/\s+/g, "")}.db`;
    return path.join(ROOT, name);
}

function readEngineState(underlying, strategy) {
    return new Promise(resolve => {
        const dbPath = dbPathFor(underlying, strategy);
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
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── auth routes — must be registered BEFORE the blanket authRequired below
app.get("/api/auth/status", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
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

    if (Date.now() < lockedUntil) {
        return res.status(429).json({ error: "too many attempts", lockedForMs: lockedUntil - Date.now() });
    }

    const { pin } = req.body || {};
    // Constant-time-ish compare — this is a single-operator convenience
    // lock, not a cryptographic boundary, but no reason to make it a
    // trivial string-equality timing leak either.
    const match = typeof pin === "string" && pin.length === WEBDASH_PIN.length &&
        crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(WEBDASH_PIN));

    if (!match) {
        failCount++;
        if (failCount >= 5) {
            lockedUntil = Date.now() + 30000;
            failCount = 0;
            return res.status(429).json({ error: "too many attempts", lockedForMs: 30000 });
        }
        return res.status(401).json({ error: "incorrect pin", attemptsLeft: 5 - failCount });
    }

    failCount = 0;
    const token = createSession();
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
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
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    res.json({ ok: true });
});

// everything else under /api requires a valid session (no-op if no PIN set)
app.use("/api", authRequired);

app.get("/api/instruments", async (req, res) => {
    try { res.json(await getEngineProcesses()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/state/:underlying/:strategy", async (req, res) => {
    try { res.json(await readEngineState(req.params.underlying, req.params.strategy)); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/control", async (req, res) => {
    const { name, action } = req.body || {};
    if (!name || !["start", "stop", "restart"].includes(action)) {
        return res.status(400).json({ error: "name and a valid action (start|stop|restart) are required" });
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
        return res.status(400).json({ error: "names (array) is required" });
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
        if (!p) return res.status(404).json({ error: "process not found" });
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
        return res.status(400).json({ error: "name and live (boolean) are required" });
    }
    if (live && confirmLive !== "LIVE") {
        return res.status(400).json({ error: 'switching to LIVE requires confirmLive: "LIVE" (typed, not assumed)' });
    }
    try {
        const procs = await getEngineProcesses();
        const p = procs.find(x => x.name === name);
        if (!p) return res.status(404).json({ error: "process not found" });

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

// ─── ADD INSTRUMENT — same discovery + resolve + start path as
// toolbox.js's addInstrument/configureAndStartInstrument. ──────────────────
app.get("/api/toolbox/strategies", (req, res) => {
    res.json({
        default: DEFAULT_STRATEGY,
        strategies: Object.keys(STRATEGIES).map(key => ({
            key,
            label: (STRATEGY_INFO[key] || {}).label || key,
            description: (STRATEGY_INFO[key] || {}).description || "",
            timeframe: STRATEGY_TIMEFRAME[key] || "15m",
        })),
        timeframes: Object.keys(TIMEFRAME_TO_INTERVAL),
    });
});

app.get("/api/toolbox/instruments", async (req, res) => {
    const exchange = req.query.exchange === "NSE" ? "NSE" : "MCX";
    const q = (req.query.q || "").toLowerCase();
    try {
        const repo = exchange === "NSE" ? await ensureEquityCsvLoaded() : await ensureCsvLoaded();
        const all = exchange === "NSE" ? repo.listEquitySymbols() : repo.listUnderlyings();
        const matches = q ? all.filter(u => u.toLowerCase().includes(q)) : all;
        res.json({ exchange, total: all.length, matches: matches.slice(0, 50), truncated: matches.length > 50 });
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
        strategy, timeframe, targetPoints, almaBandEnabled, bandStep, greyExitEnabled,
    } = req.body || {};

    if (!underlying) return res.status(400).json({ error: "underlying is required" });
    if (live && confirmLive !== "LIVE") {
        return res.status(400).json({ error: 'switching to LIVE requires confirmLive: "LIVE" (typed, not assumed)' });
    }

    const stratKey = strategy && STRATEGIES[strategy] ? strategy : DEFAULT_STRATEGY;
    const tf = timeframe || STRATEGY_TIMEFRAME[stratKey] || "15m";
    const lotsVal = lots !== undefined && lots !== null && lots !== "" ? Number(lots) : 1;
    if (!Number.isFinite(lotsVal) || lotsVal <= 0) return res.status(400).json({ error: "invalid lots value" });

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
                    error: `lot multiplier required for ${underlying} — broker lot_size (${resolved.lotSize}) is a contract count, not the real price multiplier; provide lotMultOverride`,
                });
            }
            lotMult = parsed;
        }

        const name = toProcessName(underlying, stratKey);
        const existing = await getEngineProcesses();
        if (existing.some(p => p.name === name)) {
            return res.status(409).json({ error: `${underlying} is already running ${(STRATEGY_INFO[stratKey] || {}).label || stratKey} as ${name} — stop/remove it first, or pick a different strategy` });
        }

        const env = {
            UNDERLYING: underlying,
            EXCHANGE_OVERRIDE: exchange,
            LOTS_OVERRIDE: String(lotsVal),
            LIVE_ORDERS_OVERRIDE: String(!!live),
            CARRY_OVERNIGHT_OVERRIDE: String(!!carryOvernight),
            STRATEGY_OVERRIDE: stratKey,
            TIMEFRAME_OVERRIDE: tf,
        };
        if (lotMult !== null) env.LOTMULT_OVERRIDE = String(lotMult);
        if (targetPoints !== undefined && targetPoints !== null && targetPoints !== "") {
            const parsedTarget = Number(targetPoints);
            if (Number.isFinite(parsedTarget) && parsedTarget > 0) env.TARGET_POINTS_OVERRIDE = String(parsedTarget);
        }
        if (stratKey === "ALMA_PRO_FAST" && almaBandEnabled === false) env.ALMA_BAND_OVERRIDE = "false";
        if ((stratKey === "DYNAMIC_BAND" || stratKey === "DYNAMIC_MID_COLOR" || stratKey === "DYNAMIC_MID_COLOR_HL") && bandStep !== undefined && bandStep !== null && bandStep !== "") {
            const parsedStep = Number(bandStep);
            if (Number.isFinite(parsedStep) && parsedStep > 0) env.BAND_STEP_OVERRIDE = String(parsedStep);
        }
        if (stratKey === "ALMA_TRI_BAND" && greyExitEnabled !== undefined) env.GREY_EXIT_OVERRIDE = String(!!greyExitEnabled);

        await pm2Start({ ...PM2_BASE_OPTS, script: "engine.js", name, cwd: ROOT, env });
        res.json({ ok: true, name, strategy: stratKey, timeframe: tf, live: !!live, carryOvernight: !!carryOvernight, lotMult });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── BACKTEST — same runBacktest() call backtestFlow.js's wizard makes,
// driven by a JSON body instead of a step-by-step prompt loop. ────────────
app.get("/api/toolbox/backtest/params/:strategy", (req, res) => {
    const key = req.params.strategy;
    if (!STRATEGIES[key]) return res.status(404).json({ error: "unknown strategy" });
    const paramDefs = STRATEGY_PARAMS[key] || [];
    res.json(paramDefs.map(p => ({ key: p.key, label: p.label, default: engineConfig[p.key] })));
});

app.post("/api/toolbox/backtest", async (req, res) => {
    const {
        underlying, exchange = "MCX", strategy, timeframe,
        days, from: fromStr, to: toStr, params = {}, lotMultOverride,
    } = req.body || {};

    if (!underlying) return res.status(400).json({ error: "underlying is required" });
    if (!strategy || !STRATEGIES[strategy]) return res.status(400).json({ error: "a valid strategy is required" });
    const strategyLabel = (STRATEGY_INFO[strategy] || {}).label || strategy;

    const to = toStr ? new Date(toStr) : new Date();
    let from;
    if (fromStr) {
        from = new Date(fromStr);
    } else {
        const d = days ? Number(days) : 30;
        if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: "invalid days value" });
        from = new Date(to.getTime() - d * 24 * 60 * 60 * 1000);
    }
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return res.status(400).json({ error: "invalid date range" });

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
                return res.status(400).json({ error: `lot multiplier required for ${underlying} — provide lotMultOverride` });
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
                runBacktest({ strategyKey: strategy, strategyLabel, context, timeframe: tf, from, to, params: parsedParams, kc })
            ));
        } finally {
            setEmitSuppressed(false);
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
const CREDENTIAL_FIELDS = ["API_KEY", "API_SECRET", "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID"];

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
        if (typeof req.body?.[key] === "string" && req.body[key].length > 0) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) return res.json({ ok: true, changed: 0 });
    writeEnvFile(updates);
    // engineConfig.js reads .env once at require() time — same caveat
    // toolbox.js's setupCredentials flags: this process (and any running
    // engine) needs an actual restart to pick up new values.
    res.json({ ok: true, changed: Object.keys(updates).length, note: "takes effect on next process restart — engineConfig reads .env once at boot" });
});

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
    if (!underlying) return res.status(400).json({ error: "underlying is required" });
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
        res.status(500).json({ error: `failed to stop scanner (is it running?): ${err.message}` });
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

// ─── ROLL CONTRACT — MCX futures only. NSE equities don't expire (see
// context.js's context.noRoll), so they're excluded from the candidate
// list up front rather than surfaced and then rejected. Same underlying-
// scoped pin (contractPins.json) toolbox.js's rollContract() writes, and
// the same sibling-process warning: the pin applies to every process
// running that underlying, not just the one picked, so a partial restart
// leaves processes split across two different contracts.
app.get("/api/toolbox/roll/candidates", async (req, res) => {
    try {
        const procs = await getEngineProcesses();
        const candidates = procs.filter(p => p.exchange !== "NSE");
        res.json(candidates.map(p => ({
            name: p.name,
            underlying: p.underlying,
            strategy: p.strategy,
            strategyLabel: (STRATEGY_INFO[p.strategy] || { label: p.strategy }).label,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/toolbox/roll/preview/:name", async (req, res) => {
    try {
        const procs = await getEngineProcesses();
        const p = procs.find(pr => pr.name === req.params.name);
        if (!p) return res.status(404).json({ error: "process not found" });

        const def = getDefinition(p.underlying, p.exchange);
        if (def.noRoll) {
            return res.status(400).json({
                error: `${p.underlying} is an NSE equity, not a futures contract — it doesn't expire, so there's nothing to roll.`,
                noRoll: true,
            });
        }

        const repo = await ensureCsvLoaded();
        let current;
        try {
            current = resolveCurrent(p.underlying, def, repo, pinStore).contract;
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        const allFutures = repo.findFuturesFor(p.underlying);
        const currentIdx = allFutures.findIndex(f => f.token === current.token);
        const next = currentIdx >= 0 ? allFutures[currentIdx + 1] : null;

        const siblings = procs.filter(sib => sib.underlying === p.underlying);

        res.json({
            underlying: p.underlying,
            current: { symbol: current.symbol, token: current.token, lotSize: current.lotSize, tickSize: current.tickSize },
            next: next ? { symbol: next.symbol, token: next.token, lotSize: next.lotSize } : null,
            manualEntryNeeded: !next,
            siblings: siblings.map(s => ({ name: s.name, strategy: s.strategy })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/toolbox/roll/apply", async (req, res) => {
    const { underlying, manualEntry, restart } = req.body || {};
    if (!underlying) return res.status(400).json({ error: "underlying is required" });

    try {
        const procs = await getEngineProcesses();
        const siblings = procs.filter(sib => sib.underlying === underlying);
        if (siblings.length === 0) return res.status(404).json({ error: `no running processes for ${underlying}` });

        const exchange = siblings[0].exchange;
        const def = getDefinition(underlying, exchange);
        if (def.noRoll) return res.status(400).json({ error: `${underlying} is an NSE equity — nothing to roll` });

        const repo = await ensureCsvLoaded();
        const current = resolveCurrent(underlying, def, repo, pinStore).contract;

        let next, isManual = false;
        if (manualEntry && manualEntry.symbol) {
            const token = Number(manualEntry.token);
            const lotSize = manualEntry.lotSize ? Number(manualEntry.lotSize) : current.lotSize;
            if (!Number.isFinite(token) || token <= 0) return res.status(400).json({ error: "invalid manual token" });
            if (!Number.isFinite(lotSize) || lotSize <= 0) return res.status(400).json({ error: "invalid manual lot size" });
            next = { symbol: manualEntry.symbol, token, lotSize, tickSize: current.tickSize };
            isManual = true;
        } else {
            const allFutures = repo.findFuturesFor(underlying);
            const currentIdx = allFutures.findIndex(f => f.token === current.token);
            next = currentIdx >= 0 ? allFutures[currentIdx + 1] : null;
            if (!next) return res.status(400).json({ error: "next contract not found in the instrument dump — resubmit with manualEntry" });
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
        } else {
            result.note = `pin saved but NOT applied yet — ${siblings.map(s => s.name).join(", ")} still on ${current.symbol} until restarted`;
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── KITE ACCESS TOKEN ──────────────────────────────────────────────────────
// Same exchange this project's toolbox.js already does by hand every
// morning (kc.generateSession + write to engineConfig.ACCESS_TOKEN_FILE) —
// this just adds a browser-driven way to trigger it, either via the
// auto-capture callback (if you've pointed your Kite app's Redirect URL at
// GET /api/token/callback on this server) or via manual paste, same as the
// CLI's "paste the request_token" prompt. Neither path touches any engine
// process directly — same "restart to pick it up" caveat toolbox.js already
// has applies here too.
if (!engineConfig.API_KEY) {
    console.warn("webdash: API_KEY not set in .env — /api/token/* routes will fail until it is");
}

app.get("/api/token/status", (req, res) => {
    try {
        const exists = fs.existsSync(engineConfig.ACCESS_TOKEN_FILE);
        const stat = exists ? fs.statSync(engineConfig.ACCESS_TOKEN_FILE) : null;
        res.json({
            set: exists && fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim().length > 0,
            updatedAt: stat ? stat.mtime : null,
            apiKeyConfigured: !!engineConfig.API_KEY,
            apiSecretConfigured: !!engineConfig.API_SECRET,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/token/login-url", (req, res) => {
    if (!engineConfig.API_KEY) return res.status(400).json({ error: "API_KEY not set in .env" });
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    res.json({ url: kc.getLoginURL() });
});

app.post("/api/token/exchange", async (req, res) => {
    const input = (req.body && req.body.input) || "";
    const requestToken = extractRequestToken(input);
    if (!requestToken) return res.status(400).json({ error: "no token found in that input" });
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
    if (!requestToken) {
        return res.redirect("/?token=error&msg=" + encodeURIComponent("no request_token in callback"));
    }
    try {
        await exchangeToken(requestToken);
        res.redirect("/?token=ok");
    } catch (err) {
        res.redirect("/?token=error&msg=" + encodeURIComponent(err.message));
    }
});

// ─── HTTP + WEBSOCKET SERVERS ──────────────────────────────────────────────
const server = http.createServer(app);
const engineWss = new WebSocketServer({ noServer: true });
const dashWss   = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith("/engine")) {
        engineWss.handleUpgrade(req, socket, head, ws => engineWss.emit("connection", ws, req));
    } else if (req.url.startsWith("/ws")) {
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
        pushToRing(str);
        broadcastToBrowsers(str);
    });
});

dashWss.on("connection", ws => {
    ws.send(JSON.stringify({ type: "HELLO", ts: Date.now(), replaying: ringBuffer.length }));
    for (const raw of ringBuffer) {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
});

pm2Connect()
    .then(() => {
        server.listen(PORT, () => console.log(`webdash server listening on :${PORT}`));
    })
    .catch(err => {
        console.error("webdash: failed to connect to PM2 —", err.message);
        console.error("webdash: starting anyway (instrument list / controls will be unavailable until PM2 is reachable)");
        server.listen(PORT, () => console.log(`webdash server listening on :${PORT}`));
    });
