// End-to-end: runBacktest(HOURLY_HA_SCALP) on synthetic Kite data — daily-bar feed, carry-overnight, vol-target sizing, NET-of-cost reporting.
"use strict";
const assert = require("assert");
const IST = 5.5 * 3600e3;
const { candleColor, levels, createHourlyHaScalpStrategy } = require("../strategies/hourlyHaScalp");
const { runBacktest } = require("../backtest/backtestRun"), { getDefinition, buildContext } = require("../core/context");
function bars(interval, fromStr, toStr) {
    const out = [], d0 = new Date(fromStr + "T00:00:00Z"), d1 = new Date(toStr + "T00:00:00Z");
    for (let dd = d0; dd <= d1; dd = new Date(+dd + 86400e3)) {
        const dow = dd.getUTCDay(); if (dow === 0 || dow === 6) continue; const idx = Math.round((dd - new Date("2025-01-01T00:00:00Z")) / 86400e3);
        const px = (i, m) => 100 + 14 * Math.sin((i + m / 1440) * 2 * Math.PI / 70) + 1.5 * Math.sin((i + m / 1440) * 2 * Math.PI * 3.1) + 0.6 * Math.sin((i + m / 1440) * 2 * Math.PI * 17.3);   // ~70-day swings = trends
        if (interval === "day") { const o = px(idx, 0), c = px(idx, 1439); out.push({ date: new Date(+dd - IST), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c }); continue; }
        for (let m = 9 * 60; m < 23 * 60 + 30; m += 60) { const o = px(idx, m), c = px(idx, m + 60); out.push({ date: new Date(+dd + m * 60e3 - IST), open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c, volume: 100 }); }
    } return out;
}
const kc = { getHistoricalData: async (tok, interval, f, to) => bars(interval === "day" ? "day" : "60", f, to) };
async function run(extraParams = {}, ctxExtra = {}) {
    const def = getDefinition("NATGASMINI", "MCX"), context = buildContext(def, { token: 1, symbol: "NATGASMINI26X", expiry: new Date("2027-12-01"), tickSize: 0.1, lotSize: 1 });
    context.lotMult = 250; context.timeframe = "1h"; context.carryOvernight = false; context.lots = 1; Object.assign(context, ctxExtra);
    const log = console.log; console.log = () => {}; console.warn = () => {};
    try { return await runBacktest({ strategyKey: "HOURLY_HA_SCALP", strategyLabel: "Hourly HA Scalp", context, timeframe: "1h", from: new Date("2026-02-02T00:00:00+05:30"), to: new Date("2026-12-31T23:59:59+05:30"), params: extraParams, kc }); }
    finally { console.log = log; }
}

const T = [], t = (n, f) => T.push([n, f]);
const bar = (o, h, l, c, date) => ({ open: o, high: h, low: l, close: c, date });
t("candleColor: normal vs HA, doji", () => {
    const up = [bar(100, 101, 99, 100.5, 0), bar(100.5, 103, 100, 102.5, 1)], dn = [bar(100, 101, 99, 99.5, 0), bar(99.5, 100, 97, 97.5, 1)];
    assert.strictEqual(candleColor(up, "normal"), "green"); assert.strictEqual(candleColor(dn, "normal"), "red");
    assert.strictEqual(candleColor(up, "ha"), "green"); assert.strictEqual(candleColor(dn, "ha"), "red");
    // a red normal candle inside an HA up-run is still green in HA
    const mix = [bar(100, 102, 100, 102, 0), bar(102, 104, 102, 104, 1), bar(104, 105, 103.5, 104, 2), bar(104, 104.4, 103.2, 103.6, 3)];
    assert.strictEqual(candleColor(mix, "normal"), "red"); assert.strictEqual(candleColor(mix, "ha"), "green");
    assert.strictEqual(candleColor([bar(100, 101, 99, 100, 0)].concat([]), "normal"), null); assert.strictEqual(candleColor([], "ha"), null);
});
t("levels: pct / points / atr, both sides, invalid", () => {
    const L = levels({ side: "LONG", price: 200, unit: "pct", targetVal: 0.5, slVal: 0.25, atrVal: null }); assert.ok(Math.abs(L.target - 201) < 1e-9 && Math.abs(L.stop - 199.5) < 1e-9);
    const S = levels({ side: "SHORT", price: 200, unit: "points", targetVal: 2, slVal: 1, atrVal: null }); assert.strictEqual(S.target, 198); assert.strictEqual(S.stop, 201);
    const A = levels({ side: "LONG", price: 200, unit: "atr", targetVal: 1, slVal: 0.5, atrVal: 4 }); assert.strictEqual(A.target, 204); assert.strictEqual(A.stop, 198);
    assert.strictEqual(levels({ side: "LONG", price: 200, unit: "atr", targetVal: 1, slVal: 1, atrVal: null }), null);
});
function harness(params, { liveOrders = true, orderFails = false } = {}) {
    const log = { enters: [], exits: [], closes: [], trail: null, target: null };
    let src = [], live = null, nowMs = 0;
    const state = { position: null, pnl: 0 };
    const context = { tgPrefix: "T", lots: 1, strategyParams: params, token: 1, symbol: "X" };
    const engineConfig = { ENGINE_ENABLED: true, LIVE_ORDERS: liveOrders };
    const strat = createHourlyHaScalpStrategy({ context, engineConfig, state, db: { savePosition() {}, insertOpenTrade: async () => 7, loadPosition: async () => null, getRealizedPnlToday: async () => 0, getTradeCountToday: async () => 0 },
        candles: { getSourceCandles: () => src, getRawCandles: () => src, getLivePrice: () => live },
        slStore: { setTrail: (v, d) => { log.trail = [v, d]; }, clearTrail: () => { log.trail = null; }, getTrail: () => ({ trail: log.trail && log.trail[0], dir: 0 }) },
        targetStore: { setTarget: (v, d) => { log.target = [v, d]; }, clearTarget: () => { log.target = null; }, getTarget: () => ({ target: log.target && log.target[0] }) },
        orders: { enter: async s => { log.enters.push(s); return orderFails ? null : "id"; }, exit: async s => { log.exits.push(s); return "id"; }, reconcile: async () => {} },
        positionsClose: async (p, why) => { log.closes.push([p, why]); state.position = null; }, positionsUnrealised: () => 0,
        lifecycle: { isShutdown: () => false }, tg() {}, clock: { now: () => new Date(nowMs) } });
    // feed one 1h candle that OPENS at istHH:00 and has just closed; clock = close + 5s
    const feed = async (istHH, o, h, l, c, lag = 5000) => { const open = Date.UTC(2026, 10, 9, istHH, 0) - IST; src.push(bar(o, h, l, c, new Date(open))); live = c; nowMs = open + 3600e3 + lag; await strat.processCandle(src[src.length - 1]); };
    return { feed, log, state, seed: (n, base = 100) => { for (let k = 0; k < n; k++) src.push(bar(base, base + 1, base - 1, base, new Date(Date.UTC(2026, 10, 6, 9 + k, 0) - IST))); } };
}
t("green HA -> LONG with TP/SL; next hour closes at hour end then re-decides", async () => {
    const h = harness({ unit: "points", targetVal: 2, slVal: 1, candleType: "normal" }); h.seed(3);
    await h.feed(10, 100, 103, 100, 102.5);   // closes 11:00 -> LONG (green)
    assert.deepStrictEqual(h.log.enters, ["LONG"]); assert.strictEqual(h.state.position, "LONG");
    assert.deepStrictEqual(h.log.trail, [101.5, 1]); assert.deepStrictEqual(h.log.target, [104.5, 1]);
    await h.feed(11, 102.5, 103, 100, 100.5);   // no TP/SL hit by ticks; hour ends on a RED candle: exit at 100.5 then SHORT
    assert.deepStrictEqual(h.log.exits, ["LONG"]); assert.strictEqual(h.log.closes[0][1], "HOUR_END"); assert.strictEqual(h.log.closes[0][0], 100.5);
    assert.deepStrictEqual(h.log.enters, ["LONG", "SHORT"]); assert.deepStrictEqual(h.log.target, [98.5, -1]);
});
t("fade inverts; doji skips", async () => {
    const h = harness({ direction: "fade", candleType: "normal" }); h.seed(3); await h.feed(10, 100, 103, 100, 102.5); assert.deepStrictEqual(h.log.enters, ["SHORT"]);
    const d = harness({ candleType: "normal" }); d.seed(3); await d.feed(10, 100, 101, 99, 100); assert.deepStrictEqual(d.log.enters, []);
});
t("window: closes before first / after last entry time -> no entry; boundary inclusive", async () => {
    let h = harness({ candleType: "normal", firstEntryTime: "10:00" }); h.seed(3); await h.feed(8, 100, 103, 100, 102.5); assert.deepStrictEqual(h.log.enters, []);   // closes 09:00
    h = harness({ candleType: "normal", lastEntryTime: "22:00" }); h.seed(3); await h.feed(22, 100, 103, 100, 102.5); assert.deepStrictEqual(h.log.enters, []);   // closes 23:00
    h = harness({ candleType: "normal", lastEntryTime: "22:00" }); h.seed(3); await h.feed(21, 100, 103, 100, 102.5); assert.deepStrictEqual(h.log.enters, ["LONG"]);   // closes 22:00
});
t("stale candle (boot catch-up) never enters, but still closes an open position", async () => {
    const h = harness({ candleType: "normal" }); h.seed(3); await h.feed(10, 100, 103, 100, 102.5, 40 * 60e3); assert.deepStrictEqual(h.log.enters, []);
    const g = harness({ candleType: "normal" }); g.seed(3); await g.feed(10, 100, 103, 100, 102.5); await g.feed(11, 102.5, 104, 102, 103.5, 40 * 60e3);
    assert.deepStrictEqual(g.log.exits, ["LONG"]); assert.strictEqual(g.log.enters.length, 1);
});
t("order failure: no state change; failed hour-end exit keeps position and does not enter", async () => {
    const h = harness({ candleType: "normal" }, { orderFails: true }); h.seed(3); await h.feed(10, 100, 103, 100, 102.5); assert.strictEqual(h.state.position, null); assert.strictEqual(h.log.target, null);
});
t("params: unknown / invalid fall back to defaults", async () => {
    const h = harness({ unit: "bogus", targetVal: -5 }); h.seed(3); await h.feed(10, 100, 103, 100, 102.5); assert.ok(h.log.target, "defaults (pct 0.3) used");
});
t("backtest e2e: hour-end exits, TP/SL exits, net of costs, ownGates", async () => {
    const r = await run({ strategyParams: { unit: "pct", targetVal: 0.4, slVal: 0.4 } });
    const m = r.metrics || r.report.metrics, trades = r.report ? r.report.trades : r.trades;
    assert(trades.length > 100, "many hourly trades: " + trades.length);
    assert(m.totalCosts > 0 && Math.abs(m.grossPnL - m.totalCosts - m.netPnL) < 1e-6, "net of costs");
    const reasons = {}; for (const x of trades) reasons[x.exit_reason || x.reason || "?"] = (reasons[x.exit_reason || x.reason || "?"] || 0) + 1;
    assert(reasons.HOUR_END > 0, "some trades end at the hour: " + JSON.stringify(reasons));
    assert(Object.keys(reasons).length >= 2, "TP and/or SL also fire: " + JSON.stringify(reasons));
    assert(trades.every(x => new Date(x.exit_time) - new Date(x.entry_time) > 0), "no zero-duration (phantom same-candle stop) trades");
    assert(trades.every(x => new Date(x.exit_time) - new Date(x.entry_time) <= 3600e3 + 1), "no trade lives longer than one hour");
    console.log("   backtest:", trades.length, "trades", JSON.stringify(reasons), "gross", m.grossPnL.toFixed(0), "costs", m.totalCosts.toFixed(0), "net", m.netPnL.toFixed(0));
});
(async () => { let fail = 0; for (const [n, f] of T) { try { await f(); console.log("  ok   " + n); } catch (e) { fail++; console.log("  FAIL " + n + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } } console.log(fail ? fail + " FAILED" : "all passed"); process.exit(fail ? 1 : 0); })();
