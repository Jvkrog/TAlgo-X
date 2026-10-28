// test-replay-retry.js — a boot-replay entry refused by a gate is retried on the following candles (DYNAMIC_MID_COLOR).
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

function rig({ max, maxTrades, exitMode, dailyHa, ledger, exitFails = () => false } = {}) {
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
        lifecycle: { isShutdown: () => false }, tg: tgNone, clock, htf: { isBlocked: async () => false }, dailyHa: dailyHa || { isBlocked: async () => false },
    });
    state.bandHigh = state.bandMid = state.bandLow = null;
    return {
        state, ledger, strat, context, raw,
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
    const history = r => { for (let i = 0; i < 40; i++) { const o = 100 + i * 0.5; r.raw.push({ open: o, high: o + 1, low: o - 0.2, close: o + 0.8, date: at(10, 9 + Math.floor(i / 4), (i % 4) * 15).toISOString() }); } };
    let blocked = true;
    const dailyHa = { lastBlockReason: null, isBlocked: async () => { dailyHa.lastBlockReason = blocked ? "daily-ha" : null; return blocked; } };
    const r = rig({ dailyHa }); history(r);
    const nextC = (i, d) => { const o = 120 + i; return { open: o, high: o + 1, low: o - 0.2, close: o + 0.8, date: d.toISOString() }; };
    await quiet(async () => { const c0 = nextC(0, at(11, 10)); r.raw.push(c0); await r.strat.processCandle(c0); });
    assert.strictEqual(r.state.position, null, "boot replay entry refused by the gate");
    assert.ok(r.state.pendingReplaySide, "refusal keeps the replay side pending");
    await quiet(async () => { const c1 = nextC(1, at(11, 11)); r.raw.push(c1); await r.strat.processCandle(c1); });
    assert.strictEqual(r.state.position, null, "still blocked on the next candle, still pending");
    blocked = false;
    await quiet(async () => { const c2 = nextC(2, at(11, 12)); r.raw.push(c2); await r.strat.processCandle(c2); });
    assert.ok(r.state.position, "entered on the first candle the gate allows it");
    console.log("replay retry: 1 scenario passed, position =", r.state.position); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
