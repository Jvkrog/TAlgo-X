// test-losing-switch.js — scenario tests for losingSwitchGate.js wired into DYNAMIC_BAND (same gate code the
// other DSB-family strategies use). Run: node test-losing-switch.js
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

function rig({ max, maxTrades, ledger, exitFails = () => false } = {}) {
    let now = at(11, 10);
    const clock = { now: () => now };
    ledger = ledger || createBacktestLedger({ clock });
    // the in-memory ledger has no journal query; same semantics as db.js's countLosingFlipExitsSince
    ledger.countLosingFlipExitsSince = async (engine, reasons, sinceIso) =>
        ledger.getAllTrades().filter(t => t.status === "CLOSED" && t.pnl < 0 && reasons.includes(t.exit_reason) && t.exit_time >= sinceIso).length;
    ledger.countLosingTradesSince = async (engine, sinceIso) =>
        ledger.getAllTrades().filter(t => t.status === "CLOSED" && t.pnl < 0 && t.exit_time >= sinceIso).length;
    const context = { tgPrefix: "T", symbol: "T", token: 1, lots: 1, lotMult: 1, name: "T", strategy: "DYNAMIC_BAND", maxLosingSwitchesPerDay: max, maxLosingTradesPerDay: maxTrades,
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
    // Choppy day: LONG@102 -> flips lose three times in a row
    async function choppy(r) {
        await r.feed(at(11, 10), 100, 102);   // band 99/101 -> LONG ENTRY @102
        await r.feed(at(11, 10, 15), 102, 99.5);  // SHORT reversal #1 (long loses)
        await r.feed(at(11, 10, 30), 99.5, 101.5); // LONG reversal #2 (short loses)
        await r.feed(at(11, 10, 45), 101.5, 99.5); // third losing flip
    }

    await t("limit off: unchanged behaviour (always reverses)", async () => {
        const r = rig({ max: null }); await quiet(() => choppy(r));
        assert.strictEqual(r.state.position, "SHORT"); assert.strictEqual(exits(r).length, 3);
    });
    await t("first and second losing reversals are permitted, third is blocked and stays FLAT", async () => {
        const r = rig({ max: 2 }); await quiet(() => choppy(r));
        assert.strictEqual(r.state.position, null, "flat after third");
        assert.strictEqual(exits(r).length, 3); assert.strictEqual(r.state.losingSwitchStats.blocked, 1);
        assert.strictEqual(r.state.losingSwitchStats.losingReversals, 3);
    });
    await t("limit exhausted = no entries for the rest of the day, even on clean breakouts", async () => {
        const r = rig({ max: 2 }); await quiet(async () => { await choppy(r); await r.feed(at(11, 11), 99.5, 110); await r.feed(at(11, 12), 110, 80); });
        assert.strictEqual(r.state.position, null); assert.strictEqual(r.ledger.getAllTrades().length, 3);
    });
    await t("daily reset: next IST day trades again", async () => {
        const r = rig({ max: 2 }); await quiet(async () => { await choppy(r); await r.feed(at(12, 10), 99.5, 130); });
        assert.strictEqual(r.state.position, "LONG"); assert.strictEqual(r.ledger.getAllTrades().length, 4);
    });
    await t("profitable reversal does not consume the counter", async () => {
        const r = rig({ max: 1 });
        await quiet(async () => {
            await r.feed(at(11, 10), 100, 102);      // LONG @102
            await r.feed(at(11, 10, 15), 102, 103); await r.feed(at(11, 10, 30), 103, 104); await r.feed(at(11, 10, 45), 104, 105);
            await r.feed(at(11, 11), 105, 102.5);    // reversal at +0.5 = profit
        });
        assert.strictEqual(r.state.position, "SHORT"); assert.strictEqual(r.state.losingSwitchStats.losingReversals, 0);
        assert.ok(exits(r)[0].pnl > 0);
    });
    await t("max=1: first losing reversal permitted, second blocked", async () => {
        const r = rig({ max: 1 }); await quiet(() => choppy(r));
        assert.strictEqual(r.state.position, null); assert.strictEqual(exits(r).length, 2);
    });
    await t("restart recovery: counter rebuilt from the journal, lock survives", async () => {
        const a = rig({ max: 2 }); await quiet(() => choppy(a));
        const b = rig({ max: 2, ledger: a.ledger });           // same journal, fresh process
        await quiet(async () => { await b.strat.initSignals(); await b.feed(at(11, 13), 99.5, 150); });
        assert.strictEqual(b.state.position, null, "still locked after restart");
    });
    await t("restart on a new day does not inherit yesterday's count", async () => {
        const a = rig({ max: 2 }); await quiet(() => choppy(a));
        const b = rig({ max: 2, ledger: a.ledger });
        await quiet(async () => { await b.strat.initSignals(); await b.feed(at(12, 10), 100, 130); });
        assert.strictEqual(b.state.position, "LONG");
    });
    await t("duplicate processing of the same candle cannot double-count", async () => {
        const r = rig({ max: 5 });
        await quiet(async () => { await r.feed(at(11, 10), 100, 102); await r.feed(at(11, 10, 15), 102, 99.5); await r.strat.processCandle({ open: 102, high: 102, low: 99.5, close: 99.5, date: at(11, 10, 15).toISOString() }); });
        assert.strictEqual(r.state.losingSwitchStats.losingReversals, 1);
    });
    await t("failed exit order: counter untouched, position kept, retried next candle", async () => {
        let fail = true; const r = rig({ max: 2, exitFails: () => fail });
        r.setLive(true);
        await quiet(async () => { await r.feed(at(11, 10), 100, 102); await r.feed(at(11, 10, 15), 102, 99.5); });
        assert.strictEqual(r.state.position, "LONG"); assert.strictEqual(r.state.losingSwitchStats.losingReversals, 0);
        fail = false;
        await quiet(() => r.feed(at(11, 10, 30), 99.5, 99.4));
        assert.strictEqual(r.state.losingSwitchStats.losingReversals, 1); assert.strictEqual(r.state.position, "SHORT");
        r.setLive(false);
    });
    // ── max losing trades per day (any exit reason) ──
    await t("losing-trade limit 2: second losing trade ends the day (no reversal entry)", async () => {
        const r = rig({ maxTrades: 2 }); await quiet(() => choppy(r));
        assert.strictEqual(r.state.position, null); assert.strictEqual(exits(r).length, 2);
    });
    await t("losing-trade limit 1: first losing flip exits and stays flat", async () => {
        const r = rig({ maxTrades: 1 }); await quiet(() => choppy(r));
        assert.strictEqual(r.state.position, null); assert.strictEqual(exits(r).length, 1);
    });
    await t("losing-trade limit counts stop-loss exits too, then blocks entries", async () => {
        const r = rig({ maxTrades: 1 });
        await quiet(async () => { await r.feed(at(11, 10), 100, 102); await r.close(100, "ATR SL HIT"); await r.feed(at(11, 10, 15), 100, 130); });
        assert.strictEqual(r.state.position, null); assert.strictEqual(exits(r).length, 1);
    });
    await t("profitable trades never count toward the losing-trade limit", async () => {
        const r = rig({ maxTrades: 1 });
        await quiet(async () => { await r.feed(at(11, 10), 100, 102); await r.close(105, "TARGET"); await r.feed(at(11, 10, 15), 105, 140); });
        assert.strictEqual(r.state.position, "LONG");
    });
    await t("losing-trade limit resets next IST day", async () => {
        const r = rig({ maxTrades: 1 }); await quiet(async () => { await choppy(r); await r.feed(at(12, 10), 99.5, 130); });
        assert.strictEqual(r.state.position, "LONG");
    });
    await t("losing-trade limit survives a restart (rebuilt from journal)", async () => {
        const a = rig({ maxTrades: 1 }); await quiet(() => choppy(a));
        const b = rig({ maxTrades: 1, ledger: a.ledger });
        await quiet(async () => { await b.strat.initSignals(); await b.feed(at(11, 13), 99.5, 150); });
        assert.strictEqual(b.state.position, null);
    });
    await t("both limits together: whichever is hit first blocks entries", async () => {
        const r = rig({ max: 5, maxTrades: 2 }); await quiet(() => choppy(r));
        assert.strictEqual(exits(r).length, 2); assert.strictEqual(r.state.position, null);
    });
    console.log(`\n${passed} scenarios passed`);
    process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
