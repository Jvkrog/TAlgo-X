// positions.js
"use strict";

const { tg }   = require("./telegram");
const config   = require("./config");
const { SLOW, FAST } = require("./state");

function pnlStr(val) {
    return (val >= 0 ? "+" : "") + val.toFixed(2);
}

function unrealisedSlow(price) {
    if (!SLOW.position) return 0;
    const dir = SLOW.position === "LONG" ? 1 : -1;
    return (price - SLOW.entryPrice) * dir * config.SLOW_LOT_MULT * config.SLOW_LOTS;
}

function unrealisedFast(price) {
    if (!FAST.position) return 0;
    const dir = FAST.position === "LONG" ? 1 : -1;
    return (price - FAST.entryPrice) * dir * config.FAST_LOT_MULT * config.FAST_LOTS;
}

function ts() {
    return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

function closeSlow(price, reason) {
    if (!SLOW.position) return;
    const dir   = SLOW.position === "LONG" ? 1 : -1;
    const pnl   = (price - SLOW.entryPrice) * dir * config.SLOW_LOT_MULT * config.SLOW_LOTS;
    const entry = SLOW.entryPrice;
    const pos   = SLOW.position;

    SLOW.pnl    += pnl;
    SLOW.trades += 1;
    SLOW.position   = null;
    SLOW.entryPrice = 0;

    const action = reason.includes("SL") ? "STOP" : "EXIT";
    console.log();
    console.log(`S ${pos} ${action} @ ${price.toFixed(2)}`);
    console.log(`    reason: ${reason}  entry: ${entry.toFixed(2)}`);
    console.log(`    pnl: ${pnlStr(pnl)}  session: ${pnlStr(SLOW.pnl)}`);
    console.log();
    tg(`S ${pos} ${action} (${reason})\n@ ₹${price.toFixed(2)}  entry ₹${entry.toFixed(2)}\nPnL: ${pnlStr(pnl)}  session: ${pnlStr(SLOW.pnl)}`);
}

function closeFast(price, reason) {
    if (!FAST.position) return;
    const dir   = FAST.position === "LONG" ? 1 : -1;
    const pnl   = (price - FAST.entryPrice) * dir * config.FAST_LOT_MULT * config.FAST_LOTS;
    const entry = FAST.entryPrice;
    const pos   = FAST.position;

    FAST.pnl    += pnl;
    FAST.trades += 1;
    FAST.position   = null;
    FAST.entryPrice = 0;
    FAST.stDir      = 0;

    const action = reason.includes("SL") ? "STOP" : "EXIT";
    console.log();
    console.log(`F ${pos} ${action} @ ${price.toFixed(2)}`);
    console.log(`    reason: ${reason}  entry: ${entry.toFixed(2)}`);
    console.log(`    pnl: ${pnlStr(pnl)}  session: ${pnlStr(FAST.pnl)}`);
    console.log();
    tg(`F ${pos} ${action} (${reason})\n@ ₹${price.toFixed(2)}  entry ₹${entry.toFixed(2)}\nPnL: ${pnlStr(pnl)}  session: ${pnlStr(FAST.pnl)}`);
}

module.exports = { closeSlow, closeFast, unrealisedSlow, unrealisedFast, pnlStr };
