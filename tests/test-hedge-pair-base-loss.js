// PAPER smoke of hedgePairEngine.js HEDGE_RULE=BASE_LOSS (manual side): NRML core taken at deploy on the chosen side, opposite MIS hedge
// (same contract) when core P&L < 0 at a 5-min check, hedge closed when P&L > 0, both closed at EOD (23:15).
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpbl-"));
process.env.TALGO_DB_DIR = dir; process.env.INSTRUMENT_CSV_PATH = path.join(__dirname, "..", "MCX.csv");
Object.assign(process.env, { CORE_UNDERLYING: "NATGASMINI", HEDGE_UNDERLYING: "NATGASMINI", CORE_LOTS_OVERRIDE: "1", HEDGE_LOTS_OVERRIDE: "1", CORE_LOTMULT_OVERRIDE: "250", HEDGE_LOTMULT_OVERRIDE: "250", CORE_CARRY_OVERRIDE: "true", CORE_SYMBOL_OVERRIDE: "NATGASMINI26OCTFUT", HEDGE_SYMBOL_OVERRIDE: "NATGASMINI26OCTFUT", HEDGE_RULE: "BASE_LOSS", CORE_SIDE_OVERRIDE: "LONG", HEDGE_CHECK_MINUTES: "5", HEDGE_PNL_BAND: "0", LIVE_ORDERS_OVERRIDE: "false", UNWIND_MODE_OVERRIDE: "HA_FLIP" });
let fakeNow = Date.UTC(2026, 10, 12, 6, 0, 0);   // 11:30 IST
const RealDate = Date;
global.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(fakeNow); else super(...a); } static now() { return fakeNow; } };
let price = 300, exitCode = null; const realExit = process.exit; process.exit = c => { exitCode = c; };
let TH = {}, TOK = []; const tickEvents = [];
class FakeKc { setAccessToken() {} async getLTP() { throw new Error("REST getLTP must not be used in BASE_LOSS"); } async getPositions() { return { net: [] }; } async getInstruments() { return []; } }
const origLoad = Module._load;
Module._load = function (req, parent, ...r) {
    if (req === "kiteconnect") return { KiteConnect: FakeKc, KiteTicker: class { constructor() { TH = {}; } on(e, f) { TH[e] = f; } connect() { setTimeout(() => TH.connect && TH.connect(), 0); } subscribe(t) { TOK = t; } setMode() {} } };
    if (/core\/eventBridge$/.test(req)) return { emitEvent(e, t) { if (t === "TICK") tickEvents.push(e); }, setEmitSuppressed() {}, setCurrentCandle() {} };
    return origLoad.call(this, req, parent, ...r);
};
const out = []; const rl = console.log; console.log = (...a) => out.push(a.join(" ")); console.warn = console.error = (...a) => out.push("ERR " + a.map(x => (x && x.stack) || x).join(" "));
const wait = ms => new Promise(r => setTimeout(r, ms));
const count = re => out.filter(l => re.test(l)).length;
(async () => {
    try {
        const evs = [];
        const feed = () => TH.ticks && TOK.length && TH.ticks(TOK.map(t => ({ instrument_token: t, last_price: price })));
        const iv = setInterval(feed, 100);
        require("../hedgePairEngine");
        await wait(1500);
        assert.ok(out.some(l => /base-loss, manual side/.test(l)), "banner");
        assert.ok(out.some(l => /LONG NRML/.test(l) || /NRML.*LONG|LONG.*NRML/.test(l)), "core LONG NRML taken at deploy");
        assert.ok(!out.some(l => /OPEN SHORT MIS hedge/.test(l)), "no hedge while core flat of loss");
        assert.strictEqual(out.filter(l => /\*\*CORE ENTRY\*\*/.test(l)).length, 1, "core entered exactly once");
        fakeNow += 5 * 60000; price = 290; await wait(1600);   // core 300 -> 290 = loss
        assert.ok(out.some(l => /OPEN SHORT MIS hedge/.test(l)), "loss at the 5-min check -> opposite hedge");
        fakeNow += 5 * 60000; price = 310; await wait(1600);
        assert.ok(out.some(l => /CLOSE hedge/.test(l)), "profit -> hedge closed");
        assert.ok(out.some(l => /NET\s+unreal/.test(l)), "status block logged");
        clearInterval(iv); await wait(300); const n0 = tickEvents.length; await wait(2500);
        assert.strictEqual(tickEvents.length, n0, "no TICK events are looped while no websocket ticks arrive");
        assert.ok(n0 > 0, "TICK events flow while ticks arrive");
        setInterval(feed, 100);
        fakeNow = Date.UTC(2026, 10, 12, 17, 50, 0); await wait(1600);   // 23:20 IST
        assert.ok(out.some(l => /\*\*EOD\*\*/.test(l)), "EOD runs");
    assert.ok(!out.some(l => /REST getLTP/.test(l)), "no REST price used");
    } finally { Module._load = origLoad; }
})().then(() => { console.log = rl; if (process.env.HP_DEBUG) rl(out.join("\n")); rl("hedge-pair base-loss smoke passed"); realExit(0); }).catch(e => { console.log = rl; rl(out.slice(-40).join("\n")); rl(e.stack); realExit(1); });
