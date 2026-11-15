// LIVE-mode CARRY smoke (NRML bases held, MIS hedge) with a fake broker that nets per (account, symbol, product) like Kite:
//  stage 1: NRML bases + a base-loss MIS hedge open; at EOD ONLY the MIS hedge is closed, the NRML bases stay open at the broker
//  stage 2: next morning (new process): bases are recovered from DB + broker (no new base orders), a new hedge may open
//  stage 3: a base vanished at the broker -> the stale record is not adopted (cleared + alert) and one fresh base is entered, no duplicate
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const STAGE = process.env.PMA_TEST_STAGE;
if (!STAGE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmac-")), broker = path.join(dir, "broker.json");
    fs.writeFileSync(broker, JSON.stringify({ AAA: [], BBB: [], orders: 0 }));
    const run = (stage) => { const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, PMA_TEST_STAGE: String(stage), PMA_TEST_DIR: dir, PMA_TEST_BROKER: broker }, encoding: "utf8", timeout: 90000 }); if (r.status !== 0) { console.log(r.stdout.slice(-2500), r.stderr.slice(-1500)); throw new Error("stage " + stage + " failed"); } return r.stdout; };
    const rd = () => JSON.parse(fs.readFileSync(broker, "utf8"));
    run(1);
    let b = rd(); const row = (u, prod) => (b[u].find(r => r.product === prod) || { quantity: 0 });
    assert.strictEqual(row("AAA", "NRML").quantity, 1, "LONG account NRML long base held (separate row from the hedge)");
    assert.strictEqual(row("BBB", "NRML").quantity, -1, "SHORT account NRML short base held");
    assert.strictEqual(row("AAA", "MIS").quantity, 0, "MIS hedge closed at EOD");
    assert.strictEqual(b.orders, 4, "2 bases in, 1 MIS hedge in, 1 MIS hedge out");
    run(2); b = rd();
    assert.strictEqual(b.orders, 4, "next day: both NRML bases recovered, no order placed");
    assert.strictEqual(row("AAA", "NRML").quantity, 1); assert.strictEqual(row("BBB", "NRML").quantity, -1); assert.strictEqual(row("AAA", "MIS").quantity, 0);
    b.AAA = b.AAA.filter(r => r.product !== "NRML"); fs.writeFileSync(broker, JSON.stringify(b));   // the LONG base vanishes at the broker
    run(3); b = rd(); assert.strictEqual(b.orders, 5, "stage 3: the stale record was cleared and ONE fresh base entered (no duplicate)"); assert.strictEqual(row("AAA", "NRML").quantity, 1);
    console.log("all passed"); process.exit(0);
}
// ---------------- child ----------------
const Module = require("module");
process.env.TALGO_DB_DIR = process.env.PMA_TEST_DIR; process.env.INSTRUMENT_CSV_PATH = path.join(__dirname, "..", "MCX.csv");
Object.assign(process.env, { PMA_UNDERLYING: "NATGASMINI", PMA_LONG_USER: "AAA", PMA_SHORT_USER: "BBB", PMA_LOTMULT_OVERRIDE: "250", PMA_BASE_HOUR: "0", PMA_BASE_MINUTE: "0", PMA_EOD_HOUR: "23", PMA_EOD_MINUTE: "50", PMA_POLL_MS: "1000", PMA_CONTRACT_OVERRIDE: "NATGASMINI26JULFUT", LIVE_ORDERS_OVERRIDE: "true", PMA_CARRY: "true", PMA_MODE: "PNL" });
let fakeNow = Date.UTC(2026, 10, STAGE === "1" ? 12 : 12 + Number(STAGE) - 1, 6, 0, 0); Date.now = () => fakeNow;   // each stage is a new trading day
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
const realExit = process.exit; let engineExited = false; process.exit = c => { if (c) { rl(out.slice(-20).join("\n")); realExit(c); } engineExited = true; };
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    require("../priceMaHedgeEngine");
    for (let i = 0; i < 100 && !handlers.ticks; i++) await wait(100);
    assert.ok(handlers.ticks, "subscribed");
    const has = re => out.some(l => re.test(l));
    if (STAGE === "1") {
        for (let i = 0; i < 80 && !(has(/LONG_BASE HedgeStatus=ACTIVE/) && has(/SHORT_BASE HedgeStatus=ACTIVE/)); i++) await wait(250);
        assert.ok(has(/LONG_BASE HedgeStatus=ACTIVE LONG NRML/) && has(/SHORT_BASE HedgeStatus=ACTIVE SHORT NRML/), "bases are NRML");
        fakeNow += 1000; handlers.ticks([{ instrument_token: TOKEN, last_price: 100 }]); fakeNow += 60000;
        for (let i = 0; i < 80 && !has(/LONG_HEDGE HedgeStatus=ACTIVE SHORT MIS/); i++) await wait(250);
        assert.ok(has(/LONG_HEDGE HedgeStatus=ACTIVE SHORT MIS/), "base loss opened the MIS hedge");
        await wait(2500); fakeNow = Date.UTC(2026, 10, 12, 18, 20, 0);                     // 23:50 IST = EOD
        for (let i = 0; i < 120 && !engineExited; i++) await wait(250);
        assert.ok(engineExited, "engine finished at EOD");
        assert.ok(has(/LONG_HEDGE HedgeStatus=CLOSED/), "the MIS hedge was closed at EOD");
        assert.ok(!has(/LONG_BASE HedgeStatus=CLOSED/) && !has(/SHORT_BASE HedgeStatus=CLOSED/), "the NRML bases were NOT closed");
        assert.ok(has(/held overnight/), "EOD report says so");
    } else if (STAGE === "2") {
        await wait(2500);
        assert.ok(has(/LONG_BASE: resumed LONG@300 \(NRML, broker confirmed\)/) && has(/SHORT_BASE: resumed SHORT@300 \(NRML, broker confirmed\)/), "NRML bases recovered from DB + broker");
        assert.ok(!has(/LONG_BASE HedgeStatus=ACTIVE/), "no new base order");
        assert.ok(!has(/BLOCKED/), "nothing blocked");
    } else {
        await wait(2500);
        assert.ok(has(/LONG_BASE: DB says LONG but the broker shows 0 NRML lots — NOT adopted/), "vanished base is not adopted");
        for (let i = 0; i < 40 && !has(/LONG_BASE HedgeStatus=ACTIVE LONG NRML/); i++) await wait(250);
    }
    realExit(0);
})().catch(e => { rl(out.slice(-25).join("\n")); rl(e.stack); realExit(1); });
