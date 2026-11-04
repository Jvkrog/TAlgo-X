// Linked hedge pair backtest: barrier/sync unit tests + an end-to-end replay (fake Kite) with a per-candle invariant probe.
const assert = require("assert");
const { createPairSync, runLinkedPairBacktest } = require("./backtestLinkedPair");
const { runBacktest } = require("./backtestRun");
const { getDefinition, buildContext } = require("./context");
const { isHedged } = require("./hedgeLink");
const realLog = console.log; const T = []; const t = (n, f) => T.push([n, f]);

// ── barrier unit tests with fake legs ──
const fakeRef = pos => ({ state: { position: pos }, slStore: { cleared: 0, clearTrail() { this.cleared++; } }, strategy: { rearmed: 0, rearmStop() { this.rearmed++; } } });
const candle = t => ({ date: new Date(t) });
t("sync: opposite -> both clear; aligned again -> both re-arm; counts transitions", async () => {
    const s = createPairSync(), A = s.leg("A"), B = s.leg("B"), ra = fakeRef("LONG"), rb = fakeRef("SHORT"); A.attach(ra); B.attach(rb);
    await Promise.all([A.afterSignal(candle(1)), B.afterSignal(candle(1))]);
    assert.ok(A.hedged() && B.hedged()); assert.strictEqual(ra.slStore.cleared, 1); assert.strictEqual(rb.slStore.cleared, 1); assert.strictEqual(s.stats.hedgeEvents, 1);
    rb.state.position = "LONG"; await Promise.all([A.afterSignal(candle(2)), B.afterSignal(candle(2))]);
    assert.ok(!A.hedged() && !B.hedged()); assert.strictEqual(ra.strategy.rearmed, 1); assert.strictEqual(rb.strategy.rearmed, 1); assert.strictEqual(s.stats.unhedgeEvents, 1);
    rb.state.position = null; await Promise.all([A.afterSignal(candle(3)), B.afterSignal(candle(3))]); assert.ok(!A.hedged(), "peer flat = not hedged");
});
t("sync: a leg that runs ahead waits for the peer (no deadlock, lockstep)", async () => {
    const s = createPairSync(), A = s.leg("A"), B = s.leg("B"); A.attach(fakeRef("LONG")); B.attach(fakeRef("SHORT")); const order = [];
    const a = (async () => { for (let i = 1; i <= 5; i++) { await A.afterSignal(candle(i)); order.push("A" + i); } })();
    const b = (async () => { for (let i = 1; i <= 5; i++) { await new Promise(r => setTimeout(r, 3)); await B.afterSignal(candle(i)); order.push("B" + i); } })();
    await Promise.all([a, b]); assert.strictEqual(order.length, 10); assert.strictEqual(s.stats.candles, 5);
});
t("sync: misaligned candles and a failed peer stop the run with a clear error", async () => {
    let s = createPairSync(), A = s.leg("A"), B = s.leg("B"); A.attach(fakeRef(null)); B.attach(fakeRef(null));
    await assert.rejects(Promise.all([A.afterSignal(candle(1000)), B.afterSignal(candle(2000))]), /do not line up/);
    s = createPairSync(); A = s.leg("A"); B = s.leg("B"); A.attach(fakeRef(null)); const p = A.afterSignal(candle(1)); B.finish(new Error("boom")); await assert.rejects(p, /other leg's backtest failed — boom/);
    s = createPairSync(); A = s.leg("A"); B = s.leg("B"); A.attach(fakeRef("LONG")); B.finish(); await A.afterSignal(candle(1)); assert.ok(!A.hedged(), "finished peer = flat");
});

// ── end-to-end ──
const IST = 5.5 * 3600e3;
function bars(interval, fromStr, toStr) {
    const out = []; const d0 = new Date(fromStr + "T00:00:00Z"), d1 = new Date(toStr + "T00:00:00Z");
    for (let d = d0; d <= d1; d = new Date(+d + 86400e3)) {
        const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue; const dayIdx = Math.round((d - new Date("2026-01-01T00:00:00Z")) / 86400e3);
        const px = (dayIdx, m) => 100 + 6 * Math.sin((dayIdx + m / 1440) * 2 * Math.PI / 4.3) + 2.2 * Math.sin((dayIdx + m / 1440) * 2 * Math.PI * 3.1);
        if (interval === "day") { const o = px(dayIdx, 0), c = px(dayIdx, 1439); out.push({ date: new Date(+d - IST), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c }); continue; }
        for (let m = 9 * 60; m < 23 * 60 + 30; m += 15) { const o = px(dayIdx, m), c = px(dayIdx, m + 15); out.push({ date: new Date(+d + m * 60e3 - IST), open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c }); }
    } return out;
}
const kc = { getHistoricalData: async (tok, interval, f, to) => bars(interval === "15minute" ? "15" : interval, f, to) };
function leg(role, strategyKey, carry, extra = {}) {
    const def = getDefinition("NATGASMINI", "MCX"); const context = buildContext(def, { token: 1, symbol: "NATGASMINI26X", expiry: new Date("2026-12-01"), tickSize: 0.1, lotSize: 1 });
    context.lotMult = context.lotMult || 250; context.timeframe = "15m"; context.carryOvernight = carry; context.lots = 1; context.tgPrefix += "_" + role; Object.assign(context, extra);
    return { role, label: strategyKey, args: { strategyKey, strategyLabel: strategyKey, context, timeframe: "15m", from: new Date("2026-09-01T00:00:00+05:30"), to: new Date("2026-09-20T23:59:59+05:30"), params: {}, kc } };
}
t("e2e: real strategies replay side by side; whenever hedged neither leg holds a stop", async () => {
    const violations = []; let hedgedSeen = 0, alignedSeen = 0;
    const sync = createPairSync(); const refs = {};
    const legs = [leg("A", "DSB_DUAL", false), leg("B", "DAILY_HA_BIAS", true)];
    console.log = () => {};
    const runs = legs.map(l => { const pl = sync.leg(l.role);
        const wrapped = { hedged: pl.hedged, finish: pl.finish, attach(ref) { refs[l.role] = ref; pl.attach(ref); },
            async afterSignal(cd) { await pl.afterSignal(cd); const me = refs[l.role], other = refs[l.role === "A" ? "B" : "A"]; if (!other) return;
                const hedged = isHedged(me.state.position, other.state.position), trail = me.slStore.getTrail().trail;
                if (hedged) { hedgedSeen++; if (trail !== null) violations.push(`${l.role} hedged but stop ${trail} @ ${cd.date.toISOString()}`); } } };
        return runBacktest({ ...l.args, pairSync: wrapped }).then(r => { pl.finish(); return r; }, e => { pl.finish(e); throw e; }); });
    let results; try { results = await Promise.all(runs); } finally { console.log = realLog; }
    assert.deepStrictEqual(violations.slice(0, 3), []); assert.ok(sync.stats.hedgedCandles > 0, "series never produced a hedged state — test is vacuous");
    assert.ok(sync.stats.hedgeEvents > 0 && sync.stats.unhedgeEvents > 0, JSON.stringify({ ...sync.stats, hedgedDays: sync.stats.hedgedDays.size }));
    for (const r of results) assert.ok(r.report.metrics.trades > 0);
});
t("e2e: runLinkedPairBacktest returns a combined report that equals the legs' sum", async () => {
    console.log = () => {}; let r; try { r = await runLinkedPairBacktest({ legs: [leg("A", "DSB_DUAL", false), leg("B", "DAILY_HA_BIAS", true)], from: new Date("2026-09-01T00:00:00+05:30"), to: new Date("2026-09-20T23:59:59+05:30"), pairName: "TestLink" }); } finally { console.log = realLog; }
    const sum = r.report.legs.reduce((a, l) => a + l.metrics.netPnL, 0); assert.ok(Math.abs(r.report.metrics.netPnL - sum) < 1e-6, `${r.report.metrics.netPnL} vs ${sum}`);
    assert.strictEqual(r.report.metrics.trades, r.report.legs[0].metrics.trades + r.report.legs[1].metrics.trades); assert.ok(r.report.hedge.hedgedCandles > 0);
    assert.ok(r.report.trades.every(x => x.leg === "A" || x.leg === "B")); require("fs").existsSync(r.paths.htmlPath) && assert.ok(true);
});
const fs = require("fs"), vm = require("vm"); const srv = fs.readFileSync(__dirname + "/webdash/server.js", "utf8");
async function runLinkedRoute(body) {
    const a = srv.indexOf('app.post("/api/toolbox/backtest/linked"'), b = srv.indexOf("\n});", a) + 4; let routes = {};
    const ctx = { app: { post: (r, h) => { routes[r] = h; } }, STRATEGY_INFO: {}, console, Array, Object, String, Number, backtestHandler: async () => {} }; vm.createContext(ctx); vm.runInContext(srv.slice(a, b), ctx);
    return new Promise(res => routes["/api/toolbox/backtest/linked"]({ body }, { json: x => res({ status: 200, body: x }), status: c => ({ json: x => res({ status: c, body: x }) }) }));
}
t("linked route: input validation (two legs, different strategies, only DSB_DUAL / DAILY_HA_BIAS)", async () => {
    assert.strictEqual((await runLinkedRoute({ legs: [{}] })).status, 400);
    assert.strictEqual((await runLinkedRoute({ legs: [{ strategy: "DSB_DUAL" }, { strategy: "DSB_DUAL" }] })).status, 400);
    assert.strictEqual((await runLinkedRoute({ legs: [{ strategy: "DSB_DUAL" }, { strategy: "ALMA_DSB" }] })).status, 400);
});
t("linked route: prepare-only hook sits before the run and the plain route is still registered", () => {
    assert.ok(srv.indexOf("req.__prepareOnly") > 0 && srv.indexOf("req.__prepareOnly") < srv.indexOf("const kc = ensureToolboxKite();", srv.indexOf("req.__prepareOnly")));
    assert.ok(/app\.post\("\/api\/toolbox\/backtest", backtestHandler\)/.test(srv));
});
(async () => { let fail = 0; for (const [n, f] of T) { try { await f(); realLog("  ok   " + n); } catch (e) { console.log = realLog; fail++; realLog("  FAIL " + n + "\n       " + String(e && (e.stack || e.message)).split("\n").slice(0, 4).join("\n       ")); } } realLog(fail ? `\n${fail} FAILED` : `\nall ${T.length} passed`); process.exit(fail ? 1 : 0); })();
