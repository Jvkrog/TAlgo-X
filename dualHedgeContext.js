// dualHedgeContext.js — resolves one leg (LONG account or SHORT account) of
// a dual-account hedge deployment to a full context object. Same contract-
// resolution path (CSV repo + Contract Resolver) engine.js and
// hedgePairContext.js both already use, kept in its own file for the same
// reason hedgePairContext.js is separate from hedgePairEngine.js: so a
// future backtest/replay tool can resolve the exact same way instead of
// drifting into its own copy.
//
// UNLIKE hedgePairContext.js's CORE/HEDGE legs (two DIFFERENT instruments,
// same account), a dual-account hedge's two legs are the SAME instrument,
// DIFFERENT accounts — see dualHedgeEngine.js's header for the full
// picture. side is "LONG" | "SHORT" only used for tgPrefix/name suffixing
// and to pick the leg's own directional behavior in dualHedgeEngine.js
// itself (this file doesn't branch on it beyond labeling).
"use strict";

const c = require("./c");
const { getDefinition, buildContext } = require("./context");

function resolveDualHedgeLeg({ underlying, side, userName, exchange, csvRepo, pinStore, lots, lotMultOverride, bandStepOverride }) {
    const { resolveCurrent } = require("./instrumentResolution"); // lazy — same require-cycle guard hedgePairContext.js uses
    const def = getDefinition(underlying, exchange);
    const { contract, source } = resolveCurrent(def.underlying, def, csvRepo, pinStore);
    const context = buildContext(def, contract);

    context.tgPrefix = `${context.tgPrefix}_DH_${side}`;
    context.name     = `${context.name} (Dual Hedge ${side}: ${userName})`;
    context.tgLabel  = `Dual Hedge ${side} (${userName})`;
    context.lots     = lots;
    if (lotMultOverride) context.lotMult = lotMultOverride;
    if (bandStepOverride) context.bandStep = bandStepOverride;

    // Both legs are SINGLE-DIRECTION by construction (the LONG account
    // never shorts, the SHORT account never longs) — same reasoning the
    // now-removed DYNAMIC_MID_COLOR_SHORT_HOLD strategy had for disabling
    // this: a green (or red) daily HA candle could otherwise block an
    // entire leg from ever trading its own side.
    context.dailyHaGateEnabled = false;
    // Positions carry overnight by design (explicit spec: "position carry
    // overnight") — product NRML, no EOD force-close (see
    // dualHedgeEngine.js — deliberately no checkEod() at all, unlike
    // hedgePairEngine.js's core/hedge legs).
    context.carryOvernight = true;

    if (!context.lotMult) {
        console.error(c.red(`[${context.tgPrefix}] lotMult is not set for ${underlying} — refusing to proceed.`));
        console.error(c.red(`  Fix: add a lotMult override for "${underlying}" in context.js's overrides,`));
        console.error(c.red(`  or pass a lotMult override explicitly (DH_LOTMULT_OVERRIDE, or the toolbox prompt).`));
        throw new Error(`resolveDualHedgeLeg: lotMult not set for ${underlying}`);
    }

    return { context, source };
}

module.exports = { resolveDualHedgeLeg };
