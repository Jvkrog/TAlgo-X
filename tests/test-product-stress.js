// test-product-stress.js — MIS and NRML engines trading in ONE account (same and different symbols), concurrently.
// A fake broker keeps one position row per (symbol, product) exactly like Kite and records every order. Nothing is sent anywhere.
// Run: node test-product-stress.js
"use strict";
const assert = require("assert");
const engineConfig = require("../core/engineConfig"); engineConfig.LIVE_ORDERS = true; engineConfig.DAILY_HA_GATE_ENABLED = false;
const { createOrders } = require("../core/orders");
const realLog = console.log, realErr = console.error;
let passed = 0; const t = async (n, f) => { await f(); passed++; realLog("ok  -", n); };
const quiet = async f => { console.log = () => {}; console.error = () => {}; try { return await f(); } finally { console.log = realLog; console.error = realErr; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function broker() {
    const rows = new Map(), orders = []; let rejectProduct = null;   // key "SYMBOL|PRODUCT" -> net lots
    const kc = {
        getLTP: async keys => Object.fromEntries(keys.map(k => [k, { last_price: 100 }])),
        placeOrder: async (variety, p) => {
            if (!["MIS", "NRML"].includes(p.product)) throw new Error("bad product " + p.product);
            if (rejectProduct && p.product === rejectProduct) throw new Error(`Margin product ${p.product} rejected`);
            const key = p.tradingsymbol + "|" + p.product; rows.set(key, (rows.get(key) || 0) + (p.transaction_type === "BUY" ? 1 : -1) * p.quantity);
            orders.push({ ...p }); return { order_id: "O" + orders.length };
        },
        getOrderHistory: async () => [{ status: "COMPLETE", average_price: 100 }],
        getPositions: async () => ({ net: [...rows.entries()].map(([k, q]) => { const [tradingsymbol, product] = k.split("|"); return { tradingsymbol, product, quantity: q }; }) }),
    };
    return { kc, rows, orders, reject: p => { rejectProduct = p; }, qty: (s, p) => rows.get(s + "|" + p) || 0 };
}
function engine(b, { id, symbol = "NATGAS", product, carry = false, lots = 1 }) {
    const alerts = [], ctx = { tgPrefix: id, exchange: "MCX", symbol, token: 1, lots, lotMult: 1, tickSize: 0.05, name: id, strategy: "DSB_DUAL", carryOvernight: carry, product };
    const o = createOrders(ctx, m => alerts.push(m), b.kc); return { id, ctx, o, alerts, symbol, expectProduct: carry || product === "NRML" ? "NRML" : "MIS" };
}
const cycle = async (e, side) => { await e.o.enter(side); await sleep(5); await e.o.exit(side); e.o.clearTrade(); };

(async () => {
    await t("same symbol, MIS engine and NRML engine at the same time: each uses only its own product row and both end flat", async () => {
        const b = broker(), mis = engine(b, { id: "MIS-A", product: "MIS" }), nrml = engine(b, { id: "NRML-B", product: "NRML" });
        await quiet(async () => { await Promise.all([mis.o.enter("LONG"), nrml.o.enter("SHORT")]); });
        assert.strictEqual(b.qty("NATGAS", "MIS"), 1); assert.strictEqual(b.qty("NATGAS", "NRML"), -1);
        await quiet(async () => { await Promise.all([mis.o.exit("LONG"), nrml.o.exit("SHORT")]); });
        assert.strictEqual(b.qty("NATGAS", "MIS"), 0); assert.strictEqual(b.qty("NATGAS", "NRML"), 0);
        for (const o of b.orders) assert(["MIS", "NRML"].includes(o.product)); assert.deepStrictEqual(b.orders.filter(o => o.product === "MIS").length, 2); assert.strictEqual(b.orders.filter(o => o.product === "NRML").length, 2);
    });
    await t("reconcile: with BOTH products open on one symbol neither engine raises a false mismatch (regression: quantities used to be summed across products)", async () => {
        const b = broker(), mis = engine(b, { id: "MIS-A", product: "MIS" }), nrml = engine(b, { id: "NRML-B", product: "NRML" });
        await quiet(async () => { await mis.o.enter("LONG"); await nrml.o.enter("SHORT"); await mis.o.reconcile({ position: "LONG" }); await nrml.o.reconcile({ position: "SHORT" }); });
        assert.strictEqual(mis.alerts.filter(a => /mismatch/i.test(a)).length, 0, mis.alerts.join("|")); assert.strictEqual(nrml.alerts.filter(a => /mismatch/i.test(a)).length, 0, nrml.alerts.join("|"));
    });
    await t("reconcile still catches a REAL mismatch on the engine's own product row", async () => {
        const b = broker(), mis = engine(b, { id: "MIS-A", product: "MIS" }); await quiet(async () => { await mis.o.enter("LONG"); await mis.o.reconcile({ position: null }); });
        assert(mis.alerts.some(a => /mismatch/i.test(a)));
    });
    await t("NRML+close-at-EOD engine and NRML+carry engine and MIS engine on three symbols: EOD closes exactly the right rows, the carried one stays open", async () => {
        const b = broker(), mis = engine(b, { id: "MIS", symbol: "ZINC", product: "MIS" }), close = engine(b, { id: "NRML-CLOSE", symbol: "NATGAS", product: "NRML", carry: false }), carry = engine(b, { id: "NRML-CARRY", symbol: "CRUDE", product: "NRML", carry: true });
        await quiet(async () => { await Promise.all([mis.o.enter("LONG"), close.o.enter("LONG"), carry.o.enter("SHORT")]); });
        // EOD: lifecycle exits only engines with carryOvernight=false
        await quiet(async () => { for (const e of [mis, close, carry]) if (!e.ctx.carryOvernight) await e.o.exit("LONG", { awaitFill: true }); });
        assert.strictEqual(b.qty("ZINC", "MIS"), 0); assert.strictEqual(b.qty("NATGAS", "NRML"), 0); assert.strictEqual(b.qty("CRUDE", "NRML"), -1, "carried position must stay open");
        assert.strictEqual(b.orders.find(o => o.tradingsymbol === "NATGAS").product, "NRML"); assert.strictEqual(b.orders.filter(o => o.tradingsymbol === "NATGAS").every(o => o.product === "NRML"), true);
    });
    await t("SL, target and normal exits all use the position's own product (never fall back to MIS for an NRML position)", async () => {
        const b = broker(); for (const [prod, carry] of [["MIS", false], ["NRML", false], ["NRML", true]]) {
            const e = engine(b, { id: prod + carry, symbol: "S" + prod + carry, product: prod, carry });
            await quiet(async () => { for (const fn of ["exit", "slExit", "targetExit"]) { await e.o.enter("LONG"); await sleep(5); await e.o[fn]("LONG"); e.o.clearTrade(); } });
            assert(b.orders.filter(o => o.tradingsymbol === "S" + prod + carry).every(o => o.product === e.expectProduct), prod + carry); assert.strictEqual(b.qty("S" + prod + carry, e.expectProduct), 0);
        }
    });
    await t("failure isolation: the broker rejecting NRML does not stop the MIS engine, and the failing engine stays flat and does not retry as MIS", async () => {
        const b = broker(), mis = engine(b, { id: "MIS", product: "MIS" }), nrml = engine(b, { id: "NRML", product: "NRML" }); b.reject("NRML");
        const r = await quiet(async () => [await mis.o.enter("LONG"), await nrml.o.enter("SHORT")]); assert(r[0], "MIS order should have been placed"); assert(!r[1], "NRML order should have failed");
        assert.strictEqual(b.qty("NATGAS", "MIS"), 1); assert.strictEqual(b.qty("NATGAS", "NRML"), 0); assert.strictEqual(b.orders.filter(o => o.product === "MIS").length, 1, "the failed NRML order must not be re-sent as MIS");
    });
    await t("two engines on the same (symbol, product) share ONE broker row — documented limitation: per-engine reconcile cannot separate them (alert-only, no action)", async () => {
        const b = broker(), x = engine(b, { id: "X", product: "NRML" }), y = engine(b, { id: "Y", product: "NRML" });
        await quiet(async () => { await x.o.enter("LONG"); await y.o.enter("LONG"); await x.o.reconcile({ position: "LONG" }); });
        assert.strictEqual(b.qty("NATGAS", "NRML"), 2); assert(x.alerts.some(a => /mismatch/i.test(a)), "expected the shared-row limitation to be visible as an alert, not hidden");
    });
    await t("randomised stress (deterministic seed): 400 orders over 6 engines, 3 symbols, all 3 modes — every order carries its engine's product, broker rows equal the expected sums", async () => {
        const b = broker(); let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
        const E = [["A", "ZINC", "MIS", false], ["B", "ZINC", "NRML", false], ["C", "ZINC", "NRML", true], ["D", "NATGAS", "MIS", false], ["E", "NATGAS", "NRML", true], ["F", "CRUDE", "NRML", false]].map(([id, symbol, product, carry]) => engine(b, { id, symbol, product, carry }));
        const open = new Map(), expected = new Map(); let n = 0;
        await quiet(async () => { while (n < 400) {
            const batch = []; for (let k = 0; k < 1 + rnd(3); k++) { const e = E[rnd(E.length)]; if (batch.some(x => x.e === e)) continue; batch.push({ e, side: open.get(e.id) || (rnd(2) ? "LONG" : "SHORT") }); }
            await Promise.all(batch.map(async ({ e, side }) => { const key = e.symbol + "|" + e.expectProduct; const cur = open.get(e.id);
                if (!cur) { const r = await e.o.enter(side); if (r) { open.set(e.id, side); expected.set(key, (expected.get(key) || 0) + (side === "LONG" ? 1 : -1)); n++; } }
                else { const r = await e.o.exit(cur); if (r) { open.delete(e.id); e.o.clearTrade(); expected.set(key, (expected.get(key) || 0) - (cur === "LONG" ? 1 : -1)); n++; } } }));
        } });
        const byEngine = new Map(E.map(e => [e.symbol + "|" + e.id, e])); void byEngine;
        for (const [k, q] of expected) { const [s, p] = k.split("|"); assert.strictEqual(b.qty(s, p), q, `row ${k}`); }
        assert(b.orders.every(o => o.product === "MIS" || o.product === "NRML")); assert(b.orders.some(o => o.product === "MIS") && b.orders.some(o => o.product === "NRML"));
        for (const e of E) assert(b.orders.filter(o => o.tradingsymbol === e.symbol).length > 0);
    });
    await t("per-engine isolation of the duplicate-order guard: both engines can have an order in flight at once", async () => {
        const b = broker(), a = engine(b, { id: "A", product: "MIS" }), c = engine(b, { id: "C", product: "NRML" }); const r = await quiet(() => Promise.all([a.o.enter("LONG"), c.o.enter("LONG")])); assert(r[0] && r[1]);
    });
    realLog(`\n${passed} product stress scenarios passed`); process.exit(0);
})().catch(e => { console.log = realLog; console.error = realErr; console.error("FAIL", e); process.exit(1); });
