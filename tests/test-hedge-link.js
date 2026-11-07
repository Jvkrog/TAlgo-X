// Linked hedge pair: hedge decision, file link, stop suppression, strategy re-arm, server validation, engine wiring.
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { createHedgeLink, isHedged } = require("../hedge/hedgeLink");
const { createSLStore } = require("../core/sl");
const { createDsbDualStrategy, createDailyHaBiasStrategy } = require("../strategies/strategies");
const realLog = console.log; console.log = () => {};
const T = []; const t = (n, f) => T.push([n, f]);

t("isHedged: only when both open AND opposite", () => {
    assert.strictEqual(isHedged("LONG", "SHORT"), true); assert.strictEqual(isHedged("SHORT", "LONG"), true);
    for (const [a, b] of [["LONG", "LONG"], ["SHORT", "SHORT"], ["LONG", null], [null, "SHORT"], [null, null], ["LONG", undefined], ["x", "SHORT"]]) assert.strictEqual(isHedged(a, b), false, `${a}/${b}`);
});
t("link files: each leg writes only its own file, reads the peer's; null when flat or missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-")); const a = createHedgeLink({ group: "G", role: "A", dir }), b = createHedgeLink({ group: "G", role: "B", dir });
    assert.strictEqual(b.peerSide(), null);
    a.publish("LONG"); assert.strictEqual(b.peerSide(), "LONG"); assert.strictEqual(a.peerSide(), null);
    b.publish("SHORT"); assert.strictEqual(a.peerSide(), "SHORT"); assert.ok(isHedged("LONG", a.peerSide()));
    a.publish(null); assert.strictEqual(b.peerSide(), null);
    assert.strictEqual(a.publish(null), false, "no rewrite when unchanged");
    fs.writeFileSync(path.join(dir, "hedgelink_G_A.json"), "{broken"); assert.strictEqual(b.peerSide(), null, "corrupt peer file = unknown = not hedged");
    assert.throws(() => createHedgeLink({ group: "bad group!", role: "A", dir })); assert.throws(() => createHedgeLink({ group: "G", role: "C", dir }));
});
t("slStore: suppressed -> no stop held or readable; off -> unchanged behaviour", () => {
    let sup = false; const sl = createSLStore({ isSuppressed: () => sup });
    sl.setTrail(90, 1); assert.deepStrictEqual(sl.getTrail(), { trail: 90, dir: 1 });
    sup = true; assert.strictEqual(sl.getTrail().trail, null); sl.setTrail(95, 1);
    sl.clearTrail(); sup = false; assert.strictEqual(sl.getTrail().trail, null, "set while suppressed was ignored");
    const plain = createSLStore(); plain.setTrail(1, 1); assert.strictEqual(plain.getTrail().trail, 1);
});

// ── strategy re-arm ──
const IST = 5.5 * 3600e3, at = (d, h, m) => new Date(Date.UTC(2026, 9, d, h, m) - IST);
function day15(day) { const o = []; let tt = at(day, 9, 15); for (let i = 0; i < 25; i++) { o.push({ date: new Date(tt), open: 100, high: 100.5, low: 99.5, close: 100 }); tt = new Date(+tt + 15 * 60e3); } return o; }
const eng = { ENGINE_ENABLED: true, ST_ATR_LEN: 10, ATR_SL_MULT: 2, LIVE_ORDERS: false, RESUME_INTRADAY_ONLY: true, MAX_CANDLES: 600, BAND_STEP_DEFAULT: 1, BAND_STEP2_DEFAULT: 2 };
function mk(factory, state, sl, raw) {
    return factory({ context: { tgPrefix: "T", symbol: "X", token: 1, lots: 1 }, engineConfig: eng, state, db: { savePosition() {} }, candles: { getRawCandles: () => raw, getLivePrice: () => 100 },
        slStore: sl, targetStore: {}, orders: {}, positionsClose: async () => {}, positionsUnrealised: () => 0, lifecycle: { isShutdown: () => false }, tg() {}, dailyHa: {} });
}
for (const [name, factory] of [["DSB_DUAL", createDsbDualStrategy], ["DAILY_HA_BIAS", createDailyHaBiasStrategy]]) {
    t(`${name}.rearmStop sets a fresh 2x ATR stop from the live price (LONG & SHORT), no-op when flat`, () => {
        const raw = [...day15(1), ...day15(2)];
        for (const side of ["LONG", "SHORT"]) {
            const sl = createSLStore(), st = mk(factory, { position: side, entryPrice: 100 }, sl, raw);
            assert.strictEqual(st.rearmStop(), true); const lvl = sl.getTrail().trail;
            assert.ok(Math.abs(Math.abs(100 - lvl) - 2) < 1e-6, `${side} stop distance ${100 - lvl}`); assert.ok(side === "LONG" ? lvl < 100 : lvl > 100);
        }
        const sl = createSLStore(); assert.strictEqual(mk(factory, { position: null }, sl, raw).rearmStop(), false); assert.strictEqual(sl.getTrail().trail, null);
    });
}

// ── end-to-end: two links + two slStores through the same transition logic engine.js uses ──
t("transition: aligned->hedged clears stop; hedged->aligned re-arms; peer flat keeps stops", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-")); const raw = [...day15(1), ...day15(2)];
    const leg = (role, factory, position) => { const state = { position, entryPrice: 100 }; let hedgedNow = false; const sl = createSLStore({ isSuppressed: () => hedgedNow });
        const link = createHedgeLink({ group: "P", role, dir }); const strat = mk(factory, state, sl, raw);
        return { state, sl, tick() { link.publish(state.position); const h = isHedged(state.position, link.peerSide()); if (h === hedgedNow) return; hedgedNow = h; if (h) sl.clearTrail(); else if (state.position) strat.rearmStop(); } }; };
    const both = () => { A.tick(); B.tick(); A.tick(); B.tick(); };
    const A = leg("A", createDsbDualStrategy, "LONG"), B = leg("B", createDailyHaBiasStrategy, null);
    A.sl.setTrail(98, 1); both(); assert.strictEqual(A.sl.getTrail().trail, 98, "peer flat -> stop stays");
    B.state.position = "LONG"; B.sl.setTrail(98, 1); both(); assert.strictEqual(A.sl.getTrail().trail, 98); assert.strictEqual(B.sl.getTrail().trail, 98, "same direction -> stops active");
    B.state.position = "SHORT"; both(); assert.strictEqual(A.sl.getTrail().trail, null, "opposite -> A stop removed"); assert.strictEqual(B.sl.getTrail().trail, null, "opposite -> B stop removed");
    B.sl.setTrail(102, -1); assert.strictEqual(B.sl.getTrail().trail, null, "strategy re-setting while hedged is ignored");
    B.state.position = "LONG"; both(); assert.ok(A.sl.getTrail().trail !== null && B.sl.getTrail().trail !== null, "aligned again -> both re-armed");
    assert.ok(Math.abs(A.sl.getTrail().trail - 98) < 1e-6);
    B.state.position = "SHORT"; A.tick(); B.tick(); B.state.position = null; both(); assert.ok(A.sl.getTrail().trail !== null, "peer exits while hedged -> remaining leg gets a stop back");
});

// ── server + engine wiring ──
const srv = fs.readFileSync(__dirname + "/../webdash/server.js", "utf8"), engSrc = fs.readFileSync(__dirname + "/../engine.js", "utf8");
t("buildProcessEnv always writes HEDGE_LINK_* (an edit/mode restart must not unlink the pair)", () => {
    const a = srv.indexOf("function buildProcessEnv"), b = srv.indexOf("\n}\n", a) + 2; const fn = vm.runInNewContext("(" + srv.slice(a, b).replace("function buildProcessEnv", "function") + ")", { process: { env: {} }, ROOT: "/", PM2_BASE_OPTS: {}, console, Object, String, Number });
    let env; try { env = fn({ name: "n", underlying: "X", strategy: "DSB_DUAL", hedgeGroup: "P", hedgeRole: "B" }); } catch (e) { env = null; }
    if (env) { const e = env.env || env; assert.strictEqual(e.HEDGE_LINK_GROUP, "P"); assert.strictEqual(e.HEDGE_LINK_ROLE, "B"); const f0 = fn({ name: "n", underlying: "X", strategy: "DSB_DUAL" }), f = f0.env || f0; assert.strictEqual(f.HEDGE_LINK_GROUP, ""); }
    else assert.ok(/env\.HEDGE_LINK_GROUP = p\.hedgeGroup \|\| ""/.test(srv) && /env\.HEDGE_LINK_ROLE\s+= p\.hedgeGroup/.test(srv));
});
t("engine: link only when HEDGE_LINK_GROUP set; stop suppression wired; watcher re-arms via signalsInstance.rearmStop", () => {
    assert.ok(/if \(process\.env\.HEDGE_LINK_GROUP\)/.test(engSrc)); assert.ok(/isSuppressed: \(\) => hedgedNow/.test(engSrc)); assert.ok(/signalsInstance\.rearmStop/.test(engSrc));
    assert.ok(engSrc.indexOf("let hedgeLink = null") < engSrc.indexOf("createSLStore({"), "link state declared before slStore");
});
async function runAdd(body, existing) {
    const a = srv.indexOf('app.post("/api/toolbox/instrument"'), b = srv.indexOf("\n});", a) + 4, handler = srv.slice(a, b); const stubs = {}, routes = {};
    const ra = srv.indexOf("function resolveProductMode"), rb = srv.indexOf("\n}\n", ra) + 2;
    for (let i = 0; i < 120; i++) {
        const ctx = { app: { post: (r, h) => { routes[r] = h; } }, console, Object, Array, Number, String, Date, JSON, Math, Set, Map, Promise, Error, RegExp, process: { env: {} }, ...stubs,
            STRATEGIES: { DSB_DUAL: 1, DAILY_HA_BIAS: 1 }, DEFAULT_STRATEGY: "DSB_DUAL", STRATEGY_TIMEFRAME: {}, STRATEGY_INFO: {}, getEngineProcesses: async () => existing,
            ensureCsvLoaded: async () => ({}), getDefinition: () => ({ lotMult: 100 }), resolveCurrent: () => ({ contract: { lotSize: 1 } }), toProcessName: (u, s) => `${u}_${s}`, normalizeCandleType: () => null, pinStore: {}, customStrategyDb: { getStrategyByName: async () => null } };
        ctx.pm2Start = async () => {}; vm.createContext(ctx); vm.runInContext(srv.slice(ra, rb) + "\n" + handler, ctx);
        const r = await new Promise(res => routes["/api/toolbox/instrument"]({ body: JSON.parse(JSON.stringify(body)), params: {} }, { json: x => res({ status: 200, body: x }), status: c => ({ json: x => res({ status: c, body: x }) }) }));
        const m = r.status === 500 && /^(\w+) is not defined$/.exec(String((r.body || {}).error || "")); if (!m) return r; stubs[m[1]] = new Proxy(function () {}, { get: () => () => {}, apply: () => ({}) });
    }
    throw new Error("route never settled");
}
const base = { underlying: "NATGASMINI", exchange: "MCX", lots: 1, hedgeGroup: "P", hedgeRole: "A", strategy: "DSB_DUAL", product: "MIS" };
t("add route: hedge-pair validation", async () => {
    assert.strictEqual((await runAdd({ ...base, hedgeRole: "C" }, [])).status, 400);
    assert.strictEqual((await runAdd({ ...base, hedgeGroup: "bad group" }, [])).status, 400);
    assert.strictEqual((await runAdd({ ...base, strategy: "DAILY_HA_BIAS", product: "NRML" }, [])).status, 200 );
    const mate = { name: "m", hedgeGroup: "P", hedgeRole: "A", strategy: "DSB_DUAL", underlying: "NATGASMINI", exchange: "MCX", product: "MIS" };
    assert.strictEqual((await runAdd({ ...base, hedgeRole: "A", strategy: "DAILY_HA_BIAS", product: "NRML" }, [mate])).status, 409, "role taken");
    assert.strictEqual((await runAdd({ ...base, hedgeRole: "B", strategy: "DSB_DUAL", product: "NRML" }, [mate])).status, 400, "same strategy");
    const e1 = await runAdd({ ...base, hedgeRole: "B", strategy: "DAILY_HA_BIAS", product: "MIS" }, [mate]); assert.strictEqual(e1.status, 400); assert.ok(/MIS and the other NRML/.test(e1.body.error), JSON.stringify(e1));
    assert.strictEqual((await runAdd({ ...base, hedgeRole: "B", strategy: "DAILY_HA_BIAS", product: "NRML" }, [mate])).status, 200, "valid second leg");
    assert.strictEqual((await runAdd({ ...base, underlying: "ZINCMINI", hedgeRole: "B", strategy: "DAILY_HA_BIAS", product: "MIS" }, [mate])).status, 200, "different contracts may share a product");
    assert.strictEqual((await runAdd({ ...base, strategy: "ALMA_DSB" }, [])).status, 400);
});
(async () => { let fail = 0; for (const [n, f] of T) { try { await f(); realLog("  ok   " + n); } catch (e) { fail++; realLog("  FAIL " + n + "\n       " + (e && (e.stack || e.message)).split("\n").slice(0, 3).join("\n       ")); } } realLog(fail ? `\n${fail} FAILED` : `\nall ${T.length} passed`); process.exit(fail ? 1 : 0); })();
