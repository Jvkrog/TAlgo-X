// test-dsb-dual.js — scenario tests for DSB_DUAL (two Dynamic Step Bands must agree). Run: node test-dsb-dual.js
"use strict";
const assert = require("assert");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("./state");
const { createSLStore } = require("./sl");
const { createTargetStore } = require("./target");
const positions = require("./positions");
const { toHA } = require("./indicators");
const { createBandStepper } = require("./dynamicBandReader");
const engineConfig = { ...require("./engineConfig") };
const { createDsbDualStrategy } = require("./strategies");
engineConfig.ENGINE_ENABLED = true; engineConfig.LIVE_ORDERS = false; engineConfig.CHOP_GATE_ALWAYS_FORCE = false;
engineConfig.BAND_STEP_DEFAULT = 1; engineConfig.ST_ATR_LEN = 3;

const IST = 5.5 * 3600000;
function rig(mode) {
    let now = new Date(Date.UTC(2026, 8, 11, 10) - IST);
    const clock = { now: () => now };
    const ledger = createBacktestLedger({ clock });
    ["countLosingFlipExitsSince", "countScalpTpSince", "countLosingTradesSince", "countWinningTradesSince"].forEach(k => ledger[k] = async () => 0);
    const context = { tgPrefix: "T", symbol: "T", token: 1, lots: 1, lotMult: 1, name: "T", strategy: "DSB_DUAL", bandStep: 1, bandStep2: 2, dsbDualMode: mode,
        chopFilterEnabled: false, htfGateEnabled: false, dailyHaGateEnabled: false };
    const state = createState(); const raw = []; let candle = null;
    const feed = { getLivePrice: () => candle && candle.close, getRawCandles: () => raw, getSourceCandles: () => raw, onTick() {} };
    const nop = () => {};
    const strat = createDsbDualStrategy({ context, engineConfig, state, db: ledger, candles: feed, slStore: createSLStore(), targetStore: createTargetStore(),
        orders: { enter: async () => "id", exit: async () => "id", slExit: async () => "id", reconcile: async () => {} },
        positionsClose: (p, r) => positions.close(context, state, ledger, nop, p, r), positionsUnrealised: p => positions.unrealised(context, state, p),
        lifecycle: { isShutdown: () => false }, tg: nop, clock, htf: { isBlocked: async () => false }, dailyHa: { isBlocked: async () => false } });
    return { state, raw, async feedBar(i, open, close) {
        now = new Date(now.getTime() + 60000); candle = { open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, close, date: now.toISOString() };
        raw.push(candle); await strat.processCandle(candle); } };
}
const quiet = async fn => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const col = d => d ? (d.position === "SHORT" ? "red" : d.position === "LONG" ? "green" : "none") : "none";

// Independent reference state machine: same rules, written separately from the strategy.
function refStep(mode, pos, c1, c2) {
    const bull = c1 === "green" && c2 === "green", bear = c1 === "red" && c2 === "red";
    if (pos) {
        const want = pos === "LONG" ? "green" : "red", opp = pos === "LONG" ? "red" : "green";
        const exit = mode === "HOLD" ? (c1 === opp && c2 === opp) : mode === "EXIT" ? c1 === opp : !(c1 === want && c2 === want);
        if (exit) pos = null;
    }
    if (!pos) pos = bull ? "LONG" : bear ? "SHORT" : null;
    return pos;
}
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
(async () => {
    for (const mode of ["HOLD", "EXIT", "DISAGREE"]) {
        const r = rig(mode); let price = 100, expect = null, disagreeSeen = 0, flipsHeld = 0;
        for (let i = 0; i < 400; i++) {
            const open = price; price = Math.max(50, price + (rnd() - 0.5) * 3 + Math.sin(i / 20) * 0.8);
            await quiet(() => r.feedBar(i, open, price));
            if (r.raw.length < engineConfig.ST_ATR_LEN + 6) continue;
            const ha = toHA(r.raw), s1 = createBandStepper(1), s2 = createBandStepper(2);
            for (const k of ha) { s1.push(k); s2.push(k); }
            const c1 = col(s1.state()), c2 = col(s2.state());
            expect = refStep(mode, expect, c1, c2);
            assert.strictEqual(r.state.position, expect, `${mode} candle ${i}: c1=${c1} c2=${c2} got ${r.state.position} want ${expect}`);
            if (c1 !== c2) disagreeSeen++;
            if (mode === "HOLD" && r.state.position && c1 !== c2) flipsHeld++;
        }
        assert(disagreeSeen > 5, `${mode}: scenario never produced a DSB disagreement (${disagreeSeen})`);
        if (mode === "HOLD") assert(flipsHeld > 0, "HOLD: never held through a disagreement");
        console.log("ok  -", mode, `matches the reference state machine over 400 candles (${disagreeSeen} disagreeing candles)`);
    }
    // disagree + flat = no trade
    const r = rig("HOLD");
    for (let i = 0; i < 30; i++) await quiet(() => r.feedBar(i, 100, 100));
    assert.strictEqual(r.state.position, null);
    console.log("ok  - flat market: no trade");
    process.exit(0);
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
