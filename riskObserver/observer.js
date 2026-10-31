// riskObserver/observer.js — per-instrument Multi-Timeframe Risk Observer (SHADOW / OBSERVATION ONLY).
//
// The 1H Dual DSB (strategies.js createDsbDualStrategy) stays the only trading authority. This observer
//   * READS engine state (state.position, state.entryPrice, the 1H candle buffer) and never writes to any of it,
//   * has NO reference to orders / slStore / targetStore / positionsClose — it cannot place or change an order,
//   * keeps its own 15m candle feed, its own DSB steppers and its own SQLite file,
//   * reports WATCH / DANGER / RECOVERY as monitoring labels (Telegram + dashboard), never as signals.
// Every public method is wrapped so an observer failure can never reach the trading loop.
"use strict";

const { createDsbMonitor, dualReplay, relation } = require("./dsbMonitor");
const { createCandleFeed } = require("./priceMonitor");
const { createPositionMetrics } = require("./riskMetrics");
const { newMachine, step: stepMachine } = require("./riskState");
const { atr } = require("../indicators");

const CFG_KEYS = {
    watchAdverseAtr: "RISK_OBS_WATCH_ADVERSE_ATR", watchDisagreeCandles: "RISK_OBS_WATCH_DISAGREE_CANDLES",
    dangerAdverseAtr: "RISK_OBS_DANGER_ADVERSE_ATR", dangerAdverseCandles: "RISK_OBS_DANGER_ADVERSE_CANDLES",
    dangerOppositeAtr: "RISK_OBS_DANGER_OPPOSITE_ATR", dangerDisagreeCandles: "RISK_OBS_DANGER_DISAGREE_CANDLES",
    escalateConfirm: "RISK_OBS_ESCALATE_CONFIRM", clearConfirm: "RISK_OBS_CLEAR_CONFIRM", normalConfirm: "RISK_OBS_NORMAL_CONFIRM",
    clearAdverseAtr: "RISK_OBS_CLEAR_ADVERSE_ATR", evalSeconds: "RISK_OBS_EVAL_SECONDS", staleGraceSeconds: "RISK_OBS_STALE_GRACE_SECONDS",
    errorAfterFails: "RISK_OBS_ERROR_AFTER_FAILS",
};
// engineConfig defaults + per-instrument overrides (RISK_OBS_PARAMS_OVERRIDE JSON, keys as in CFG_KEYS)
function resolveParams(engineConfig, overrides) {
    const p = {};
    for (const [k, ek] of Object.entries(CFG_KEYS)) p[k] = engineConfig[ek];
    for (const [k, v] of Object.entries(overrides || {})) if (k in CFG_KEYS && Number.isFinite(Number(v)) && Number(v) >= 0) p[k] = Number(v);
    return p;
}

const SHORT_TF = "15m";
const fx = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : Number(v).toFixed(d));

function createRiskObserver({ context, engineConfig, state, candles, store, tg = () => {}, emit = () => {}, clock = { now: () => Date.now() }, fetchRaw, params, marketOpen = () => true, log = () => {} }) {
    const cfg = params;
    const tfMs = 15 * 60000;
    const step1 = context.bandStep ?? engineConfig.BAND_STEP_DEFAULT, step2 = context.bandStep2 ?? engineConfig.BAND_STEP2_DEFAULT;
    const monitor = createDsbMonitor({ step1, step2, tfMs });
    const feed = createCandleFeed({ fetchRaw, monitor, tfMs, now: () => clock.now(), staleGraceMs: cfg.staleGraceSeconds * 1000, errorAfterFails: cfg.errorAfterFails });
    const perPoint = () => (Number(context.lotMult) || 1) * (Number(context.lots) || 1);

    let tracked = null;            // { id, metrics, machine, openedAt, reconciled, note }
    let machine = newMachine();    // risk machine while a position is tracked
    let lastEvalAt = null, lastSnapEmitAt = 0, lastPersistAt = 0, lastRuntimeEventAt = null, lastPriceAt = null;
    let health = { status: "STALE", reason: "starting" };
    let reconcileNote = null, lastTransition = null, started = false;
    const timers = [];
    let busy = false;

    const safe = fn => async (...a) => { try { return await fn(...a); } catch (err) { try { log(`risk observer error: ${err && err.message ? err.message : err}`); } catch { /* ignore */ } } };
    const nowMs = () => clock.now();

    // ── position identity / reconciliation ─────────────────────────────────
    function liveIdentity() {
        if (!state.position) return null;
        return { side: state.position, entryPrice: Number(state.entryPrice), tradeId: state.openTradeId ?? null };
    }
    function sameIdentity(row, live) {
        if (!row || !live || row.side !== live.side) return false;
        const tol = Math.max(1e-6, (Number(context.tickSize) || 0.05) * 2);
        if (!(Math.abs(row.entryPrice - live.entryPrice) <= tol)) return false;
        return row.tradeId === null || live.tradeId === null || row.tradeId === live.tradeId;   // a missing id on one side is "unknown", not a mismatch
    }
    async function openTracking(live, reconciled, note) {
        const metrics = createPositionMetrics({ side: live.side, entryPrice: live.entryPrice, perPoint: perPoint(), entryTs: nowMs(), tradeId: live.tradeId });
        const id = await store.openPosition({ side: live.side, entryPrice: live.entryPrice, entryTs: metrics.raw.entryTs, tradeId: live.tradeId, openedAt: nowMs(), riskState: "NORMAL", metrics: metrics.persistable(), reconciled });
        tracked = { id, metrics, openedAt: nowMs(), reconciled, note: note || null };
        machine = newMachine();
        await store.addEvent({ posId: id, ts: nowMs(), kind: "POSITION_OPEN", to: "NORMAL", detail: { side: live.side, entryPrice: live.entryPrice, reconciled, note } });
    }
    async function closeTracking(note) {
        if (!tracked) return;
        const snap = tracked.metrics.snapshot();
        await store.updatePosition(tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() });
        await store.addEvent({ posId: tracked.id, ts: nowMs(), kind: "POSITION_CLOSE", from: machine.state, detail: { note, mae: snap.maePts, mfe: snap.mfePts, peakPnl: snap.peakPnl, maxGiveback: snap.maxGiveback, stateSecs: snap.stateSecs } });
        await store.closePosition(tracked.id, note, nowMs());
        tracked = null; machine = newMachine();
    }
    // startup reconciliation against the engine's (already broker-reconciled) position
    async function reconcile() {
        const live = liveIdentity();
        const row = await store.getOpenPosition();
        if (!live && !row) { reconcileNote = null; return; }
        if (!live && row) {
            await store.addEvent({ posId: row.id, ts: nowMs(), kind: "RECONCILE", detail: { result: "persisted position has no live position — closed while the engine was down" } });
            await store.closePosition(row.id, "closed while offline", nowMs());
            reconcileNote = "previous observer position closed while the engine was down";
            return;
        }
        if (live && row && sameIdentity(row, live)) {
            const metrics = createPositionMetrics({ side: live.side, entryPrice: live.entryPrice, perPoint: perPoint(), entryTs: row.entryTs, tradeId: live.tradeId });
            if (row.metrics) metrics.restore(row.metrics);
            tracked = { id: row.id, metrics, openedAt: row.openedAt, reconciled: row.reconciled, note: null };
            machine = { ...newMachine(), state: ["NORMAL", "WATCH", "DANGER", "RECOVERY"].includes(row.riskState) ? row.riskState : "NORMAL" };
            await store.addEvent({ posId: row.id, ts: nowMs(), kind: "RECONCILE", detail: { result: "resumed", state: machine.state } });
            reconcileNote = null;
            return;
        }
        // live position exists but the observer record is missing or belongs to a DIFFERENT position: never resume it
        if (row) await store.closePosition(row.id, "identity mismatch with live position", nowMs());
        const why = row ? `persisted observer position (${row.side} @ ${fx(row.entryPrice)}) does not match the live ${live.side} @ ${fx(live.entryPrice)}` : `live ${live.side} @ ${fx(live.entryPrice)} has no observer record`;
        reconcileNote = `${why} — metrics restart from now (MAE/MFE/peak are PARTIAL for this position)`;
        await openTracking(live, false, reconcileNote);
        await store.addEvent({ posId: tracked.id, ts: nowMs(), kind: "RECONCILE", detail: { result: "uncertain", why } });
        tg(`[RISK OBSERVER — ${context.name}]\nReconciliation uncertain: ${why}.\nObserver metrics for this position are partial; trading is unaffected.`);
    }
    async function syncPosition() {
        const live = liveIdentity();
        if (tracked && (!live || !sameIdentity({ side: tracked.metrics.raw.side, entryPrice: tracked.metrics.raw.entryPrice, tradeId: tracked.metrics.raw.tradeId }, live))) {
            await closeTracking(live ? "position replaced" : "position closed");
        }
        if (!tracked && live) await openTracking(live, true, null);
    }

    // ── 1H trend authority (read-only replay of the strategy's own two bands on its own candle buffer) ──
    function trend1h() {
        const raw = candles.getRawCandles ? candles.getRawCandles() : [];
        if (!raw || raw.length < 3) return { c1: "none", c2: "none", dir: "NONE", agree: false, lastTs: null };
        const { toHA } = require("../indicators");
        const bars = toHA(raw).slice(-engineConfig.MAX_CANDLES).map((k, i, a) => ({ ...k, ts: new Date(k.date).getTime() || i }));
        const rows = dualReplay(bars, step1, step2), r = rows[rows.length - 1];
        const agree = r.c1 === r.c2 && r.c1 !== "none";
        return { c1: r.c1, c2: r.c2, agree, dir: agree ? (r.c1 === "green" ? "LONG" : "SHORT") : (r.c1 === "none" || r.c2 === "none" ? "NONE" : "DISAGREE"), lastTs: raw.length ? new Date(raw[raw.length - 1].date).getTime() : null };
    }

    // ── telegram / events ───────────────────────────────────────────────────
    function transitionMessage(t, snap, tr, obs, rel) {
        const lines = [`[RISK OBSERVER — ${context.name}]`, "", `State: ${t.to}`, `Position: ${tracked.metrics.raw.side}`, `1H Dual DSB: ${tr.dir}`];
        if (obs) { lines.push(`15M DSB 1: ${obs.c1 === "green" ? "LONG" : obs.c1 === "red" ? "SHORT" : "-"}`, `15M DSB 2: ${obs.c2 === "green" ? "LONG" : obs.c2 === "red" ? "SHORT" : "-"}`, `15M Dual DSB: ${rel === "aligned" ? "aligned with position" : rel === "opposite" ? "agree AGAINST position" : rel === "disagree" ? "Disagree" : "undecided"}`); }
        if (t.reasons && t.reasons.length) lines.push(`Reason: ${t.reasons.join("; ")}`);
        lines.push(`Adverse movement: ${fx(snap.currentAdversePts)} pts`, `ATR ratio: ${fx(snap.atrRatio)}`, `MFE: ${fx(snap.mfePts)} pts`, `MAE: ${fx(snap.maePts)} pts`);
        lines.push(t.to === "DANGER" || t.to === "WATCH" ? "Action: HOLD — observation only" : t.to === "RECOVERY" ? "Adverse conditions easing — still observing" : "Observer back to NORMAL");
        return lines.join("\n");
    }

    // ── one evaluation ──────────────────────────────────────────────────────
    async function evaluate() {
        if (busy) return; busy = true;
        try {
            const t = nowMs(), dt = lastEvalAt === null ? 0 : Math.min(120, (t - lastEvalAt) / 1000);
            lastEvalAt = t;
            await syncPosition();

            // authoritative completed 15m candles (one request only when the newest expected candle is missing)
            const res = await feed.poll();
            if (res.candles && res.candles.length) {
                const latestRows = dualReplay(monitor.candles(), step1, step2);
                const colorBy = new Map(latestRows.map(r => [r.ts, r]));
                for (const cd of res.candles) {
                    const rr = colorBy.get(cd.ts) || {};
                    const isNew = await store.markCandle({ ...cd, c1: rr.c1, c2: rr.c2 });   // restart-safe de-duplication
                    if (isNew && tracked) tracked.metrics.onCandle(cd);
                }
            }
            health = feed.health(marketOpen(new Date(t)));

            const tr = trend1h();
            const last = monitor.latest(), dis = monitor.disagreement();
            const atrVal = monitor.size() > cfg_atrLen() ? atr(monitor.candles(), cfg_atrLen()) : null;
            const side = tracked ? tracked.metrics.raw.side : null;
            const rel = side && last ? relation(side, last.c1, last.c2) : null;

            let snap = null, riskState = tracked ? machine.state : "NORMAL", reliable = health.status === "HEALTHY";
            if (tracked) {
                tracked.metrics.addStateTime(machine.state, dt);
                snap = tracked.metrics.snapshot();
                snap.atrRatio = atrVal && atrVal > 0 ? snap.currentAdversePts / atrVal : null;
                // Missing / stale / errored data is never classified as NORMAL: the machine is frozen and the state shown as UNKNOWN
                if (reliable && snap.atrRatio !== null && snap.lastPrice !== null) {
                    const inputs = { adverseAtr: snap.atrRatio, adverseCandles: snap.adverseCandles, disagreeCandles: dis.candles, oppositeAgree: rel === "opposite" };
                    const out = stepMachine(machine, inputs, cfg);
                    machine = out.machine;
                    if (out.transition) {
                        lastTransition = { ...out.transition, ts: t };
                        riskState = machine.state;
                        await store.addEvent({ posId: tracked.id, ts: t, kind: "STATE", from: out.transition.from, to: out.transition.to, detail: { reasons: out.transition.reasons, adverseAtr: snap.atrRatio, disagreeCandles: dis.candles, rel, mae: snap.maePts, mfe: snap.mfePts } });
                        await store.updatePosition(tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() });
                        tg(transitionMessage(out.transition, snap, tr, last, rel));
                        emit(context.tgPrefix, "RISKOBS_TRANSITION", { from: out.transition.from, to: out.transition.to, reasons: out.transition.reasons });
                    }
                }
                riskState = machine.state;
            }
            if (!reliable) await maybeHealthEvent();

            if (tracked && t - lastPersistAt > 10000) { lastPersistAt = t; await store.updatePosition(tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() }); }
            publish({ tr, last, dis, rel, atrVal, snap, riskState, reliable, side }, t, true);
        } finally { busy = false; }
    }
    const cfg_atrLen = () => engineConfig.ST_ATR_LEN || 10;

    let lastHealthKey = "HEALTHY";
    async function maybeHealthEvent() {
        const key = health.status;
        if (key === lastHealthKey) return;
        lastHealthKey = key;
        await store.addEvent({ posId: tracked ? tracked.id : null, ts: nowMs(), kind: "HEALTH", to: key, detail: { reason: health.reason } });
        tg(`[RISK OBSERVER — ${context.name}]\nObserver health: ${key}${health.reason ? ` (${health.reason})` : ""}\nRisk state is frozen while data is unreliable. Trading is unaffected.`);
    }
    // recovery of health is reported too
    function noteHealthRecovered() { if (health.status === "HEALTHY" && lastHealthKey !== "HEALTHY") { const prev = lastHealthKey; lastHealthKey = "HEALTHY"; store.addEvent({ posId: tracked ? tracked.id : null, ts: nowMs(), kind: "HEALTH", from: prev, to: "HEALTHY" }).catch(() => {}); tg(`[RISK OBSERVER — ${context.name}]\nObserver health: HEALTHY again (was ${prev}).`); } }

    let latestSnapshot = null;
    function publish(x, t, force) {
        noteHealthRecovered();
        const m = x.snap;
        latestSnapshot = {
            mode: "SHADOW — observation only", storeFile: store.file ? require("path").basename(store.file) : null, ts: t, instrument: context.name, tgPrefix: context.tgPrefix, strategy: context.strategy, timeframe: context.timeframe,
            position: state.position || null, entryPrice: state.position ? Number(state.entryPrice) : null, pnl: m ? m.pnl : null,
            trend1h: x.tr,
            obs15: { c1: x.last ? x.last.c1 : "none", c2: x.last ? x.last.c2 : "none", relation: x.rel, agree: x.last ? x.last.c1 === x.last.c2 && x.last.c1 !== "none" : false, disagreeCandles: x.dis.candles, disagreeMs: x.dis.durationMs, lastCandleTs: monitor.lastTs(), steps: [step1, step2] },
            riskState: x.reliable || !tracked ? x.riskState : "UNKNOWN", lastKnownRiskState: x.riskState, riskReliable: x.reliable,
            health, reconcileNote, lastTransition,
            metrics: m ? { ...m, atr15: x.atrVal, atrRatio: m.atrRatio } : null,
            freshness: { last15mCandleTs: monitor.lastTs(), last15mFetchOkAt: feed.info().lastOkAt, last1hCandleTs: x.tr.lastTs, lastRuntimeEventAt, lastPriceAt },
            params: cfg,
        };
        if (force || t - lastSnapEmitAt >= 5000) { lastSnapEmitAt = t; emit(context.tgPrefix, "RISKOBS", { snapshot: latestSnapshot }); }
    }

    // ── public surface ──────────────────────────────────────────────────────
    const onTick = price => { try { lastPriceAt = nowMs(); lastRuntimeEventAt = lastPriceAt; if (tracked && Number.isFinite(price)) tracked.metrics.onPrice(price); } catch { /* never reach the trading loop */ } };
    const start = safe(async () => {
        if (started) return; started = true;
        await reconcile();
        await evaluate();
        timers.push(setInterval(() => { evaluate().catch(() => {}); }, Math.max(5, cfg.evalSeconds) * 1000));
        for (const t of timers) if (t.unref) t.unref();
    });
    const stop = safe(async () => { for (const t of timers) clearInterval(t); timers.length = 0; if (tracked) await store.updatePosition(tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() }); });
    return { start, stop, onTick, evaluate: safe(evaluate), reconcile: safe(reconcile), snapshot: () => latestSnapshot, _internals: { monitor, feed, get tracked() { return tracked; }, get machine() { return machine; }, get health() { return health; } } };
}

module.exports = { createRiskObserver, resolveParams, CFG_KEYS };
