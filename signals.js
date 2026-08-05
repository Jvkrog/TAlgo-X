// signals.js — Strategy dispatcher.
//
// CHANGED (this pass): all trading logic moved out to strategies.js.
// This file no longer contains any strategy code itself — it just picks
// the right factory by context.strategy (set per-instrument in
// context.js's overrides, defaults to DEFAULT_STRATEGY) and hands back
// its { processCandle, initSignals } unchanged. engine.js's call site
// (`createSignals({...})`) needed no changes for this — same deps in,
// same shape out.
"use strict";

const { STRATEGIES, DEFAULT_STRATEGY } = require("./strategies");

function createSignals(deps) {
    const key     = deps.context.strategy || DEFAULT_STRATEGY;
    const factory = STRATEGIES[key];
    if (!factory) {
        throw new Error(`createSignals: unknown strategy "${key}" (known: ${Object.keys(STRATEGIES).join(", ")})`);
    }
    return factory(deps);
}

module.exports = { createSignals };
