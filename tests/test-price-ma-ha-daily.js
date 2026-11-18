// End-to-end PAPER smoke of priceMaHedgeEngine.js with a fake Kite (ticker + REST), fake user registry, a controllable clock
// and a temp DB dir: base MIS legs at the base time, GREEN -> LONG NRML hedge in the SHORT account, RED flip, state file, EOD flatten + exit.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pma-"));
process.env.TALGO_DB_DIR = dir; process.env.INSTRUMENT_CSV_PATH = path.join(__dirname, "..", "MCX.csv");
Object.assign(process.env, { PMA_UNDERLYING: "NATGASMINI", PMA_LONG_USER: "AAA", PMA_SHORT_USER: "BBB", PMA_LOTMULT_OVERRIDE: "250", PMA_BASE_HOUR: "0", PMA_BASE_MINUTE: "0", PMA_EOD_HOUR: "23", PMA_EOD_MINUTE: "59", PMA_POLL_MS: "1000", PMA_CARRY: "true", PMA_CONTRACT_OVERRIDE: "NATGASMINI26JULFUT", PMA_BASE_RULE: "HA_DAILY", PMA_CHECK_MINUTES: "5", LIVE_ORDERS_OVERRIDE: "false" });

let fakeNow = Date.UTC(2026, 10, 12, 6, 0, 0);       // 11:30 IST, a minute boundary
const realNow = Date.now; Date.now = () => fakeNow;
let tickerHandlers = {}, exitCode = null;
const realExit = process.exit; process.exit = c => { exitCode = c; };
const DAILY = process.env.TEST_DAILY === "red" ? [30,29,28,27,26] : [26,27,28,29,30];
class FakeKc { constructor() {} async getHistoricalData() { return DAILY.map((c, i) => ({ date: new Date(Date.UTC(2026, 10, 1 + i)), open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 1 })); } setAccessToken() {} async getLTP(keys) { return Object.fromEntries(keys.map(k => [k, { last_price: /AUGFUT/.test(k) ? 150 : 300 }])); } async getPositions() { return { net: [] }; } async getInstruments() { return []; } }
class FakeTicker { constructor() { tickerHandlers = {}; this.modeLTP = "ltp"; } on(e, f) { tickerHandlers[e] = f; } connect() { setTimeout(() => tickerHandlers.connect && tickerHandlers.connect(), 0); } subscribe(t) { TOKEN = t[0]; TOKENS = t; } setMode() {} }
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
const minute = async (price) => { for (const p of [price - 0.1, price, price + 0.1]) { fakeNow += 1000; tickerHandlers.ticks([{ instrument_token: TOKEN, last_price: p }, { instrument_token: TOKENS[1], last_price: p / 2 }]); } fakeNow += 60000 - 3000; };
let TOKEN = null, TOKENS = [];
(async () => {
    try {
        const { createCsvRepository } = require("../data/csvRepository");
        require("../priceMaHedgeEngine");
        for (let i = 0; i < 80 && !tickerHandlers.ticks; i++) await wait(100);
        assert.ok(tickerHandlers.ticks, "engine booted and subscribed");
        await wait(1500);
        assert.ok(TOKEN, "subscribed to the contract token");
        const red = process.env.TEST_DAILY === "red", entered = k => out.some(l => new RegExp(k + " .*(ENTRY|entered|@ \\d)|\\[" + k + "\\]").test(l));
        assert.ok(out.some(l => /BASE RULE daily Heikin-Ashi colour/.test(l)), "banner names the rule");
        await minute(300); await wait(800); await minute(300); await wait(800);
        assert.ok(out.some(l => new RegExp("daily HA colour -> " + (red ? "red: SHORT" : "green: LONG")).test(l)), "colour read -> " + (red ? "SHORT" : "LONG"));
        const mine = red ? "SHORT_BASE" : "LONG_BASE", other = red ? "LONG_BASE" : "SHORT_BASE";
        assert.ok(out.some(l => l.includes(mine) && /@ \d/.test(l)), mine + " entered");
        assert.ok(!out.some(l => l.includes(other) && /@ \d/.test(l) && /ACTIVE|ENTRY|NRML/.test(l)), other + " never entered");
    } finally { Module._load = origLoad; }
})().then(() => { console.log = rl; if (process.env.PMA_DEBUG) rl(out.join("\n")); console.log("boot smoke passed"); realExit(0); }).catch(e => { console.log = rl; rl(out.slice(-25).join("\n")); rl(e.stack); realExit(1); });
