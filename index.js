"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TALGO X — INDEX (Boot)
//
// Wires all 6 modules. Starts:
//   - WebSocket (ticks → X-Exec onTick + trap exit)
//   - 1H loop  → X-Core → updates G.elite
//   - 15m loop → X-Exec → Controller → Allocator → Execution
//   - Risk monitor (every candle)
//   - Lifecycle (23:00 force close, 23:15 shutdown)
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

const { KiteConnect, KiteTicker } = require("kiteconnect");
const axios = require("axios");
const fs    = require("fs");

const { G }                         = require("./core/state");
const { runXCore }                  = require("./core/x_core");
const { runXExec, onTick }          = require("./core/x_exec");
const { runController }             = require("./core/x_controller");
const { runAllocator }              = require("./core/x_allocator");
const { evaluateRiskState, onTickRiskCheck, computeMetaMode } = require("./core/x_risk");
const { init: initExec, placeOrder, exitAll, handleProbation, checkTrapExit, handleConfirmed } = require("./core/x_execution");

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY      = process.env.API_KEY;
const ACCESS_TOKEN = fs.readFileSync("access_code.txt", "utf8").trim();
const CAPITAL      = 500000;

const SYMBOL = {
    tradingsymbol:    "ZINC26MARFUT",
    exchange:         "MCX",
    instrument_token: 124841479
};

// ── Kite ──────────────────────────────────────────────────────────────────────
const kc = new KiteConnect({ api_key: API_KEY });
kc.setAccessToken(ACCESS_TOKEN);

// ── Telegram ──────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(msg) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) { console.log("[TG]", msg); return; }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text: `[TAlgo X]\n${msg}` });
    } catch (e) { console.log("TG Error:", e.message); }
}

// ── Logger ────────────────────────────────────────────────────────────────────
const startTime = new Date();
function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}][X][${G.riskState}|${G.metaMode}] ${msg}`);
}
function logEvent(obj) {
    const event = { ...obj, ts: new Date().toISOString(), ms: Date.now() };
    fs.appendFileSync("x_events.jsonl", JSON.stringify(event) + "\n");
}

// ── Init execution engine with injected utils ─────────────────────────────────
G.equityHigh = CAPITAL;
initExec({ sendTelegram, log, logEvent, kc, symbol: SYMBOL });

// ── Loop tracking ─────────────────────────────────────────────────────────────
let last1HKey   = null;
let last15mSlot = null;
let loopRunning = false;

// ── 1H candle loop ────────────────────────────────────────────────────────────
async function run1HLoop() {
    const now    = new Date();
    const hour   = now.getHours();
    const minute = now.getMinutes();

    if (hour < 9 || hour >= 23)    return;
    if (minute !== 1)              return;

    const key = `${hour}-1H`;
    if (last1HKey === key)          return;
    last1HKey = key;

    log(`🕯 1H candle @ ${now.toLocaleTimeString()}`);

    // Fetch 14 days of 1H candles — enough for ALMA(20) + ATR + swing lookback
    const from = new Date(Date.now() - 1000 * 60 * 60 * 24 * 14);
    const candles = await kc.getHistoricalData(SYMBOL.instrument_token, "60minute", from, now);

    if (candles.length < 40) { log("⚠ Insufficient 1H candles"); return; }

    // Snapshot tick pressure from X-Exec (already done in runXExec, passed here for X-Core context)
    const aggressiveBuy  = G.exec?.aggressiveBuy  || false;
    const aggressiveSell = G.exec?.aggressiveSell || false;

    const elite = runXCore(candles, aggressiveBuy, aggressiveSell);
    if (!elite) return;

    // Update meta mode
    G.metaMode = computeMetaMode(elite);

    log(`🧠 Elite: ${elite.trend} | ${elite.personality} | ${elite.volatility} | ${elite.session} | 4H:${elite.trend4h} | Score:${elite.routerOutput.score?.toFixed(2)} | Meta:${G.metaMode}`);
    evaluateRiskState(elite);
    log(`⚙ Risk: ${G.riskState}`);
}

// ── 15m candle loop ───────────────────────────────────────────────────────────
async function run15mLoop() {
    if (loopRunning) return;
    loopRunning = true;

    try {
        const now  = new Date();
        const hour = now.getHours();
        if (hour < 9 || hour >= 23) return;

        // Fire at :01 of each 15m boundary
        if ((now.getMinutes() - 1) % 15 !== 0) return;

        const slot = Math.floor(Date.now() / 900000);
        if (slot === last15mSlot) return;
        last15mSlot = slot;

        log(`🕯 15m candle @ ${now.toLocaleTimeString()}`);

        // Fetch 220 × 15m candles
        const from = new Date(Date.now() - 1000 * 60 * 15 * 220);
        const fastCandles = await kc.getHistoricalData(SYMBOL.instrument_token, "15minute", from, now);

        if (fastCandles.length < 60) { log("⚠ Insufficient 15m candles"); return; }

        const price = G.livePrice || fastCandles.at(-1).close;

        // Compute ATR for X-Exec (15m basis)
        const { calcATR, smoothATR } = require("./indicators/indicators");
        G.previousATR = G.currentATR;
        G.currentATR  = calcATR(fastCandles);

        // ── Run engines ─────────────────────────────────────────────────────
        const exec = runXExec(fastCandles, G.currentATR);
        if (!exec) return;

        // ── Risk state evaluation ────────────────────────────────────────────
        evaluateRiskState(G.elite);

        // ── Meta mode ────────────────────────────────────────────────────────
        G.metaMode = computeMetaMode(G.elite);

        log(`⚡ Exec: bias:${exec.bias} signal:${exec.signal} conf:${exec.confidence?.toFixed(2)} cross:${exec.cross} explosive:${exec.isExplosive}`);

        // ── Controller ───────────────────────────────────────────────────────
        const ctrl = runController(G.elite, exec, G.riskState, G.metaMode);
        log(`🎯 Controller: ${ctrl.action} [${ctrl.reason}] dir:${ctrl.direction}`);

        // ── Handle open position ─────────────────────────────────────────────
        if (G.tradeState === "PROBATION") {
            await handleProbation(price, G.elite);
            return;
        }

        if (G.tradeState === "CONFIRMED") {
            await handleConfirmed(price, G.elite, exec);
            return;
        }

        // ── Entry logic (WAIT state) ─────────────────────────────────────────
        if (G.tradeState === "WAIT") {
            if (ctrl.action === "BLOCK") {
                log(`⏸ BLOCKED: ${ctrl.reason}`);
                return;
            }

            // Allocator decides lot size
            const alloc = runAllocator(G.elite, exec, ctrl, G.riskState, G.metaMode);
            log(`📦 Allocator: ${alloc.lots}L [${alloc.reason}]`);

            if (alloc.lots === 0) {
                log("⏸ Allocator: 0 lots — no entry");
                return;
            }

            // Overextension guard: don't chase price > 2.2×ATR from ALMA
            const atr = G.elite?.atr || G.currentATR;
            const refPrice = G.elite?.almaLow || price;
            if (Math.abs(price - refPrice) > atr * 2.2) {
                log(`🚫 Overextended (${(Math.abs(price - refPrice) / atr).toFixed(2)}×ATR) — skip`);
                return;
            }

            await placeOrder(ctrl.direction, alloc.lots, ctrl.action, ctrl.strategy);
        }

    } finally {
        loopRunning = false;
    }
}

// ── Main poll interval ────────────────────────────────────────────────────────
setInterval(async () => {
    try {
        await run1HLoop();
        await run15mLoop();
    } catch (err) {
        log(`ERR: ${err.message}`);
    }
}, 1000);

// ── WebSocket ─────────────────────────────────────────────────────────────────
const ticker = new KiteTicker({ api_key: API_KEY, access_token: ACCESS_TOKEN });
ticker.connect();

ticker.on("connect", () => {
    ticker.subscribe([SYMBOL.instrument_token]);
    ticker.setMode(ticker.modeFull, [SYMBOL.instrument_token]);
    log("WS Connected");
    sendTelegram(
        `🚀 TAlgo X Started\n📅 ${startTime.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short" })}\n🕐 ${startTime.toLocaleTimeString()}\nSymbol: ${SYMBOL.tradingsymbol}\nCapital: ₹${CAPITAL.toLocaleString()}`
    );
});

ticker.on("ticks", ticks => {
    if (!ticks.length) return;
    const tick = ticks.find(t => t.instrument_token === SYMBOL.instrument_token);
    if (!tick) return;

    const price = tick.last_price;
    onTick(price);                          // X-Exec pressure tracker
    onTickRiskCheck(G.elite);              // continuous HARD_HALT monitor
    checkTrapExit(price, G.elite);         // PROBATION trap exit

    // Live PnL log when in position
    if (G.position && G.currentATR > 0) {
        const dir  = G.position === "LONG" ? 1 : -1;
        const pnl  = (price - G.avgPrice) * dir * G.lots * 5000;
        log(`💰 LIVE ${G.position} ${G.lots}L avg:${G.avgPrice.toFixed(2)} → ${price.toFixed(2)} | PnL:₹${pnl.toFixed(0)} | Sess:₹${G.sessionPnL.toFixed(0)}`);
    }
});

ticker.on("error",      err  => log(`WS Error: ${err.message}`));
ticker.on("close",      ()   => log("WS Closed"));
ticker.on("reconnect",  ()   => log("WS Reconnecting..."));
ticker.on("noreconnect", ()  => log("WS Max reconnect — manual restart needed"));

// ── Lifecycle ─────────────────────────────────────────────────────────────────
setInterval(() => {
    const now = new Date();

    if (now.getHours() === 23 && now.getMinutes() === 0 && !G.lifecycleClosed) {
        G.lifecycleClosed = true;
        if (G.position) {
            log("🔔 23:00 Force close");
            exitAll(G.livePrice || G.avgPrice, "EOD");
        }
        sendTelegram("🔔 23:00 — All positions closed (EOD)");
    }

    if (now.getHours() === 23 && now.getMinutes() === 15 && !G.lifecycleShutdown) {
        G.lifecycleShutdown = true;
        log("📴 23:15 Shutdown");

        const pnls    = G.tradeLog.map(t => t.pnl);
        const best    = pnls.length ? Math.max(...pnls) : 0;
        const worst   = pnls.length ? Math.min(...pnls) : 0;
        const elapsed = Math.round((new Date() - startTime) / 60000);

        sendTelegram(
            `📊 TAlgo X Session\n📅 ${new Date().toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short" })}\n🕐 ${elapsed}m runtime\n\n` +
            `💰 PnL:   ₹${G.sessionPnL.toFixed(0)}\n` +
            `📦 Trades: ${G.tradesToday}\n` +
            `🏆 Best:  ₹${best.toFixed(0)}\n` +
            `💀 Worst: ₹${worst.toFixed(0)}\n\n` +
            `⚙ Final Risk: ${G.riskState}\n` +
            `🧠 Meta: ${G.metaMode}\n` +
            `📈 Win Streak: ${G.winStreak} | Loss Streak: ${G.lossStreak}`
        );

        setTimeout(() => process.exit(0), 2000);
    }
}, 30000);
