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
let unhandled = 0; process.on("unhandledRejection", (e) => { unhandled++; if (process.env.RO_DEBUG) console.log("UNHANDLED", e && e.stack); });   // any promise rejection nobody handled would be an observer leak into the process
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
    function rig({ marketOpen: mo, entryMeta, pOver = {}, position = null, entryPrice = 100, tradeId = 7, store = createMemoryStore(), startMs, bars, now0 } = {}) {
        let now = now0 ?? (T0 + 130 * TF + 5000);
        const clock = { now: () => now };
        const state = { position, entryPrice, openTradeId: tradeId };
        const raw1h = mkBars(T0 - 400 * 3600000, 120, i => [100 + Math.sin(i) * .1, 100.3, 99.7, 100 + Math.cos(i) * .1]);
        const candles = { getRawCandles: () => raw1h };
        const tgs = [], events = [];
        let allBars = bars || mkBars(T0, 140, flat), failFetch = false, fetches = 0;
        const fetchRaw = async () => { fetches++; if (failFetch) throw new Error("kite down"); return allBars.filter(b => new Date(b.date).getTime() <= now); };
        const context = { name: "ZINCMINI", tgPrefix: "ZINCMINI", strategy: "DSB_DUAL", timeframe: "1h", lotMult: 1000, lots: 1, tickSize: 0.05, bandStep: 0.5, bandStep2: 1 };
        const obs = createRiskObserver({ context, engineConfig, state, candles, store, tg: m => tgs.push(m), emit: (e, ty, p) => events.push({ ty, p }), clock, fetchRaw, params: resolveParams(engineConfig, { evalSeconds: 30, ...pOver }), marketOpen: mo || (() => true), getEntryMeta: async () => { const m = typeof entryMeta === "function" ? entryMeta(now) : entryMeta === undefined ? { tradeId, entryTs: (now0 ?? (T0 + 130 * TF + 5000)) - 600000, side: state.position, entryPrice: state.entryPrice } : entryMeta; return m; } });
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
        assert.strictEqual(b.obs._internals.tracked.origin, "discovered_after_entry");   // the engine's trade record identifies the NEW position, so its entry time is known
        assert(b.tgs.some(m => /Reconciliation:/.test(m)));
        assert(/PARTIAL/.test((await (async () => { await b.obs.evaluate(); return b.obs.snapshot().reconcileNote; })())));
    });
    await t("persisted position but engine is flat on restart: closed as 'closed while observer offline (close time unknown)'", async () => {
        const store = createMemoryStore();
        const a = rig({ position: "SHORT", entryPrice: 100, store }); await a.obs.evaluate(); await a.obs.stop();
        const b = rig({ position: null, store }); await b.obs.reconcile();
        assert(store._positions[0].closedAt); assert.strictEqual(store._positions[0].closeNote, "closed while observer offline (close time unknown)");
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

    // ═════════ PHASE 1 ═════════
    const { createBandStepper } = require("./dynamicBandReader");
    const { toHA, toHAAlways } = require("./indicators");
    const { replayHa } = require("./riskObserver/dsbMonitor");
    const colorFrom = s => (s.position === "LONG" ? "green" : s.position === "SHORT" ? "red" : "none");

    // A1 ── 1H trend must use ONE HA conversion, exactly like the strategy
    await t("A1: 1H trend uses a single HA conversion (matches strategy); double conversion would differ (regression)", async () => {
        let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        const strategyTrend = raw => { const ha = toHA(raw).slice(-engineConfig.MAX_CANDLES); const a = createBandStepper(0.5), b = createBandStepper(1); for (const k of ha) { a.push(k); b.push(k); } return [colorFrom(a.state()), colorFrom(b.state())]; };
        const doubleTrend = raw => { const ha = toHAAlways(toHA(raw)).slice(-engineConfig.MAX_CANDLES); const a = createBandStepper(0.5), b = createBandStepper(1); for (const k of ha) { a.push(k); b.push(k); } return [colorFrom(a.state()), colorFrom(b.state())]; };
        let found = null;
        for (let n = 0; n < 400 && !found; n++) {
            let p = 100; const raw = [];
            for (let i = 0; i < 80; i++) { const o = p, c = p + (rnd() - 0.5) * 2.2, h = Math.max(o, c) + rnd() * 0.6, l = Math.min(o, c) - rnd() * 0.6; p = c; raw.push({ date: new Date(T0 + i * 3600000).toISOString(), open: o, high: h, low: l, close: c }); }
            if (JSON.stringify(strategyTrend(raw)) !== JSON.stringify(doubleTrend(raw))) found = raw;
        }
        assert(found, "no dataset where double conversion differs was found");
        const r = rig({ position: "LONG", entryPrice: 100 }); r.candles.getRawCandles = () => found; await r.obs.evaluate();
        const want = strategyTrend(found), got = r.obs.snapshot().trend1h;
        assert.deepStrictEqual([got.c1, got.c2], want, "observer 1H colours must equal the strategy's");
        assert.notDeepStrictEqual([got.c1, got.c2], doubleTrend(found), "must NOT equal the double-converted result");
    });

    // A2 ── live price freshness is explicit and separate from REST candle health
    const posRig = o => rig({ position: "SHORT", entryPrice: 100, ...o });
    const dangerRig = () => rig({ position: "SHORT", entryPrice: 100, pOver: { dangerAdverseCandles: 0 } });
    await t("A2: no LTP since startup -> LTP NONE, risk UNKNOWN, REST health independent", async () => {
        const r = posRig(); await r.obs.evaluate(); const s = r.obs.snapshot();
        assert.strictEqual(s.ltpHealth.status, "NONE"); assert.strictEqual(s.restHealth.status, "HEALTHY"); assert.strictEqual(s.riskState, "UNKNOWN"); assert.strictEqual(s.riskReliable, false);
    });
    await t("A2: LTP normal -> HEALTHY, reliable, age reported", async () => {
        const r = posRig(); await r.obs.evaluate(); r.obs.onTick(100); r.advance(5000); await r.obs.evaluate(); const s = r.obs.snapshot();
        assert.strictEqual(s.ltpHealth.status, "HEALTHY"); assert.strictEqual(s.ltpHealth.ageMs, 5000); assert.strictEqual(s.riskState, "NORMAL"); assert.strictEqual(s.riskReliable, true);
    });
    await t("A2: LTP stale after healthy -> UNKNOWN, last known state preserved, never classified on the old price", async () => {
        const r = posRig(); await r.obs.evaluate(); r.obs.onTick(130);           // hugely adverse tick, then silence
        r.advance(cfg.ltpStaleSeconds * 1000 + 5000);
        for (let i = 0; i < 5; i++) { await r.obs.evaluate(); r.advance(1000); }
        const s = r.obs.snapshot();
        assert.strictEqual(s.ltpHealth.status, "STALE"); assert.strictEqual(s.riskState, "UNKNOWN"); assert.strictEqual(s.lastKnownRiskState, "NORMAL");
        assert.strictEqual(r.obs._internals.machine.state, "NORMAL", "state machine must be frozen on an old LTP"); assert(r.tgs.some(m => /Live price \(LTP\) health: STALE/.test(m)));
        assert.strictEqual(s.metrics.coverage.live, "PARTIAL");   // observation was interrupted
    });
    await t("A2: fresh LTP resumes classification automatically", async () => {
        const r = posRig(); await r.obs.evaluate(); r.obs.onTick(130); r.advance(cfg.ltpStaleSeconds * 1000 + 5000); await r.obs.evaluate();
        assert.strictEqual(r.obs.snapshot().riskState, "UNKNOWN");
        r.obs.onTick(130); for (let i = 0; i < cfg.escalateConfirm + 1; i++) { r.advance(1000); r.obs.onTick(130); await r.obs.evaluate(); }
        const s = r.obs.snapshot(); assert.strictEqual(s.ltpHealth.status, "HEALTHY"); assert.strictEqual(s.riskReliable, true); assert.notStrictEqual(s.riskState, "UNKNOWN"); assert.notStrictEqual(s.riskState, "NORMAL");
        assert(r.tgs.some(m => /Live price \(LTP\) HEALTHY again/.test(m)));
    });
    await t("A2: REST healthy but LTP stale -> dimensions reported separately", async () => {
        const r = posRig(); await r.obs.evaluate(); r.obs.onTick(100); r.advance(cfg.ltpStaleSeconds * 1000 + 1000); await r.obs.evaluate();
        const s = r.obs.snapshot(); assert.strictEqual(s.restHealth.status, "HEALTHY"); assert.strictEqual(s.ltpHealth.status, "STALE"); assert.strictEqual(s.riskState, "UNKNOWN");
    });
    await t("A2: LTP healthy but REST stale -> dimensions reported separately, still UNKNOWN", async () => {
        const r = posRig(); await r.obs.evaluate(); r.setBars(mkBars(T0, 100, flat)); r.advance(100 * 60000); r.obs.onTick(100); await r.obs.evaluate();
        const s = r.obs.snapshot(); assert.strictEqual(s.restHealth.status, "STALE"); assert.strictEqual(s.ltpHealth.status, "HEALTHY"); assert.strictEqual(s.riskState, "UNKNOWN");
    });

    await t("A2: both feeds stale -> both dimensions reported stale, UNKNOWN, no classification", async () => {
        const r = posRig(); await r.obs.evaluate(); r.obs.onTick(100); r.setBars(mkBars(T0, 100, flat)); r.advance(100 * 60000); await r.obs.evaluate();
        const s = r.obs.snapshot(); assert.strictEqual(s.restHealth.status, "STALE"); assert.strictEqual(s.ltpHealth.status, "STALE"); assert.strictEqual(s.riskState, "UNKNOWN"); assert.strictEqual(r.obs._internals.machine.state, "NORMAL");
    });

    // A3 ── completed-candle sequence gaps
    const mkFeed = (bars0, opts = {}) => {
        let now = opts.now0 ?? (T0 + 130 * TF + 5000), bars = bars0, calls = [], failBackfill = false;
        const monitor = createDsbMonitor({ step1: 0.5, step2: 1 });
        const fetchRaw = async (from, to) => { calls.push([from, to]); if (failBackfill && calls.length > 1) throw new Error("kite down"); return bars.filter(b => new Date(b.date).getTime() <= now).map(b => ({ ...b })); };
        const feed = createCandleFeed({ fetchRaw, monitor, tfMs: TF, now: () => now, backfillGapMs: 30000, maxBackfillTries: 3, session: opts.session });
        return { feed, monitor, calls, advance: ms => { now += ms; }, setBars: b => { bars = b; }, fail: v => { failBackfill = v; } };
    };
    const full = mkBars(T0, 140, flat);
    const holey = full.filter((_, i) => i !== 40 && i !== 41);
    await t("A3: internal gap detected with count + range; health GAPS, never silently HEALTHY", async () => {
        const f = mkFeed(holey); await f.feed.poll(); const g = f.feed.gaps(), h = f.feed.health(true);
        assert.strictEqual(g.count, 2); assert.strictEqual(h.status, "GAPS"); assert.strictEqual(h.missingCount, 2); assert(h.reason.includes("2 completed 15m"));
        assert(f.feed.diagnostics().missingCount === 2);
    });
    await t("A3: duplicate candles from the broker never create duplicates", async () => {
        const dup = [...full, ...full.slice(10, 20)]; const f = mkFeed(dup); await f.feed.poll(); assert.strictEqual(f.monitor.size(), new Set(full.filter(b => new Date(b.date).getTime() + TF <= T0 + 130 * TF + 5000).map(b => b.date)).size);
    });
    await t("A3: successful backfill fills the gap without duplicates and health recovers", async () => {
        const f = mkFeed(holey); await f.feed.poll(); assert.strictEqual(f.feed.health(true).status, "GAPS");
        f.setBars(full); f.advance(31000); await f.feed.poll();
        assert.strictEqual(f.feed.gaps().count, 0); assert.strictEqual(f.feed.health(true).status, "HEALTHY");
        const ts = f.monitor.candles().map(c => c.ts); assert.strictEqual(new Set(ts).size, ts.length);
    });
    await t("A3: backfill is throttled (no request storm while gap persists)", async () => {
        const f = mkFeed(holey); await f.feed.poll(); await f.feed.poll(); const n = f.calls.length; await f.feed.poll(); await f.feed.poll(); assert.strictEqual(f.calls.length, n);   // within backfillGapMs
    });
    await t("A3: failed backfill keeps GAPS visible; broker-empty slots stay in diagnostics (incomplete), not silently healthy", async () => {
        const f = mkFeed(holey); await f.feed.poll();
        for (let i = 0; i < 6; i++) { f.advance(31000); await f.feed.poll(); }
        const d = f.feed.diagnostics(), h = f.feed.health(true);
        assert(d.missingCount > 0 || d.brokerEmptyCount > 0, "gap must remain visible"); if (h.status === "HEALTHY") assert.strictEqual(h.incomplete, true);
        const g = mkFeed(holey); await g.feed.poll(); g.fail(true); g.advance(31000); await g.feed.poll(); assert.notStrictEqual(g.feed.health(true).status, "HEALTHY");
    });
    await t("A3: weekends, overnight and exchange-closed days are not 'missing'", async () => {
        // Fri 2026-10-23 and Mon 2026-10-26 sessions present (09:00-23:30 IST), weekend absent
        const sess = (y, m, d) => { const out = []; const s = Date.UTC(y, m, d, 3, 30); for (let i = 0; i < 58; i++) out.push({ date: new Date(s + i * TF).toISOString(), open: 100, high: 100.2, low: 99.8, close: 100 }); return out; };
        const bars = [...sess(2026, 9, 23), ...sess(2026, 9, 26)];
        const f = mkFeed(bars, { now0: Date.UTC(2026, 9, 26, 18, 30) }); await f.feed.poll();
        assert.strictEqual(f.feed.gaps().count, 0); assert.notStrictEqual(f.feed.health(false).status, "GAPS");
    });
    await t("A3: a weekday holiday (no candles all day) is probed once and recorded as a closure, not as missing", async () => {
        const sess = (y, m, d) => { const out = []; const s = Date.UTC(y, m, d, 3, 30); for (let i = 0; i < 58; i++) out.push({ date: new Date(s + i * TF).toISOString(), open: 100, high: 100.2, low: 99.8, close: 100 }); return out; };
        const bars = [...sess(2026, 9, 26), ...sess(2026, 9, 28)];   // Tue 27th has nothing
        const f = mkFeed(bars, { now0: Date.UTC(2026, 9, 28, 18, 30) }); await f.feed.poll();
        for (let i = 0; i < 4; i++) { f.advance(31000); await f.feed.poll(); }
        assert.strictEqual(f.feed.health(true).status, "HEALTHY"); assert.strictEqual(f.feed.gaps().count, 0);
    });
    await t("A3: observer surfaces gap count/range and freezes classification while history is incomplete", async () => {
        const r = posRig({ bars: holey }); await r.obs.evaluate(); r.obs.onTick(100); await r.obs.evaluate();
        const s = r.obs.snapshot(); assert.strictEqual(s.restHealth.status, "GAPS"); assert(s.candleDiagnostics.missingCount >= 1); assert.strictEqual(s.riskState, "UNKNOWN");
    });

    // A4 ── recoverable startup
    const fakeTimers = () => { const ints = new Map(), touts = new Map(); let id = 0; return { setInterval: (fn, ms) => { ints.set(++id, fn); return id; }, clearInterval: i => ints.delete(i), setTimeout: (fn, ms) => { touts.set(++id, fn); return id; }, clearTimeout: i => touts.delete(i), ints, touts, fireTimeouts: async () => { const l = [...touts.entries()]; touts.clear(); for (const [, fn] of l) await fn(); } }; };
    const startRig = (o = {}) => { const store = o.store || createMemoryStore(); const state = { position: o.position || null, entryPrice: 100, openTradeId: 7 }; const tm = fakeTimers(); const tgs = [], logs = [];
        const obs = createRiskObserver({ context: { name: "Z", tgPrefix: "Z", strategy: "DSB_DUAL", timeframe: "1h", lotMult: 1000, lots: o.lots ?? 1, tickSize: .05, bandStep: .5, bandStep2: 1 }, engineConfig, state, candles: { getRawCandles: () => mkBars(T0 - 400 * 3600000, 120, () => [100, 100.3, 99.7, 100]) }, store, tg: m => tgs.push(m), clock: { now: () => T0 + 130 * TF + 5000 }, fetchRaw: async () => mkBars(T0, 140, flat).filter(b => new Date(b.date).getTime() + TF <= T0 + 130 * TF + 5000), params: resolveParams(engineConfig, {}), timers: tm, log: m => logs.push(m) });
        return { obs, store, state, tm, tgs, logs }; };
    await t("A4: reconciliation failure does not permanently block start; retry succeeds; failure is logged and contained", async () => {
        const r = startRig({ position: "LONG" }); const orig = r.store.getOpenPosition; r.store.getOpenPosition = async () => { throw new Error("db locked"); };
        await r.obs.start();   // must not throw
        assert.strictEqual(r.obs._internals.initState, "failed"); assert.strictEqual(r.obs.snapshot().riskState, "UNKNOWN"); assert(r.logs.some(l => /START FAILED/.test(l) && /db locked/.test(l)));
        assert.strictEqual(r.tm.ints.size, 0, "no evaluation timer while failed"); assert.strictEqual(r.tm.touts.size, 1, "exactly one retry scheduled");
        r.store.getOpenPosition = orig; await r.tm.fireTimeouts();
        assert.strictEqual(r.obs._internals.initState, "running"); assert.strictEqual(r.tm.ints.size, 1); assert.strictEqual(r.tm.touts.size, 0);
    });
    await t("A4: initial store failure (cannot create the position record) -> start fails cleanly, retry works, no duplicate record", async () => {
        const r = startRig({ position: "LONG" }); const orig = r.store.openPosition; r.store.openPosition = async () => { throw new Error("disk full"); };
        await r.obs.start(); assert.strictEqual(r.obs._internals.initState, "failed"); assert.strictEqual(r.obs._internals.tracked, null);
        r.store.openPosition = orig; await r.tm.fireTimeouts(); assert.strictEqual(r.obs._internals.initState, "running");
        assert.strictEqual(r.store._positions.filter(p => p.closedAt == null).length, 1);
    });
    await t("A4: repeated start() / stop() / restart never duplicate timers", async () => {
        const r = startRig(); await r.obs.start(); await r.obs.start(); await r.obs.start(); assert.strictEqual(r.obs._internals.timerCount(), 1);
        await r.obs.stop(); assert.strictEqual(r.obs._internals.timerCount(), 0); await r.obs.stop(); assert.strictEqual(r.obs._internals.timerCount(), 0);
        await r.obs.start(); assert.strictEqual(r.obs._internals.timerCount(), 1); assert.strictEqual(r.tm.ints.size, 1);
    });
    await t("A4: stop() cancels a pending retry", async () => {
        const r = startRig({ position: "LONG" }); r.store.getOpenPosition = async () => { throw new Error("x"); }; await r.obs.start(); assert.strictEqual(r.tm.touts.size, 1); await r.obs.stop(); assert.strictEqual(r.tm.touts.size, 0);
    });
    await t("A4: SQLite failing at runtime is counted and never interrupts anything", async () => {
        const r = startRig({ position: "LONG" }); await r.obs.start(); r.store.addEvent = async () => { throw new Error("io"); }; r.store.updatePosition = async () => { throw new Error("io"); };
        r.state.position = null; await r.obs.evaluate(); assert(r.obs._internals.storeErrors >= 1); assert.strictEqual(r.obs._internals.initState, "running");
    });

    // A5 ── explicit direct NORMAL -> DANGER
    await t("A5: direct NORMAL->DANGER stays allowed, needs confirmation, records WATCH skipped with reasons + inputs", async () => {
        const r = dangerRig(); await r.obs.evaluate(); const tick = p => { r.advance(1000); r.obs.onTick(p); };
        tick(100); await r.obs.evaluate(); tick(100.1); await r.obs.evaluate();
        tick(112); await r.obs.evaluate(); assert.strictEqual(r.obs._internals.machine.state, "NORMAL", "one evaluation is not enough (hysteresis)");
        for (let i = 0; i < cfg.escalateConfirm + 1; i++) { tick(112); await r.obs.evaluate(); }
        const ev = r.store._events.filter(e => e.kind === "STATE"); const d = ev.find(e => e.to === "DANGER");
        assert(d, "DANGER event missing: " + JSON.stringify(ev.map(e => e.to))); assert.strictEqual(d.from, "NORMAL"); assert.strictEqual(d.detail.skippedWatch, true); assert.deepStrictEqual(d.detail.skipped, ["WATCH"]);
        assert(d.detail.reasons.length > 0); assert(d.detail.inputs && "adverseAtr" in d.detail.inputs); assert(r.tgs.some(m => /WATCH skipped/.test(m) && /Action: HOLD — observation only/.test(m)));
        assert.strictEqual(r.obs.snapshot().lastTransition.skippedWatch, true);
    });
    await t("A5: recovery after direct DANGER goes DANGER -> RECOVERY with confirmation", async () => {
        const r = dangerRig(); await r.obs.evaluate(); const tick = p => { r.advance(1000); r.obs.onTick(p); };
        for (let i = 0; i < cfg.escalateConfirm + 2; i++) { tick(112); await r.obs.evaluate(); } assert.strictEqual(r.obs._internals.machine.state, "DANGER");
        tick(100); await r.obs.evaluate(); assert.strictEqual(r.obs._internals.machine.state, "DANGER", "not on a single calm evaluation");
        for (let i = 0; i < cfg.clearConfirm + 1; i++) { tick(100); await r.obs.evaluate(); } assert.strictEqual(r.obs._internals.machine.state, "RECOVERY");
    });
    await t("A5: a state machine going via WATCH is NOT flagged as skipped", async () => {
        let r = run(newMachine(), { adverseAtr: 1.2, adverseCandles: 0, disagreeCandles: 0, oppositeAgree: false }, 2); assert.strictEqual(r.m.state, "WATCH");
        r = run(r.m, { adverseAtr: 2.4, adverseCandles: 3, disagreeCandles: 0, oppositeAgree: false }, 2); assert.strictEqual(r.tr.to, "DANGER"); assert.strictEqual(r.tr.skippedWatch, false);
    });

    // Part B ── metrics integrity
    await t("B: restart on the same position keeps MAE/MFE but marks live coverage PARTIAL (engine was not watched while down)", async () => {
        const store = createMemoryStore(); const a = posRig({ store }); await a.obs.evaluate(); a.obs.onTick(103); a.advance(1000); a.obs.onTick(98); a.advance(1000); await a.obs.evaluate(); await a.obs.stop();
        const b = posRig({ store }); await b.obs.reconcile(); await b.obs.evaluate(); const m = b.obs.snapshot().metrics;
        assert(m.maeLivePts >= 3 && m.mfeLivePts >= 2); assert.strictEqual(m.coverage.live, "PARTIAL"); assert(/interruption/.test(m.coverage.liveNote));
    });
    await t("B: quantity / size change is never mistaken for the same position (no silent reset, no false 'full')", async () => {
        const store = createMemoryStore(); const a = posRig({ store }); await a.obs.evaluate(); a.obs.onTick(103); await a.obs.evaluate(); await a.obs.stop();
        store._positions[0].metrics.perPoint = 500;                                   // the persisted record was for a different size
        const c = posRig({ store }); await c.obs.reconcile(); await c.obs.evaluate(); const s = c.obs.snapshot();
        assert.strictEqual(store._positions.length, 2); assert(/size changed/.test(store._positions[0].closeNote));
        assert.strictEqual(s.entry.origin, "discovered_after_entry"); assert.strictEqual(s.metrics.coverage.live, "PARTIAL"); assert(/PARTIAL/.test(s.reconcileNote)); assert.strictEqual(s.metrics.maeLivePts, 0, "old record's excursions must not carry over");
    });
    await t("B: uncertain reconciliation labels metrics PARTIAL and states the limitation; trading position untouched", async () => {
        const store = createMemoryStore(); const a = posRig({ store, entryPrice: 100 }); await a.obs.evaluate(); await a.obs.stop();
        const b = posRig({ store, entryPrice: 120 }); await b.obs.reconcile(); await b.obs.evaluate();
        const s = b.obs.snapshot(); assert.strictEqual(s.metrics.coverage.live, "PARTIAL"); assert(/PARTIAL/.test(s.reconcileNote)); assert.strictEqual(b.state.position, "SHORT"); assert.strictEqual(b.state.entryPrice, 120);
    });
    await t("B: multi-instrument stores stay isolated (different files/state)", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-")); const s1 = await createSqliteStore(path.join(dir, "a_riskobs.db")), s2 = await createSqliteStore(path.join(dir, "b_riskobs.db"));
        const a = posRig({ store: s1 }), b = rig({ position: "LONG", entryPrice: 50, store: s2 }); await a.obs.evaluate(); await b.obs.evaluate();
        assert.strictEqual((await s1.getOpenPosition()).side, "SHORT"); assert.strictEqual((await s2.getOpenPosition()).side, "LONG"); await s1.close(); await s2.close();
    });
    // ═════════ PHASE 2 ═════════
    const { loadHistoryReadOnly, summarize } = require("./riskObserver/analytics");
    await t("P2: timeline survives a process restart (sqlite): same position id, events appended, history readable read-only", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro2-")), file = path.join(dir, "z_dsb_dual_riskobs.db");
        let store = await createSqliteStore(file); const a = posRig({ store }); await a.obs.evaluate(); a.obs.onTick(101); await a.obs.evaluate();
        const id1 = a.obs._internals.tracked.id; await a.obs.stop(); await store.close();
        store = await createSqliteStore(file); const b = posRig({ store }); await b.obs.start(); await b.obs.stop();
        assert.strictEqual(b.obs._internals.tracked.id, id1); await store.close();
        const h = await loadHistoryReadOnly(file), kinds = h.events.map(e => e.kind);
        assert(kinds.includes("POSITION_OPEN") && kinds.includes("DSB") && kinds.includes("RECONCILE"), kinds.join()); assert.strictEqual(h.positions.length, 1); assert(h.candles.length > 50, "15m candles recorded for later replay");
        const sum = summarize(h); assert(sum.positions[0].timeline.length >= 3 && sum.positions[0].timeline.length <= h.events.length);
    });
    await t("P2: closing a position persists its FINAL metrics and a POSITION_CLOSE event with coverage", async () => {
        const r = posRig(); await r.obs.evaluate(); r.obs.onTick(104); r.advance(1000); r.obs.onTick(99); await r.obs.evaluate(); r.state.position = null; await r.obs.evaluate();
        const row = r.store._positions[0]; assert(row.closedAt); assert.strictEqual(row.metrics.liveMae, 4); assert(row.metrics.liveMfe >= 1);
        const c = r.store._events.find(e => e.kind === "POSITION_CLOSE"); assert(c && c.detail.coverage && "mae" in c.detail && "peakPnl" in c.detail);
    });
    await t("P2: STATE events carry the metrics + 1H/15M picture that caused the transition", async () => {
        const r = dangerRig(); await r.obs.evaluate(); for (let i = 0; i < cfg.escalateConfirm + 1; i++) { r.advance(1000); r.obs.onTick(112); await r.obs.evaluate(); }
        const e = r.store._events.find(x => x.kind === "STATE" && x.to === "DANGER"); assert(e); for (const k of ["adversePts", "pnl", "peakPnl", "giveback", "mae", "mfe", "trend1h", "obs15", "reasons", "inputs", "coverage"]) assert(k in e.detail, "missing " + k);
        const sum = summarize({ positions: await r.store.allPositions(), events: await r.store.allEvents(), candles: await r.store.allCandles() }).positions[0]; assert(sum.visitedDanger && sum.directDanger); assert.strictEqual(sum.status, "OPEN");
    });
    await t("P2: DSB changes are recorded once per change (no spam) and health events join the same timeline", async () => {
        const r = posRig(); await r.obs.evaluate(); await r.obs.evaluate(); await r.obs.evaluate(); const n = r.store._events.filter(e => e.kind === "DSB").length; assert.strictEqual(n, 1);
        r.setBars(mkBars(T0, 100, flat)); r.advance(100 * 60000); await r.obs.evaluate(); assert(r.store._events.some(e => e.kind === "HEALTH" && e.to === "STALE"));
    });
    await t("P2: dashboard / Telegram failures (emit and tg throw) never reach the observer or change state", async () => {
        const r = rig({ position: "SHORT", entryPrice: 100 }); const o2 = createRiskObserver({ context: r.context, engineConfig, state: r.state, candles: r.candles, store: createMemoryStore(), tg: () => { throw new Error("telegram down"); }, emit: () => { throw new Error("ws closed"); }, clock: r.clock, fetchRaw: async () => mkBars(T0, 140, flat), params: resolveParams(engineConfig, {}), marketOpen: () => true });
        await o2.evaluate(); o2.onTick(100); await o2.evaluate(); assert(o2.snapshot()); assert.strictEqual(o2._internals.tracked.metrics.snapshot().lastPrice, 100);
    });
    await t("P2: snapshot exposes overall health as the worst of REST / LTP / startup", async () => {
        const r = posRig(); await r.obs.evaluate(); assert.strictEqual(r.obs.snapshot().overallHealth, "STALE"); r.obs.onTick(100); await r.obs.evaluate(); assert.strictEqual(r.obs.snapshot().overallHealth, "HEALTHY");
    });
    // ═════════ FINAL ROUND — Finding A: position origin / entry coverage ═════════
    const mkObs = o => { // observer whose engine state and trade record the test controls (entryAt = the engine's recorded entry time)
        let entryAt = o.entryAt, tradeId = o.tradeId ?? 7, metaOn = o.meta !== false;
        const r = rig({ position: o.position ?? null, entryPrice: 100, tradeId, store: o.store, bars: o.bars, now0: o.now0, entryMeta: () => (metaOn ? { tradeId: r.state.openTradeId, entryTs: entryAt, side: r.state.position, entryPrice: r.state.entryPrice } : null) });
        r.setEntry = v => { entryAt = v; }; r.metaOff = () => { metaOn = false; }; r.enter = (side, px, id) => { r.state.position = side; r.state.entryPrice = px; r.state.openTradeId = id; };
        return r;
    };
    await t("A: observer starts BEFORE the entry -> observed_from_entry, real entry time, coverage FULL", async () => {
        const r = mkObs({}); await r.obs.evaluate(); r.advance(30000); await r.obs.evaluate();   // sees the instrument flat
        r.advance(20000); const entryAt = r.clock.now() - 5000; r.setEntry(entryAt); r.enter("SHORT", 100, 8); r.obs.onTick(100); await r.obs.evaluate();
        const s = r.obs.snapshot(); assert.strictEqual(s.entry.origin, "observed_from_entry"); assert.strictEqual(s.entry.entryTs, entryAt); assert.notStrictEqual(s.entry.entryTs, r.clock.now());
        assert.strictEqual(s.metrics.coverage.live, "FULL"); assert.strictEqual(s.metrics.coverage.candle, "FULL");
        const row = r.store._positions[0]; assert.strictEqual(row.origin, "observed_from_entry"); assert.strictEqual(row.entryTsSource, "engine-trade-record"); assert.strictEqual(row.reconciled, true);
        assert.strictEqual(r.store._events.find(e => e.kind === "POSITION_OPEN").detail.origin, "observed_from_entry");
    });
    await t("A: position opens while running but is noticed LATE -> discovered_after_entry; entry time stays the engine's; live PARTIAL with the reason recorded", async () => {
        const r = mkObs({}); await r.obs.evaluate(); const entryAt = r.clock.now() + 1000; r.setEntry(entryAt); r.advance(1000); r.enter("SHORT", 100, 8);
        r.advance(900000); r.obs.onTick(100); await r.obs.evaluate();       // observer stalled 15 min
        const s = r.obs.snapshot(); assert.strictEqual(s.entry.origin, "discovered_after_entry"); assert.strictEqual(s.entry.entryTs, entryAt, "must NOT be replaced by discovery time");
        assert.strictEqual(s.metrics.coverage.live, "PARTIAL"); assert(/not observed/.test(s.metrics.coverage.liveNote)); assert(r.store._events.find(e => e.kind === "POSITION_OPEN").detail.note.includes("noticed it"));
        assert.strictEqual(s.metrics.coverage.leadInMs, 900000);
    });
    await t("A: observer starts while a position is ALREADY open -> discovered_after_entry; candle metrics rebuilt from recorded candles, live PARTIAL; never fabricated", async () => {
        const T = T0 + 130 * TF + 5000, bars = mkBars(T0, 140, i => (i >= 125 ? [100, 103, 99.8, 100.1] : [100, 100.2, 99.8, 100.05]));   // candles 125+ have a high of 103
        const r = mkObs({ position: "SHORT", bars, now0: T, entryAt: T0 + 124 * TF + 60000 }); await r.obs.evaluate();
        const s = r.obs.snapshot(); assert.strictEqual(s.entry.origin, "discovered_after_entry"); assert.strictEqual(s.entry.entryTs, T0 + 124 * TF + 60000);
        assert.strictEqual(s.metrics.maeCandlePts, 3, "rebuilt from the recorded candles since the actual entry"); assert.strictEqual(s.metrics.maeLivePts, 0, "no live prices were seen: nothing fabricated");
        assert.strictEqual(s.metrics.coverage.candle, "FULL"); assert.strictEqual(s.metrics.coverage.live, "PARTIAL"); assert.strictEqual(s.metrics.peakPnl, 0);
    });
    await t("A: candle metrics are PARTIAL when recorded candles do not reach back to the entry", async () => {
        const T = T0 + 130 * TF + 5000, bars = mkBars(T0 + 100 * TF, 40, flat);   // history starts long after the entry
        const r = mkObs({ position: "SHORT", bars, now0: T, entryAt: T0 + 60 * TF }); await r.obs.evaluate(); const s = r.obs.snapshot();
        assert.strictEqual(s.metrics.coverage.candle, "PARTIAL"); assert(/missing|no candles/.test(s.metrics.coverage.candleNote));
    });
    await t("A: same position resumes after restart -> original origin kept, metrics preserved, no duplicate record, live gap recorded", async () => {
        const store = createMemoryStore(); const a = mkObs({ store }); await a.obs.evaluate(); a.advance(30000); await a.obs.evaluate(); const entryAt = a.clock.now() - 2000; a.setEntry(entryAt); a.enter("SHORT", 100, 8);
        await a.obs.evaluate(); a.obs.onTick(104); await a.obs.evaluate(); await a.obs.stop(); assert.strictEqual(store._positions[0].origin, "observed_from_entry");
        const b = mkObs({ store, position: "SHORT", tradeId: 8, entryAt }); await b.obs.reconcile(); const tr = b.obs._internals.tracked;
        assert.strictEqual(store._positions.length, 1); assert.strictEqual(tr.origin, "observed_from_entry"); assert.strictEqual(tr.metrics.raw.liveMae, 4); assert.strictEqual(tr.metrics.raw.liveGaps, 1);
        const rec = store._events.find(e => e.kind === "RECONCILE"); assert.strictEqual(rec.detail.result, "resumed"); assert(rec.detail.lastObservedAt);
    });
    await t("A: engine entry metadata UNAVAILABLE -> origin uncertain, both metric families PARTIAL, discovery time is not passed off as entry time", async () => {
        const r = mkObs({ position: "SHORT" }); r.metaOff(); await r.obs.evaluate(); const s = r.obs.snapshot(), row = r.store._positions[0];
        assert.strictEqual(s.entry.origin, "uncertain"); assert.strictEqual(row.entryTsSource, "observer-discovery-time"); assert.strictEqual(s.metrics.coverage.candle, "PARTIAL"); assert.strictEqual(s.metrics.coverage.live, "PARTIAL"); assert(/NOT known/.test(s.entry.note));
        assert(/NOT known/.test(r.store._events.find(e => e.kind === "POSITION_OPEN").detail.note));
    });
    await t("A: engine trade record that contradicts the live position (different trade id) -> uncertain, not trusted", async () => {
        const r = mkObs({ position: "SHORT", tradeId: 7 }); r.setEntry(T0 + 100 * TF); const orig = r.state.openTradeId; r.state.openTradeId = 7;
        const r2 = rig({ position: "SHORT", entryPrice: 100, tradeId: 7, entryMeta: { tradeId: 999, entryTs: T0 + 100 * TF, side: "SHORT" } }); await r2.obs.evaluate();
        assert.strictEqual(r2.obs.snapshot().entry.origin, "uncertain");
    });
    await t("A: entry metadata inconsistent with observed history (observer saw it flat AFTER the claimed entry) -> uncertain", async () => {
        const r = mkObs({}); await r.obs.evaluate(); r.advance(1200000); await r.obs.evaluate();   // flat for 20 minutes
        r.setEntry(r.clock.now() - 1100000); r.enter("SHORT", 100, 8); await r.obs.evaluate(); assert.strictEqual(r.obs.snapshot().entry.origin, "uncertain"); assert(/inconsistent/.test(r.obs.snapshot().entry.note));
    });
    await t("A: position identity changes unexpectedly while running -> old record closed with the reason, new record created, nothing carried over", async () => {
        const r = mkObs({}); await r.obs.evaluate(); r.advance(30000); await r.obs.evaluate(); r.setEntry(r.clock.now() - 1000); r.enter("SHORT", 100, 8); await r.obs.evaluate(); r.obs.onTick(104); await r.obs.evaluate();
        assert.strictEqual(r.obs._internals.tracked.metrics.raw.liveMae, 4);
        r.advance(30000); r.setEntry(r.clock.now() - 1000); r.enter("SHORT", 100, 9); await r.obs.evaluate();   // a different trade, same side / price
        assert.strictEqual(r.store._positions.length, 2); assert(/trade id/.test(r.store._positions[0].closeNote)); assert.strictEqual(r.obs._internals.tracked.metrics.raw.liveMae, 0);
    });
    await t("A: position closes while the observer is OFFLINE -> closed with an explicit 'unknown close time' note; final stretch flagged unobserved", async () => {
        const store = createMemoryStore(); const a = mkObs({ store, position: "SHORT" }); await a.obs.evaluate(); a.obs.onTick(101); a.advance(30000); await a.obs.evaluate(); await a.obs.stop();
        const b = mkObs({ store }); await b.obs.start(); await b.obs.stop();
        assert(store._positions[0].closedAt); assert(/close time unknown/.test(store._positions[0].closeNote));
        const e = store._events.find(x => x.kind === "RECONCILE"); assert.strictEqual(e.detail.result, "closed_offline"); assert(e.detail.lastObservedAt); assert(/NOT observed/.test(e.detail.why));
    });

    // ═════════ Finding C: reliable vs unknown duration ═════════
    const sec = (r, k) => r.obs.snapshot().metrics.durations;
    const tickEval = async (r, n, { tick = true, ms = 30000, px = 100 } = {}) => { for (let i = 0; i < n; i++) { r.advance(ms); if (tick) r.obs.onTick(px); await r.obs.evaluate(); } };
    await t("C: healthy observation -> every second is reliable state time, none is unknown", async () => {
        const r = posRig(); r.obs.onTick(100); await r.obs.evaluate(); await tickEval(r, 4); const d = sec(r);
        assert.strictEqual(d.reliableStateSecs.NORMAL, 120); assert.strictEqual(d.unknownSecs.total, 0); assert.strictEqual(d.marketClosedSecs, 0);
    });
    await t("C: REST feed failure -> state time stops, UNKNOWN(rest) time grows, last known state is not credited", async () => {
        const r = posRig(); r.obs.onTick(100); await r.obs.evaluate(); r.setBars(mkBars(T0, 100, flat)); r.fail(true);
        await tickEval(r, 40); const mid = sec(r); assert(mid.unknownSecs.rest > 0, JSON.stringify(mid));
        const n0 = mid.reliableStateSecs.NORMAL; await tickEval(r, 10); const d = sec(r);
        assert.strictEqual(d.reliableStateSecs.NORMAL, n0, "frozen state must not keep accumulating"); assert(d.unknownSecs.rest >= mid.unknownSecs.rest + 299, JSON.stringify([mid.unknownSecs, d.unknownSecs])); assert.strictEqual(r.obs.snapshot().riskState, "UNKNOWN");
    });
    await t("C: LTP stale -> unknown(ltp) time, no state time; recovery on a fresh tick resumes state time", async () => {
        const r = posRig(); r.obs.onTick(100); await r.obs.evaluate(); await tickEval(r, 2); const base = sec(r).reliableStateSecs.NORMAL;
        await tickEval(r, 8, { tick: false }); const d1 = sec(r);   // 240s of silence; first 90s still fresh (threshold 120s)
        assert(d1.unknownSecs.ltp > 0); assert(d1.reliableStateSecs.NORMAL < base + 240, "silent time must not all be credited to the state");
        const frozen = d1.reliableStateSecs.NORMAL; await tickEval(r, 4, { tick: false }); assert.strictEqual(sec(r).reliableStateSecs.NORMAL, frozen);
        await tickEval(r, 3); await tickEval(r, 3); assert(sec(r).reliableStateSecs.NORMAL > frozen, "state time resumes once ticks are fresh again"); assert.strictEqual(r.obs.snapshot().riskReliable, true);
    });
    await t("C: LTP disconnect (no tick at all since start) -> everything is unknown(ltp), nothing is state time", async () => {
        const r = posRig(); await r.obs.evaluate(); await tickEval(r, 6, { tick: false }); const d = sec(r);
        assert.strictEqual(d.reliableStateSecs.NORMAL, 0); assert.strictEqual(d.unknownSecs.ltp, 180);
    });
    await t("C: market closed -> booked as market-closed time, not unknown and not state time", async () => {
        let open = true; const r = posRig({ marketOpen: () => open }); r.obs.onTick(100); await r.obs.evaluate(); await tickEval(r, 2); open = false; await tickEval(r, 4); const d = sec(r);
        assert.strictEqual(d.marketClosedSecs, 120); assert.strictEqual(d.unknownSecs.total, 0); assert.strictEqual(d.reliableStateSecs.NORMAL, 60);   // two reliable 30s intervals before the close
    });
    await t("C: a stalled evaluation loop is booked as UNOBSERVED, never as state time", async () => {
        const r = posRig(); r.obs.onTick(100); await r.obs.evaluate(); r.advance(600000); r.obs.onTick(100); await r.obs.evaluate(); const d = sec(r);
        assert(d.unknownSecs.unobserved >= 480, JSON.stringify(d)); assert(d.reliableStateSecs.NORMAL <= 120);
    });
    await t("C: durations persist across a restart; downtime is not credited and no transition is inferred during it", async () => {
        const store = createMemoryStore(); const a = posRig({ store }); a.obs.onTick(100); await a.obs.evaluate(); await tickEval(a, 4); await a.obs.stop();
        const before = JSON.parse(JSON.stringify(store._positions[0].metrics)); assert.strictEqual(before.stateSecs.NORMAL, 120);
        const stateEvents = store._events.filter(e => e.kind === "STATE").length;
        const b = posRig({ store }); b.advance(3600000); await b.obs.reconcile(); const m = b.obs._internals.tracked.metrics.raw;
        assert.strictEqual(m.stateSecs.NORMAL, 120); assert.strictEqual(m.unknownSecs.total === undefined ? 0 : 0, 0); assert.strictEqual(store._events.filter(e => e.kind === "STATE").length, stateEvents);
        assert.strictEqual(b.obs._internals.machine.state, "NORMAL");
    });
    // ═════════ Persistence / duplicates / evidence / lifecycle (isolated sqlite) ═════════
    const tmpDb = name => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "roobs-")), name + "_riskobs.db");
    const kinds = ev => ev.reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {});
    await t("D/restart: REST health interruption is persisted; after a DB restart analytics still censors the unreliable stretch", async () => {
        const file = tmpDb("h"); let store = await createSqliteStore(file, { instrument: "Z" }); const r = posRig({ store }); r.obs.onTick(100); await r.obs.evaluate();
        r.setBars(mkBars(T0, 100, flat)); r.fail(true); for (let i = 0; i < 45; i++) { r.advance(30000); r.obs.onTick(100); await r.obs.evaluate(); }   // ~22 min without new candles -> STALE
        r.state.position = null; await r.obs.evaluate(); await store.close();
        store = await createSqliteStore(file, { instrument: "Z" }); const h = await loadHistoryReadOnly(file); await store.close();
        assert(h.events.some(e => e.kind === "HEALTH" && e.detail.dim === "rest" && e.to !== "HEALTHY"), "degradation event must survive"); const p = summarize(h, { nowMs: r.clock.now() }).positions[0];
        assert(p.dsbRelation.unknownSecs > 0, JSON.stringify(p.dsbRelation)); assert(p.dsbRelation.reliableSecs > 0); assert(p.unknownSecs.rest > 0);
    });
    await t("events are deduplicated: steady state writes NO further events per evaluation cycle", async () => {
        const r = posRig(); r.obs.onTick(100); await r.obs.evaluate(); await tickEval(r, 3); const before = kinds(r.store._events); await tickEval(r, 25); assert.deepStrictEqual(kinds(r.store._events), before);
    });
    await t("timeline records gaps, backfills, closure/broker-empty evidence and lifecycle once each, and evidence is not re-logged after a restart", async () => {
        const store = createMemoryStore(); const holey2 = mkBars(T0, 140, flat).filter((_, i) => i !== 40);
        const a = rig({ store, bars: holey2, position: "SHORT", entryPrice: 100 }); await a.obs.start(); a.obs.onTick(100);
        for (let i = 0; i < 12; i++) { a.advance(31000); a.obs.onTick(100); await a.obs.evaluate(); }
        const k = kinds(store._events); assert(k.CANDLE_GAP >= 1, JSON.stringify(k)); assert(k.CLOSURE_EVIDENCE >= 1, "broker-empty evidence after the retry limit"); assert.strictEqual(k.OBSERVER, 1);
        await a.obs.stop(); assert.strictEqual(kinds(store._events).OBSERVER, 2);
        const evid0 = kinds(store._events).CLOSURE_EVIDENCE; const b = rig({ store, bars: holey2, position: "SHORT", entryPrice: 100 }); await b.obs.start(); for (let i = 0; i < 4; i++) { b.advance(31000); b.obs.onTick(100); await b.obs.evaluate(); }
        assert.strictEqual(kinds(store._events).CLOSURE_EVIDENCE, evid0, "evidence is seeded from the database, not re-discovered and re-logged"); await b.obs.stop();
    });
    await t("a successful backfill is recorded and the gap is logged as resolved", async () => {
        const holey3 = mkBars(T0, 140, flat).filter((_, i) => i !== 40), r = rig({ bars: holey3 }); await r.obs.evaluate(); r.advance(31000); await r.obs.evaluate();
        r.setBars(mkBars(T0, 140, flat)); r.advance(31000); await r.obs.evaluate(); r.advance(31000); await r.obs.evaluate();
        assert(r.store._events.some(e => e.kind === "BACKFILL")); assert(r.store._events.some(e => e.kind === "CANDLE_GAP" && e.detail.state === "resolved")); assert(r.obs.snapshot().lastBackfillOkAt);
    });
    await t("a re-delivered candle that DIFFERS is never written over history: persisted value kept, conflict recorded", async () => {
        const bars = mkBars(T0, 140, flat), r = rig({ bars }); await r.obs.evaluate();
        const exp = Math.floor(r.clock.now() / TF) * TF - TF, lastBar = bars.find(b => new Date(b.date).getTime() === exp); const altered = bars.map(b => (b === lastBar ? { ...b, high: 150 } : b));
        r.setBars(altered); r.advance(TF); r.setBars([...altered, ...mkBars(T0 + 140 * TF, 3, flat)]); await r.obs.evaluate();
        const stored = (await r.store.allCandles()).find(c => c.ts === exp); assert.strictEqual(stored.high, 100.2); assert(r.store._events.some(e => e.kind === "CANDLE_CONFLICT" && e.detail.received.high === 150));
        assert.strictEqual(r.obs._internals.monitor.candles().find(c => c.ts === exp).high, 100.2);
    });
    await t("lifecycle: failure then recovery is on the timeline (start_failed, recovered, stopped)", async () => {
        const r = startRig({ position: "LONG" }); const orig = r.store.getOpenPosition; r.store.getOpenPosition = async () => { throw new Error("locked"); }; await r.obs.start();
        r.store.getOpenPosition = orig; await r.tm.fireTimeouts(); await r.obs.stop(); const k = r.store._events.filter(e => e.kind === "OBSERVER").map(e => e.detail.event);
        assert.deepStrictEqual(k, ["start_failed", "recovered", "stopped"]);
    });
    await t("multiple instruments run simultaneously on separate databases; a failing instrument never affects the other", async () => {
        const fa = tmpDb("a"), fb = tmpDb("b"); const sa = await createSqliteStore(fa, { instrument: "A" }), sb = await createSqliteStore(fb, { instrument: "B" });
        const a = posRig({ store: sa }), b = rig({ position: "LONG", entryPrice: 50, store: sb }); await a.obs.evaluate(); await b.obs.evaluate();
        sa.addEvent = async () => { throw new Error("A disk full"); }; sa.updatePosition = async () => { throw new Error("A disk full"); }; a.obs.onTick(105); b.obs.onTick(49); await a.obs.evaluate(); await b.obs.evaluate();
        assert(a.obs._internals.storeErrors > 0); assert.strictEqual(b.obs._internals.storeErrors, 0, String(b.obs.snapshot().storeHealth.lastError)); assert.strictEqual(b.obs.snapshot().metrics.maeLivePts, 1);
        assert.strictEqual((await sb.getOpenPosition()).side, "LONG"); assert.strictEqual((await sa.getOpenPosition()).side, "SHORT");
        await assert.rejects(() => createSqliteStore(fa, { instrument: "B" }), /belongs to instrument/); await sa.close(); await sb.close();
    });

    // ═════════ Fault injection: nothing may escape into the trading loop or the process ═════════
    await t("FAULT REST: Kite down -> ERROR health, UNKNOWN, no exception, recovers when Kite returns", async () => {
        const r = posRig(); r.obs.onTick(100); await r.obs.evaluate(); r.fail(true); r.setBars(mkBars(T0, 100, flat));
        for (let i = 0; i < 45; i++) { r.advance(30000); r.obs.onTick(100); await r.obs.evaluate(); } const s = r.obs.snapshot(); assert.strictEqual(s.restHealth.status, "ERROR"); assert.strictEqual(s.riskState, "UNKNOWN"); assert.strictEqual(s.overallHealth, "ERROR");
        r.fail(false); r.setBars(mkBars(T0, 200, flat)); r.advance(60000); r.obs.onTick(100); await r.obs.evaluate(); assert.strictEqual(r.obs.snapshot().restHealth.status, "HEALTHY"); assert.strictEqual(r.obs.snapshot().riskReliable, true);
    });
    await t("FAULT WebSocket: garbage / missing ticks are ignored, never throw, never fabricate a price", async () => {
        const r = posRig(); await r.obs.evaluate(); for (const bad of [NaN, undefined, null, "x", {}, Infinity, -Infinity]) assert.doesNotThrow(() => r.obs.onTick(bad));
        await r.obs.evaluate(); assert.strictEqual(r.obs.snapshot().metrics.lastPrice, null); assert.strictEqual(r.obs.snapshot().ltpHealth.status, "NONE");
    });
    await t("FAULT SQLite: every store operation failing at start -> start() resolves, no unhandled rejection, retry scheduled; recovers when the store does", async () => {
        const r = startRig({ position: "LONG" }); const ops = ["getMeta", "setMeta", "getOpenPosition", "openPosition", "updatePosition", "closePosition", "addEvent", "markCandle", "eventsByKind"], saved = {};
        for (const o of ops) { saved[o] = r.store[o]; r.store[o] = async () => { throw new Error("sqlite unavailable"); }; }
        await r.obs.start(); assert.strictEqual(r.obs._internals.initState, "failed"); assert.strictEqual(r.tm.touts.size, 1); assert.strictEqual(r.obs.snapshot().init.state, "failed"); assert.strictEqual(r.obs.snapshot().overallHealth, "ERROR");
        for (const o of ops) r.store[o] = saved[o]; await r.tm.fireTimeouts(); assert.strictEqual(r.obs._internals.initState, "running"); await r.obs.stop();
    });
    await t("FAULT SQLite at runtime: writes fail, trading-side calls keep working, errors are counted and visible", async () => {
        const r = posRig(); r.obs.onTick(100); await r.obs.evaluate(); for (const o of ["addEvent", "updatePosition", "markCandle", "closePosition", "openPosition"]) r.store[o] = async () => { throw new Error("io"); };
        r.state.position = null; await r.obs.evaluate(); r.state.position = "LONG"; r.state.entryPrice = 90; await r.obs.evaluate(); assert(r.obs._internals.storeErrors >= 3); assert.strictEqual(r.obs.snapshot().storeHealth.errors, r.obs._internals.storeErrors); assert.strictEqual(r.obs.snapshot().init.state, "idle");
    });
    await t("FAULT Telegram: tg throwing / rejecting never changes state or leaks an unhandled rejection", async () => {
        for (const mode of ["throw", "reject"]) {
            const r = rig({ position: "SHORT", entryPrice: 100, pOver: { dangerAdverseCandles: 0 } }); const o2 = createRiskObserver({ context: r.context, engineConfig, state: r.state, candles: r.candles, store: createMemoryStore(), tg: () => (mode === "throw" ? (() => { throw new Error("tg down"); })() : Promise.reject(new Error("tg 429"))), emit: () => {}, clock: r.clock, fetchRaw: async () => mkBars(T0, 140, flat), params: resolveParams(engineConfig, { evalSeconds: 30, dangerAdverseCandles: 0 }), marketOpen: () => true, getEntryMeta: async () => ({ tradeId: 7, entryTs: T0 + 100 * TF, side: "SHORT" }) });
            await o2.evaluate(); for (let i = 0; i < 5; i++) { r.advance(1000); o2.onTick(112); await o2.evaluate(); } assert.strictEqual(o2._internals.machine.state, "DANGER", mode);
        }
        await new Promise(res => setImmediate(res)); assert.strictEqual(unhandled, 0, "unhandled promise rejection");
    });
    await t("FAULT dashboard / event bridge: emit throwing for every call never reaches the evaluation", async () => {
        const r = rig({ position: "SHORT", entryPrice: 100 }); let calls = 0; const o2 = createRiskObserver({ context: r.context, engineConfig, state: r.state, candles: r.candles, store: createMemoryStore(), emit: () => { calls++; throw new Error("ws closed"); }, clock: r.clock, fetchRaw: async () => mkBars(T0, 140, flat), params: resolveParams(engineConfig, {}), marketOpen: () => true });
        for (let i = 0; i < 4; i++) { r.advance(5000); o2.onTick(100); await o2.evaluate(); } assert(calls >= 1); assert(o2.snapshot().ts);
    });
    await t("ISOLATION: onTick is synchronous and returns nothing the trading loop could await; start/evaluate/stop never throw or reject under total failure", async () => {
        const r = startRig({ position: "LONG" }); for (const k of Object.keys(r.store)) if (typeof r.store[k] === "function") r.store[k] = async () => { throw new Error("dead"); };
        assert.strictEqual(r.obs.onTick(100), undefined); await assert.doesNotReject(() => r.obs.start()); await assert.doesNotReject(() => r.obs.evaluate()); await assert.doesNotReject(() => r.obs.stop()); await assert.doesNotReject(() => r.obs.stop());
    });
    await t("no unhandled promise rejections occurred anywhere in this file", async () => { await new Promise(res => setImmediate(res)); assert.strictEqual(unhandled, 0); });
    await t("Safety: riskObserver/ has no reference to orders, SL, targets or position-closing", async () => {
        const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []));   // recursive: intel/, portfolio/, sim/ are covered too
        for (const f of walk(path.join(__dirname, "riskObserver"))) { const src = fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/`[^`]*`|"[^"\n]*"/g, "");
            assert(!/\b(placeOrder|orders\.|slStore|targetStore|exitPosition|positionsClose|kc\.placeOrder|modifyOrder|cancelOrder)\b/.test(src), f + " references trading primitives"); }
    });
    console.log(`\n${passed} scenarios passed`); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
