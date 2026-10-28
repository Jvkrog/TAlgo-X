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

function createSLStore() {
    let trail = null;
    let dir   = 0;

    return {
        setTrail(trailVal, dirVal) { trail = trailVal; dir = dirVal; },
        clearTrail()               { trail = null; dir = 0; },
        getTrail()                 { return { trail, dir }; },
    };
}

module.exports = { createSLStore };
