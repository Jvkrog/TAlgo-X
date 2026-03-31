// positions.js
const { tg } = require("./telegram");
const config = require("./config");
const { FAST } = require("./state");

function pnlStr(val) {
    return val >= 0 ? `+₹${val.toFixed(0)}` : `-₹${Math.abs(val).toFixed(0)}`;
}

function unrealisedFast(price) {
    if (!FAST.position) return 0;
    const dir = FAST.position === "LONG" ? 1 : -1;
    return (price - FAST.entryPrice) * dir * config.LOT_MULT * config.LOTS;
}

function closeFast(price, reason) {
    if (!FAST.position) return;

    const dir = FAST.position === "LONG" ? 1 : -1;
    const pnl = (price - FAST.entryPrice) * dir * config.LOT_MULT * config.LOTS;
    const entry = FAST.entryPrice;
    const pos = FAST.position;

    FAST.pnl += pnl;
    FAST.trades++;

    const action = reason.includes("SL") || reason.includes("PROTECT") ? "STOP" : "EXIT";

    console.log(`→ FAST ${pos} ${action} (${reason}) @ ${price.toFixed(2)}   PnL: ${pnl.toFixed(0)}`);

    tg(`→ FAST ${pos} ${action} (${reason}) @ ₹${price.toFixed(2)}\n` +
       `Entry: ₹${entry.toFixed(2)} | PnL: ${pnlStr(pnl)}\n` +
       `Session: ${pnlStr(FAST.pnl)}`);
}

module.exports = { closeFast, unrealisedFast, pnlStr };