// test-depth-hub.js — depthHub with a fake KiteTicker: subscribe, full-mode tick -> browser message, unsubscribe, idle close.
"use strict";
const assert = require("assert");
const Module = require("module");
const events = {}; const calls = [];
class FakeTicker {
    constructor(o) { this.o = o; calls.push(["new", o.access_token]); this.modeFull = "full"; }
    autoReconnect() {} on(e, f) { events[e] = f; } connect() { calls.push(["connect"]); setImmediate(() => events.connect()); }
    subscribe(t) { calls.push(["sub", t]); } setMode(m, t) { calls.push(["mode", m, t]); } unsubscribe(t) { calls.push(["unsub", t]); } disconnect() { calls.push(["disconnect"]); }
}
const orig = Module._load;
Module._load = function (req, ...a) { return req === "kiteconnect" ? { KiteTicker: FakeTicker } : orig.call(this, req, ...a); };
const { createDepthHub } = require("./webdash/depthHub");
(async () => {
    const hub = createDepthHub({ getCreds: () => ({ apiKey: "k", accessToken: "tok1" }) });
    const sent = []; const ws = { readyState: 1, send: m => sent.push(JSON.parse(m)) };
    hub.subscribe(ws, { name: "ZINC", token: 123, key: "MCX:ZINC26OCTFUT" });
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(calls.find(c => c[0] === "mode"), ["mode", "full", [123]], "full mode on connect");
    events.ticks([{ instrument_token: 999, depth: { buy: [], sell: [] } }]);            // not subscribed: ignored
    events.ticks([{ instrument_token: 123, last_price: 419.5, volume_traded: 10, total_buy_quantity: 50, total_sell_quantity: 30,
        depth: { buy: [{ price: 419.4, quantity: 5, orders: 2 }, { price: 0, quantity: 0, orders: 0 }], sell: [{ price: 419.6, quantity: 7, orders: 1 }] } }]);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, "DEPTH"); assert.strictEqual(sent[0].name, "ZINC");
    assert.deepStrictEqual(sent[0].data.bids, [{ price: 419.4, qty: 5, orders: 2 }], "empty levels dropped");
    assert.strictEqual(sent[0].data.totalBuy, 50);
    hub.dropSocket(ws);
    events.ticks([{ instrument_token: 123, last_price: 420, depth: { buy: [{ price: 1, quantity: 1, orders: 1 }], sell: [] } }]);
    assert.strictEqual(sent.length, 1, "nothing after unsubscribe");
    assert.ok(calls.some(c => c[0] === "unsub"), "token unsubscribed when last viewer leaves");
    console.log("depth hub: 1 scenario passed"); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
