// test-losing-switch.js — scenario tests for the max-profitable-trades limit (losingSwitchGate.js) wired into DYNAMIC_BAND (same gate code the
// other DSB-family strategies use). Run: node test-profit-limit.js
"use strict";
const assert = require("assert");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("./state");
const { createSLStore } = require("./sl");
const { createTargetStore } = require("./target");
const positions = require("./positions");
const engineConfig = { ...require("./engineConfig") };
const { createDynamicBandStrategy } = require("./strategies");

engineConfig.ENGINE_ENABLED = true; engineConfig.LIVE_ORDERS = false;
engineConfig.CHOP_GATE_ALWAYS_FORCE = false; engineConfig.BAND_STEP_DEFAULT = 1;

const IST = 5.5 * 3600000;
const at = (day, hh, mm = 0) => new Date(Date.UTC(2026, 8, day, hh, mm) - IST);   // IST wall time on Sep <day>

function rig({ max, maxTrades, maxProfit, scalp, ledger, exitFails = () => false } = {}) {
    let now = at(11, 10);
    const clock = { now: () => now };
    ledger = ledger || createBacktestLedger({ clock });
    // the in-memory ledger has no journal query; same semantics as db.js's countLosingFlipExitsSince
    ledger.countLosingFlipExitsSince = async (engine, reasons, sinceIso) =>
        ledger.getAllTrades().filter(t => t.status === "CLOSED" && t.pnl < 0 && reasons.includes(t.exit_reason) && t.exit_time >= sinceIso).length;
    ledger.countScalpTpSince = async (engine, sinceIso) =>
        ledger.getAllTrades().filter(t => t.status === "CLOSED" && t.exit_reason === "SCALP_TP" && t.exit_time >= sinceIso).length;
    ledger.countLosingTradesSince = async (engine, sinceIso) =>
        ledger.getAllTrades().filter(t => t.status === "CLOSED" && t.pnl < 0 && t.exit_time >= sinceIso).length;
    ledger.countWinningTradesSince = async (engine, sinceIso) =>
        ledger.getAllTrades().filter(t => t.status === "CLOSED" && t.pnl > 0 && t.exit_time >= sinceIso).length;
    const context = { tgPrefix: "T", symbol: "T", token: 1, lots: 1, lotMult: 1, name: "T", strategy: "DYNAMIC_BAND", maxLosingSwitchesPerDay: max, maxLosingTradesPerDay: maxTrades, maxProfitTradesPerDay: maxProfit, scalpTargetRupees: scalp ? 2000 : null, scalpStopForDay: !!scalp,
        chopFilterEnabled: false, bandStep: 1, htfGateEnabled: false, dailyHaGateEnabled: false };
    const state = createState();
    let candle = null; const raw = [];
    const feed = { getLivePrice: () => candle && candle.close, getRawCandles: () => raw, getSourceCandles: () => raw, onTick() {} };
    const tgNone = () => {};
    const posClose = (price, reason) => positions.close(context, state, ledger, tgNone, price, reason);
    const orders = { enter: async () => "id", exit: async () => (exitFails() ? null : "id"), slExit: async () => "id", reconcile: async () => {} };
    const strat = createDynamicBandStrategy({
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
    const win = async r => { await r.feed(at(11, 10), 100, 102); await r.close(105, "TARGET"); };   // LONG @102 closed @105 = winner
    await t("limit off: re-enters after a winner", async () => {
        const r = rig({}); await quiet(async () => { await win(r); await r.feed(at(11, 10, 15), 105, 140); });
        assert.strictEqual(r.state.position, "LONG");
    });
    await t("limit 1: after the first winner no more entries today", async () => {
        const r = rig({ maxProfit: 1 }); await quiet(async () => { await win(r); await r.feed(at(11, 10, 15), 105, 140); await r.feed(at(11, 11), 140, 90); });
        assert.strictEqual(r.state.position, null); assert.strictEqual(exits(r).length, 1);
        assert.strictEqual(r.state.losingSwitchStats.profitTrades, 1);
    });
    await t("limit 2: first winner still allows a second entry", async () => {
        const r = rig({ maxProfit: 2 }); await quiet(async () => { await win(r); await r.feed(at(11, 10, 15), 105, 140); });
        assert.strictEqual(r.state.position, "LONG");
    });
    await t("losers do not count toward the profit limit", async () => {
        const r = rig({ maxProfit: 1 }); await quiet(async () => { await r.feed(at(11, 10), 100, 102); await r.close(100, "ATR SL HIT"); await r.feed(at(11, 10, 15), 100, 130); });
        assert.strictEqual(r.state.position, "LONG"); assert.strictEqual(r.state.losingSwitchStats.profitTrades, 0);
    });
    await t("cooldown ends at the next IST day", async () => {
        const r = rig({ maxProfit: 1 }); await quiet(async () => { await win(r); await r.feed(at(12, 10), 100, 130); });
        assert.strictEqual(r.state.position, "LONG");
    });
    await t("restart recovery: counter rebuilt from the journal, lock survives", async () => {
        const a = rig({ maxProfit: 1 }); await quiet(() => win(a));
        const b = rig({ maxProfit: 1, ledger: a.ledger });
        await quiet(async () => { await b.strat.initSignals(); await b.feed(at(11, 13), 99.5, 150); });
        assert.strictEqual(b.state.position, null, "still locked after restart");
    });
    console.log(`${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
