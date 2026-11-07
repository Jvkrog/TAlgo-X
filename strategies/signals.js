// signals.js — Strategy dispatcher.
//
// CHANGED (this pass): all trading logic moved out to strategies.js.
// This file no longer contains any strategy code itself — it just picks
// the right factory by context.strategy (set per-instrument in
// context.js's overrides, defaults to DEFAULT_STRATEGY) and hands back
// its { processCandle, initSignals } unchanged. engine.js's call site
// (`createSignals({...})`) needed no changes for this — same deps in,
// same shape out.
//
// CHANGED (strategy builder pass): createSignals is now ASYNC. A key not
// found in the hardcoded STRATEGIES registry is no longer an immediate
// throw — it now falls back to customStrategyDb, since that key might be
// a user-built strategy saved via the toolbox/webdash wizard. Only throws
// if it's missing from BOTH. engine.js's one call site was updated to
// `await createSignals(...)` for this — see engine.js's main().
"use strict";

const { STRATEGIES, DEFAULT_STRATEGY } = require("./strategies");
const customStrategyDb = require("./customStrategyDb");
const { createCustomStrategy } = require("./customStrategyRuntime");

async function createSignals(deps) {
    const key     = deps.context.strategy || DEFAULT_STRATEGY;
    const factory = STRATEGIES[key];
    if (factory) return factory(deps);

    const spec = await customStrategyDb.getStrategyByName(key);
    if (!spec) {
        throw new Error(`createSignals: unknown strategy "${key}" (not in STRATEGIES, and no custom_strategies row by that name)`);
    }
    if (!spec.entryLong && !spec.entryShort) {
        throw new Error(`createSignals: custom strategy "${key}" has no entry conditions saved yet — finish it in the builder before deploying`);
    }
    return createCustomStrategy(spec)(deps);
}

module.exports = { createSignals };
