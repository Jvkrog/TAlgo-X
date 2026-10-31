// riskObserver/riskState.js — pure risk-state machine: NORMAL -> WATCH -> DANGER -> RECOVERY -> NORMAL.
// Observation only. A state here is a monitoring label, never a trading signal. No I/O, no clock, no mutable globals.
//
// Hysteresis: a WORSE state must hold for `escalateConfirm` consecutive evaluations before it is entered; leaving
// WATCH/DANGER needs `clearConfirm` consecutive clear evaluations (RECOVERY), then `normalConfirm` more for NORMAL.
// A re-trigger while in RECOVERY goes straight back to WATCH/DANGER (after its escalate confirmation).
"use strict";

const ORDER = { NORMAL: 0, RECOVERY: 0.5, WATCH: 1, DANGER: 2 };

function newMachine() { return { state: "NORMAL", worseTarget: null, worseCount: 0, clearCount: 0, normalCount: 0 }; }

// inputs: { adverseAtr, adverseCandles, disagreeCandles, oppositeAgree }  (all numbers/bool, finite)
// Returns { level: "NORMAL"|"WATCH"|"DANGER", reasons: [...] } = the raw (un-hysteresised) condition level.
function classify(inp, cfg) {
    const reasons = [];
    const adv = inp.adverseAtr, dis = inp.disagreeCandles || 0;
    let danger = false, watch = false;
    if (adv >= cfg.dangerAdverseAtr && inp.adverseCandles >= cfg.dangerAdverseCandles) { danger = true; reasons.push(`persistent adverse movement (${adv.toFixed(2)} ATR, ${inp.adverseCandles} adverse candles)`); }
    if (inp.oppositeAgree && adv >= cfg.dangerOppositeAtr) { danger = true; reasons.push(`15M DSBs agree against the position with ${adv.toFixed(2)} ATR adverse`); }
    if (dis >= cfg.dangerDisagreeCandles && adv >= cfg.watchAdverseAtr) { danger = true; reasons.push(`15M DSB disagreement for ${dis} candles with ${adv.toFixed(2)} ATR adverse`); }
    if (adv >= cfg.watchAdverseAtr) { watch = true; reasons.push(`adverse movement ${adv.toFixed(2)} ATR`); }
    if (dis >= cfg.watchDisagreeCandles) { watch = true; reasons.push(`15M DSB disagreement (${dis} candles)`); }
    if (inp.oppositeAgree && !danger) { watch = true; reasons.push("15M DSBs agree against the position"); }
    return { level: danger ? "DANGER" : watch ? "WATCH" : "NORMAL", reasons };
}

// "Clear" is stricter than NORMAL-level: adverse must be under the (lower) clear threshold and the DSBs not against us.
function isClear(inp, cfg) {
    return inp.adverseAtr < cfg.clearAdverseAtr && !inp.oppositeAgree && (inp.disagreeCandles || 0) === 0;
}

// step(machine, inputs, cfg) -> { machine (new), transition: null | { from, to, reasons } }
function step(m, inp, cfg) {
    const cls = classify(inp, cfg);
    const clear = isClear(inp, cfg);
    const next = { ...m };
    let to = null;

    if (m.state === "NORMAL" || m.state === "RECOVERY") {
        if (cls.level !== "NORMAL") {
            // escalation needs confirmation of the SAME (or worse) level
            const lvl = ORDER[cls.level];
            if (next.worseTarget !== null && ORDER[next.worseTarget] <= lvl) next.worseCount++;
            else next.worseCount = 1;
            next.worseTarget = cls.level;
            next.clearCount = 0; next.normalCount = 0;
            if (next.worseCount >= cfg.escalateConfirm) { to = cls.level; }
        } else {
            next.worseTarget = null; next.worseCount = 0;
            if (m.state === "RECOVERY") {
                if (clear) { next.normalCount++; if (next.normalCount >= cfg.normalConfirm) to = "NORMAL"; }
                else next.normalCount = 0;
            }
        }
    } else if (m.state === "WATCH") {
        if (cls.level === "DANGER") {
            next.worseCount = (next.worseTarget === "DANGER" ? next.worseCount : 0) + 1; next.worseTarget = "DANGER"; next.clearCount = 0;
            if (next.worseCount >= cfg.escalateConfirm) to = "DANGER";
        } else if (clear) {
            next.worseTarget = null; next.worseCount = 0;
            next.clearCount++; if (next.clearCount >= cfg.clearConfirm) to = "RECOVERY";
        } else { next.worseTarget = null; next.worseCount = 0; next.clearCount = 0; }
    } else if (m.state === "DANGER") {
        // DANGER relaxes only when the danger conditions are gone AND the position is recovering; it passes through RECOVERY
        if (cls.level !== "DANGER" && (cls.level === "NORMAL" || inp.adverseAtr < cfg.dangerAdverseAtr * 0.75)) {
            next.clearCount++; if (next.clearCount >= cfg.clearConfirm) to = "RECOVERY";
        } else next.clearCount = 0;
    }

    if (to && to !== m.state) {
        next.state = to; next.worseTarget = null; next.worseCount = 0; next.clearCount = 0; next.normalCount = 0;
        return { machine: next, transition: { from: m.state, to, reasons: cls.reasons } };
    }
    return { machine: next, transition: null };
}

module.exports = { newMachine, step, classify, isClear };
