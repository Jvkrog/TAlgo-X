// Custom strategy runtime: a failed (null) broker order must not mutate engine state.
"use strict";
const assert = require("assert");
const { createCustomStrategy } = require("./strategies/customStrategyRuntime");
const cond = { op: "AND", conditions: [{ left: "price.close", operator: ">", right: 1 }] };
function mk(orders, state, exitCfg) {
    const spec = { name: "T", candleType: "raw", timeframe: "15m", indicators: [], entryLong: cond, entryShort: null, exitConfig: exitCfg || {} };
    const closed = [], inserted = [], saved = [];
    const r = createCustomStrategy(spec)({
        context: { tgPrefix: "X", token: 1, symbol: "S", lots: 1, lotMult: 1 },
        engineConfig: { ENGINE_ENABLED: true, LIVE_ORDERS: true, CHOP_GATE_ALWAYS_FORCE: false }, state,
        db: { savePosition: (...a) => saved.push(a), insertOpenTrade: async () => { inserted.push(1); return 1; } },
        candles: { getRawCandles: () => Array.from({ length: 40 }, () => ({ open: 1, high: 3, low: 1, close: 2, volume: 1 })), getLivePrice: () => 2 },
        slStore: { setTrail() {}, clearTrail() {} }, targetStore: { setTarget() {}, clearTarget() {} },
        orders, positionsClose: async () => closed.push(1), lifecycle: { isShutdown: () => false }, tg: () => {},
    });
    return { r, closed, inserted, saved };
}
(async () => {
    // 1) entry order fails -> stay flat, no DB trade row
    let calls = 0, st = { position: null };
    let m = mk({ enter: async () => { calls++; return null; }, exit: async () => null }, st);
    await m.r.processCandle({ close: 2 });
    assert.strictEqual(calls, 1, "entry attempted"); assert.strictEqual(st.position, null); assert.strictEqual(m.inserted.length, 0);
    // 2) entry succeeds -> position set (control)
    st = { position: null };
    m = mk({ enter: async () => "oid", exit: async () => "oid" }, st);
    await m.r.processCandle({ close: 2 });
    assert.strictEqual(st.position, "LONG"); assert.strictEqual(m.inserted.length, 1);
    // 3) exit order fails -> position kept, nothing closed
    st = { position: "LONG", positionSource: "T", entryPrice: 1 };
    m = mk({ enter: async () => "oid", exit: async () => null }, st, { conditionExit: cond });
    await m.r.processCandle({ close: 2 });
    assert.strictEqual(st.position, "LONG"); assert.strictEqual(m.closed.length, 0); assert.strictEqual(m.saved.length, 0);
    // 4) exit succeeds -> closed
    st = { position: "LONG", positionSource: "T", entryPrice: 1 };
    m = mk({ enter: async () => "oid", exit: async () => "oid" }, st, { conditionExit: cond });
    await m.r.processCandle({ close: 2 });
    assert.strictEqual(m.closed.length, 1);
    console.log("PASS custom-strategy order-failure handling (4 cases)");
})().catch(e => { console.error("FAIL", e); process.exit(1); });
