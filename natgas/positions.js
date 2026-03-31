// positions.js
const { tg } = require("./telegram");
const config = require("./config");
const { SLOW, FAST } = require("./state");

function pnlStr(val) {
    return val >= 0 ? `+₹${val.toFixed(0)}` : `-₹${Math.abs(val).toFixed(0)}`;
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

function closeSlow(price, reason) {
    if (!SLOW.position) return;
    const dir = SLOW.position === "LONG" ? 1 : -1;
    const pnl = (price - SLOW.entryPrice) * dir * config.SLOW_LOT_MULT * config.SLOW_LOTS;
    const entry = SLOW.entryPrice;
    const pos = SLOW.position;

    SLOW.pnl += pnl;
    SLOW.trades++;

    const action = reason.includes("SL") || reason.includes("PROTECT") ? "STOP" : "EXIT";

    console.log(`→ SLOW ${pos} ${action} (${reason}) @ ${price.toFixed(2)}   PnL: ${pnl.toFixed(0)}`);

    tg(`→ SLOW ${pos} ${action} (${reason}) @ ₹${price.toFixed(2)}\n` +
       `Entry: ₹${entry.toFixed(2)} | PnL: ${pnlStr(pnl)}\n` +
       `Session SLOW: ${pnlStr(SLOW.pnl)}`);
}

function closeFast(price, reason) {
    if (!FAST.position) return;
    const dir = FAST.position === "LONG" ? 1 : -1;
    const pnl = (price - FAST.entryPrice) * dir * config.FAST_LOT_MULT * config.FAST_LOTS;
    const entry = FAST.entryPrice;
    const pos = FAST.position;

    FAST.pnl += pnl;
    FAST.trades++;

    const action = reason.includes("SL") || reason.includes("PROTECT") ? "STOP" : "EXIT";

    console.log(`→ FAST ${pos} ${action} (${reason}) @ ${price.toFixed(2)}   PnL: ${pnl.toFixed(0)}`);

    tg(`→ FAST ${pos} ${action} (${reason}) @ ₹${price.toFixed(2)}\n` +
       `Entry: ₹${entry.toFixed(2)} | PnL: ${pnlStr(pnl)}\n` +
       `Session FAST: ${pnlStr(FAST.pnl)}`);
}

module.exports = { closeSlow, closeFast, unrealisedSlow, unrealisedFast, pnlStr };