// End-to-end PAPER smoke of priceMaHedgeEngine.js with a fake Kite (ticker + REST), fake user registry, a controllable clock
// and a temp DB dir: base MIS legs at the base time, GREEN -> LONG NRML hedge in the SHORT account, RED flip, state file, EOD flatten + exit.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pma-"));
process.env.TALGO_DB_DIR = dir; process.env.INSTRUMENT_CSV_PATH = path.join(__dirname, "..", "MCX.csv");
Object.assign(process.env, { PMA_UNDERLYING: "NATGASMINI", PMA_LONG_USER: "AAA", PMA_SHORT_USER: "BBB", PMA_LOTMULT_OVERRIDE: "250", PMA_ALLOW_EARLY_BASE: "true", PMA_BASE_HOUR: "0", PMA_BASE_MINUTE: "0", PMA_EOD_HOUR: "23", PMA_EOD_MINUTE: "59", PMA_POLL_MS: "1000", PMA_CARRY: "false", PMA_CONTRACT_OVERRIDE: "NATGASMINI26JULFUT", PMA_HEDGE_CONTRACT: "NEXT", LIVE_ORDERS_OVERRIDE: "false" });

let fakeNow = Date.UTC(2026, 10, 12, 6, 0, 0);       // 11:30 IST, a minute boundary
const realNow = Date.now; Date.now = () => fakeNow;
let tickerHandlers = {}, exitCode = null;
const realExit = process.exit; process.exit = c => { exitCode = c; };
class FakeKc { constructor() {} setAccessToken() {} async getLTP(keys) { return Object.fromEntries(keys.map(k => [k, { last_price: /AUGFUT/.test(k) ? 150 : 300 }])); } async getPositions() { return { net: [] }; } async getInstruments() { return []; } }
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
        assert.strictEqual(TOKENS.length, 2, "base AND next-month hedge contract are subscribed");
        assert.ok(out.some(l => /hedge contract NATGASMINI\w+ \(calendar spread vs NATGASMINI26JULFUT\)/.test(l)), "calendar-spread hedge announced");
        await minute(300); await wait(500); await minute(100); await wait(2500);
        const st = stateFile();
        assert.ok(st && st.hedges.length === 1, "LONG base under water -> one hedge");
        const hl = out.find(l => /LONG_HEDGE HedgeStatus=ACTIVE SHORT NRML @ (\d+\.\d+)/.test(l));
        assert.ok(hl, "hedge opened"); const px = Number(hl.match(/@ (\d+\.\d+)/)[1]);
        assert.ok(Math.abs(px - 150) < 1, `hedge entry ${px} comes from the HEDGE contract price (150), not the base price (300)`);
        const hev = ltpEvents.filter(x => /_PMA_LONG_HEDGE$/.test(x.e)).pop(), bev = ltpEvents.filter(x => /_PMA_LONG_BASE$/.test(x.e)).pop();
        assert.ok(hev && bev && Math.abs(bev.price - 2 * hev.price) < 1, "hedge LTP events carry the hedge contract price");
    } finally { Module._load = origLoad; }
})().then(() => { console.log = rl; if (process.env.PMA_DEBUG) rl(out.join("\n")); console.log("boot smoke passed"); realExit(0); }).catch(e => { console.log = rl; rl(out.slice(-25).join("\n")); rl(e.stack); realExit(1); });
