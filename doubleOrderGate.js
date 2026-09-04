"use strict";
// doubleOrderGate.js — optional "no more than one entry per session, per
// instrument" gate. Mirrors chopGate.js in shape and calling convention on
// purpose: a pure check (isDoubleOrderBlocked) called from each strategy's
// own entry site, BEFORE orders.enter() is called — not a wrapper around
// orders.enter() itself, for the exact same paper-mode reason documented
// in chopGate.js's header (orders.js's _place() returns null immediately
// whenever !engineConfig.LIVE_ORDERS, so a block disguised as that same
// null return is silently ignored by every strategy's own
// `if (engineConfig.LIVE_ORDERS && ordered === null)` commit check in
// paper mode — the gate has to run upstream of orders.enter(), not around
// it).
//
// context.disableDoubleOrders: default OFF (undefined/false/null) — every
// existing strategy already re-enters freely via its own gates once flat,
// so this has to be opt-IN via Edit Params, never a silent behavior change
// for anything already deployed.
//
// state.tradesToday: how many entries THIS instrument has taken today,
// regardless of whether each one is currently open or already closed.
// Incremented in-process on every successful entry (mirrors state.trades,
// but reset daily rather than accumulating across restarts) and boot-seeded
// from db.getTradeCountToday() in each strategy's initSignals() — same
// "rebuilt from the ledger, not trusted from RAM" reasoning state.pnl
// already uses, so a mid-day restart doesn't reset the count and let a
// disabled instrument double-order again after a crash/redeploy.
function isDoubleOrderBlocked(context, state) {
    if (!context.disableDoubleOrders) return false;
    return (state.tradesToday || 0) > 0;
}

module.exports = { isDoubleOrderBlocked };
