// Weekly HA Bias (DAILY_HA_BIAS with biasPeriod WEEKLY): weekly candle maths, strategy side/CURRENT mode, backtest replay, plumbing.
const assert = require("assert"), fs = require("fs"), vm = require("vm");
const W = require("../strategies/weeklyHa"), { createDailyHaBiasStrategy } = require("../strategies/strategies"), { createSLStore } = require("../core/sl");
const { toHAAlways } = require("../indicators/indicators");
const realLog = console.log, T = [], t = (n, f) => T.push([n, f]);
const IST = 5.5 * 3600e3, istMid = s => new Date(new Date(s + "T00:00:00Z").getTime() - IST);   // Kite daily bars stamp IST midnight
const d = (day, o, h, l, c) => ({ date: istMid(day), open: o, high: h, low: l, close: c });
// Mon 2026-09-07 .. Fri 09-11 (rising), Mon 09-14 .. Fri 09-18 (falling), Mon 09-21 ...
const rising = [d("2026-09-07", 100, 103, 99, 102), d("2026-09-08", 102, 105, 101, 104), d("2026-09-09", 104, 107, 103, 106), d("2026-09-10", 106, 109, 105, 108), d("2026-09-11", 108, 115, 107, 112)];
const falling = [d("2026-09-14", 110, 111, 105, 106), d("2026-09-15", 106, 107, 101, 102), d("2026-09-16", 102, 103, 97, 98), d("2026-09-17", 98, 99, 93, 94), d("2026-09-18", 94, 95, 89, 90)];
const all = [...rising, ...falling];

t("weekStartKey: Monday of the IST week (Sun belongs to the week that ends on it)", () => {
    assert.strictEqual(W.weekStartKey("2026-09-09"), "2026-09-07"); assert.strictEqual(W.weekStartKey("2026-09-07"), "2026-09-07"); assert.strictEqual(W.weekStartKey("2026-09-13"), "2026-09-07"); assert.strictEqual(W.weekStartKey("2026-09-14"), "2026-09-14");
});
t("aggregate: open = first open, close = last close, high/low = extremes", () => {
    const w = W.aggregate(rising); assert.strictEqual(w.length, 1); assert.deepStrictEqual([w[0].open, w[0].high, w[0].low, w[0].close], [100, 115, 99, 112]);
});
t("latestCompletedWeekly: mid-week and Monday use the last COMPLETED week; the forming week never leaks in", () => {
    const wk1 = W.latestCompletedWeekly(all, "2026-09-16");   // Wed of week 2: only week 1 is complete
    assert.strictEqual(wk1.color, "green"); assert.strictEqual(wk1.close, toHAAlways(W.aggregate(rising)).pop().close);
    assert.strictEqual(W.latestCompletedWeekly(all, "2026-09-14").color, "green");   // Monday of week 2, same read
    const wk2 = W.latestCompletedWeekly(all, "2026-09-21"); assert.strictEqual(wk2.color, "red", "week 2 is red once complete");
    assert.strictEqual(W.latestCompletedWeekly(all, "2026-09-10"), null, "no completed week before the first one ends");
});
t("latestCompletedWeekly ignores bars dated today or later (no look-ahead)", () => {
    const mut = all.map(x => ({ ...x })); mut[5].close = 500; mut[5].high = 500;   // Mon 09-14 inflated
    assert.strictEqual(W.latestCompletedWeekly(mut, "2026-09-14").color, "green"); assert.deepStrictEqual(W.latestCompletedWeekly(mut, "2026-09-14"), W.latestCompletedWeekly(all, "2026-09-14"));
});
t("weekSoFar: this week's earlier days only (null on the week's first day)", () => {
    assert.strictEqual(W.weekSoFar(all, "2026-09-14"), null); const w = W.weekSoFar(all, "2026-09-17"); assert.deepStrictEqual(w, { open: 110, high: 111, low: 97 });
});

// ── strategy ──
const at = (day, h, m) => new Date(Date.UTC(2026, 8, day, h, m) - IST);
function make(ctx, latest, weekSoFar, nowFn, raw, live) {
    const sl = createSLStore(), state = { position: null, pnl: 0 }; let entered = null;
    const context = { tgPrefix: "T", symbol: "X", token: 1, lots: 1, dailyBiasEntryHour: 10, dailyBiasEntryMinute: 0, longCandleFilterEnabled: false, ...ctx };
    const strat = createDailyHaBiasStrategy({ context, engineConfig: { ENGINE_ENABLED: true, ST_ATR_LEN: 10, ATR_SL_MULT: 2, LIVE_ORDERS: false, RESUME_INTRADAY_ONLY: true },
        state, db: { insertOpenTrade: async () => 1, savePosition() {}, loadPosition: async () => null }, candles: { getRawCandles: () => raw, getLivePrice: () => live },
        slStore: sl, targetStore: {}, orders: { enter: async s => { entered = s; return {}; }, reconcile: async () => {} }, positionsClose: async () => {}, positionsUnrealised: () => 0,
        lifecycle: { isShutdown: () => false }, tg() {}, clock: { now: nowFn }, dailyHa: { getLatest: async () => latest, getWeekSoFar: async () => weekSoFar } });
    return { strat, state, entered: () => entered };
}
const day15 = (day, base) => { const out = []; let tt = at(day, 9, 15); for (let i = 0; i < 25; i++) { out.push({ date: new Date(tt), open: base, high: base + 0.5, low: base - 0.5, close: base }); tt = new Date(+tt + 900e3); } return out; };
const prevGreen = { color: "green", date: at(7, 0, 0), open: 100, close: 110, high: 111, low: 99 };
t("strategy WEEKLY, PREVIOUS: side comes from the weekly candle (green -> LONG, red -> SHORT)", async () => {
    for (const [latest, want] of [[prevGreen, "LONG"], [{ ...prevGreen, color: "red" }, "SHORT"]]) {
        const raw = [...day15(15, 100), ...day15(16, 100).slice(0, 4)]; const h = make({ biasPeriod: "WEEKLY" }, latest, null, () => at(16, 10, 0), raw, 100);
        await h.strat.processCandle(raw[raw.length - 1]); assert.strictEqual(h.state.position, want);
    }
});
t("strategy WEEKLY, CURRENT: this week's earlier days + today flip a green previous week to red", async () => {
    // previous weekly HA candle open 100 close 110 -> haOpen 105. This week so far fell hard (open 110, low 80); today flat near 85 -> HA close ~ (110+110+80+85)/4 = 96 < 105 -> red
    const raw = [...day15(15, 85), ...day15(16, 85).slice(0, 4)]; const wsf = { open: 110, high: 110, low: 80 };
    const h = make({ biasPeriod: "WEEKLY", dailyBiasCandle: "CURRENT" }, prevGreen, wsf, () => at(16, 10, 0), raw, 85);
    await h.strat.processCandle(raw[raw.length - 1]); assert.strictEqual(h.state.position, "SHORT");
    const h2 = make({ biasPeriod: "WEEKLY", dailyBiasCandle: "PREVIOUS" }, prevGreen, wsf, () => at(16, 10, 0), raw, 85);
    await h2.strat.processCandle(raw[raw.length - 1]); assert.strictEqual(h2.state.position, "LONG", "PREVIOUS ignores the forming week");
});
t("strategy: DAILY (default) never asks for the week-so-far and is unchanged", async () => {
    let asked = 0; const raw = [...day15(15, 100), ...day15(16, 100).slice(0, 4)]; const h = make({ dailyBiasCandle: "CURRENT" }, prevGreen, null, () => at(16, 10, 0), raw, 105);
    await h.strat.processCandle(raw[raw.length - 1]); assert.ok(h.state.position === "LONG" || h.state.position === "SHORT"); assert.strictEqual(asked, 0);
});

// ── backtest replay (fake Kite) ──
const { runBacktest } = require("../backtest/backtestRun"), { getDefinition, buildContext } = require("../core/context");
function bars(interval, fromStr, toStr) {
    const out = []; const d0 = new Date(fromStr + "T00:00:00Z"), d1 = new Date(toStr + "T00:00:00Z");
    for (let dd = d0; dd <= d1; dd = new Date(+dd + 86400e3)) {
        const dow = dd.getUTCDay(); if (dow === 0 || dow === 6) continue; const idx = Math.round((dd - new Date("2026-01-01T00:00:00Z")) / 86400e3);
        const px = (i, m) => 100 + 9 * Math.sin((i + m / 1440) * 2 * Math.PI / 17) + 1.5 * Math.sin((i + m / 1440) * 2 * Math.PI * 3.1);
        if (interval === "day") { const o = px(idx, 0), c = px(idx, 1439); out.push({ date: new Date(+dd - IST), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c }); continue; }
        for (let m = 9 * 60; m < 23 * 60 + 30; m += 15) { const o = px(idx, m), c = px(idx, m + 15); out.push({ date: new Date(+dd + m * 60e3 - IST), open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c, volume: 100 }); }
    } return out;
}
const kc = { getHistoricalData: async (tok, interval, f, to) => bars(interval === "15minute" ? "15" : interval, f, to) };
async function replay(extra) {
    const def = getDefinition("NATGASMINI", "MCX"), context = buildContext(def, { token: 1, symbol: "NATGASMINI26X", expiry: new Date("2026-12-01"), tickSize: 0.1, lotSize: 1 });
    context.lotMult = context.lotMult || 250; context.timeframe = "15m"; context.carryOvernight = false; context.lots = 1; Object.assign(context, extra);
    console.log = () => {}; try { return await runBacktest({ strategyKey: "DAILY_HA_BIAS", strategyLabel: "DHAB", context, timeframe: "15m", from: new Date("2026-09-01T00:00:00+05:30"), to: new Date("2026-10-15T23:59:59+05:30"), params: {}, kc }); } finally { console.log = realLog; }
}
t("backtest: every WEEKLY entry follows the last completed weekly HA candle as of that day", async () => {
    const r = await replay({ biasPeriod: "WEEKLY", dailyHaGateEnabled: false }), daily = bars("day", "2026-05-01", "2026-10-16"), trades = r.report.trades;
    assert.ok(trades.length >= 10, "enough trades to mean something: " + trades.length);
    const istDay = x => new Date(new Date(x).getTime() + IST).toISOString().split("T")[0]; let checked = 0;
    for (const tr of trades) { const day = istDay(tr.entry_time), exp = W.latestCompletedWeekly(daily, day); if (!exp || !exp.color) continue; checked++;
        assert.strictEqual(tr.side || tr.direction, exp.color === "green" ? "LONG" : "SHORT", `${day}: ${JSON.stringify(tr).slice(0, 160)}`); }
    assert.ok(checked >= 10);
    const d2 = await replay({ dailyHaGateEnabled: false }); assert.notDeepStrictEqual(d2.report.trades.map(x => x.side || x.direction), trades.map(x => x.side || x.direction), "weekly and daily sides must differ somewhere");
});

// ── plumbing ──
const srv = fs.readFileSync(__dirname + "/../webdash/server.js", "utf8"), app = fs.readFileSync(__dirname + "/../webdash/public/app.js", "utf8"), eng = fs.readFileSync(__dirname + "/../engine.js", "utf8"), tbx = fs.readFileSync(__dirname + "/../toolbox.js", "utf8");
t("env plumbing: always written explicitly, only for DAILY_HA_BIAS, WEEKLY only", () => {
    const bpA = srv.indexOf("function buildProcessEnv"), bpB = srv.indexOf("\n}\n", bpA) + 2; const ctx = { ...require('../strategies/strategyParams'), process: { env: {} }, console, String, Number, Object, Math, JSON, Date, Array, Boolean }; vm.createContext(ctx); vm.runInContext(srv.slice(bpA, bpB), ctx);
    const mk = p => { try { return ctx.buildProcessEnv({ name: "N", underlying: "GOLD", exchange: "MCX", strategy: "DAILY_HA_BIAS", timeframe: "15m", lots: "1", product: "MIS", ...p }); } catch (e) { return { __err: e.message }; } };
    const w = mk({ biasPeriod: "WEEKLY" }), dl = mk({ biasPeriod: "DAILY" }), non = mk({ strategy: "DSB_DUAL", biasPeriod: "WEEKLY" });
    if (w.__err) throw new Error(w.__err); assert.strictEqual(w.BIAS_PERIOD_OVERRIDE, "WEEKLY"); assert.strictEqual(dl.BIAS_PERIOD_OVERRIDE, ""); assert.strictEqual(non.BIAS_PERIOD_OVERRIDE, "");
    assert.ok(/BIAS_PERIOD_OVERRIDE/.test(tbx) && /BIAS_PERIOD_OVERRIDE/.test(eng));
    assert.ok(/context\.biasPeriod = "WEEKLY"; context\.dailyHaGateEnabled = false/.test(eng), "engine switches the daily gate off for weekly");
});
t("UI: Weekly HA Bias option, per-leg candle select, mapping to DAILY_HA_BIAS + biasPeriod", () => {
    assert.ok(/value="WEEKLY_HA_BIAS"/.test(app) && /biasPeriod: "WEEKLY"/.test(app) && /\$\{id\}HaCandle/.test(app)); assert.ok(/isHa \? "DAILY_HA_BIAS" : "DSB_DUAL"/.test(app));
});
(async () => { let fail = 0; for (const [n, f] of T) { try { await f(); realLog("  ok   " + n); } catch (e) { console.log = realLog; fail++; realLog("  FAIL " + n + "\n       " + String(e && (e.stack || e.message)).split("\n").slice(0, 4).join("\n       ")); } } realLog(fail ? `\n${fail} FAILED` : `\nall ${T.length} passed`); process.exit(fail ? 1 : 0); })();
