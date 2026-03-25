"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TALGO X — SHARED STATE (state.js)
//
// Single source of truth. All modules import G and mutate it directly.
// No module keeps its own position/PnL/risk state — everything lives here.
//
// Discipline: only x_execution.js writes position/trade fields.
//             only x_risk.js writes riskState.
//             x_core and x_exec write their own output slots.
// ─────────────────────────────────────────────────────────────────────────────

const G = {

    // ── Position ────────────────────────────────────────────────────────────
    position:       null,       // "LONG" | "SHORT" | null
    avgPrice:       0,
    lots:           0,
    totalExposure:  0,
    tradeState:     "WAIT",     // WAIT | PROBATION | CONFIRMED
    tradeStartTime: null,
    isExiting:      false,

    // ── PnL & Session ───────────────────────────────────────────────────────
    sessionPnL:     0,
    tradesToday:    0,
    lastTradeTime:  0,
    lastPartialTime: 0,
    equityHigh:     0,          // set to CAPITAL on boot
    tradeLog:       [],         // { pnl, holdMs, tag, strategy }

    // ── Engine Outputs (refreshed each candle) ───────────────────────────────
    elite:          null,       // X-Core output (1H)
    exec:           null,       // X-Exec output (15m)
    controller:     null,       // X-Controller output (15m)

    // ── Risk ────────────────────────────────────────────────────────────────
    riskState:      "NORMAL",   // NORMAL | DEFENSE | COOL_DOWN | RECOVERY | HARD_HALT
    metaMode:       "TREND",    // TREND | MEAN_REVERSION | DEFENSIVE

    // ── Streak Tracking (for Allocator equity-curve intelligence) ───────────
    recentResults:  [],         // last 5 trade outcomes: 1=win, 0=loss
    winStreak:      0,
    lossStreak:     0,

    // ── Lifecycle ───────────────────────────────────────────────────────────
    lifecycleClosed:   false,
    lifecycleShutdown: false,

    // ── Live Market ─────────────────────────────────────────────────────────
    livePrice:      0,
    currentATR:     0,
    previousATR:    0
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function recordResult(win) {
    G.recentResults.push(win ? 1 : 0);
    if (G.recentResults.length > 5) G.recentResults.shift();

    if (win) {
        G.winStreak++;
        G.lossStreak = 0;
    } else {
        G.lossStreak++;
        G.winStreak = 0;
    }
}

function resetTradeState() {
    G.position       = null;
    G.avgPrice       = 0;
    G.lots           = 0;
    G.tradeState     = "WAIT";
    G.tradeStartTime = null;
    G.isExiting      = false;
    G.lastTradeTime  = Date.now();
    G.controller     = null;
}

function last3Loss() {
    if (G.recentResults.length < 3) return false;
    return G.recentResults.slice(-3).every(r => r === 0);
}

module.exports = { G, recordResult, resetTradeState, last3Loss };
