// state.js — Brain runtime state.
//
// CHANGED: was a module-level singleton object (`const FAST = {...}`), which
// meant every file that did require("./state") got the SAME object — fine
// for one instrument per process, but it's the thing that makes "one Brain,
// many contexts" impossible. Now it's a factory: engine.js calls
// createState() ONCE per running instrument and passes the resulting
// object down explicitly. Nothing else changes about the shape.
"use strict";

function createState() {
    return {
        position:    null,
        entryPrice:  0,
        pnl:         0,
        trades:      0,
        tradesToday: 0,  // entries taken TODAY (open or closed), for the double-order
                          // gate (doubleOrderGate.js) — boot-seeded from
                          // db.getTradeCountToday() in initSignals, NOT reset by an
                          // in-process restart, unlike `trades` above which is a
                          // lifetime-of-process counter with no daily meaning.
        stDir:       0,     // last known SuperTrend direction: 1 | -1 | 0
        peakDPI:     0,
        peakPnl: null, troughPnl: null, // observed best/worst unrealised P&L of the open position (trade journal)
        openTradeId: null,  // row id in db.trades while a position is OPEN
        positionSource: null,  // "TREND" | "MEANREV" — which engine opened the
    };
}

module.exports = { createState };
