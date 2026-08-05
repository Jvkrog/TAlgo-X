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

const ROOT = path.join(__dirname, "..");
const PORT = process.env.WEBDASH_PORT || 4790;

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
function pm2Stop(n)   { return new Promise((res, rej) => pm2.stop(n, e => e ? rej(e) : res())); }
function pm2Restart(n){ return new Promise((res, rej) => pm2.restart(n, e => e ? rej(e) : res())); }
function pm2Delete(n) { return new Promise((res, rej) => pm2.delete(n, e => e ? rej(e) : res())); }
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
    };
    if (p.lots !== "default") env.LOTS_OVERRIDE = String(p.lots);
    if (p.lotMult) env.LOTMULT_OVERRIDE = String(p.lotMult);
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
// Scope deliberately stops short of "everything" for now: Add Instrument,
// Roll Contract, Backtest, Setup Credentials, and Trending/Market-State
// screens are NOT here. Those touch contract identity, broker CSV lookups,
// or the backtest engine directly — real financial-safety surface area
// (see the lot-multiplier warning in toolbox.js's own addInstrument, which
// exists because of a real PnL bug) that deserves its own dedicated pass
// rather than a rushed port. What IS here (delete, logs, mode toggle) is
// ported with the exact same guardrails the CLI enforces, not a
// simplified version of them.

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
