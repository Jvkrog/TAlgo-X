// sl.js — SL level store (per-instrument).
//
// CHANGED: was a module-level `let` pair — same singleton problem as
// state.js/candleBuilder.js. Now createSLStore() returns one instance per
// running instrument. Also dropped "fast" naming on the trail functions
// since there's one Brain now, not a fast/slow engine pair —
// setTrail/getTrail/clearTrail is just "the active SL trail."
//
// Legacy slow-regime ALMA SL (setSlowSL/getSlowSL/clearSlowSL) removed —
// no SLOW engine exists anymore, so that state had no reader.
//
// Kept as a standalone factory with no dependencies — breaks the circular
// chain: signals.js → candlePoll.js → signals.js
"use strict";

// opts.isDisabled(): when it returns true the store never holds a stop (the "disable stop-loss" option), so every
// strategy and both SL monitors (live checkSL, backtest) see no stop at all.
// opts.isSuppressed(): same, but temporary — a linked hedge pair's legs are hedged against each other (opposite sides), so no stop
// is held while it returns true; strategies keep calling setTrail and it is simply ignored until the legs align again.
function createSLStore(opts = {}) {
    let trail = null;
    let dir   = 0;

    return {
        setTrail(trailVal, dirVal) { if (opts.isDisabled && opts.isDisabled()) return; if (opts.isSuppressed && opts.isSuppressed()) return; trail = trailVal; dir = dirVal; },
        clearTrail()               { trail = null; dir = 0; },
        getTrail()                 { return (opts.isSuppressed && opts.isSuppressed()) ? { trail: null, dir: 0 } : { trail, dir }; },
    };
}

module.exports = { createSLStore };
