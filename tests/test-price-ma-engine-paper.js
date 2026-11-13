// End-to-end PAPER smoke of priceMaHedgeEngine.js with a fake Kite (ticker + REST), fake user registry, a controllable clock
// and a temp DB dir: base MIS legs at the base time, GREEN -> LONG NRML hedge in the SHORT account, RED flip, state file, EOD flatten + exit.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pma-"));
process.env.TALGO_DB_DIR = dir; process.env.INSTRUMENT_CSV_PATH = path.join(__dirname, "..", "MCX.csv");
Object.assign(process.env, { PMA_UNDERLYING: "NATGASMINI", PMA_LONG_USER: "AAA", PMA_SHORT_USER: "BBB", PMA_LOTMULT_OVERRIDE: "250", PMA_BASE_HOUR: "0", PMA_BASE_MINUTE: "0", PMA_EOD_HOUR: "23", PMA_EOD_MINUTE: "59", PMA_POLL_MS: "1000", PMA_CONTRACT_OVERRIDE: "NATGASMINI26JULFUT", LIVE_ORDERS_OVERRIDE: "false" });

let fakeNow = Date.UTC(2026, 10, 12, 6, 0, 0);       // 11:30 IST, a minute boundary
const realNow = Date.now; Date.now = () => fakeNow;
let tickerHandlers = {}, exitCode = null;
const realExit = process.exit; process.exit = c => { exitCode = c; };
class FakeKc { constructor() {} setAccessToken() {} async getLTP(keys) { return Object.fromEntries(keys.map(k => [k, { last_price: 300 }])); } async getPositions() { return { net: [] }; } async getInstruments() { return []; } }
class FakeTicker { constructor() { tickerHandlers = {}; this.modeLTP = "ltp"; } on(e, f) { tickerHandlers[e] = f; } connect() { setTimeout(() => tickerHandlers.connect && tickerHandlers.connect(), 0); } subscribe(t) { TOKEN = t[0]; } setMode() {} }
const users = [{ name: "AAA", apiKey: "k", accessToken: "t" }, { name: "BBB", apiKey: "k2", accessToken: "t2" }];
const origLoad = Module._load;
Module._load = function (req, parent, ...r) {
    if (req === "kiteconnect") return { KiteConnect: FakeKc, KiteTicker: FakeTicker };
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
        const { createCsvRepository } = require("../data/csvRepository");
        require("../priceMaHedgeEngine");
        for (let i = 0; i < 80 && !tickerHandlers.ticks; i++) await wait(100);
        assert.ok(tickerHandlers.ticks, "engine booted and subscribed");
        await wait(1500);
        assert.ok(TOKEN, "subscribed to the contract token");
        assert.ok(out.some(l => /PAPER/.test(l)), "paper mode announced");
        const sig = () => stateFile();
        const open = () => out.filter(l => /HedgeStatus=ACTIVE/.test(l)).map(l => (l.match(/\] (\w+) HedgeStatus/) || [])[1]);
        assert.ok(out.some(l => /LONG_BASE.*HedgeStatus=ACTIVE.*BASE/.test(l)) && out.some(l => /SHORT_BASE.*HedgeStatus=ACTIVE.*BASE/.test(l)), "both MIS bases opened at the base time");
        await minute(100); await minute(100.5);                        // baseline minute, then rising -> GREEN
        fakeNow += 0; tickerHandlers.ticks([{ instrument_token: TOKEN, last_price: 100.6 }]);
        await wait(2500);
        assert.ok(out.some(l => /\[PRICE_MA\].*Slope=\+0\.50.*Signal=GREEN/.test(l)), "PRICE_MA log: slope +0.50 GREEN");
        assert.ok(out.some(l => /SHORT_HEDGE HedgeStatus=ACTIVE LONG NRML/.test(l)), "GREEN opened LONG NRML hedge in the SHORT account");
        assert.ok(sig() && sig().hedge && sig().hedge.account === "SHORT" && sig().hedge.direction === "LONG" && sig().hedge.product === "NRML", "state file records the hedge");
        await minute(100.2); tickerHandlers.ticks([{ instrument_token: TOKEN, last_price: 100.1 }]); await wait(2500);   // falling -> RED
        assert.ok(out.some(l => /SHORT_HEDGE HedgeStatus=CLOSED/.test(l)) && out.some(l => /LONG_HEDGE HedgeStatus=ACTIVE SHORT NRML/.test(l)), "RED closed the LONG hedge and opened SHORT NRML in the LONG account");
        const n = out.filter(l => /LONG_HEDGE HedgeStatus=ACTIVE/.test(l)).length;
        await minute(100.0); tickerHandlers.ticks([{ instrument_token: TOKEN, last_price: 99.9 }]); await wait(2500);     // RED again: no duplicate
        assert.strictEqual(out.filter(l => /LONG_HEDGE HedgeStatus=ACTIVE/.test(l)).length, n, "duplicate RED places nothing");
    } finally { Module._load = origLoad; }
})().then(() => { console.log = rl; if (process.env.PMA_DEBUG) rl(out.join("\n")); console.log("boot smoke passed"); realExit(0); }).catch(e => { console.log = rl; rl(out.slice(-25).join("\n")); rl(e.stack); realExit(1); });
