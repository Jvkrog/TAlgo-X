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
// SCOPE — reversals only, NOT "any 2nd+ entry today": a "double order" is
// specifically the exit-then-immediate-opposite-entry pair every strategy's
// flip/reversal logic already does in one shot (e.g. LONG open, signal
// reverses to SHORT -> exit LONG, enter SHORT, same candle). Blocking THAT
// automatic re-entry is what this toggle is for. A later, unrelated fresh
// entry — the instrument went flat off a target/SL hit earlier in the day,
// and an independent signal fires sometime after — is not a double order
// and must never be blocked by this, no matter how many trades already
// happened today. Each call site passes `isReversal`, computed locally:
// runSignals()-style sites capture state.position at the top of the
// function call (before any exit in that same call can clear it) and
// compare it to the side about to be entered; doEnter(...reason)-style
// sites detect it from the reason string every reversal call already
// tags with the word "REVERSAL" (see strategies.js call sites). This used
// to key off state.tradesToday instead (any entry after the first blocked
// outright) — tradesToday is still tracked and still used elsewhere
// (display, backtest logs), just no longer read here.
//
// The Choppiness Index check on a reversal entry isn't handled here at
// all — chopGate.js's `force` option already runs the chop check on
// EVERY entry, reversal or not (see its own header comment), so a
// reversal blocked by disableDoubleOrders never even reaches the point
// where that distinction would matter, and an allowed reversal gets the
// same chop check any other entry gets.
function isDoubleOrderBlocked(context, state, isReversal) {
    if (!context.disableDoubleOrders) return false;
    return !!isReversal;
}

module.exports = { isDoubleOrderBlocked };
