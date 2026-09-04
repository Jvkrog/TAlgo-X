"use strict";
// chopGate.js — universal Choppiness Index entry filter, available to ANY
// strategy via Edit Params (context.chopFilterEnabled/chopPeriod/chopMax —
// same fields VOLUME_DELTA_CVD already used, now generic).
//
// WHY THIS IS A CHECK CALLED FROM EACH STRATEGY'S OWN ENTRY SITE, NOT A
// WRAPPER AROUND orders.enter(): an earlier version of this wrapped
// orders.enter() itself so no strategy file would need touching. That
// doesn't work — orders.js's _place() returns null immediately whenever
// !engineConfig.LIVE_ORDERS (paper mode's normal path), and every
// strategy's own commit check is `if (engineConfig.LIVE_ORDERS && ordered
// === null)` — which is always false in paper mode, so paper trades always
// proceed regardless of what orders.enter() actually returned. A
// chop-block disguised as that same null would be silently ignored in
// paper mode, the default and most-used mode. So the gate has to run
// BEFORE orders.enter() is even called, at each strategy's own entry
// decision — this file is the one shared check every one of those ~19
// sites (see strategies.js) now calls, kept in exactly one place so
// tuning the gate logic itself still only means editing this file.
//
// ALMA_PRO_FAST/ALMA_PRO_SLOW are the one exception — they keep their own
// pre-existing, dedicated chop-filter implementation
// (almaChopFilterEnabled + ALMA_PRO_FAST_CHOP_MAX/ALMA_PRO_SLOW_CHOP_MAX,
// baked into their own entry conditions, unchanged) rather than also
// calling this — stacking two independent chop checks with different
// default period/threshold sources on the same strategy risked silently
// changing already-running behavior, so this file is skipped there
// (isChopBlocked isn't called from either of their entry sites).

const { choppinessIndex } = require("./indicators");

// `force` — added for doubleOrderGate.js: when double orders remain
// ALLOWED for an instrument (context.disableDoubleOrders is off), any
// 2nd+ entry that session must ALSO be checked against the Choppiness
// Index specifically, independent of whether this instrument's own
// context.chopFilterEnabled toggle is on — a double order is exactly the
// situation where skipping the chop check is riskiest, so it isn't left
// opt-in. force:true skips the chopFilterEnabled gate below and always
// evaluates chop; every other behavior (period/max resolution, the actual
// indicator call) is unchanged and shared with the normal path.
function isChopBlocked(context, engineConfig, candles, { force = false } = {}) {
    if (!force && !context.chopFilterEnabled) return false; // OFF by default for every strategy that never had a chop filter before — opt IN via Edit Params, not a silent behavior change for anything already deployed
    const chopPeriod = context.chopPeriod ?? engineConfig.CHOP_LEN;
    const chopMax = context.chopMax ?? 50; // same 50 every chop filter in this codebase uses
    const rawCandles = candles.getRawCandles();
    const chopArr = choppinessIndex(rawCandles, chopPeriod);
    const chopVal = chopArr.length ? chopArr[chopArr.length - 1] : null;
    return chopVal !== null && chopVal > chopMax;
}

module.exports = { isChopBlocked };
