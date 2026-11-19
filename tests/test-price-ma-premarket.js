// End-to-end PAPER smoke of priceMaHedgeEngine.js with a fake Kite (ticker + REST), fake user registry, a controllable clock
// and a temp DB dir: base MIS legs at the base time, GREEN -> LONG NRML hedge in the SHORT account, RED flip, state file, EOD flatten + exit.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pma-"));
process.env.TALGO_DB_DIR = dir; process.env.INSTRUMENT_CSV_PATH = path.join(__dirname, "..", "MCX.csv");
Object.assign(process.env, { PMA_UNDERLYING: "NATGASMINI", PMA_LONG_USER: "AAA", PMA_SHORT_USER: "BBB", PMA_LOTMULT_OVERRIDE: "250", PMA_BASE_HOUR: "0", PMA_BASE_MINUTE: "0", PMA_EOD_HOUR: "23", PMA_EOD_MINUTE: "59", PMA_POLL_MS: "1000", PMA_CARRY: "false", PMA_CONTRACT_OVERRIDE: "NATGASMINI26JULFUT", LIVE_ORDERS_OVERRIDE: "false" });

let fakeNow = Date.UTC(2026, 10, 12, 2, 46, 0);       // 08:16 IST (pre-market), a minute boundary
const realNow = Date.now; Date.now = () => fakeNow;
let tickerHandlers = {}, exitCode = null;
const realExit = process.exit; process.exit = c => { exitCode = c; };
class FakeKc { constructor() {} setAccessToken() {} async getLTP(keys) { return Object.fromEntries(keys.map(k => [k, { last_price: 300 }])); } async getPositions() { return { net: [] }; } async getInstruments() { return []; } }
class FakeTicker { constructor() { tickerHandlers = {}; this.modeLTP = "ltp"; } on(e, f) { tickerHandlers[e] = f; } connect() { setTimeout(() => tickerHandlers.connect && tickerHandlers.connect(), 0); } subscribe(t) { TOKEN = t[0]; } setMode() {} }
const users = [{ name: "AAA", apiKey: "k", accessToken: "t" }, { name: "BBB", apiKey: "k2", accessToken: "t2" }];
const ltpEvents = [];
const origLoad = Module._load;
Module._load = function (req, parent, ...r) {
    if (req === "kiteconnect") return { KiteConnect: FakeKc, KiteTicker: FakeTicker };
    if (/core\/eventBridge$/.test(req)) return { emitEvent: (e, ty, pl) => { if (ty === "LTP") ltpEvents.push({ e, ...pl }); }, setEmitSuppressed() {}, setCurrentCandle() {} };
    if (/hedge\/dualHedgeUsers$/.test(req)) return { listUsers: () => users };
    return origLoad.call(this, req, parent, ...r);
};
const out = []; const rl = console.log; console.log = (...a) => { out.push(a.join(" ")); }; console.warn = console.error = (...a) => out.push("ERR " + a.map(x => (x && x.stack) || x).join(" "));
const wait = ms => new Promise(r => setTimeout(r, ms));
const stateFile = () => { const f = fs.readdirSync(dir).find(x => /^pma_.*\.json$/.test(x)); return f ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) : null; };
const minute = async (price) => { for (const p of [price - 0.1, price, price + 0.1]) { fakeNow += 1000; tickerHandlers.ticks([{ instrument_token: TOKEN, last_price: p }]); } fakeNow += 60000 - 3000; };
let TOKEN = null;
(async () => {
    try {
        require("../data/csvRepository");
        require("../priceMaHedgeEngine");
        for (let i = 0; i < 80 && !tickerHandlers.ticks; i++) await wait(100);
        assert.ok(tickerHandlers.ticks, "engine booted and subscribed");
        await wait(1500);
        assert.ok(out.some(l => /before market hours — bases will wait until 09:15/.test(l)), "early base time clamped to 09:15");
        await minute(100); await minute(100); await wait(1500);
        assert.ok(!out.some(l => /_BASE.*HedgeStatus=ACTIVE.*BASE/.test(l)), "no base entry before 09:15");
        fakeNow = Date.UTC(2026, 10, 12, 3, 46, 0);   // 09:16 IST
        await minute(100); await wait(1500);
        assert.ok(out.some(l => /LONG_BASE.*HedgeStatus=ACTIVE.*BASE/.test(l)), "bases enter once 09:15 is reached");
    } finally { Module._load = origLoad; }
})().then(() => { console.log = rl; rl("price-ma pre-market floor passed"); realExit(0); }).catch(e => { console.log = rl; rl(out.slice(-30).join("\n")); rl(e.stack); realExit(1); });
