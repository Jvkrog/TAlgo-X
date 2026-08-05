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
        stDir:       0,     // last known SuperTrend direction: 1 | -1 | 0
        peakDPI:     0,     // peak favorable DPI pressure since entry (for giveback exit)
        openTradeId: null,  // row id in db.trades while a position is OPEN
        positionSource: null,  // "TREND" | "MEANREV" — which engine opened the
                                // current position, so exits route correctly.
                                // Trend exits (SMA9/giveback/eff-low) only fire
                                // for TREND positions; the RSI-flip exit only
                                // fires for MEANREV positions.
    };
}

module.exports = { createState };
