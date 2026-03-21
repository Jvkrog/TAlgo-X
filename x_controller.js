"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TALGO X — X-CONTROLLER (Master Controller)
//
// The most critical module. Stateless — runs fresh every 15m candle.
// Takes Elite (1H) + Exec (15m) outputs and produces a decision.
//
// Output:
//   { action: "ALLOW" | "LIMIT" | "BLOCK", direction, lots, reason, strategy }
//
// Key design principles from review:
//   1. Direction conflict = LIMIT (not BLOCK) — soft conflict still trades at 1 lot
//   2. Score thresholds tiered: < 1.0 block, 1.0–2.0 limit, ≥ 2.0 allow
//   3. Hard blocks are binary (EXTREME_VOL, DEAD_DAY, HALT)
//   4. Soft filters affect lots, not block
//   5. Strong exec counter-elite → allow probe (alpha source)
//   6. Meta Mode drives overall posture
// ─────────────────────────────────────────────────────────────────────────────

const { G } = require("./state");

// ── Bias maturity delay ───────────────────────────────────────────────────────
// Don't let FAST engine fire immediately after SLOW sets a new bias.
// Strong conviction → 15m wait. Normal → 30m.
function biasIsFresh(exec, elite) {
    if (!exec.biasSetTime) return false;
    const delay = exec.conviction > elite.atr * 0.5 ? 900000 : 1800000;
    return (Date.now() - exec.biasSetTime) < delay;
}

// ── Main controller ───────────────────────────────────────────────────────────

function runController(elite, exec, riskState, metaMode) {

    if (!elite || !exec) {
        return block("ENGINES_NOT_READY");
    }

    // ── HARD BLOCKS — absolute, no override ─────────────────────────────────
    if (riskState === "HARD_HALT")                      return block("HARD_HALT");
    if (riskState === "COOL_DOWN")                      return block("COOL_DOWN");
    if (elite.personality === "DEAD_DAY")               return block("DEAD_DAY");
    if (elite.volatility  === "EXTREME_VOL")            return block("EXTREME_VOL");
    if (elite.session     === "OFF")                    return block("MARKET_CLOSED");

    // ── META MODE gate ───────────────────────────────────────────────────────
    // DEFENSIVE mode: only 1-lot limits, no ALLOW
    // Acts as a system-wide posture — doesn't block but caps everything at LIMIT
    if (metaMode === "DEFENSIVE") {
        if (exec.signal === "NONE") return block("DEFENSIVE_NO_SIGNAL");
        return limit("DEFENSIVE_MODE", exec.signal, exec.confidence, elite.routerOutput.strategy);
    }

    // ── Router hard block ────────────────────────────────────────────────────
    if (elite.routerOutput.strategy === "NO_TRADE") {
        // Exception: probe can override a NO_TRADE if exec has a strong signal
        if (exec.probe && exec.bias !== 0 && exec.signal !== "NONE" && exec.isExplosive) {
            return limit("PROBE_OVERRIDE", exec.signal, exec.confidence, "PROBE");
        }
        return block(`ROUTER_${elite.routerOutput.reason}`);
    }

    // ── SLOW bias gate ───────────────────────────────────────────────────────
    if (exec.bias === 0) return block("NO_SLOW_BIAS");

    // ── 4H counter-trend hard block ──────────────────────────────────────────
    if (elite.trend4h === "UPTREND"   && exec.bias === -1) return block("COUNTER_4H");
    if (elite.trend4h === "DOWNTREND" && exec.bias ===  1) return block("COUNTER_4H");

    // ── Bias freshness gate ──────────────────────────────────────────────────
    if (biasIsFresh(exec, elite)) return block("BIAS_TOO_FRESH");

    // ── Exec signal gate ────────────────────────────────────────────────────
    if (exec.signal === "NONE") {
        // Probe can still fire without a clean signal — 1 lot in bias direction
        if (exec.probe && exec.bias !== 0) {
            const probeDir = exec.bias === 1 ? "LONG" : "SHORT";
            return limit("PROBE_STAGNATION", probeDir, 0.5, "PROBE");
        }
        return block("NO_EXEC_SIGNAL");
    }

    // ── Compute Elite bias ───────────────────────────────────────────────────
    const eliteBias = elite.trend === "UPTREND"   ?  1
                    : elite.trend === "DOWNTREND" ? -1 : 0;

    // ── Clean structure gate ─────────────────────────────────────────────────
    if (!elite.cleanStructure && exec.signal !== "NONE" && !exec.isExplosive) {
        return block("WEAK_STRUCTURE");
    }

    // ── DIRECTION CONFLICT ───────────────────────────────────────────────────
    // FIX from review: conflict = LIMIT(1 lot) not BLOCK
    // Exception: strong explosive exec against elite → allow counter probe
    if (eliteBias !== 0 && eliteBias !== exec.bias) {

        // Strong counter-elite signal (isExplosive) → probe at 1 lot
        if (exec.isExplosive && exec.confidence > 0.8) {
            return limit("COUNTER_PROBE", exec.signal, exec.confidence, "COUNTER_PROBE");
        }

        // Weak conflict → limit at 1 lot (don't fully block)
        return limit("WEAK_CONFLICT", exec.signal, exec.confidence, elite.routerOutput.strategy);
    }

    // ── SIDEWAYS regime ──────────────────────────────────────────────────────
    if (eliteBias === 0) {
        if (elite.routerOutput.strategy === "MEAN_REVERSION") {
            return limit("SIDEWAYS_MR", exec.signal, exec.confidence, "MEAN_REVERSION");
        }
        return block("SIDEWAYS_NO_EDGE");
    }

    // ── Signal direction mismatch ────────────────────────────────────────────
    const expectedSignal = exec.bias === 1 ? "LONG" : "SHORT";
    if (exec.signal !== expectedSignal) {
        return block("SIGNAL_BIAS_MISMATCH");
    }

    // ── Score gate (tiered) ──────────────────────────────────────────────────
    const score = elite.routerOutput.score ?? 0;
    if (score < 1.0) return block(`SCORE_TOO_LOW:${score}`);

    // FIX from review: score 1.0–2.0 → LIMIT not BLOCK
    if (score < 2.0 || elite.routerOutput.mode === "LIMIT") {
        return limit(`LOW_SCORE:${score}`, exec.signal, exec.confidence, elite.routerOutput.strategy);
    }

    // ── ALLOW ────────────────────────────────────────────────────────────────
    const ctrl = {
        action:    "ALLOW",
        direction: exec.signal,
        confidence: exec.confidence,
        strategy:  elite.routerOutput.strategy,
        score,
        reason:    `OK score:${score} conf:${exec.confidence.toFixed(2)}`
    };

    G.controller = ctrl;
    return ctrl;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function block(reason) {
    const ctrl = { action: "BLOCK", direction: "NONE", reason };
    G.controller = ctrl;
    return ctrl;
}

function limit(reason, direction = "NONE", confidence = 0.5, strategy = "LIMIT") {
    const ctrl = {
        action:    "LIMIT",
        direction,
        confidence,
        strategy,
        reason,
        score:     G.elite?.routerOutput?.score ?? 0
    };
    G.controller = ctrl;
    return ctrl;
}

module.exports = { runController };
