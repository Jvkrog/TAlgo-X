// LIVE-mode NRML-carry smoke with a fake broker that NETS positions per (account, symbol, product) like Kite:
//  stage 1: bases (NRML) open, a base loss opens the hedge in the same NRML row (net 0 at the broker)
//  stage 2: a new process recovers all legs from DB + the account NET quantity, places no orders
//  stage 3: the broker net is tampered with -> that account's legs are BLOCKED, no orders
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const STAGE = process.env.PMA_TEST_STAGE;
if (!STAGE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmac-")), broker = path.join(dir, "broker.json");
    fs.writeFileSync(broker, JSON.stringify({ AAA: [], BBB: [], orders: 0 }));
    const run = (stage) => { const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, PMA_TEST_STAGE: String(stage), PMA_TEST_DIR: dir, PMA_TEST_BROKER: broker }, encoding: "utf8", timeout: 90000 }); if (r.status !== 0) { console.log(r.stdout.slice(-2500), r.stderr.slice(-1500)); throw new Error("stage " + stage + " failed"); } return r.stdout; };
    const rd = () => JSON.parse(fs.readFileSync(broker, "utf8"));
    run(1);
    let b = rd(); const row = u => (b[u].find(r => r.product === "NRML") || {});
    assert.strictEqual(row("AAA").quantity, 0, "LONG account: base +1 and hedge -1 net to 0 in ONE NRML row");
    assert.strictEqual(row("BBB").quantity, -1, "SHORT account: only the SHORT NRML base");
    const orders1 = b.orders; assert.strictEqual(orders1, 3, "3 orders: 2 bases + 1 hedge");
    run(2); b = rd(); assert.strictEqual(b.orders, orders1, "restart recovered everything, placed no order");
    b.AAA.find(r => r.product === "NRML").quantity = 5; fs.writeFileSync(broker, JSON.stringify(b));
    run(3); b = rd(); assert.strictEqual(b.orders, orders1, "blocked account placed no order");
    console.log("all passed"); process.exit(0);
}
// ---------------- child ----------------
const Module = require("module");
process.env.TALGO_DB_DIR = process.env.PMA_TEST_DIR; process.env.INSTRUMENT_CSV_PATH = path.join(__dirname, "..", "MCX.csv");
Object.assign(process.env, { PMA_UNDERLYING: "NATGASMINI", PMA_LONG_USER: "AAA", PMA_SHORT_USER: "BBB", PMA_LOTMULT_OVERRIDE: "250", PMA_BASE_HOUR: "0", PMA_BASE_MINUTE: "0", PMA_EOD_HOUR: "23", PMA_EOD_MINUTE: "59", PMA_POLL_MS: "1000", PMA_CONTRACT_OVERRIDE: "NATGASMINI26JULFUT", LIVE_ORDERS_OVERRIDE: "true", PMA_CARRY: "true", PMA_MODE: "PNL" });
let fakeNow = Date.UTC(2026, 10, 12, 6, 0, 0); Date.now = () => fakeNow;
const bf = process.env.PMA_TEST_BROKER, rdB = () => JSON.parse(fs.readFileSync(bf, "utf8")), wrB = o => fs.writeFileSync(bf, JSON.stringify(o));
let handlers = {}, TOKEN = null; const orderBook = {};
class FakeKc {
    setAccessToken(t) { this.u = t === "t" ? "AAA" : "BBB"; }
    async getLTP(keys) { return Object.fromEntries(keys.map(k => [k, { last_price: 300 }])); }
    async getPositions() { return { net: rdB()[this.u] }; }
    async getInstruments() { return []; }
    async placeOrder(v, p) { const b = rdB(); b.orders++; let r = b[this.u].find(x => x.tradingsymbol === p.tradingsymbol && x.product === p.product);
        if (!r) { r = { tradingsymbol: p.tradingsymbol, exchange: p.exchange, product: p.product, quantity: 0 }; b[this.u].push(r); }
        r.quantity += (p.transaction_type === "BUY" ? 1 : -1) * p.quantity; wrB(b); const id = "O" + b.orders; orderBook[id] = p.quantity; return { order_id: id }; }
    async getOrderHistory(id) { return [{ status: "COMPLETE", filled_quantity: orderBook[id], average_price: 300 }]; }
    async cancelOrder() {}
}
class FakeTicker { constructor() { handlers = {}; this.modeLTP = "ltp"; } on(e, f) { handlers[e] = f; } connect() { setTimeout(() => handlers.connect && handlers.connect(), 0); } subscribe(t) { TOKEN = t[0]; } setMode() {} }
const users = [{ name: "AAA", apiKey: "k", accessToken: "t" }, { name: "BBB", apiKey: "k2", accessToken: "t2" }];
const orig = Module._load; Module._load = function (req, parent, ...r) {
    if (req === "kiteconnect") return { KiteConnect: FakeKc, KiteTicker: FakeTicker };
    if (/hedge\/dualHedgeUsers$/.test(req)) return { listUsers: () => users };
    return orig.call(this, req, parent, ...r);
};
const out = []; const rl = console.log; console.log = (...a) => out.push(a.join(" ")); console.warn = console.error = (...a) => out.push("ERR " + a.join(" "));
const realExit = process.exit; process.exit = c => { if (c) { rl(out.slice(-20).join("\n")); } realExit(c); };
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    require("../priceMaHedgeEngine");
    for (let i = 0; i < 100 && !handlers.ticks; i++) await wait(100);
    assert.ok(handlers.ticks, "subscribed");
    const has = re => out.some(l => re.test(l));
    if (STAGE === "1") {
        for (let i = 0; i < 80 && !(has(/LONG_BASE HedgeStatus=ACTIVE/) && has(/SHORT_BASE HedgeStatus=ACTIVE/)); i++) await wait(250);
        assert.ok(has(/LONG_BASE HedgeStatus=ACTIVE LONG NRML/) && has(/SHORT_BASE HedgeStatus=ACTIVE SHORT NRML/), "bases are NRML in carry mode");
        fakeNow += 1000; handlers.ticks([{ instrument_token: TOKEN, last_price: 100 }]); fakeNow += 60000;
        for (let i = 0; i < 80 && !has(/LONG_HEDGE HedgeStatus=ACTIVE SHORT NRML/); i++) await wait(250);
        assert.ok(has(/LONG_HEDGE HedgeStatus=ACTIVE SHORT NRML/), "base loss opened the hedge");
    } else if (STAGE === "2") {
        await wait(3500);
        assert.ok(has(/LONG_BASE: resumed LONG@300 \(NRML carry, broker net 0 == expected 0\)/), "LONG base resumed against the account NET");
        assert.ok(has(/LONG_HEDGE: resumed SHORT@300/) && has(/SHORT_BASE: resumed SHORT@300/), "hedge + short base resumed");
        assert.ok(!has(/BLOCKED/), "nothing blocked");
    } else {
        await wait(3500);
        assert.ok(has(/LONG account: broker net NRML 5 lots .* != expected 0.*BLOCKED/), "tampered net blocks the LONG account's legs");
        assert.ok(!has(/SHORT account:.*BLOCKED/) && has(/SHORT_BASE: resumed SHORT@300/), "the SHORT account is unaffected");
    }
    realExit(0);
})().catch(e => { rl(out.slice(-25).join("\n")); rl(e.stack); realExit(1); });
