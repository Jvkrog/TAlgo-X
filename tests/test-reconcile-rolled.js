// reconcile(): a position left on the previous contract after a roll must raise an alert (it used to be invisible).
"use strict";
const assert = require("assert"), engineConfig = require("../core/engineConfig"); engineConfig.LIVE_ORDERS = true;
const { createOrders } = require("../core/orders"), { createState } = require("../core/state");
async function run(net) {
    const tgs = []; const kc = { getPositions: async () => ({ net }) };
    const o = createOrders({ tgPrefix: "T", symbol: "ZINCMINI26NOVFUT", exchange: "MCX", tickSize: 0.05, lots: 1, lotMult: 1, product: "MIS", carryOvernight: false }, m => tgs.push(String(m)), kc);
    const log = console.log; console.log = () => {}; try { await o.reconcile(createState()); } finally { console.log = log; }
    return tgs;
}
(async () => {
    let t = await run([{ tradingsymbol: "ZINCMINI26OCTFUT", product: "MIS", quantity: 1 }]);
    assert(t.some(m => /ZINCMINI26OCTFUT/.test(m) && /contract roll/.test(m)), "old-contract position flagged");
    t = await run([{ tradingsymbol: "ZINCMINI26OCTFUT", product: "NRML", quantity: 1 }, { tradingsymbol: "LEADMINI26OCTFUT", product: "MIS", quantity: 1 }, { tradingsymbol: "ZINCMINI26OCTFUT", product: "MIS", quantity: 0 }]);
    assert.strictEqual(t.length, 0, "other product / other instrument / flat rows are not flagged: " + t);
    console.log("PASS reconcile flags a position left on the previous contract"); process.exit(0);
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
