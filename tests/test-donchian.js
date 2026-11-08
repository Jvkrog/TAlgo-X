"use strict";
const assert = require("assert");
const { createTrendDonchianVtStrategy, donchianSignal, sizeLots } = require("../strategies/trendDonchianVt");
const { resolveParams, validateParams, paramsToEnv, paramsFromEnv } = require("../strategies/strategyParams");
let fail = 0; const t = async (n, f) => { try { await f(); console.log("  ok   " + n); } catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); } };
const mkBars = (closes, spread = 1) => closes.map((cl, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)), open: cl, high: cl + spread, low: cl - spread, close: cl }));
const flat = n => Array(n).fill(100);

(async () => {
    await t("signal: breakout above the 20d high enters LONG, fresh only on the first bar", async () => {
        const s1 = donchianSignal(mkBars([...flat(25), 110]), { entryN: 20, exitN: 10, reentry: "fresh" });
        assert(s1.enterLong && !s1.enterShort);
        const s2 = donchianSignal(mkBars([...flat(25), 110, 112]), { entryN: 20, exitN: 10, reentry: "fresh" });
        assert(!s2.enterLong, "second consecutive breakout bar is not fresh");
        const s3 = donchianSignal(mkBars([...flat(25), 110, 112]), { entryN: 20, exitN: 10, reentry: "any" });
        assert(s3.enterLong, "any mode re-enters while beyond the channel");
    });
    await t("signal: breakdown enters SHORT; exits use the shorter channel", async () => {
        const s = donchianSignal(mkBars([...flat(25), 90]), { entryN: 20, exitN: 10, reentry: "fresh" });
        assert(s.enterShort && !s.enterLong && s.exitLong && !s.exitShort);
    });
    await t("signal: not enough bars -> null; no look-ahead (channel excludes the signal bar)", async () => {
        assert.strictEqual(donchianSignal(mkBars(flat(10)), { entryN: 20, exitN: 10, reentry: "fresh" }), null);
        const s = donchianSignal(mkBars([...flat(25), 100.5]), { entryN: 20, exitN: 10, reentry: "fresh" });
        assert(!s.enterLong, "100.5 close is inside the 101 high of the prior bars");
    });
    await t("sizing: risk budget, clamp, overshoot, fixed fallback", async () => {
        const base = { riskPct: 0.5, maxLots: 3, minLotOvershoot: 1.5, stopAtrMult: 2, lotMult: 250, fixedLots: 2 };
        assert.strictEqual(sizeLots({ ...base, equity: 0, atrVal: 10 }).lots, 2);                    // off -> fixed
        const a = sizeLots({ ...base, equity: 1e6, atrVal: 4 });                                    // budget 5000, per lot 2*4*250=2000 -> 2
        assert.strictEqual(a.lots, 2);
        assert.strictEqual(sizeLots({ ...base, equity: 1e7, atrVal: 4 }).lots, 3);                  // capped at maxLots
        const o = sizeLots({ ...base, equity: 1e6, atrVal: 12 });                                   // per lot 6000 > budget 5000 but <= 1.5x -> 1 lot
        assert(o.lots === 1 && !o.skip);
        const sk = sizeLots({ ...base, equity: 1e6, atrVal: 20 });                                  // per lot 10000 > 7500 -> skip
        assert(sk.skip && sk.lots === 0);
    });

    // ---- strategy integration with fake deps
    function rig({ bars, orders, hour = 10, params = {}, lots = 1, saved = null, openTrade = null }) {
        const log = { closes: [], saves: [], inserted: [], tg: [] };
        const context = { tgPrefix: "T", symbol: "S", token: 1, lots, lotMult: 250, carryOvernight: true, strategyParams: params };
        const state = { position: null, pnl: 0, trades: 0 };
        const slSet = []; let sl = null;
        const strat = createTrendDonchianVtStrategy({
            context, state, engineConfig: { ENGINE_ENABLED: true, LIVE_ORDERS: true, RESUME_INTRADAY_ONLY: true },
            db: { savePosition: (...a) => log.saves.push(a), insertOpenTrade: async (...a) => { log.inserted.push(a); return 7; }, loadPosition: async () => saved, getOpenTrade: async () => openTrade, getRealizedPnlToday: async () => 0, getTradeCountToday: async () => 0 },
            candles: { getLivePrice: () => bars[bars.length - 1].close }, slStore: { setTrail: (v, d) => { sl = [v, d]; slSet.push([v, d]); }, clearTrail: () => { sl = null; } }, targetStore: { clearTarget() {} },
            orders: { reconcile: async () => {}, ...orders }, positionsClose: async (p, r) => { log.closes.push([p, r]); state.position = null; }, positionsUnrealised: () => 0,
            lifecycle: { isShutdown: () => false }, tg: m => log.tg.push(m),
            clock: { now: () => new Date(Date.UTC(2026, 5, 10, hour - 5, 30 - 30 + 0)) },   // hour IST (UTC+5:30)
            dailyBars: { getCompleted: async () => bars },
        });
        return { strat, context, state, log, getSl: () => sl };
    }
    const up = mkBars([...flat(30), 110]);                                       // fresh LONG breakout; ATR ~ 2.x
    await t("entry: LONG sized by vol target, stop = 2 ATR below, lots set on context + DB row", async () => {
        const r = rig({ bars: up, orders: { enter: async () => "oid", exit: async () => "oid" }, params: { equity: 1e6, riskPct: 0.5, maxLots: 3 } });
        await r.strat.processCandle({ close: 110 });
        assert.strictEqual(r.state.position, "LONG");
        assert(r.context.lots >= 1 && r.context.lots <= 3 && r.log.inserted[0][3] === r.context.lots);
        const [stop, dir] = r.getSl(); assert(dir === 1 && stop < 110 && stop > 90);
        assert(r.log.saves.some(a => a[3] === "LONG"));
    });
    await t("entry before the decision time does nothing; once per day", async () => {
        const early = rig({ bars: up, hour: 9, orders: { enter: async () => "oid" } }); await early.strat.processCandle({ close: 110 }); assert.strictEqual(early.state.position, null);
        let n = 0; const r = rig({ bars: up, orders: { enter: async () => { n++; return null; }, exit: async () => "oid" } });
        await r.strat.processCandle({ close: 110 }); await r.strat.processCandle({ close: 110 });
        assert.strictEqual(n, 1, "a failed entry is not retried the same day");
    });
    await t("failed entry order: stays flat, lots restored", async () => {
        const r = rig({ bars: up, lots: 2, orders: { enter: async () => null }, params: { equity: 1e6 } });
        await r.strat.processCandle({ close: 110 });
        assert.strictEqual(r.state.position, null); assert.strictEqual(r.context.lots, 2); assert.strictEqual(r.log.inserted.length, 0);
    });
    await t("oversized single lot is skipped with an alert", async () => {
        const r = rig({ bars: up, orders: { enter: async () => { throw new Error("must not order"); } }, params: { equity: 1000, riskPct: 0.5 } });
        await r.strat.processCandle({ close: 110 });
        assert.strictEqual(r.state.position, null); assert(r.log.tg.some(m => /skipped/.test(m)));
    });
    await t("channel exit: closes, and a failed exit order keeps the position and retries", async () => {
        const down = mkBars([...flat(30), 108, 108, 108, 108, 108, 108, 108, 108, 108, 108, 96]);   // closes below the 10d low
        let fails = 1;
        const r = rig({ bars: down, orders: { enter: async () => "oid", exit: async () => (fails-- > 0 ? null : "oid") } });
        r.state.position = "LONG"; r.state.entryPrice = 108; r.context.lots = 2;
        await r.strat.processCandle({ close: 96 });
        assert.strictEqual(r.state.position, "LONG"); assert.strictEqual(r.log.closes.length, 0);
        await r.strat.processCandle({ close: 96 });                            // not decided yet -> retried
        assert.strictEqual(r.log.closes.length, 1);
    });
    await t("resume restores the size the open trade was opened with", async () => {
        const r = rig({ bars: up, orders: {}, lots: 1, saved: { position: "LONG", entry_price: 105, entry_date: "2026-06-08", position_source: "TREND_DONCHIAN_VT" }, openTrade: { id: 9, qty: 3 } });
        await r.strat.initSignals();
        assert(r.state.position === "LONG" && r.context.lots === 3 && r.state.openTradeId === 9);
    });
    await t("params: defaults, validation, env round trip", async () => {
        const d = resolveParams("TREND_DONCHIAN_VT", {}); assert(d.values.entryN === 20 && d.values.exitN === 10 && d.values.entryTime === "10:00");
        const v = validateParams("TREND_DONCHIAN_VT", { entryN: "55", reentry: "ANY", entryTime: "9:30", bogus: 1 });
        assert(!v.ok && v.params.entryN === 55 && v.params.reentry === "any" && v.params.entryTime === "09:30" && v.errors.some(e => /bogus/.test(e)));
        assert(!validateParams("TREND_DONCHIAN_VT", { entryN: 3 }).ok && !validateParams("TREND_DONCHIAN_VT", { exitN: 2.5 }).ok);
        const env = paramsToEnv("TREND_DONCHIAN_VT", { entryN: 55 }); assert.strictEqual(paramsFromEnv("TREND_DONCHIAN_VT", env).values.entryN, 55);
        assert.strictEqual(paramsToEnv("TREND_DONCHIAN_VT", {}), ""); assert.strictEqual(paramsToEnv("DAILY_HA_BIAS", { a: 1 }), "");
        assert(paramsFromEnv("TREND_DONCHIAN_VT", "{bad").errors.length === 1);
    });
    console.log(fail ? `\n${fail} FAILED` : "\nall passed"); process.exit(fail ? 1 : 0);
})();
