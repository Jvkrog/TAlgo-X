// riskObserver/observer.js — per-instrument Multi-Timeframe Risk Observer (SHADOW / OBSERVATION ONLY).
//
// The 1H Dual DSB (strategies.js createDsbDualStrategy) stays the only trading authority. This observer
//   * READS engine state (state.position, state.entryPrice, the 1H candle buffer) and never writes to any of it,
//   * has NO reference to orders / slStore / targetStore / positionsClose — it cannot place or change an order,
//   * keeps its own 15m candle feed, its own DSB steppers and its own SQLite file,
//   * reports WATCH / DANGER / RECOVERY as monitoring labels (Telegram + dashboard), never as signals.
// Every public method is contained so an observer failure can never reach the trading loop.
//
// TWO independent health dimensions (never confused):
//   REST  — the 15m candle feed (HEALTHY | GAPS | STALE | ERROR), see priceMonitor.js
//   LTP   — the live WebSocket price (HEALTHY | STALE | NONE | CLOSED), age vs RISK_OBS_LTP_STALE_SECONDS
// The risk machine only steps when BOTH are healthy; otherwise it freezes, the last known state is kept for display and
// the dashboard shows UNKNOWN. It resumes by itself when fresh data returns.
"use strict";

const { createDsbMonitor, dualReplay, replayHa, relation } = require("./dsbMonitor");
const { createCandleFeed, sessionFor } = require("./priceMonitor");
const { createPositionMetrics } = require("./riskMetrics");
const { newMachine, step: stepMachine } = require("./riskState");
const { atr } = require("../indicators");

const CFG_KEYS = {
    watchAdverseAtr: "RISK_OBS_WATCH_ADVERSE_ATR", watchDisagreeCandles: "RISK_OBS_WATCH_DISAGREE_CANDLES",
    dangerAdverseAtr: "RISK_OBS_DANGER_ADVERSE_ATR", dangerAdverseCandles: "RISK_OBS_DANGER_ADVERSE_CANDLES",
    dangerOppositeAtr: "RISK_OBS_DANGER_OPPOSITE_ATR", dangerDisagreeCandles: "RISK_OBS_DANGER_DISAGREE_CANDLES",
    escalateConfirm: "RISK_OBS_ESCALATE_CONFIRM", clearConfirm: "RISK_OBS_CLEAR_CONFIRM", normalConfirm: "RISK_OBS_NORMAL_CONFIRM",
    clearAdverseAtr: "RISK_OBS_CLEAR_ADVERSE_ATR", evalSeconds: "RISK_OBS_EVAL_SECONDS", staleGraceSeconds: "RISK_OBS_STALE_GRACE_SECONDS",
    errorAfterFails: "RISK_OBS_ERROR_AFTER_FAILS", ltpStaleSeconds: "RISK_OBS_LTP_STALE_SECONDS", backfillTries: "RISK_OBS_BACKFILL_TRIES",
    startRetrySeconds: "RISK_OBS_START_RETRY_SECONDS", sessionStartMin: "RISK_OBS_SESSION_START_MIN", sessionEndMin: "RISK_OBS_SESSION_END_MIN",
};
// engineConfig defaults + per-instrument overrides (RISK_OBS_PARAMS_OVERRIDE JSON, keys as in CFG_KEYS)
function resolveParams(engineConfig, overrides) {
    const p = {};
    for (const [k, ek] of Object.entries(CFG_KEYS)) p[k] = engineConfig[ek];
    for (const [k, v] of Object.entries(overrides || {})) if (k in CFG_KEYS && v !== null && Number.isFinite(Number(v)) && Number(v) >= 0) p[k] = Number(v);
    return p;
}

const fx = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : Number(v).toFixed(d));

function createRiskObserver({ context, engineConfig, state, candles, store, tg: tgRaw = () => {}, emit: emitRaw = () => {}, clock = { now: () => Date.now() }, fetchRaw, params, marketOpen = () => true, log = () => {},
    timers = { setInterval, clearInterval, setTimeout, clearTimeout } }) {
    const cfg = params;
    // dashboard / Telegram failures (disconnected WebSocket, bad token) must never reach the evaluation or the trading loop
    const tg = (...a) => { try { const r = tgRaw(...a); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ } };
    const emit = (...a) => { try { emitRaw(...a); } catch { /* ignore */ } };
    const tfMs = 15 * 60000;
    const step1 = context.bandStep ?? engineConfig.BAND_STEP_DEFAULT, step2 = context.bandStep2 ?? engineConfig.BAND_STEP2_DEFAULT;
    const monitor = createDsbMonitor({ step1, step2, tfMs });
    const feed = createCandleFeed({
        fetchRaw, monitor, tfMs, now: () => clock.now(), staleGraceMs: cfg.staleGraceSeconds * 1000, errorAfterFails: cfg.errorAfterFails,
        session: sessionFor(context.exchange, { sessionStartMin: cfg.sessionStartMin, sessionEndMin: cfg.sessionEndMin }), maxBackfillTries: cfg.backfillTries || 3,
    });
    const perPoint = () => (Number(context.lotMult) || 1) * (Number(context.lots) || 1);
    const nowMs = () => clock.now();

    let tracked = null;            // { id, metrics, openedAt, reconciled, note }
    let machine = newMachine();
    let lastEvalAt = null, lastSnapEmitAt = 0, lastPersistAt = 0, lastRuntimeEventAt = null, lastPriceAt = null;
    let health = { status: "STALE", reason: "starting" };                          // REST (15m candle feed)
    let ltp = { status: "NONE", ageMs: null, lastAt: null, staleAfterMs: cfg.ltpStaleSeconds * 1000 };   // live price
    let reconcileNote = null, lastTransition = null, latestSnapshot = null;
    let busy = false, initState = "idle", initError = null, initFailures = 0;
    let evalTimer = null, retryTimer = null;
    let storeErrors = 0, lastStoreError = null, strictStore = false;
    let lastRestKey = "HEALTHY", lastLtpKey = null;

    // Persistence is best-effort at runtime (a failed SQLite write must never interrupt anything); during start() it is
    // strict so that a failure makes the start fail and be retried instead of running on half-initialised state.
    async function st(op, ...args) {
        try { return await store[op](...args); }
        catch (err) { storeErrors++; lastStoreError = err && err.message ? err.message : String(err); if (strictStore) throw err; try { log(`risk observer store ${op} failed: ${lastStoreError}`); } catch { /* ignore */ } return undefined; }
    }
    const safe = fn => async (...a) => { try { return await fn(...a); } catch (err) { try { log(`risk observer error: ${err && err.message ? err.message : err}`); } catch { /* ignore */ } } };

    // ── position identity / reconciliation ─────────────────────────────────
    const liveIdentity = () => (state.position ? { side: state.position, entryPrice: Number(state.entryPrice), tradeId: state.openTradeId ?? null, perPoint: perPoint() } : null);
    function identityDiff(row, live) {   // null when the same position, else a reason string
        if (!row || !live) return "no position on one side";
        if (row.side !== live.side) return `side ${row.side} vs ${live.side}`;
        const tol = Math.max(1e-6, (Number(context.tickSize) || 0.05) * 2);
        if (!(Math.abs(row.entryPrice - live.entryPrice) <= tol)) return `entry ${fx(row.entryPrice)} vs ${fx(live.entryPrice)}`;
        if (row.tradeId !== null && live.tradeId !== null && row.tradeId !== live.tradeId) return `trade id ${row.tradeId} vs ${live.tradeId}`;
        if (row.perPoint !== undefined && row.perPoint !== null && Math.abs(row.perPoint - live.perPoint) > 1e-9) return `position size changed (₹/pt ${row.perPoint} vs ${live.perPoint}) — quantity change or partial close; rupee metrics are not comparable`;
        return null;
    }
    async function openTracking(live, reconciled, note) {
        const metrics = createPositionMetrics({ side: live.side, entryPrice: live.entryPrice, perPoint: live.perPoint, entryTs: nowMs(), tradeId: live.tradeId });
        if (!reconciled) metrics.markPartial(note || "partial: observer started mid-position");
        const id = await st("openPosition", { side: live.side, entryPrice: live.entryPrice, entryTs: metrics.raw.entryTs, tradeId: live.tradeId, openedAt: nowMs(), riskState: "NORMAL", metrics: metrics.persistable(), reconciled });
        tracked = { id: id ?? null, metrics, openedAt: nowMs(), reconciled, note: note || null };
        machine = newMachine();
        await st("addEvent", { posId: tracked.id, ts: nowMs(), kind: "POSITION_OPEN", to: "NORMAL", detail: { side: live.side, entryPrice: live.entryPrice, reconciled, note } });
    }
    async function closeTracking(note) {
        if (!tracked) return;
        const snap = tracked.metrics.snapshot(), id = tracked.id, finalMetrics = tracked.metrics.persistable();
        tracked = null; const lastState = machine.state; machine = newMachine();
        if (id == null) return;
        await st("updatePosition", id, { riskState: lastState, metrics: finalMetrics });
        await st("addEvent", { posId: id, ts: nowMs(), kind: "POSITION_CLOSE", from: lastState, detail: { note, mae: snap.maePts, mfe: snap.mfePts, peakPnl: snap.peakPnl, maxGiveback: snap.maxGiveback, stateSecs: snap.stateSecs, coverage: snap.coverage, pnl: snap.pnl, giveback: snap.giveback, entryTs: snap.entryTs } });
        await st("closePosition", id, note, nowMs());
    }
    // startup reconciliation against the engine's (already broker-reconciled) position; strict during start()
    async function reconcileInner() {
        const live = liveIdentity();
        const row = await st("getOpenPosition");
        if (!live && !row) { reconcileNote = null; return; }
        if (!live && row) {
            await st("addEvent", { posId: row.id, ts: nowMs(), kind: "RECONCILE", detail: { result: "persisted position has no live position — closed while the engine was down" } });
            await st("closePosition", row.id, "closed while offline", nowMs());
            reconcileNote = "previous observer position closed while the engine was down";
            return;
        }
        const rowIdent = row ? { side: row.side, entryPrice: row.entryPrice, tradeId: row.tradeId, perPoint: row.metrics && row.metrics.perPoint } : null;
        const diff = row ? identityDiff(rowIdent, live) : "no observer record";
        if (live && row && diff === null) {
            const metrics = createPositionMetrics({ side: live.side, entryPrice: live.entryPrice, perPoint: live.perPoint, entryTs: row.entryTs, tradeId: live.tradeId });
            if (row.metrics) metrics.restore(row.metrics);
            metrics.markLiveGap();   // the engine was not observed while it was down: live extremes / peak / giveback have a hole
            tracked = { id: row.id, metrics, openedAt: row.openedAt, reconciled: row.reconciled, note: null };
            machine = { ...newMachine(), state: ["NORMAL", "WATCH", "DANGER", "RECOVERY"].includes(row.riskState) ? row.riskState : "NORMAL" };
            await st("addEvent", { posId: row.id, ts: nowMs(), kind: "RECONCILE", detail: { result: "resumed", state: machine.state, liveGaps: metrics.raw.liveGaps } });
            reconcileNote = row.reconciled ? null : "this position's metrics were already PARTIAL before the restart";
            return;
        }
        // live position exists but the observer record is missing or belongs to a DIFFERENT position: never resume it
        if (row) await st("closePosition", row.id, `identity mismatch with live position (${diff})`, nowMs());
        const why = row ? `persisted observer position (${row.side} @ ${fx(row.entryPrice)}) does not match the live ${live.side} @ ${fx(live.entryPrice)} (${diff})` : `live ${live.side} @ ${fx(live.entryPrice)} has no observer record`;
        reconcileNote = `${why} — metrics restart from now: MAE / MFE / peak P&L / giveback are PARTIAL for this position`;
        await openTracking(live, false, reconcileNote);
        await st("addEvent", { posId: tracked.id, ts: nowMs(), kind: "RECONCILE", detail: { result: "uncertain", why } });
        tg(`[RISK OBSERVER — ${context.name}]\nReconciliation uncertain: ${why}.\nObserver metrics for this position are PARTIAL; trading is unaffected.`);
    }
    async function syncPosition() {
        const live = liveIdentity();
        if (tracked) {
            const raw = tracked.metrics.raw, diff = live ? identityDiff({ side: raw.side, entryPrice: raw.entryPrice, tradeId: raw.tradeId, perPoint: raw.perPoint }, live) : "closed";
            if (diff !== null) await closeTracking(live ? `position replaced (${diff})` : "position closed");
        }
        if (!tracked && live) await openTracking(live, true, null);
    }

    // ── 1H trend authority: the strategy's own calculation, reproduced read-only ──
    // createDsbDualStrategy: haCandles = toHA(rawCandles) (ONE conversion, honouring the process HA switches), then
    // haCandles.slice(-MAX_CANDLES) feeds both steppers. Same here — and the already-HA bars are NOT converted again.
    function trend1h() {
        const raw = candles.getRawCandles ? candles.getRawCandles() : [];
        if (!raw || raw.length < 3) return { c1: "none", c2: "none", dir: "NONE", agree: false, lastTs: null };
        const { toHA } = require("../indicators");
        const ha = toHA(raw).slice(-engineConfig.MAX_CANDLES).map((k, i) => ({ ...k, ts: new Date(k.date).getTime() || i }));
        const rows = replayHa(ha, step1, step2), r = rows[rows.length - 1];
        const agree = r.c1 === r.c2 && r.c1 !== "none";
        return { c1: r.c1, c2: r.c2, agree, dir: agree ? (r.c1 === "green" ? "LONG" : "SHORT") : (r.c1 === "none" || r.c2 === "none" ? "NONE" : "DISAGREE"), lastTs: new Date(raw[raw.length - 1].date).getTime() || null };
    }

    // ── live price (WebSocket) health — separate from the REST candle health ──
    function ltpHealth(t, open) {
        const staleAfterMs = cfg.ltpStaleSeconds * 1000;
        if (!open) return { status: "CLOSED", ageMs: lastPriceAt === null ? null : t - lastPriceAt, lastAt: lastPriceAt, staleAfterMs };
        if (lastPriceAt === null) return { status: "NONE", ageMs: null, lastAt: null, staleAfterMs };
        const ageMs = t - lastPriceAt;
        return { status: ageMs > staleAfterMs ? "STALE" : "HEALTHY", ageMs, lastAt: lastPriceAt, staleAfterMs };
    }

    function transitionMessage(t, snap, tr, obs, rel) {
        const lines = [`[RISK OBSERVER — ${context.name}]`, "", `State: ${t.to}${t.skippedWatch ? " (direct escalation — WATCH skipped)" : ""}`, `Position: ${tracked.metrics.raw.side}`, `1H Dual DSB: ${tr.dir}`];
        if (obs) lines.push(`15M DSB 1: ${obs.c1 === "green" ? "LONG" : obs.c1 === "red" ? "SHORT" : "-"}`, `15M DSB 2: ${obs.c2 === "green" ? "LONG" : obs.c2 === "red" ? "SHORT" : "-"}`, `15M Dual DSB: ${rel === "aligned" ? "aligned with position" : rel === "opposite" ? "agree AGAINST position" : rel === "disagree" ? "Disagree" : "undecided"}`);
        if (t.reasons && t.reasons.length) lines.push(`Reason: ${t.reasons.join("; ")}`);
        lines.push(`Adverse movement: ${fx(snap.currentAdversePts)} pts`, `ATR ratio: ${fx(snap.atrRatio)}`, `MFE: ${fx(snap.mfePts)} pts`, `MAE: ${fx(snap.maePts)} pts`);
        if (snap.coverage && snap.coverage.live === "PARTIAL") lines.push("Note: live metrics are PARTIAL (see dashboard)");
        lines.push(t.to === "DANGER" || t.to === "WATCH" ? "Action: HOLD — observation only" : t.to === "RECOVERY" ? "Adverse conditions easing — still observing" : "Observer back to NORMAL");
        return lines.join("\n");
    }
    async function dimensionEvents() {
        if (health.status !== lastRestKey) {
            const prev = lastRestKey; lastRestKey = health.status;
            await st("addEvent", { posId: tracked ? tracked.id : null, ts: nowMs(), kind: "HEALTH", from: prev, to: health.status, detail: { dimension: "REST 15m candles", reason: health.reason } });
            tg(health.status === "HEALTHY" ? `[RISK OBSERVER — ${context.name}]\nObserver health: HEALTHY again (was ${prev}).` : `[RISK OBSERVER — ${context.name}]\nObserver 15m candle feed health: ${health.status}${health.reason ? ` (${health.reason})` : ""}\nRisk state is frozen while data is unreliable. Trading is unaffected.`);
        }
        if (lastLtpKey === null) { lastLtpKey = ltp.status; return; }
        if (ltp.status !== lastLtpKey) {
            const prev = lastLtpKey; lastLtpKey = ltp.status;
            if (tracked && ltp.status !== "CLOSED" && prev !== "CLOSED") {
                await st("addEvent", { posId: tracked.id, ts: nowMs(), kind: "HEALTH", from: prev, to: ltp.status, detail: { dimension: "live price (LTP)", ageMs: ltp.ageMs } });
                tg(ltp.status === "HEALTHY" ? `[RISK OBSERVER — ${context.name}]\nLive price (LTP) HEALTHY again (was ${prev}). Risk classification resumed.` : `[RISK OBSERVER — ${context.name}]\nLive price (LTP) health: ${ltp.status}${ltp.ageMs !== null ? ` (last tick ${Math.round(ltp.ageMs / 1000)}s ago)` : " (no tick received since startup)"}\nRisk state is frozen (shown UNKNOWN) until fresh prices resume. Trading is unaffected.`);
            }
        }
    }

    // ── one evaluation ──────────────────────────────────────────────────────
    async function evaluate() {
        if (busy) return; busy = true;
        try {
            const t = nowMs(), dt = lastEvalAt === null ? 0 : Math.min(120, (t - lastEvalAt) / 1000);
            lastEvalAt = t;
            await syncPosition();

            const res = await feed.poll();    // one request only when the newest candle is late or an internal gap needs backfill
            if (res.candles && res.candles.length) for (const cd of res.candles) await st("markCandle", { ...cd });   // restart-safe de-duplication record
            if (tracked) {                    // candle excursions from every completed candle since entry (also covers time the engine was down)
                const e = tracked.metrics.raw.entryTs;
                for (const cd of monitor.candles()) if (cd.ts >= e && (tracked.metrics.raw.lastCandleTs === null || cd.ts > tracked.metrics.raw.lastCandleTs)) tracked.metrics.onCandle(cd);
            }
            const open = marketOpen(new Date(t));
            health = feed.health(open);
            const prevLtp = ltp.status; ltp = ltpHealth(t, open);
            if (tracked && prevLtp !== "STALE" && ltp.status === "STALE") tracked.metrics.markLiveGap();   // live observation interrupted

            const tr = trend1h();
            const last = monitor.latest(), dis = monitor.disagreement();
            const atrVal = monitor.size() > (engineConfig.ST_ATR_LEN || 10) ? atr(monitor.candles(), engineConfig.ST_ATR_LEN || 10) : null;
            const side = tracked ? tracked.metrics.raw.side : null;
            const rel = side && last ? relation(side, last.c1, last.c2) : null;

            const restOk = health.status === "HEALTHY", ltpOk = ltp.status === "HEALTHY";
            const canClassify = restOk && ltpOk;
            const displayUnknown = !!tracked && (!restOk || (open && !ltpOk));
            let snap = null, riskState = tracked ? machine.state : "NORMAL";
            if (tracked) {
                tracked.metrics.addStateTime(machine.state, dt);
                snap = tracked.metrics.snapshot();
                snap.atrRatio = atrVal && atrVal > 0 ? snap.currentAdversePts / atrVal : null;
                snap.priceStale = !ltpOk;
                // Never classify on stale / missing data, and never on an old LTP: the machine freezes (last known state kept)
                if (canClassify && snap.atrRatio !== null && snap.lastPrice !== null) {
                    const inputs = { adverseAtr: snap.atrRatio, adverseCandles: snap.adverseCandles, disagreeCandles: dis.candles, oppositeAgree: rel === "opposite" };
                    const out = stepMachine(machine, inputs, cfg);
                    machine = out.machine;
                    if (out.transition) {
                        const tx = out.transition;
                        lastTransition = { ...tx, ts: t };
                        await st("addEvent", { posId: tracked.id, ts: t, kind: "STATE", from: tx.from, to: tx.to, detail: { reasons: tx.reasons, skippedWatch: tx.skippedWatch, skipped: tx.skipped, inputs: tx.inputs, confirmations: tx.confirmations, atr15: atrVal, rel, mae: snap.maePts, mfe: snap.mfePts, adversePts: snap.currentAdversePts, pnl: snap.pnl, peakPnl: snap.peakPnl, giveback: snap.giveback, maxGiveback: snap.maxGiveback, trend1h: tr.dir, obs15: last ? { c1: last.c1, c2: last.c2 } : null, coverage: snap.coverage } });
                        await st("updatePosition", tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() });
                        tg(transitionMessage(tx, snap, tr, last, rel));
                    }
                }
                riskState = machine.state;
            }
            // timeline: record every change of the 1H / 15M DSB picture while a position is observed (only on reliable candle data)
            if (tracked && restOk) {
                const key = `${tr.dir}|${tr.c1}|${tr.c2}|${last ? last.c1 : "-"}|${last ? last.c2 : "-"}|${rel}`;
                if (key !== tracked.lastDsbKey) {
                    tracked.lastDsbKey = key;
                    await st("addEvent", { posId: tracked.id, ts: t, kind: "DSB", detail: { trend1h: { c1: tr.c1, c2: tr.c2, dir: tr.dir }, obs15: last ? { c1: last.c1, c2: last.c2, relation: rel, disagreeCandles: dis.candles } : null } });
                }
            }
            await dimensionEvents();
            if (tracked && tracked.id != null && t - lastPersistAt > 10000) { lastPersistAt = t; await st("updatePosition", tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() }); }
            publish({ tr, last, dis, rel, atrVal, snap, riskState, displayUnknown, side, open }, t);
        } finally { busy = false; }
    }

    // overall observer health = the worst of REST candles, live price (only while the market is open and a position is observed), start-up and storage
    function overall(open) {
        if (initState === "failed" || health.status === "ERROR") return "ERROR";
        if (health.status !== "HEALTHY" || (open && tracked && ltp.status !== "HEALTHY")) return "STALE";
        return "HEALTHY";
    }
    function publish(x, t) {
        const m = x.snap, gd = feed.diagnostics();
        latestSnapshot = {
            mode: "SHADOW — observation only", storeFile: store.file ? require("path").basename(store.file) : null, ts: t, instrument: context.name, tgPrefix: context.tgPrefix, strategy: context.strategy, timeframe: context.timeframe,
            position: state.position || null, entryPrice: state.position ? Number(state.entryPrice) : null, pnl: m && !m.priceStale ? m.pnl : null, pnlStale: !!(m && m.priceStale),
            trend1h: x.tr,
            obs15: { c1: x.last ? x.last.c1 : "none", c2: x.last ? x.last.c2 : "none", relation: x.rel, agree: x.last ? x.last.c1 === x.last.c2 && x.last.c1 !== "none" : false, disagreeCandles: x.dis.candles, disagreeMs: x.dis.durationMs, lastCandleTs: monitor.lastTs(), steps: [step1, step2] },
            riskState: x.displayUnknown ? "UNKNOWN" : x.riskState, lastKnownRiskState: x.riskState, riskReliable: !x.displayUnknown,
            health, restHealth: health, ltpHealth: ltp, candleDiagnostics: gd, overallHealth: overall(x.open),
            init: { state: initState, error: initError, failures: initFailures }, storeHealth: { errors: storeErrors, lastError: lastStoreError },
            reconcileNote, lastTransition,
            metrics: m ? { ...m, atr15: x.atrVal, atrRatio: m.atrRatio } : null,
            freshness: { last15mCandleTs: monitor.lastTs(), last15mFetchOkAt: feed.info().lastOkAt, last1hCandleTs: x.tr.lastTs, lastRuntimeEventAt, lastPriceAt, ltpAgeMs: ltp.ageMs },
            params: cfg,
        };
        if (t - lastSnapEmitAt >= 4000 || x.force) { lastSnapEmitAt = t; emit(context.tgPrefix, "RISKOBS", { snapshot: latestSnapshot }); }
    }
    function publishInitFailure() {
        const t = nowMs();
        latestSnapshot = { mode: "SHADOW — observation only", storeFile: store.file ? require("path").basename(store.file) : null, ts: t, instrument: context.name, tgPrefix: context.tgPrefix, strategy: context.strategy, timeframe: context.timeframe,
            position: state.position || null, entryPrice: state.position ? Number(state.entryPrice) : null, pnl: null, trend1h: { c1: "none", c2: "none", dir: "NONE", agree: false, lastTs: null }, obs15: { c1: "none", c2: "none", relation: null, agree: false, disagreeCandles: 0, disagreeMs: 0, lastCandleTs: null, steps: [step1, step2] },
            riskState: "UNKNOWN", lastKnownRiskState: "NORMAL", riskReliable: false, health: { status: "ERROR", reason: `observer initialisation failed: ${initError}` }, restHealth: { status: "ERROR", reason: `observer initialisation failed: ${initError}` }, ltpHealth: ltp, candleDiagnostics: feed.diagnostics(),
            init: { state: initState, error: initError, failures: initFailures }, storeHealth: { errors: storeErrors, lastError: lastStoreError }, reconcileNote, lastTransition, metrics: null,
            freshness: { last15mCandleTs: monitor.lastTs(), last15mFetchOkAt: null, last1hCandleTs: null, lastRuntimeEventAt, lastPriceAt, ltpAgeMs: null }, params: cfg };
        emit(context.tgPrefix, "RISKOBS", { snapshot: latestSnapshot });
    }

    // ── lifecycle: recoverable start, no duplicate timers ───────────────────
    function clearRetry() { if (retryTimer) { timers.clearTimeout(retryTimer); retryTimer = null; } }
    async function start() {
        try {
            if (initState === "running" || initState === "starting") return;
            clearRetry(); initState = "starting";
            strictStore = true;
            try {
                await reconcileInner();
                strictStore = false;
                await evaluate();
            } catch (err) {
                strictStore = false;
                // contained: nothing half-initialised survives, and tracking is dropped so a retry reconciles from scratch
                tracked = null; machine = newMachine();
                throw err;
            }
            if (!evalTimer) { evalTimer = timers.setInterval(() => { evaluate().catch(() => {}); }, Math.max(5, cfg.evalSeconds) * 1000); if (evalTimer && evalTimer.unref) evalTimer.unref(); }
            initState = "running"; initError = null;
        } catch (err) {
            strictStore = false;
            initState = "failed"; initFailures++; initError = err && err.message ? err.message : String(err);
            try { log(`risk observer START FAILED (attempt ${initFailures}): ${initError} — retrying in ${cfg.startRetrySeconds}s; trading is unaffected`); } catch { /* ignore */ }
            try { publishInitFailure(); } catch { /* ignore */ }
            clearRetry();
            retryTimer = timers.setTimeout(() => { retryTimer = null; return start().catch(() => {}); }, Math.max(1, cfg.startRetrySeconds) * 1000);
            if (retryTimer && retryTimer.unref) retryTimer.unref();
        }
    }
    async function stop() {
        try {
            clearRetry();
            if (evalTimer) { timers.clearInterval(evalTimer); evalTimer = null; }
            initState = "idle";
            if (tracked && tracked.id != null) await st("updatePosition", tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() });
        } catch { /* contained */ }
    }
    const onTick = price => {
        try {
            if (!Number.isFinite(price)) return;
            lastPriceAt = nowMs(); lastRuntimeEventAt = lastPriceAt;
            if (tracked) tracked.metrics.onPrice(price);
        } catch { /* never reach the trading loop */ }
    };

    return {
        start, stop, onTick, evaluate: safe(evaluate), reconcile: async () => { strictStore = false; return safe(reconcileInner)(); }, snapshot: () => latestSnapshot,
        _internals: { monitor, feed, get tracked() { return tracked; }, get machine() { return machine; }, get health() { return health; }, get ltp() { return ltp; }, get initState() { return initState; }, get initFailures() { return initFailures; }, timerCount: () => (evalTimer ? 1 : 0) + (retryTimer ? 1 : 0), get storeErrors() { return storeErrors; } },
    };
}

module.exports = { createRiskObserver, resolveParams, CFG_KEYS };
