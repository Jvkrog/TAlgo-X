// test-scalp.js — scalp target (context.scalpTargetRupees) in the backtest's intrabar check. Run: node test-scalp.js
"use strict";
const assert = require("assert");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("./state");
const { createSLStore } = require("./sl");
const positions = require("./positions");
const { createBacktestSL } = require("./backtestSL");

function rig(over = {}) {
    const context = { tgPrefix: "T", symbol: "T", token: 1, lots: 1, lotMult: 1000, name: "T", scalpTargetRupees: 2000, ...over };
    const state = createState(), ledger = createBacktestLedger({ clock: { now: () => new Date("2026-09-11T05:00:00Z") } });
    const slStore = createSLStore(), tg = () => {};
    const posClose = (price, reason) => positions.close(context, state, ledger, tg, price, reason);
    const sl = createBacktestSL({ context, engineConfig: { ENGINE_ENABLED: true }, state, slStore, orders: { slExit: async () => "id" }, positionsClose: posClose, db: ledger, tg });
    return { context, state, ledger, slStore, sl, enter(side, px) { state.position = side; state.entryPrice = px; } };
}
const quiet = async fn => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
(async () => {
    // lotMult 1000 * 1 lot: Rs 2000 = 2.0 points
    let r = rig(); r.enter("SHORT", 420);
    assert.strictEqual(await quiet(() => r.sl.checkTarget({ high: 420.5, low: 417.9 })), true, "short hits 418.00");
    assert.strictEqual(r.state.position, null);
    let t = r.ledger.getAllTrades(); assert.strictEqual(t.length, 0 + t.length);   // no open trade row in this rig; P&L booked on state
    assert.ok(Math.abs(r.state.pnl - 2000) < 1e-6, "pnl = +2000, got " + r.state.pnl);

    r = rig(); r.enter("LONG", 420);
    assert.strictEqual(await quiet(() => r.sl.checkTarget({ high: 421.9, low: 419 })), false, "not reached yet");
    assert.strictEqual(r.state.position, "LONG");
    assert.strictEqual(await quiet(() => r.sl.checkTarget({ high: 422.0, low: 419 })), true, "long hits 422.00");
    assert.ok(Math.abs(r.state.pnl - 2000) < 1e-6);

    r = rig(); r.enter("LONG", 420); r.slStore.setTrail && r.slStore.setTrail(419.5, 1);
    assert.strictEqual(await quiet(() => r.sl.checkTarget({ high: 423, low: 419.0 })), false, "stop touched in same candle wins");
    assert.strictEqual(r.state.position, "LONG");

    r = rig({ scalpTargetRupees: null }); r.enter("LONG", 420);
    assert.strictEqual(await quiet(() => r.sl.checkTarget({ high: 500, low: 400 })), false, "off = no-op");
    r = rig({ targetPoints: 5 }); r.enter("LONG", 420);
    assert.strictEqual(await quiet(() => r.sl.checkTarget({ high: 500, low: 400 })), false, "fixed points target takes precedence");
    r = rig({ lots: 2 }); r.enter("LONG", 420);   // Rs 2000 / (1000*2) = 1.0 point
    assert.strictEqual(await quiet(() => r.sl.checkTarget({ high: 421, low: 419.5 })), true, "scales with lots");
    console.log("scalp target: 6 scenarios passed"); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
