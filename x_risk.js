"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TALGO X — X-RISK (Risk Engine)
//
// Unified risk state machine — drawn from both vk.js and v3_nat.js.
// Runs once per candle + continuously monitors equity on every tick.
//
// States:
//   NORMAL    → full lot logic, scaling allowed
//   DEFENSE   → lots locked at 1, no scaling, stricter entry slope
//   COOL_DOWN → no entries; spike-path = 1 candle, loss-path = adaptive timer
//   RECOVERY  → lots at 1, standard slope; 2 clean wins → NORMAL
//   HARD_HALT → irrevocable for the session, no trading
//
// Transitions:
//   NORMAL    → DEFENSE   : sessionPnL ≤ -1% capital
//   DEFENSE   → COOL_DOWN : 2 consecutive losses in DEFENSE
//   COOL_DOWN → DEFENSE   : spike: 1 candle elapsed | loss: adaptive timer
//   DEFENSE   → RECOVERY  : sessionPnL > -0.25% capital
//   RECOVERY  → DEFENSE   : sessionPnL ≤ -0.25% capital
//   RECOVERY  → NORMAL    : 2 clean wins in RECOVERY
//   Any       → HARD_HALT : daily DD > 3% OR trailing DD > 6% (adaptive)
//
// Meta Mode (from review):
//   TREND         → personality TRENDING_DAY or normal
//   MEAN_REVERSION → personality RANGING_DAY
//   DEFENSIVE     → drawdown detected before HARD_HALT threshold
//
// FIX from review: dynamic HARD_HALT limit (not static 3%)
//   dynamicLimit = max(capital × 0.02, elite.atr × LOT_MULTIPLIER × 3)
// ─────────────────────────────────────────────────────────────────────────────

const { G, recordResult } = require("./state");

// ── Config ───────────────────────────────────────────────────────────────────
const CAPITAL          = 500000;
const LOT_MULTIPLIER   = 5000;
const TRAIL_DD_PCT     = 0.06;
const BASE_DAILY_RISK  = 0.03;
const VOL_SPIKE_MULT   = 2.0;

// ── Internal state ───────────────────────────────────────────────────────────
let cooldownStartTime  = null;
let cooldownCandles    = 0;
let defenseLossCount   = 0;
let recoveryWinCount   = 0;
let previousATR        = 0;

// ── Adaptive daily limit ──────────────────────────────────────────────────────
// FIX from review: not static. Reacts to volatility + drawdown depth.
function getDynamicLimit(elite) {
    const base    = CAPITAL * BASE_DAILY_RISK;
    const atrBase = elite ? elite.atr * LOT_MULTIPLIER * 3 : 0;

    // Vol factor
    let volFactor = 1.0;
    if (elite?.volatility === "LOW_VOL")  volFactor = 0.7;
    if (elite?.volatility === "HIGH_VOL") volFactor = 1.2;

    // Session performance factor
    let perfFactor = 1.0;
    if (G.sessionPnL >  CAPITAL * 0.01) perfFactor = 1.3;
    if (G.sessionPnL < 0)               perfFactor = 0.8;

    // Drawdown factor
    const dd = G.equityHigh - (CAPITAL + G.sessionPnL);
    let ddFactor = 1.0;
    if (dd > CAPITAL * 0.02) ddFactor = 0.7;

    const adaptive = base * volFactor * perfFactor * ddFactor;
    const floor    = base * 0.5;
    return Math.max(Math.max(adaptive, floor), atrBase);
}

// ── Adaptive cooldown duration ────────────────────────────────────────────────
function getCooldownDuration(volatility) {
    if (volatility === "HIGH_VOL") return 30 * 60 * 1000;
    if (volatility === "LOW_VOL")  return 90 * 60 * 1000;
    return 60 * 60 * 1000;
}

// ── Meta mode ─────────────────────────────────────────────────────────────────
// Derived each candle from personality + drawdown state.
function computeMetaMode(elite) {
    const dd = G.equityHigh - (CAPITAL + G.sessionPnL);
    const ddPct = dd / CAPITAL;

    // Approaching halt threshold → defensive posture
    if (ddPct > 0.03 || G.sessionPnL < -(CAPITAL * 0.015)) {
        return "DEFENSIVE";
    }

    if (!elite) return "TREND";

    if (elite.personality === "RANGING_DAY" || elite.trend === "SIDEWAYS") {
        return "MEAN_REVERSION";
    }

    return "TREND";
}

// ── Evaluate risk state (once per candle) ─────────────────────────────────────

function evaluateRiskState(elite) {
    const equity = CAPITAL + G.sessionPnL;
    G.equityHigh = Math.max(G.equityHigh, equity);

    const dynamicLimit = getDynamicLimit(elite);
    const trailingDD   = G.equityHigh - equity;

    // ── HARD_HALT — check first, irrevocable ────────────────────────────────
    if (G.riskState !== "HARD_HALT") {
        if (G.sessionPnL < -dynamicLimit || trailingDD >= CAPITAL * TRAIL_DD_PCT) {
            G.riskState = "HARD_HALT";
            return "HARD_HALT";
        }
    }

    // ── Volatility spike → COOL_DOWN ────────────────────────────────────────
    if (elite && previousATR > 0
        && G.riskState !== "COOL_DOWN"
        && elite.volatility !== "EXTREME_VOL"
        && elite.atr > previousATR * VOL_SPIKE_MULT) {
        cooldownCandles = 1;
        G.riskState = "COOL_DOWN";
        previousATR = elite.atr;
        return "COOL_DOWN:SPIKE";
    }

    if (elite) previousATR = elite.atr;

    // ── COOL_DOWN transitions ────────────────────────────────────────────────
    if (G.riskState === "COOL_DOWN") {
        if (cooldownCandles > 0) {
            cooldownCandles--;
            if (cooldownCandles <= 0) {
                G.riskState = "DEFENSE";
                defenseLossCount = 0;
            }
        } else if (cooldownStartTime) {
            const cdDuration = getCooldownDuration(elite?.volatility);
            if (Date.now() - cooldownStartTime >= cdDuration) {
                G.riskState = "DEFENSE";
                defenseLossCount = 0;
                cooldownStartTime = null;
            }
        }
        return G.riskState;
    }

    // ── NORMAL → DEFENSE ────────────────────────────────────────────────────
    const DEFENSE_THRESHOLD = CAPITAL * 0.01;
    if (G.riskState === "NORMAL" && G.sessionPnL < -DEFENSE_THRESHOLD) {
        G.riskState = "DEFENSE";
        defenseLossCount = 0;
        return "DEFENSE";
    }

    // ── DEFENSE → RECOVERY or COOL_DOWN ─────────────────────────────────────
    if (G.riskState === "DEFENSE") {
        if (G.sessionPnL > -(CAPITAL * 0.0025)) {
            G.riskState = "RECOVERY";
            recoveryWinCount = 0;
            return "RECOVERY";
        }
    }

    // ── RECOVERY transitions ─────────────────────────────────────────────────
    if (G.riskState === "RECOVERY") {
        if (G.sessionPnL < -(CAPITAL * 0.0025)) {
            G.riskState = "DEFENSE";
            defenseLossCount = 0;
            return "DEFENSE";
        }
    }

    return G.riskState;
}

// ── Post-trade bookkeeping ────────────────────────────────────────────────────
// Called by execution engine after every trade close.

function onTradeClose(pnl) {
    const won = pnl > 0;
    recordResult(won);

    if (!won) {
        if (G.riskState === "DEFENSE") {
            defenseLossCount++;
            if (defenseLossCount >= 2) {
                cooldownStartTime = Date.now();
                cooldownCandles   = 0;
                G.riskState       = "COOL_DOWN";
            }
        }
        if (G.riskState === "RECOVERY") {
            recoveryWinCount = 0;
        }
    } else {
        if (G.riskState === "RECOVERY") {
            recoveryWinCount++;
            if (recoveryWinCount >= 2) {
                G.riskState      = "NORMAL";
                defenseLossCount = 0;
                recoveryWinCount = 0;
            }
        }
        if (G.riskState === "DEFENSE") {
            defenseLossCount = 0;
        }
    }
}

// ── Continuous equity monitor (called on every tick) ─────────────────────────
// Only checks for HARD_HALT on each tick — state machine runs candle-level.

function onTickRiskCheck(elite) {
    if (G.riskState === "HARD_HALT") return;
    const equity     = CAPITAL + G.sessionPnL;
    G.equityHigh     = Math.max(G.equityHigh, equity);
    const trailingDD = G.equityHigh - equity;
    const dynLimit   = getDynamicLimit(elite);
    if (G.sessionPnL < -dynLimit || trailingDD >= CAPITAL * TRAIL_DD_PCT) {
        G.riskState = "HARD_HALT";
    }
}

module.exports = { evaluateRiskState, onTradeClose, onTickRiskCheck, computeMetaMode };
