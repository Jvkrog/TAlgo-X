// positions.js — position close + PnL math.
//
// CHANGED:
//   - No more `require("./config")` / `require("./state")` / `require("./db")` /
//     `require("./telegram")` at module scope. Every function now takes
//     (context, state, db, tg, ...) explicitly — context/state/db from their
//     respective factories, tg from createTelegram(context, engineConfig) —
//     all instantiated once by engine.js and passed down.
//   - Dropped "Fast" naming: closeFast → close, unrealisedFast → unrealised.
//     There's one Brain now, not a fast/slow pair, so the qualifier was
//     just noise.
"use strict";

const c = require("./c");
const { emitEvent } = require("./eventBridge"); // web dashboard only, see eventBridge.js header

function pnlStr(val) {
    return (val >= 0 ? "+" : "") + val.toFixed(2);
}

function unrealised(context, state, price) {
    if (!state.position) return 0;
    const dir = state.position === "LONG" ? 1 : -1;
    return (price - state.entryPrice) * dir * context.lotMult * context.lots;
}

async function close(context, state, db, tg, price, reason) {
    if (!state.position) return;
    const dir   = state.position === "LONG" ? 1 : -1;
    const pnl   = (price - state.entryPrice) * dir * context.lotMult * context.lots;
    const entry = state.entryPrice;
    const pos   = state.position;

    state.pnl    += pnl;
    state.trades += 1;
    await db.closeTrade(state.openTradeId, price, pnl, reason);
    state.openTradeId = null;
    state.position     = null;
    state.entryPrice   = 0;
    state.stDir        = 0;
    state.peakDPI       = 0;
    state.positionSource = null;

    const action = reason.includes("SL") ? "STOP" : "EXIT";
    const col    = pnl > 0 ? c.green : pnl < 0 ? c.red : c.white;
    console.log();
    console.log(col(`${pos} ${action} @ ${price.toFixed(2)}`));
    console.log(col(`    reason: ${reason}  entry: ${entry.toFixed(2)}`));
    console.log(col(`    pnl: ${pnlStr(pnl)}  session: ${pnlStr(state.pnl)}`));
    console.log();
    tg(`${pos} ${action} (${reason})\n@ ₹${price.toFixed(2)}  entry ₹${entry.toFixed(2)}\nPnL: ${pnlStr(pnl)}  session: ${pnlStr(state.pnl)}`);
    emitEvent(context.tgPrefix, "EXIT", { side: pos, action, price, entry, reason, pnl, session: state.pnl });
}

module.exports = { close, unrealised, pnlStr };
