// state.js
"use strict";

const SLOW = {
    position:   null,
    entryPrice: 0,
    pnl:        0,
    trades:     0,
};

const FAST = {
    position:   null,
    entryPrice: 0,
    pnl:        0,
    trades:     0,
    stDir:      0,     // last known SuperTrend direction: 1 | -1 | 0
};

module.exports = { SLOW, FAST };
