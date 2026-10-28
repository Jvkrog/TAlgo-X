// backtestBroker.js — simulated fills, stands in for orders.js during a
// backtest. Mirrors its interface exactly: enter(side)/exit(side)/
// slExit(side) each resolve to an order id (never null here — see note
// below), reconcile(state) is a no-op.
//
// Why this can be this simple: a strategy's enter()/exit() return value is
// ONLY used as a null-check gate (`engineConfig.LIVE_ORDERS && ordered ===
// null`) — the actual fill PRICE always comes from candles.getLivePrice()
// in runSignals(), never from what orders.enter()/exit() returns. And
// since a backtest run always has engineConfig.LIVE_ORDERS === false, that
// gate evaluates false regardless of what this returns. Returning a real
// synthetic id (instead of just always resolving true/undefined) is done
// anyway, for two reasons: it matches orders.js's actual contract instead
// of relying on a gate side-effect, and it leaves room to simulate
// occasional rejects later (a real backtester feature — modeling that not
// every order fills) without changing this file's shape.
"use strict";

function createBacktestBroker() {
    let nextOrderId = 1;

    async function enter(side)  { return `BT-${nextOrderId++}`; }
    async function exit(side)   { return `BT-${nextOrderId++}`; }
    async function slExit(side) { return `BT-${nextOrderId++}`; }

    // Nothing to reconcile against — there is no broker. orders.js's real
    // reconcile() is also a no-op whenever LIVE_ORDERS is false, so this
    // just always takes that branch.
    async function reconcile(state) {}

    return { enter, exit, slExit, reconcile };
}

module.exports = { createBacktestBroker };
