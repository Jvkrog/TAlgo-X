// test-risk-observer.js — unit/scenario tests for riskObserver/. Run: node test-risk-observer.js
"use strict";
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const engineConfig = { ...require("./engineConfig") };
const { newMachine, step } = require("./riskObserver/riskState");
const { createPositionMetrics } = require("./riskObserver/riskMetrics");
const { createDsbMonitor, relation } = require("./riskObserver/dsbMonitor");
const { createCandleFeed } = require("./riskObserver/priceMonitor");
const { createRiskObserver, resolveParams } = require("./riskObserver/observer");
const { createMemoryStore, createSqliteStore } = require("./riskObserver/riskStore");

const cfg = resolveParams(engineConfig, {});
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log("ok  -", name); }
const run = (m, inputs, n = 1) => { let tr = null; for (let i = 0; i < n; i++) { const o = step(m, inputs, cfg); m = o.machine; if (o.transition) tr = o.transition; } return { m, tr }; };
const calm = { adverseAtr: 0.1, adverseCandles: 0, disagreeCandles: 0, oppositeAgree: false };

(async () => {
    // ── risk state machine ──
    await t("normal trend stays NORMAL", async () => { const { m, tr } = run(newMachine(), calm, 20); assert.strictEqual(m.state, "NORMAL"); assert.strictEqual(tr, null); });
    await t("single-band pullback (short disagreement, small adverse) -> no escalation beyond WATCH confirm", async () => {
        let r = run(newMachine(), { ...calm, disagreeCandles: 1, adverseAtr: 0.3 }, 6); assert.strictEqual(r.m.state, "NORMAL");   // 1 disagree candle < watch threshold
        r = run(newMachine(), { ...calm, disagreeCandles: 2, adverseAtr: 0.3 }, 1); assert.strictEqual(r.m.state, "NORMAL");       // needs the confirm count too (hysteresis)
        r = run(newMachine(), { ...calm, disagreeCandles: 2, adverseAtr: 0.3 }, 2); assert.strictEqual(r.m.state, "WATCH");
    });
    await t("both-band reversal against position with adverse -> DANGER (no order is ever issued)", async () => {
        const { m, tr } = run(newMachine(), { adverseAtr: 1.8, adverseCandles: 1, disagreeCandles: 0, oppositeAgree: true }, 2);
        assert.strictEqual(m.state, "DANGER"); assert.strictEqual(tr.to, "DANGER");
    });
    await t("persistent adverse movement -> DANGER", async () => { const { m } = run(newMachine(), { adverseAtr: 2.4, adverseCandles: 3, disagreeCandles: 0, oppositeAgree: false }, 2); assert.strictEqual(m.state, "DANGER"); });
    await t("hysteresis: one-evaluation spike does not change state", async () => {
        let r = run(newMachine(), { adverseAtr: 2.5, adverseCandles: 3, disagreeCandles: 5, oppositeAgree: true }, 1); assert.strictEqual(r.m.state, "NORMAL");
        r = run(r.m, calm, 1); r = run(r.m, { adverseAtr: 2.5, adverseCandles: 3, disagreeCandles: 5, oppositeAgree: true }, 1); assert.strictEqual(r.m.state, "NORMAL");
    });
    await t("adverse movement followed by recovery: DANGER -> RECOVERY -> NORMAL with confirmations", async () => {
        let r = run(newMachine(), { adverseAtr: 2.4, adverseCandles: 3, disagreeCandles: 0, oppositeAgree: false }, 2); assert.strictEqual(r.m.state, "DANGER");
        r = run(r.m, { ...calm, adverseAtr: 0.9 }, cfg.clearConfirm - 1); assert.strictEqual(r.m.state, "DANGER");   // not yet
        r = run(r.m, { ...calm, adverseAtr: 0.9, }, 1); assert.strictEqual(r.m.state, "RECOVERY");
        r = run(r.m, calm, cfg.normalConfirm); assert.strictEqual(r.m.state, "NORMAL");
    });
    await t("RECOVERY re-triggers back to WATCH/DANGER", async () => {
        let r = run(newMachine(), { adverseAtr: 1.2, adverseCandles: 0, disagreeCandles: 0, oppositeAgree: false }, 2); assert.strictEqual(r.m.state, "WATCH");
        r = run(r.m, calm, cfg.clearConfirm); assert.strictEqual(r.m.state, "RECOVERY");
        r = run(r.m, { adverseAtr: 2.4, adverseCandles: 3, disagreeCandles: 0, oppositeAgree: false }, 2); assert.strictEqual(r.m.state, "DANGER");
    });

    // ── metrics ──
    await t("MAE/MFE/giveback: LONG", async () => {
        const m = createPositionMetrics({ side: "LONG", entryPrice: 100, perPoint: 1000, entryTs: 1000 });
        m.onPrice(103); m.onPrice(97); m.onPrice(101);
        const s = m.snapshot();
        assert.strictEqual(s.maeLivePts, 3); assert.strictEqual(s.mfeLivePts, 3); assert.strictEqual(s.peakPnl, 3000); assert.strictEqual(s.pnl, 1000);
        assert.strictEqual(s.giveback, 2000); assert.strictEqual(s.maxGiveback, 6000); assert.strictEqual(s.currentAdversePts, 0);
    });
    await t("MAE/MFE: SHORT uses highest price for MAE (points, not rupees)", async () => {
        const m = createPositionMetrics({ side: "SHORT", entryPrice: 100, perPoint: 1000, entryTs: 1000 });
        m.onPrice(98); m.onPrice(104); m.onPrice(103);
        const s = m.snapshot(); assert.strictEqual(s.maeLivePts, 4); assert.strictEqual(s.mfeLivePts, 2); assert.strictEqual(s.currentAdversePts, 3); assert.strictEqual(s.pnl, -3000);
    });
    await t("candle excursions: pre-entry and duplicate candles ignored; adverse streak resets", async () => {
        const m = createPositionMetrics({ side: "SHORT", entryPrice: 100, perPoint: 1, entryTs: 5000 });
        assert.strictEqual(m.onCandle({ ts: 1000, open: 100, high: 120, low: 90, close: 110 }), false);   // before entry
        assert.strictEqual(m.onCandle({ ts: 5000, open: 100, high: 102, low: 99, close: 101.5 }), true);    // adverse (close above open)
        assert.strictEqual(m.onCandle({ ts: 5000, open: 100, high: 102, low: 99, close: 101.5 }), false);  // duplicate
        m.onCandle({ ts: 6000, open: 101, high: 103, low: 100, close: 102 });
        assert.strictEqual(m.snapshot().adverseCandles, 2); assert.strictEqual(m.snapshot().maeCandlePts, 3);
        m.onCandle({ ts: 7000, open: 102, high: 102, low: 99, close: 99.5 }); assert.strictEqual(m.snapshot().adverseCandles, 0);
    });

    // ── helpers for observer-level tests ──
    const TF = 15 * 60000, T0 = Date.UTC(2026, 9, 28, 4, 0);   // 09:30 IST, on the 15m grid
    function mkBars(fromTs, n, fn) { const out = []; for (let i = 0; i < n; i++) { const [o, h, l, c] = fn(i); out.push({ date: new Date(fromTs + i * TF).toISOString(), open: o, high: h, low: l, close: c }); } return out; }
    const flat = i => [100, 100.2, 99.8, 100.05];
    function rig({ position = null, entryPrice = 100, tradeId = 7, store = createMemoryStore(), startMs, bars, now0 } = {}) {
        let now = now0 ?? (T0 + 130 * TF + 5000);
        const clock = { now: () => now };
        const state = { position, entryPrice, openTradeId: tradeId };
        const raw1h = mkBars(T0 - 400 * 3600000, 120, i => [100 + Math.sin(i) * .1, 100.3, 99.7, 100 + Math.cos(i) * .1]);
        const candles = { getRawCandles: () => raw1h };
        const tgs = [], events = [];
        let allBars = bars || mkBars(T0, 140, flat), failFetch = false, fetches = 0;
        const fetchRaw = async () => { fetches++; if (failFetch) throw new Error("kite down"); return allBars.filter(b => new Date(b.date).getTime() <= now); };
        const context = { name: "ZINCMINI", tgPrefix: "ZINCMINI", strategy: "DSB_DUAL", timeframe: "1h", lotMult: 1000, lots: 1, tickSize: 0.05, bandStep: 0.5, bandStep2: 1 };
        const obs = createRiskObserver({ context, engineConfig, state, candles, store, tg: m => tgs.push(m), emit: (e, ty, p) => events.push({ ty, p }), clock, fetchRaw, params: resolveParams(engineConfig, { evalSeconds: 30 }), marketOpen: () => true });
        return { obs, state, store, tgs, events, advance(ms) { now += ms; }, setBars(b) { allBars = b; }, fail(v) { failFetch = v; }, get fetches() { return fetches; }, clock, context, candles };
    }

    await t("forming 15m candle is never treated as completed; duplicates ignored; no repeat request when up to date", async () => {
        const r = rig(); await r.obs.evaluate();
        const mon = r.obs._internals.monitor, expected = Math.floor(r.clock.now() / TF) * TF - TF;
        assert.strictEqual(mon.lastTs(), expected);
        const f = r.fetches; await r.obs.evaluate(); await r.obs.evaluate(); assert.strictEqual(r.fetches, f);   // up to date -> no further requests
        assert.strictEqual(mon.addCandles([{ ts: expected, open: 1, high: 2, low: 0, close: 1 }]), 0);   // duplicate
    });
    await t("missing 15m candles / stale market data -> health STALE, risk state frozen and shown UNKNOWN (never NORMAL)", async () => {
        const r = rig({ position: "SHORT", entryPrice: 100 }); await r.obs.evaluate();
        r.obs.onTick(100);
        r.setBars(mkBars(T0, 100, flat));         // feed stops: no newer candles appear
        r.advance(100 * 60000); await r.obs.evaluate();
        const s = r.obs.snapshot(); assert.strictEqual(s.health.status, "STALE"); assert.strictEqual(s.riskState, "UNKNOWN"); assert.strictEqual(s.riskReliable, false);
        assert(r.tgs.some(m => /health: STALE/.test(m)));
    });
    await t("WebSocket disconnection: no ticks -> price age shown, metrics not invented; kite failures -> ERROR then HEALTHY again", async () => {
        const r = rig({ position: "LONG", entryPrice: 100 }); await r.obs.evaluate();
        const s0 = r.obs.snapshot(); assert.strictEqual(s0.freshness.lastPriceAt, null); assert.strictEqual(s0.metrics.pnl, null);
        r.fail(true); r.advance(40 * 60000);
        for (let i = 0; i < 4; i++) { r.advance(30000); await r.obs.evaluate(); }
        assert.strictEqual(r.obs.snapshot().health.status, "ERROR");
        r.fail(false); r.setBars(mkBars(T0, 200, flat)); r.advance(60000); await r.obs.evaluate();
        assert.strictEqual(r.obs.snapshot().health.status, "HEALTHY"); assert(r.tgs.some(m => /HEALTHY again/.test(m)));
    });
    await t("persistent adverse movement + opposite DSBs on a real SHORT -> WATCH then DANGER, Telegram once per transition, no orders", async () => {
        // price climbs hard against a SHORT entered at 100
        const bars = mkBars(T0, 200, i => i < 130 ? [100, 100.2, 99.8, 100] : [100 + (i - 130) * 1.2, 101 + (i - 130) * 1.2, 99.9 + (i - 130) * 1.2, 100.9 + (i - 130) * 1.2]);
        const r = rig({ position: "SHORT", entryPrice: 100, now0: T0 + 131 * TF + 5000, bars });
        await r.obs.evaluate(); r.obs.onTick(100);
        const states = [];
        for (let k = 0; k < 40; k++) {
            r.advance(TF / 3); r.obs.onTick(100 + Math.min(40, (r.clock.now() - (T0 + 131 * TF)) / TF * 1.2));
            await r.obs.evaluate(); states.push(r.obs.snapshot().riskState);
        }
        assert(states.includes("WATCH") || states.includes("DANGER"), "never escalated: " + [...new Set(states)]);
        assert(states.includes("DANGER"), "no DANGER: " + [...new Set(states)]);
        const transMsgs = r.tgs.filter(m => /State: (WATCH|DANGER)/.test(m));
        assert(transMsgs.length >= 1 && transMsgs.length <= 3, "alert spam/none: " + transMsgs.length);
        assert(transMsgs.every(m => /Action: HOLD — observation only/.test(m)));
        assert.strictEqual(new Set(transMsgs).size, transMsgs.length);   // no duplicate notifications
        assert(!("orders" in r.obs) && !("exit" in r.obs));
    });
    await t("EOD / position closed: record finalised with MAE/MFE/time-in-state", async () => {
        const r = rig({ position: "LONG", entryPrice: 100 }); await r.obs.evaluate();
        r.obs.onTick(102); r.obs.onTick(99); r.advance(60000); await r.obs.evaluate();
        r.state.position = null; r.advance(30000); await r.obs.evaluate();
        const closed = r.store._positions[0]; assert(closed.closedAt); assert.strictEqual(r.obs._internals.tracked, null);
        const ev = r.store._events.find(e => e.kind === "POSITION_CLOSE"); assert(ev && ev.detail.mae >= 1 && ev.detail.mfe >= 2);
    });
    await t("restart recovery: same position resumes MAE/MFE/state; candle timestamps dedupe", async () => {
        const store = createMemoryStore();
        const a = rig({ position: "SHORT", entryPrice: 100, store }); await a.obs.evaluate(); a.obs.onTick(103); a.advance(60000); await a.obs.evaluate(); await a.obs.stop();
        const maeBefore = a.obs.snapshot().metrics.maeLivePts; assert.strictEqual(maeBefore, 3);
        const b = rig({ position: "SHORT", entryPrice: 100, store }); await b.obs.reconcile();
        assert.strictEqual(b.obs._internals.tracked.metrics.raw.liveMae, 3);
        await b.obs.evaluate();
        assert.strictEqual(store._positions.length, 1);   // resumed, not duplicated
        assert.strictEqual(await store.markCandle({ ts: T0, open: 1, high: 1, low: 1, close: 1 }), false);   // already recorded by the first run
    });
    await t("broker/engine position mismatch: old observer record is never resumed; flagged partial + alert", async () => {
        const store = createMemoryStore();
        const a = rig({ position: "SHORT", entryPrice: 100, store }); await a.obs.evaluate(); await a.obs.stop();
        const b = rig({ position: "LONG", entryPrice: 120, tradeId: 99, store }); await b.obs.reconcile();
        assert.strictEqual(store._positions.length, 2); assert(store._positions[0].closedAt);
        assert.strictEqual(b.obs._internals.tracked.reconciled, false);
        assert(b.tgs.some(m => /Reconciliation uncertain/.test(m)));
        assert(/PARTIAL/.test((await (async () => { await b.obs.evaluate(); return b.obs.snapshot().reconcileNote; })())));
    });
    await t("persisted position but engine is flat on restart: closed as 'closed while offline'", async () => {
        const store = createMemoryStore();
        const a = rig({ position: "SHORT", entryPrice: 100, store }); await a.obs.evaluate(); await a.obs.stop();
        const b = rig({ position: null, store }); await b.obs.reconcile();
        assert(store._positions[0].closedAt); assert.strictEqual(store._positions[0].closeNote, "closed while offline");
    });
    await t("SQLite recovery: store survives reopen; candle dedupe + position resume from disk", async () => {
        let sqliteOk = true; try { require("sqlite3"); } catch { sqliteOk = false; }
        if (!sqliteOk) { console.log("skip - sqlite3 not installed here"); return; }
        const file = path.join(os.tmpdir(), `riskobs-test-${process.pid}.db`); try { fs.unlinkSync(file); } catch { /* none */ }
        let st = await createSqliteStore(file);
        const id = await st.openPosition({ side: "SHORT", entryPrice: 100, entryTs: 5, tradeId: 7, openedAt: 5, metrics: { liveMae: 2 } });
        assert.strictEqual(await st.markCandle({ ts: 10, open: 1, high: 1, low: 1, close: 1, c1: "red", c2: "red" }), true);
        assert.strictEqual(await st.markCandle({ ts: 10, open: 1, high: 1, low: 1, close: 1 }), false);
        await st.addEvent({ posId: id, ts: 6, kind: "STATE", from: "NORMAL", to: "WATCH", detail: { x: 1 } }); await st.close();
        st = await createSqliteStore(file);
        const open = await st.getOpenPosition(); assert.strictEqual(open.id, id); assert.strictEqual(open.metrics.liveMae, 2); assert.strictEqual(await st.lastCandleTs(), 10);
        assert.strictEqual((await st.recentEvents())[0].to, "WATCH"); await st.close(); fs.unlinkSync(file);
    });
    await t("multiple instruments run simultaneously with fully independent state", async () => {
        const a = rig({ position: "SHORT", entryPrice: 100 }), b = rig({ position: "LONG", entryPrice: 200 });
        await a.obs.evaluate(); await b.obs.evaluate();
        a.obs.onTick(104); b.obs.onTick(201);
        a.advance(1000); b.advance(1000); await a.obs.evaluate(); await b.obs.evaluate();
        assert.strictEqual(a.obs.snapshot().metrics.maeLivePts, 4); assert.strictEqual(b.obs.snapshot().metrics.maeLivePts, 0);
        assert.notStrictEqual(a.store, b.store);
    });
    await t("observer failure never propagates (fetch throws, store throws)", async () => {
        const r = rig({ position: "LONG", entryPrice: 100 }); await r.obs.evaluate();
        r.store.addEvent = async () => { throw new Error("disk full"); }; r.state.position = null;
        await r.obs.evaluate();           // must not throw
        r.obs.onTick(NaN); r.obs.onTick(undefined);
    });
    await t("1H trend authority shown separately from 15M observation and risk state", async () => {
        const r = rig({ position: "SHORT", entryPrice: 100 }); await r.obs.evaluate();
        const s = r.obs.snapshot(); assert(s.trend1h && "c1" in s.trend1h && "dir" in s.trend1h); assert(s.obs15 && "relation" in s.obs15); assert(s.health.status); assert(s.mode.includes("observation only"));
    });
    console.log(`\n${passed} scenarios passed`); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
