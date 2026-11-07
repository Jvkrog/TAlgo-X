// target.js — favorable-target level store (per-instrument).
//
// Companion to sl.js, same shape: sl.js tracks the level that closes a
// position on ADVERSE movement (checkSL in candlePoll.js); this tracks the
// level that closes a position on FAVORABLE movement (checkTarget in
// candlePoll.js) — the scalp take-profit added for MA_SLOPE_SCALP. Both
// stores are checked on every WebSocket tick, not on candle close.
//
// Kept as a standalone factory with no dependencies, same reasoning as
// sl.js — breaks the circular chain: signals.js → candlePoll.js → signals.js
"use strict";

function createTargetStore() {
    let target = null;
    let dir    = 0; // 1 = LONG (exit when price >= target), -1 = SHORT (exit when price <= target)

    return {
        setTarget(targetVal, dirVal) { target = targetVal; dir = dirVal; },
        clearTarget()                { target = null; dir = 0; },
        getTarget()                  { return { target, dir }; },
    };
}

module.exports = { createTargetStore };
