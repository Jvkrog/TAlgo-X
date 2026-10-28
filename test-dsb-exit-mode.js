// test-dsb-exit-mode.js — scenario tests for losingSwitchGate.js wired into DYNAMIC_BAND (same gate code the
// other DSB-family strategies use). Run: node test-losing-switch.js
"use strict";
const assert = require("assert");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("./state");
const { createSLStore } = require("./sl");
const { createTargetStore } = require("./target");
const positions = require("./positions");
const engineConfig = { ...require("./engineConfig") };
const { createDynamicMidColorStrategy } = require("./strategies");

engineConfig.ENGINE_ENABLED = true; engineConfig.LIVE_ORDERS = false;
engineConfig.CHOP_GATE_ALWAYS_FORCE = false; engineConfig.BAND_STEP_DEFAULT = 1;

const IST = 5.5 * 3600000;
const at = (day, hh, mm = 0) => new Date(Date.UTC(2026, 8, day, hh, mm) - IST);   // IST wall time on Sep <day>

function rig({ max, maxTrades, exitMode, ledger, exitFails = () => false } = {}) {
    let now = at(11, 10);
    const clock = { now: () => now };
    ledger = ledger || createBacktestLedger({ clock });
    // the in-memory ledger has no journal query; same semantics as db.js's countLosingFlipExitsSince
    ledger.countLosingFlipExitsSince = async (engine, reasons, sinceIso) =>
        ledger.getAllTrades().filter(t => t.status === "CLOSED" && t.pnl < 0 && reasons.includes(t.exit_reason) && t.exit_time >= sinceIso).length;
    ledger.countLosingTradesSince = async (engine, sinceIso) =>
        ledger.getAllTrades().filter(t => t.status === "CLOSED" && t.pnl < 0 && t.exit_time >= sinceIso).length;
    const context = { tgPrefix: "T", symbol: "T", token: 1, lots: 1, lotMult: 1, name: "T", strategy: "DYNAMIC_MID_COLOR", maxLosingSwitchesPerDay: max, maxLosingTradesPerDay: maxTrades, dsbExitMode: exitMode,
        chopFilterEnabled: false, bandStep: 1, htfGateEnabled: false, dailyHaGateEnabled: false };
    const state = createState();
    let candle = null; const raw = [];
    const feed = { getLivePrice: () => candle && candle.close, getRawCandles: () => raw, getSourceCandles: () => raw, onTick() {} };
    const tgNone = () => {};
    const posClose = (price, reason) => positions.close(context, state, ledger, tgNone, price, reason);
    const orders = { enter: async () => "id", exit: async () => (exitFails() ? null : "id"), slExit: async () => "id", reconcile: async () => {} };
    const strat = createDynamicMidColorStrategy({
        context, engineConfig, state, db: ledger, candles: feed, slStore: createSLStore(), targetStore: createTargetStore(),
        orders, positionsClose: posClose, positionsUnrealised: p => positions.unrealised(context, state, p),
        lifecycle: { isShutdown: () => false }, tg: tgNone, clock, htf: { isBlocked: async () => false }, dailyHa: { isBlocked: async () => false },
    });
    state.bandHigh = state.bandMid = state.bandLow = null;
    return {
        state, ledger, strat, context,
        async feed(d, open, close) { now = d; candle = { open, high: Math.max(open, close), low: Math.min(open, close), close, date: d.toISOString() }; raw.push(candle); await strat.processCandle(candle); },
        close: (price, reason) => posClose(price, reason),
        setLive(l) { engineConfig.LIVE_ORDERS = l; },
    };
}
const quiet = async fn => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const exits = r => r.ledger.getAllTrades().filter(t => t.status === "CLOSED");
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log("ok  -", name); }

(async () => {
    const warm = async r => { for (let i = 0; i < 30; i++) await r.feed(at(10, 10 + Math.floor(i / 4), (i % 4) * 15), 100, 100.2 + (i % 2) * 0.1); };
    async function scenario(exitMode) {
        const r = rig({ exitMode });
        await quiet(async () => {
            await warm(r);
            await r.feed(at(11, 10), 100, 103);        // breakout -> LONG
            await r.feed(at(11, 10, 15), 103, 96);     // close below low -> flip signal
        });
        return r;
    }
    const flip = await scenario(undefined);
    console.log("default position after flip signal:", flip.state.position, "trades:", flip.ledger.getAllTrades().length);
    const sl = await scenario("SL");
    console.log("SL-mode position after flip signal:", sl.state.position, "trades:", sl.ledger.getAllTrades().length);
    assert.strictEqual(flip.state.position, "SHORT", "default: flips");
    assert.strictEqual(sl.state.position, "LONG", "SL mode: holds through the flip");
    assert.ok(sl.ledger.getAllTrades().every(t => t.exit_reason !== "COLOR FLIP EXIT"), "no flip exit recorded in SL mode");
    console.log("dsb exit mode: 2 scenarios passed"); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
