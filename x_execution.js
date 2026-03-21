"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TALGO X — EXECUTION ENGINE
//
// Owns: placeOrder, exitAll, exitPartial, trade state machine
// State machine: WAIT → PROBATION → CONFIRMED → (EXIT → WAIT)
//
// PROBATION rules (merged from both engines):
//   +0.2×ATR move in favor → CONFIRMED
//   -0.3×ATR move against → exit immediately
//   Spike > 0.8×ATR (tick-level) → trap exit
//
// CONFIRMED rules:
//   Pullback counter (2 candles) → exit
//   Structure stop (2.5×ATR from avg) → exit ALL
//   Capital stop (0.6% of capital) → exit ALL
//   Bias flip (elite trend reverses) → exit ALL
//   MEAN_REVERSION: exit at ALMA midpoint
//   Scaling: if NORMAL + NORMAL_VOL + strong + explosive
//   Max duration (90m) → exit
//
// Does NOT: evaluate risk state, compute lot size, run indicators.
// Calls: sendTelegram, logEvent (injected via init).
// ─────────────────────────────────────────────────────────────────────────────

const { G, resetTradeState } = require("./state");
const { onTradeClose }       = require("./x_risk");
const { recordStrategyOutcome } = require("./x_core");
const { shouldScale }        = require("./x_allocator");

// ── Config ───────────────────────────────────────────────────────────────────
const CAPITAL         = 500000;
const LOT_MULTIPLIER  = 5000;
const MAX_LOTS        = 4;
const MAX_TRADE_DUR   = 90 * 60 * 1000;  // 90 min max
const MIN_HOLD_CANDLES = 2;               // min 2 closed 1H candles before pullback exit
const MAX_TRADES_DAY  = 3;
const MIN_TRADE_GAP   = 30 * 60 * 1000;  // 30 min min gap

// ── Injected utilities (set by index.js) ─────────────────────────────────────
let _sendTelegram = () => {};
let _log          = msg => console.log(`[EXEC] ${msg}`);
let _logEvent     = () => {};
let _kc           = null;
let _symbol       = null;

function init({ sendTelegram, log, logEvent, kc, symbol }) {
    _sendTelegram = sendTelegram;
    _log          = log;
    _logEvent     = logEvent;
    _kc           = kc;
    _symbol       = symbol;
}

// ── Internal counters ─────────────────────────────────────────────────────────
let pullbackCount = 0;
let candlesHeld   = 0;

// ── PnL calculation ───────────────────────────────────────────────────────────
function calcPnL(price, position, avgPrice, lots) {
    const dir = position === "LONG" ? 1 : -1;
    return (price - avgPrice) * dir * lots * LOT_MULTIPLIER;
}

// ── Avg price update after adding lots ───────────────────────────────────────
function updateAvgPrice(price, newLots) {
    const existingUnits = G.lots;
    if (existingUnits === 0) {
        G.avgPrice = price;
    } else {
        G.avgPrice = (G.avgPrice * existingUnits + price * newLots) / (existingUnits + newLots);
    }
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function placeOrder(direction, lots, tag, strategy) {
    if (G.isExiting)                   return;
    if (G.tradesToday >= MAX_TRADES_DAY) return;
    if (Date.now() - G.lastTradeTime < MIN_TRADE_GAP) return;

    const price = G.livePrice || G.elite?.price || 0;
    if (price === 0) { _log("❌ placeOrder: no live price"); return; }

    // In production: call kc.placeOrder here
    // await _kc.placeOrder(_symbol.exchange, _symbol.tradingsymbol,
    //   direction === "LONG" ? "BUY" : "SELL", lots, "MARKET", 0);

    const prevLots = G.lots;
    updateAvgPrice(price, lots);
    G.lots           += lots;
    G.totalExposure  += lots;
    G.position        = direction;
    G.tradeState      = "PROBATION";
    G.tradeStartTime  = G.tradeStartTime || Date.now();
    G.lastTradeTime   = Date.now();
    G.tradesToday++;
    pullbackCount     = 0;

    _log(`📥 ${tag} ${direction} ${lots}L @ ₹${price.toFixed(2)} | avg:${G.avgPrice.toFixed(2)} exp:${G.totalExposure}`);
    _sendTelegram(`📥 ENTRY [${tag}]\n${direction} ${lots}L @ ₹${price.toFixed(2)}\nAvg: ₹${G.avgPrice.toFixed(2)} | Exp: ${G.totalExposure}\nState: ${G.riskState}`);
    _logEvent({ type: "ENTRY", tag, direction, lots, price, avgPrice: G.avgPrice, strategy, exposure: G.totalExposure });
}

// ── Exit ALL ──────────────────────────────────────────────────────────────────

async function exitAll(price, reason) {
    if (G.isExiting || !G.position) return;
    G.isExiting = true;

    const pnl = calcPnL(price, G.position, G.avgPrice, G.lots);
    G.sessionPnL += pnl;

    const holdMs = G.tradeStartTime ? Date.now() - G.tradeStartTime : 0;
    G.tradeLog.push({ pnl, holdMs, reason, strategy: G.controller?.strategy });

    _log(`🚪 EXIT ALL [${reason}] ${G.position} ${G.lots}L @ ₹${price.toFixed(2)} | PnL: ₹${pnl.toFixed(0)} | Sess: ₹${G.sessionPnL.toFixed(0)}`);
    _sendTelegram(`❌ EXIT ALL [${reason}]\n${G.position} ${G.lots}L @ ₹${price.toFixed(2)}\nPnL: ₹${pnl.toFixed(0)} | Sess: ₹${G.sessionPnL.toFixed(0)}\nState: ${G.riskState}`);
    _logEvent({ type: "EXIT", reason, price, pnl, holdMs, lots: G.lots });

    onTradeClose(pnl);
    recordStrategyOutcome(G.controller?.strategy, pnl > 0);

    resetTradeState();
    pullbackCount = 0;
    candlesHeld   = 0;
}

// ── Exit partial (1 lot off) ───────────────────────────────────────────────────

async function exitPartial(price, reason) {
    if (G.isExiting || G.lots <= 1 || !G.position) return;

    const pnl = calcPnL(price, G.position, G.avgPrice, 1);
    G.sessionPnL    += pnl;
    G.lots           = Math.max(0, G.lots - 1);
    G.totalExposure  = Math.max(0, G.totalExposure - 1);
    G.lastPartialTime = Date.now();

    _log(`💰 PARTIAL EXIT [${reason}] 1L @ ₹${price.toFixed(2)} | PnL: ₹${pnl.toFixed(0)} | Rem: ${G.lots}L`);
    _sendTelegram(`💰 PARTIAL [${reason}]\n1L @ ₹${price.toFixed(2)} | PnL: ₹${pnl.toFixed(0)}\nRem: ${G.lots}L | Sess: ₹${G.sessionPnL.toFixed(0)}`);
    _logEvent({ type: "PARTIAL", reason, price, pnl, remaining: G.lots });
}

// ── PROBATION handler (called each candle while in PROBATION) ─────────────────

async function handleProbation(price, elite) {
    if (!G.position || G.tradeState !== "PROBATION") return;

    const posDir  = G.position === "LONG" ? 1 : -1;
    const pnlMove = (price - G.avgPrice) * posDir;
    const atr     = elite?.atr || G.currentATR;

    const stopMult    = 0.3;
    const confirmMult = 0.2;

    if (pnlMove < -(atr * stopMult)) {
        _log(`❌ PROBATION STOP (${(pnlMove / atr).toFixed(2)}×ATR)`);
        await exitAll(price, "PROBATION_STOP");
    } else if (pnlMove > atr * confirmMult) {
        _log(`✅ CONFIRMED — moved ${(pnlMove / atr).toFixed(2)}×ATR in favor`);
        G.tradeState = "CONFIRMED";
        candlesHeld  = 0;
    } else {
        _log(`⏳ PROBATION hold (move:${pnlMove.toFixed(2)} need ±${(atr * confirmMult).toFixed(2)})`);
    }
}

// ── Trap exit (PROBATION, tick-level) ────────────────────────────────────────

async function checkTrapExit(livePrice, elite) {
    if (!G.position || G.tradeState !== "PROBATION" || G.isExiting) return;
    const atr   = elite?.atr || G.currentATR;
    const spike = Math.abs(livePrice - G.avgPrice);
    if (spike > atr * 0.8) {
        _log(`⚠ TRAP EXIT @ ₹${livePrice} | spike: ${spike.toFixed(2)} > ATR×0.8: ${(atr * 0.8).toFixed(2)}`);
        _sendTelegram(`⚠ TRAP EXIT [PROBATION]\n${G.position} @ ₹${livePrice} | State: ${G.riskState}`);
        await exitAll(livePrice, "TRAP_EXIT");
    }
}

// ── CONFIRMED handler (called each candle while in CONFIRMED) ────────────────

async function handleConfirmed(price, elite, exec) {
    if (!G.position || G.tradeState !== "CONFIRMED") return;

    const atr     = elite?.atr || G.currentATR;
    const posDir  = G.position === "LONG" ? 1 : -1;
    candlesHeld++;

    const tradeAge = G.tradeStartTime ? Date.now() - G.tradeStartTime : 0;
    if (tradeAge > MAX_TRADE_DUR) {
        _log(`⏱ Trade expired (${Math.round(tradeAge / 60000)}m)`);
        await exitAll(price, "EXPIRED");
        return;
    }

    const currentPnL = calcPnL(price, G.position, G.avgPrice, G.lots);

    // Structure stop: 2.5×ATR from avg price
    if (Math.abs(price - G.avgPrice) > atr * 2.5) {
        _log(`🛑 Structure stop (${(Math.abs(price - G.avgPrice) / atr).toFixed(1)}×ATR)`);
        await exitAll(price, "STRUCTURE_STOP");
        return;
    }

    // Capital stop: 0.6% of capital
    const capStop = CAPITAL * 0.006;
    if (currentPnL < -capStop) {
        _log(`🛑 Capital stop ₹${capStop} | actual ₹${currentPnL.toFixed(0)}`);
        await exitAll(price, "CAPITAL_STOP");
        return;
    }

    // Bias flip: elite trend reversed against position
    if (elite) {
        const eliteBias = elite.trend === "UPTREND"  ?  1
                        : elite.trend === "DOWNTREND" ? -1 : 0;
        if (eliteBias !== 0 && eliteBias !== posDir) {
            _log(`🔄 Elite bias flip → EXIT ALL`);
            await exitAll(price, "BIAS_FLIP");
            return;
        }
    }

    // Profit lock: session up 0.5%+ and trade pulling back
    const profitLock = CAPITAL * 0.005;
    if (G.sessionPnL > profitLock && currentPnL < -(atr * LOT_MULTIPLIER)) {
        _log(`🔒 Profit lock — sess:₹${G.sessionPnL.toFixed(0)} trade:₹${currentPnL.toFixed(0)}`);
        await exitAll(price, "PROFIT_LOCK");
        return;
    }

    // ── MEAN_REVERSION exit ───────────────────────────────────────────────
    const strategy = G.controller?.strategy;
    if (strategy === "MEAN_REVERSION" && elite) {
        const almaMid = (elite.almaHigh + elite.almaLow) / 2;
        if (G.position === "LONG"  && price >= almaMid) { await exitAll(price, "MR_TARGET"); return; }
        if (G.position === "SHORT" && price <= almaMid) { await exitAll(price, "MR_TARGET"); return; }
    }

    // ── Trend pullback counter ────────────────────────────────────────────
    else {
        if (candlesHeld < MIN_HOLD_CANDLES) {
            pullbackCount = 0; // protect new trade
        } else {
            const almaHigh = elite?.almaHigh || G.avgPrice;
            const almaLow  = elite?.almaLow  || G.avgPrice;
            if (G.position === "LONG"  && price < almaHigh) pullbackCount++;
            if (G.position === "SHORT" && price > almaLow)  pullbackCount++;
            if (pullbackCount >= 2) { await exitAll(price, "PULLBACK"); return; }
        }
    }

    // ── Scaling ───────────────────────────────────────────────────────────
    if (exec && shouldScale(elite, exec, G.riskState)) {
        _log(`📈 Scaling to ${G.lots + 1}L | Exp: ${G.totalExposure + 1}`);
        await placeOrder(G.position, 1, "SCALE", strategy);
    }
}

module.exports = { init, placeOrder, exitAll, exitPartial, handleProbation, checkTrapExit, handleConfirmed };
