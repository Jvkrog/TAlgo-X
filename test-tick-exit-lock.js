// candlePoll tick exits: ticks arriving while a stop exit is in flight must not spawn extra exits or false "SL order FAILED" alerts,
// and a genuinely failed exit must still be retried on a later tick.
const assert = require("assert"), engineConfig = require("./engineConfig"); engineConfig.LIVE_ORDERS = true; engineConfig.ENGINE_ENABLED = true;
const { createOrders } = require("./orders"), { createCandlePoll } = require("./candlePoll"), { createSLStore } = require("./sl"), { createState } = require("./state");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function scenario(failFirst) {
    let placed = 0, attempts = 0, closes = 0; const tgs = [];
    const kc = { getLTP: async () => ({ "MCX:X": { last_price: 100 } }), getOrderHistory: async () => [{ status: "COMPLETE", average_price: 99.9 }],
        placeOrder: async () => { await sleep(300); attempts++; if (failFirst && attempts === 1) throw new Error("rejected"); placed++; return { order_id: "1" }; } };
    const context = { tgPrefix: "T", symbol: "X", exchange: "MCX", tickSize: 0.05, lots: 1, lotMult: 1, product: "MIS", carryOvernight: false, dailyHaGateEnabled: false };
    const state = createState(); state.position = "LONG"; state.entryPrice = 105; state.openTradeId = 1; const sl = createSLStore(); sl.setTrail(100, 1);
    const orders = createOrders(context, m => tgs.push(String(m).split("\n")[0]), kc);
    const poll = createCandlePoll({ context, engineConfig, state, candles: {}, slStore: sl, targetStore: { getTarget: () => ({ target: null }), clearTarget() {} }, orders,
        positionsClose: async () => { closes++; await sleep(50); state.position = null; }, processCandle: async () => {}, db: { savePosition() {} }, tg: m => tgs.push(String(m).split("\n")[0]) });
    const log = console.log, err = console.error; console.log = () => {}; console.error = () => {};
    try { const ticks = []; for (let i = 0; i < 8; i++) { ticks.push(poll.checkSL(99 - i * 0.1)); await sleep(150); } await Promise.all(ticks); await sleep(500); } finally { console.log = log; console.error = err; }
    return { placed, attempts, closes, tgs };
}
(async () => {
    let fail = 0; const t = async (n, f) => { try { await f(); console.log("  ok   " + n); } catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); } };
    await t("burst of ticks during the exit: one order, one booking, no false FAILED alert", async () => { const r = await scenario(false); assert.strictEqual(r.placed, 1); assert.strictEqual(r.closes, 1); assert.ok(!r.tgs.some(x => /FAILED/.test(x)), JSON.stringify(r.tgs)); });
    await t("a rejected exit is retried on the next tick and then booked once", async () => { const r = await scenario(true); assert.strictEqual(r.attempts, 2); assert.strictEqual(r.placed, 1); assert.strictEqual(r.closes, 1); });
    console.log(fail ? `\n${fail} FAILED` : "\nall passed"); process.exit(fail ? 1 : 0);
})();
