"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TALGO X — X-ALLOCATOR (Capital Allocator)
//
// Decides lot size given:
//   - Elite score + ATR risk formula (from vk.js getDynamicLot + calculateLot)
//   - Exec conviction + explosive signal boost (from v3_nat.js)
//   - Risk state hard overrides (DEFENSE/RECOVERY → 1 lot always)
//   - Session PnL aggression adjustment (from vk.js adjustAggression)
//   - Equity curve intelligence: loss streak, win streak (from review)
//   - META MODE posture
//
// Returns: { lots: number, reason: string }
// ─────────────────────────────────────────────────────────────────────────────

const { G, last3Loss } = require("./state");

// ── Config (symbol-specific, import from symbols/*.js in production) ──────────
const CAPITAL             = 500000;
const MAX_LOTS            = 4;
const LOT_MULTIPLIER      = 5000;   // ZINC — update per symbol
const RISK_PER_TRADE_PCT  = 0.005;  // 0.5% per trade base risk

// ── ATR-based base lot ────────────────────────────────────────────────────────
function calculateBaseLot(atr) {
    const riskCapital = CAPITAL * RISK_PER_TRADE_PCT;
    const riskPerLot  = atr * LOT_MULTIPLIER;
    return Math.max(1, Math.min(Math.floor(riskCapital / riskPerLot), MAX_LOTS));
}

// ── Main allocator ────────────────────────────────────────────────────────────

function runAllocator(elite, exec, ctrl, riskState, metaMode) {

    // ── Risk state hard overrides — always win ───────────────────────────────
    if (riskState === "HARD_HALT" || riskState === "COOL_DOWN") {
        return { lots: 0, reason: `BLOCKED:${riskState}` };
    }
    if (riskState === "DEFENSE" || riskState === "RECOVERY") {
        return { lots: 1, reason: `FORCED_1:${riskState}` };
    }

    // ── META MODE posture ────────────────────────────────────────────────────
    if (metaMode === "DEFENSIVE") {
        return { lots: 1, reason: "DEFENSIVE_MODE" };
    }

    const score = elite.routerOutput.score ?? 0;
    const atr   = elite.atr;

    // ── Base lot from ATR risk formula ───────────────────────────────────────
    let base = calculateBaseLot(atr);

    // ── Score scaling (from vk.js getDynamicLot) ─────────────────────────────
    if (score > 4.0)      base = Math.min(base + 2, MAX_LOTS);
    else if (score > 3.0) base = Math.min(base + 1, MAX_LOTS);

    // ── Conviction + explosive boost (from v3_nat.js) ────────────────────────
    if (exec.isExplosive && exec.conviction > atr * 0.6) {
        base = Math.min(base + 1, MAX_LOTS);
    }

    // ── Personality penalty ──────────────────────────────────────────────────
    if (elite.personality === "VOLATILE_DAY") {
        base = 1;
    }

    // ── HIGH_VOL regime cap ──────────────────────────────────────────────────
    if (elite.volatility === "HIGH_VOL") {
        base = Math.min(base, 1);
    }

    // ── LIMIT action → force 1 lot ───────────────────────────────────────────
    if (ctrl.action === "LIMIT") {
        return { lots: 1, reason: `LIMIT_ACTION:${ctrl.reason}` };
    }

    // ── Session PnL aggression (from vk.js adjustAggression) ─────────────────
    const sessionPnL = G.sessionPnL;
    if (sessionPnL < -(CAPITAL * 0.005)) {
        base = Math.min(base, 2);
    } else if (sessionPnL > CAPITAL * 0.01) {
        base = Math.min(base + 1, MAX_LOTS);
    }

    // ── Equity curve intelligence (from review) ──────────────────────────────
    // Last 3 trades all losses → protect, drop to 1 lot
    if (last3Loss()) {
        return { lots: 1, reason: "LOSS_STREAK_3:PROTECT" };
    }

    // Win streak ≥ 3 → confidence bonus
    if (G.winStreak >= 3) {
        base = Math.min(base + 1, MAX_LOTS);
    }

    // ── Exposure cap ─────────────────────────────────────────────────────────
    const maxExposure = computeMaxExposure(sessionPnL);
    const remaining   = maxExposure - G.totalExposure;
    if (remaining <= 0) return { lots: 0, reason: "EXPOSURE_CAP" };
    base = Math.min(base, remaining);

    return { lots: Math.max(1, base), reason: `SCORE:${score} ATR:${atr.toFixed(2)} WS:${G.winStreak}` };
}

// ── Dynamic max exposure (from vk.js adjustAggression, enhanced) ─────────────
function computeMaxExposure(sessionPnL) {
    if (sessionPnL < -(CAPITAL * 0.005)) return 2;   // losing → reduce ceiling
    if (sessionPnL > CAPITAL * 0.01)     return 4;   // winning → allow expansion
    return 3;                                          // neutral default
}

// ── Scaling decision (called from execution engine in CONFIRMED state) ────────
// Only allowed in NORMAL risk state + NORMAL_VOL regime + sufficient distance

function shouldScale(elite, exec, riskState) {
    if (riskState !== "NORMAL")                        return false;
    if (elite.volatility !== "NORMAL_VOL")             return false;
    if (G.totalExposure >= computeMaxExposure(G.sessionPnL)) return false;
    if (G.lots >= MAX_LOTS)                            return false;

    // Breakout distance filter — must be at least 0.4×ATR from entry
    const breakoutDist = Math.abs(G.livePrice - G.avgPrice);
    if (breakoutDist < elite.atr * 0.4)               return false;

    // Needs strong + accelerating trend
    return exec.isStrong && exec.isExplosive;
}

module.exports = { runAllocator, shouldScale, computeMaxExposure };
