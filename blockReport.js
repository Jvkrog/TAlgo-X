// blockReport.js — tells the web dashboard WHY an entry was blocked, so the live chart's
// "Filters" tab can mark the candle. Called right after a strategy evaluates its entry
// gates (chop / volume / long-candle / HTF / daily-HA + entry-time / double-order).
// Fire-and-forget over eventBridge.js (silent no-op if the dashboard isn't running);
// never throws, never affects trading.
"use strict";

const { emitEvent } = require("./eventBridge");

function reportBlocks(context, side, price, flags, dailyHa) {
    try {
        const reasons = [];
        if (flags.chop) reasons.push("CHOP");
        if (flags.volume) reasons.push("VOLUME");
        if (flags.longCandle) reasons.push("LONG_CANDLE");
        if (flags.htf) reasons.push("HTF");
        if (flags.double) reasons.push("DOUBLE_ORDER");
        if (flags.dailyHa) reasons.push(dailyHa && dailyHa.lastBlockReason === "entry-time" ? "ENTRY_TIME" : "DAILY_HA");
        if (!reasons.length) return;
        emitEvent(context.tgPrefix, "BLOCK", { side, price: price ?? null, reasons, proc: process.env.PROCESS_NAME || null });
    } catch { /* dashboard-only */ }
}

module.exports = { reportBlocks };
