// DAILY_HA_BIAS opt-in trailing stop (chandelier on best price) + 1h ATR. Real strategy code, stubbed deps.
const assert = require("assert");
const { createDailyHaBiasStrategy } = require("./strategies");
const { createSLStore: createSl } = require("./sl");
const { atr } = require("./indicators");
const vm = require("vm"), fs = require("fs");
const srv = fs.readFileSync(__dirname + "/webdash/server.js", "utf8");
async function runEdit(strategy, body) {
    const bpA = srv.indexOf("function buildProcessEnv"), bpB = srv.indexOf("\n}\n", bpA) + 2;
    const ra = srv.indexOf("function resolveProductMode"), rb = srv.indexOf("\n}\n", ra) + 2, ma = srv.indexOf("function resolveModeProduct"), mb = srv.indexOf("\n}\n", ma) + 2;
    const ha = srv.indexOf('app.post("/api/toolbox/edit"'), hb = srv.indexOf("\n});", ha) + 4;
    const stubs = {}, routes = {};
    for (let i = 0; i < 80; i++) {
        const envs = [];
        const ctx = { app: { post: (r, h) => { routes[r] = h; } }, console, Object, Array, Number, String, Date, JSON, Math, Set, Map, Promise, Error, process: { env: {} }, ...stubs,
            getEngineProcesses: async () => [{ name: "N", underlying: "GOLD", strategy, timeframe: "15m", live: false, exchange: "MCX", lots: "1", product: "MIS" }],
            pm2RestartWithConfig: async o => { envs.push(o.env); }, pm2Restart: async o => { envs.push(o.env); } };
        vm.createContext(ctx); vm.runInContext(srv.slice(ra, rb) + "\n" + srv.slice(ma, mb) + "\n" + srv.slice(bpA, bpB) + "\n" + srv.slice(ha, hb), ctx);
        const r = await new Promise(res => routes["/api/toolbox/edit"]({ body: JSON.parse(JSON.stringify(body)), params: {} }, { json: b => res({ status: 200, body: b }), status: c => ({ json: b => res({ status: c, body: b }) }) }));
        const m = r.status === 500 && /^(\w+) is not defined$/.exec(String((r.body || {}).error || ""));
        if (!m) return { r, env: envs[0] };
        assert(!["slTrail", "atrSlTimeframe"].includes(m[1]), m[1] + " is not defined");
        stubs[m[1]] = new Proxy(function () {}, { get: () => () => {}, apply: () => ({}) });
    }
    throw new Error("route never settled");
}
const origLog = console.log; console.log = () => {};
const IST = 5.5 * 3600e3;
const at = (day, h, m) => new Date(Date.UTC(2026, 9, day, h, m) - IST);   // IST wall clock -> Date
// 15m candles 09:15..15:15 on `day`, flat range 1 around base unless overridden
function day15(day, base, f) { const out = []; let t = at(day, 9, 15); for (let i = 0; i < 25; i++) { const b = f ? f(i, base) : { o: base, h: base + 0.5, l: base - 0.5, c: base }; out.push({ date: new Date(t), open: b.o, high: b.h, low: b.l, close: b.c }); t = new Date(+t + 15 * 60e3); } return out; }
function make(ctx, raw, nowFn) {
    const sl = createSl();
    const state = { position: null, pnl: 0 }; let live = null, entered = null;
    const candles = { getRawCandles: () => raw, getLivePrice: () => live };
    const context = { tgPrefix: "T", symbol: "X", token: 1, lots: 1, dailyBiasEntryHour: 10, dailyBiasEntryMinute: 0, longCandleFilterEnabled: false, ...ctx };
    const clockObj = { now: () => nowFn() };
    const strat = createDailyHaBiasStrategy({
        context, engineConfig: { ENGINE_ENABLED: true, ST_ATR_LEN: 10, ATR_SL_MULT: 2, LIVE_ORDERS: false, RESUME_INTRADAY_ONLY: true },
        state, db: { insertOpenTrade: async () => 1, savePosition() {}, loadPosition: async () => null },
        candles, slStore: sl, targetStore: {}, orders: { enter: async s => { entered = s; return {}; }, reconcile: async () => {} },
        positionsClose: async () => {}, positionsUnrealised: () => 0, lifecycle: { isShutdown: () => false }, tg() {}, clock: clockObj,
        dailyHa: { getLatest: () => ({ color: ctx.__color || "green", date: at(1, 0, 0), open: 100, close: 101, high: 102, low: 99 }) },
    });
    return { strat, sl, state, setLive: v => (live = v), entered: () => entered };
}
(async () => {
    const T = [];
    const t = (n, f) => T.push([n, f]);
    // Day 1 candles with constant true range 1.0 (h=base+.5,l=base-.5) -> ATR(10)=1.0 ; mult 2 => stop distance 2.
    const mk = (n) => [...day15(1, 100), ...day15(2, 100).slice(0, n)];

    t("default (no opt-in): stop stays fixed even when price runs", async () => {
        let now = at(2, 10, 0); const raw = mk(4); const h = make({}, raw, () => now);
        h.setLive(100); await h.strat.processCandle(raw[raw.length - 1]);
        assert.strictEqual(h.state.position, "LONG"); const entry = h.sl.getTrail().trail;
        raw.push({ date: at(2, 10, 15), open: 100, high: 110, low: 100, close: 109 }); now = at(2, 10, 15); h.setLive(109);
        await h.strat.processCandle(raw[raw.length - 1]);
        assert.strictEqual(h.sl.getTrail().trail, entry);
    });
    t("trail LONG: ratchets up with best high, never down", async () => {
        let now = at(2, 10, 0); const raw = mk(4); const h = make({ slTrail: true }, raw, () => now);
        h.setLive(100); await h.strat.processCandle(raw[raw.length - 1]);
        const entry = h.sl.getTrail().trail; assert.ok(Math.abs(entry - (100 - 2 * 1.0)) < 1e-9, "entry stop " + entry);
        const push = (hi, lo) => { raw.push({ date: new Date(+raw[raw.length - 1].date + 15 * 60e3), open: 100, high: hi, low: lo, close: hi }); now = new Date(+now + 15 * 60e3); };
        push(110, 100); await h.strat.processCandle(raw[raw.length - 1]);
        const l1 = h.sl.getTrail().trail; assert.ok(l1 > entry, "moved up " + l1);
        push(104, 95); await h.strat.processCandle(raw[raw.length - 1]);          // pullback: best stays 110
        assert.strictEqual(h.sl.getTrail().trail, l1);
        push(120, 112); await h.strat.processCandle(raw[raw.length - 1]);
        assert.ok(h.sl.getTrail().trail > l1);
    });
    t("trail SHORT: ratchets down", async () => {
        let now = at(2, 10, 0); const raw = mk(4); const h = make({ slTrail: true, __color: "red" }, raw, () => now);
        h.setLive(100); await h.strat.processCandle(raw[raw.length - 1]);
        assert.strictEqual(h.state.position, "SHORT"); const entry = h.sl.getTrail().trail;
        raw.push({ date: at(2, 10, 15), open: 100, high: 100, low: 90, close: 91 }); now = at(2, 10, 15);
        await h.strat.processCandle(raw[raw.length - 1]);
        assert.ok(h.sl.getTrail().trail < entry);
    });
    t("hard rupee stop disables trailing", async () => {
        let now = at(2, 10, 0); const raw = mk(4); const h = make({ slTrail: true, hardSlRupees: 500 }, raw, () => now);
        h.setLive(100); await h.strat.processCandle(raw[raw.length - 1]);
        const entry = h.sl.getTrail().trail;
        raw.push({ date: at(2, 10, 15), open: 100, high: 130, low: 100, close: 129 }); now = at(2, 10, 15);
        await h.strat.processCandle(raw[raw.length - 1]);
        assert.strictEqual(h.sl.getTrail().trail, entry);
    });
    t("restart: stop re-armed from today's candles when trail on", async () => {
        let now = at(2, 11, 0); const raw = [...day15(1, 100), ...day15(2, 100).slice(0, 8)]; raw[raw.length - 3].high = 112;
        const h = make({ slTrail: true }, raw, () => now);
        h.state.position = "LONG"; h.state.entryPrice = 100; h.state.dailyBiasDecidedForDate = "2026-10-02";
        assert.strictEqual(h.sl.getTrail().trail, null);
        await h.strat.processCandle(raw[raw.length - 1]);
        assert.ok(Math.abs(h.sl.getTrail().trail - (112 - 2 * atr(raw, 10))) < 1e-9, "got " + h.sl.getTrail().trail);
    });
    t("restart without trail opt-in leaves stop unarmed (unchanged behaviour)", async () => {
        let now = at(2, 11, 0); const raw = [...day15(1, 100), ...day15(2, 100).slice(0, 8)];
        const h = make({}, raw, () => now); h.state.position = "LONG"; h.state.entryPrice = 100; h.state.dailyBiasDecidedForDate = "2026-10-02";
        await h.strat.processCandle(raw[raw.length - 1]); assert.strictEqual(h.sl.getTrail().trail, null);
    });
    t("1h ATR: uses completed 1h bars (range 4/hour -> ATR 4, stop 8) not 15m ATR (1)", async () => {
        // two prior days of 15m candles, each hour: one candle spans wide so 1h TR = 4
        const f = (i, b) => { const q = i % 4; return { o: b, h: b + (q === 0 ? 2 : 0.5), l: b - (q === 3 ? 2 : 0.5), c: b }; };
        const raw = [...day15(-1, 100, f), ...day15(0, 100, f), ...day15(1, 100, f), ...day15(2, 100, f)];
        const cut = raw.findIndex(k => +k.date >= +at(2, 10, 15)); const sub = raw.slice(0, cut);
        let now = at(2, 10, 15);
        const h1 = make({ atrSlTimeframe: "1h" }, sub, () => now); h1.setLive(100); await h1.strat.processCandle(sub[sub.length - 1]);
        const h15 = make({}, sub, () => now); h15.setLive(100); await h15.strat.processCandle(sub[sub.length - 1]);
        assert.strictEqual(h1.state.position, "LONG"); assert.strictEqual(h15.state.position, "LONG");
        const d1 = 100 - h1.sl.getTrail().trail, d15 = 100 - h15.sl.getTrail().trail;
        assert.ok(d1 > d15 * 2, `1h distance ${d1} should be much wider than 15m distance ${d15}`);
    });
    t("1h ATR: incomplete trailing hour is never used", async () => {
        const f = (i, b) => ({ o: b, h: b + 0.5, l: b - 0.5, c: b });
        const raw = [...day15(-1, 100, f), ...day15(0, 100, f), ...day15(1, 100, f), ...day15(2, 100, f)]; const cut = raw.findIndex(k => +k.date >= +at(2, 10, 15));
        const sub = raw.slice(0, cut + 1);   // adds first candle of a new (10:15) hour -> incomplete group
        sub[sub.length - 1] = { ...sub[sub.length - 1], high: 999, low: 1 };   // would blow ATR up if used
        let now = at(2, 10, 30); const h = make({ atrSlTimeframe: "1h" }, sub, () => now); h.setLive(100);
        await h.strat.processCandle(sub[sub.length - 1]);
        assert.strictEqual(h.state.position, "LONG"); const d = 100 - h.sl.getTrail().trail; assert.ok(d < 10, "incomplete hour leaked: " + d);
    });
    t("1h ATR: too little hourly history -> fail safe, no entry", async () => {
        const raw = day15(2, 100).slice(0, 4); let now = at(2, 10, 0);
        const h = make({ atrSlTimeframe: "1h" }, raw, () => now); h.setLive(100); await h.strat.processCandle(raw[raw.length - 1]);
        assert.strictEqual(h.state.position, null, "only 1 prior-less partial hour -> fail safe");
    });
    t("edit route: slTrail/atrSlTimeframe reach the engine env (DAILY_HA_BIAS), and never leak to other strategies", async () => {
        const a = await runEdit("DAILY_HA_BIAS", { name: "N", slTrail: true, atrSlTimeframe: "1h" });
        assert.strictEqual(a.r.status, 200, JSON.stringify(a.r)); assert.strictEqual(a.env.SL_TRAIL_OVERRIDE, "1"); assert.strictEqual(a.env.ATR_SL_TF_OVERRIDE, "1h");
        const b = await runEdit("DAILY_HA_BIAS", { name: "N", slTrail: false, atrSlTimeframe: "15m" });
        assert.strictEqual(b.env.SL_TRAIL_OVERRIDE, ""); assert.strictEqual(b.env.ATR_SL_TF_OVERRIDE, "");
        const c2 = await runEdit("DSB_DUAL", { name: "N", slTrail: true, atrSlTimeframe: "1h" });
        assert.strictEqual(c2.env.SL_TRAIL_OVERRIDE, ""); assert.strictEqual(c2.env.ATR_SL_TF_OVERRIDE, "");
        const bad = await runEdit("DAILY_HA_BIAS", { name: "N", atrSlTimeframe: "4h" }); assert.strictEqual(bad.r.status, 400);
    });
    t("engine env -> context (SL_TRAIL_OVERRIDE / ATR_SL_TF_OVERRIDE), defaults off", async () => {
        const eng = fs.readFileSync(__dirname + "/engine.js", "utf8"); const a = eng.indexOf("process.env.SL_TRAIL_OVERRIDE"), b = eng.indexOf("\n", eng.indexOf("ATR_SL_TF_OVERRIDE", a));
        const blk = eng.slice(a - 4, b); const run = env => { const context = {}; vm.runInNewContext(blk, { process: { env }, context }); return context; };
        assert.deepStrictEqual({ ...run({}) }, {}); const x = run({ SL_TRAIL_OVERRIDE: "1", ATR_SL_TF_OVERRIDE: "1h" }); assert.strictEqual(x.slTrail, true); assert.strictEqual(x.atrSlTimeframe, "1h");
        assert.deepStrictEqual({ ...run({ SL_TRAIL_OVERRIDE: "", ATR_SL_TF_OVERRIDE: "" }) }, {});
    });
    let fail = 0;
    for (const [n, f] of T) { try { await f(); origLog("  ok   " + n); } catch (e) { fail++; origLog("  FAIL " + n + "\n       " + (e && e.message)); } }
    console.log = origLog; origLog(fail ? `\n${fail} FAILED` : `\nall ${T.length} passed`); process.exit(fail ? 1 : 0);
})();
