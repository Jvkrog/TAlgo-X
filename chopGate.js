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
// ALMA_PRO_FAST/ALMA_PRO_SLOW keep their own pre-existing, dedicated
// chop-filter implementation too (almaChopFilterEnabled +
// ALMA_PRO_FAST_CHOP_MAX/ALMA_PRO_SLOW_CHOP_MAX, baked into their own
// entry conditions, unchanged) — this file's check now runs there ALSO,
// stacked on top, since every strategy checks Choppiness Index on every
// entry as of the "make every strategy use check chopiness index at
// entry even at 9.15" change. Their own dedicated filter isn't replaced
// or touched — an entry there has to clear BOTH checks.

const { choppinessIndex } = require("./indicators");

// `force` — every one of strategies.js's entry sites calls with
// { force: engineConfig.CHOP_GATE_ALWAYS_FORCE !== false } — defaulting
// true (engineConfigDefaults.js's CHOP_GATE_ALWAYS_FORCE), so the
// Choppiness Index check runs on every single live entry for every
// strategy, including the very first entry of the day (the 9:15
// market-open boot/history-replay entry — see strategies.js's
// replayHistory()/doEnter() and ALMA's initSignals() boot-time entries,
// which route through the exact same doEnter()/enterPosition() functions
// as every live-candle entry, so there's no separate code path to have
// missed). context.chopFilterEnabled is not read for gating purposes as
// a result in live trading — every strategy is checked regardless of
// that per-instrument toggle's value — but context.chopPeriod/chopMax
// below are still fully respected, so Edit Params' period/threshold
// customization keeps working exactly as before. Backtests are the one
// place engineConfig.CHOP_GATE_ALWAYS_FORCE can be set false (via
// backtestFlow.js's Step 6, params merged onto a per-run engineConfig
// copy — see backtestRun.js), to compare a run with the chop gate
// on vs off — force:true skips the chopFilterEnabled gate below and
// always evaluates chop; every other behavior (period/max resolution,
// the actual indicator call) is unchanged and shared with the normal path.
function isChopBlocked(context, engineConfig, candles, { force = false } = {}) {
    if (!force && !context.chopFilterEnabled) return false; // reached in live trading only if a caller ever passes force:false explicitly — no current call site does; reached routinely in backtests when CHOP_GATE_ALWAYS_FORCE is set false
    const chopPeriod = context.chopPeriod ?? engineConfig.CHOP_LEN;
    const chopMax = context.chopMax ?? engineConfig.CHOP_GATE_MAX_DEFAULT;
    const rawCandles = candles.getRawCandles();
    const chopArr = choppinessIndex(rawCandles, chopPeriod);
    const chopVal = chopArr.length ? chopArr[chopArr.length - 1] : null;
    return chopVal !== null && chopVal > chopMax;
}

module.exports = { isChopBlocked };
