// dashboard.js — NatGas Engine Observability Server
// Runs inside the same Node process as the engine.
// Called once from index.js: startDashboard()
// No separate PM2 process needed.
"use strict";

const http       = require("http");
const path       = require("path");
const express    = require("express");
const { Server } = require("socket.io");

const config             = require("./config");
const { SLOW, FAST }     = require("./state");
const { getSlowSL, getFastSL } = require("./sl");
const { getRawCandles }        = require("./candleBuilder");
const { toHA, alma, supertrend } = require("./indicators");

const PORT    = process.env.DASH_PORT || 3001;

// ─── INTERNAL STATE ───────────────────────────────────────────────────────────
let io        = null;
let _wsConn   = false;
let _price    = null;
let _regime   = 0;
let _stDir    = 0;
let _almaVal  = null;
let _rsiVal   = null;
let _trail    = null;
let _bootTime = Date.now();
let _logRing  = [];   // circular buffer, last 200 lines

// ─── PUBLIC SETTERS — called by signals.js each candle ───────────────────────
function setDashWS(v)     { _wsConn  = v; _broadcast(); }
function setDashRegime(v) { _regime  = v; }
function setDashSTDir(v)  { _stDir   = v; }
function setDashAlma(v)   { _almaVal = v; }
function setDashRSI(v)    { _rsiVal  = v; }
function setDashTrail(v)  { _trail   = v; }

// ─── LOG CAPTURE ──────────────────────────────────────────────────────────────
// Intercept console.log globally so all engine output (signals, positions, etc.)
// appears in the dashboard live log panel AND in PM2 stdout simultaneously.
// Must be installed before any engine modules are required.
const _origLog = console.log.bind(console);
function emitLog(msg) {
    const line = {
        ts:  new Date().toLocaleTimeString("en-IN", { hour12: false }),
        msg: String(msg).trim(),
    };
    if (!line.msg) return;                          // skip blank spacer lines
    _logRing.push(line);
    if (_logRing.length > 200) _logRing.shift();
    if (io) io.emit("log", line);
    _origLog(line.ts + "  " + line.msg);
}
// Patch console.log — blank lines still go to stdout only (visual spacing in PM2)
console.log = (...args) => {
    const msg = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    if (!msg.trim()) { _origLog(); return; }        // blank spacer → stdout only
    emitLog(msg);
};

// ─── TICK BROADCAST — called from index.js ticker.on("ticks") ─────────────────
function emitTick(price) {
    _price = price;
    if (!io) return;

    // Build live candle for chart — updating the forming bar on every tick
    let liveCandle = null;
    try {
        const raw = getRawCandles();
        if (raw && raw.length >= 2) {
            const ha     = toHA(raw);
            const last   = ha[ha.length - 1];
            const haOpen = (last.open + last.close) / 2;
            liveCandle = {
                time:  Math.floor(new Date(last.date).getTime() / 1000),
                open:  haOpen,
                high:  Math.max(haOpen, price, last.high),
                low:   Math.min(haOpen, price, last.low),
                close: price,
            };
        }
    } catch (_) {}

    io.emit("tick", {
        price,
        slowUPnL:   _uPnL(SLOW, price, config.SLOW_LOT_MULT, config.SLOW_LOTS),
        fastUPnL:   _uPnL(FAST, price, config.FAST_LOT_MULT, config.FAST_LOTS),
        session:    _session(price),
        liveCandle,
        ts:         Date.now(),
    });
}

// ─── BROADCAST full state — called after every candle ────────────────────────
function broadcast() {
    if (io) io.emit("state", _snapshot());
}

// ─── CHART DATA — computed fresh from candle buffer ───────────────────────────
function _chartData() {
    const raw = getRawCandles();
    if (!raw || raw.length < config.ALMA_LEN + 1) return null;

    const ha      = toHA(raw);
    const closes  = ha.map(c => c.close);
    const stArr   = supertrend(ha, config.ST_ATR_LEN, config.ST_FACTOR) || [];

    const almaPoints = [];
    for (let i = config.ALMA_LEN - 1; i < ha.length; i++) {
        const slice = closes.slice(0, i + 1);
        const v     = alma(slice, config.ALMA_LEN, config.ALMA_OFFSET, config.ALMA_SIGMA);
        if (v) almaPoints.push({ date: ha[i].date, value: v });
    }

    const stPoints = stArr
        .map((s, i) => s ? { date: ha[i].date, dir: s.dir, trend: s.trend } : null)
        .filter(Boolean);

    return { ha, alma: almaPoints, st: stPoints };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function _uPnL(leg, price, mult, lots) {
    if (!leg.position || !price) return 0;
    return (price - leg.entryPrice) * (leg.position === "LONG" ? 1 : -1) * mult * lots;
}

function _session(price) {
    return (SLOW.pnl || 0) + (FAST.pnl || 0)
        + _uPnL(SLOW, price, config.SLOW_LOT_MULT, config.SLOW_LOTS)
        + _uPnL(FAST, price, config.FAST_LOT_MULT, config.FAST_LOTS);
}

function _alignment() {
    if (_regime === 1  && _stDir === 1)  return "LONG  ▲▲ ALIGNED";
    if (_regime === -1 && _stDir === -1) return "SHORT ▼▼ ALIGNED";
    if (_regime === 1  && _stDir === -1) return "DIVERGE  ALMA↑ ST↓";
    if (_regime === -1 && _stDir === 1)  return "DIVERGE  ALMA↓ ST↑";
    return "NEUTRAL";
}

function _snapshot() {
    const price    = _price;
    const slowUPnL = _uPnL(SLOW, price, config.SLOW_LOT_MULT, config.SLOW_LOTS);
    const fastUPnL = _uPnL(FAST, price, config.FAST_LOT_MULT, config.FAST_LOTS);
    const { trail: slTrail } = getFastSL();

    return {
        ts:        Date.now(),
        uptime:    Math.floor((Date.now() - _bootTime) / 1000),
        wsConnected: _wsConn,
        price,
        bufLen:    getRawCandles().length,
        almaVal:   _almaVal,
        rsiVal:    _rsiVal,
        stDir:     _stDir,
        trail:     _trail ?? slTrail,
        regime:    _regime,
        alignment: _alignment(),
        flags: {
            adx: config.USE_ADX_FILTER,
            rsi: config.USE_RSI_FILTER,
        },
        slow: {
            enabled:    config.SLOW_ENABLED,
            position:   SLOW.position,
            entryPrice: SLOW.entryPrice,
            uPnL:       slowUPnL,
            realPnL:    SLOW.pnl,
            trades:     SLOW.trades,
            sl:         getSlowSL(),
        },
        fast: {
            enabled:    config.FAST_ENABLED,
            position:   FAST.position,
            entryPrice: FAST.entryPrice,
            uPnL:       fastUPnL,
            realPnL:    FAST.pnl,
            trades:     FAST.trades,
            sl:         slTrail,
        },
        session: _session(price),
        logs:    _logRing.slice(-80),
    };
}

function _broadcast() {
    if (io) io.emit("state", _snapshot());
}

// ─── START — called once from index.js ───────────────────────────────────────
function startDashboard() {
    const app    = express();
    const server = http.createServer(app);
    io           = new Server(server, { cors: { origin: "*" } });

    // Serve dashboard HTML from same directory as this file
    app.get("/", (_req, res) =>
        res.sendFile(path.join(__dirname, "dashboard.html"))
    );

    // State snapshot (polling fallback)
    app.get("/api/state", (_req, res) => res.json(_snapshot()));

    // Chart data — computed on demand, not pushed every tick
    app.get("/api/chart", (_req, res) => {
        const data = _chartData();
        if (!data) return res.status(503).json({ error: "warmup" });
        res.json(data);
    });

    io.on("connection", socket => {
        socket.emit("state", _snapshot());
        socket.emit("logs",  _logRing.slice(-80));
    });

    server.listen(PORT, () =>
        console.log(`dashboard  http://localhost:${PORT}`)
    );

    // Keep browser in sync even when market is quiet
    setInterval(_broadcast, 5000);
}

module.exports = {
    startDashboard,
    emitLog,
    emitTick,
    broadcast,
    setDashWS,
    setDashRegime,
    setDashSTDir,
    setDashAlma,
    setDashRSI,
    setDashTrail,
};
