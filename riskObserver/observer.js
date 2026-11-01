// riskObserver/observer.js — per-instrument Multi-Timeframe Risk Observer (SHADOW / OBSERVATION ONLY).
//
// The 1H Dual DSB (strategies.js createDsbDualStrategy) stays the only trading authority. This observer
//   * READS engine state (state.position, state.entryPrice, the 1H candle buffer, the engine's open-trade record) and never
//     writes to any of it,
//   * has NO reference to orders / slStore / targetStore / positionsClose — it cannot place or change an order,
//   * keeps its own 15m candle feed, its own DSB steppers and its own SQLite file,
//   * reports WATCH / DANGER / RECOVERY as monitoring labels (Telegram + dashboard), never as signals.
// Every public method is contained so an observer failure can never reach the trading loop.
//
// Two independent health dimensions (never confused): REST (15m candle feed: HEALTHY|GAPS|STALE|ERROR, priceMonitor.js) and
// LTP (live WebSocket price: HEALTHY|STALE|NONE|CLOSED, age vs RISK_OBS_LTP_STALE_SECONDS). The risk machine only steps when
// BOTH are healthy; otherwise it freezes (counters untouched), the display shows UNKNOWN, the last known state is kept
// separately, and the elapsed time is booked as UNKNOWN time — never as time in the last known state.
//
// Position origin (what the observer can honestly claim about a position's history):
//   observed_from_entry   — observer was running and saw the instrument flat; the engine's own entry time is within tolerance
//   discovered_after_entry — engine entry time is known but the observer saw the position later (live metrics PARTIAL; candle
//                            metrics rebuilt from recorded candles, FULL only if the recorded candles provably cover entry→now)
//   uncertain             — engine entry metadata missing / inconsistent: BOTH metric families PARTIAL, entry time not trusted
//   (a position restored after an observer restart keeps its original origin; live coverage gains an interruption mark)
"use strict";

const { createDsbMonitor, replayHa, relation } = require("./dsbMonitor");
const { createCandleFeed, sessionFor } = require("./priceMonitor");
const { createPositionMetrics } = require("./riskMetrics");
const { newMachine, step: stepMachine } = require("./riskState");
const { coverageReport, fmt: fmtTs } = require("./coverage");
const { atr } = require("../indicators");
const { createAlertGate } = require("./alerts");

const CFG_KEYS = {
    watchAdverseAtr: "RISK_OBS_WATCH_ADVERSE_ATR", watchDisagreeCandles: "RISK_OBS_WATCH_DISAGREE_CANDLES",
    dangerAdverseAtr: "RISK_OBS_DANGER_ADVERSE_ATR", dangerAdverseCandles: "RISK_OBS_DANGER_ADVERSE_CANDLES",
    dangerOppositeAtr: "RISK_OBS_DANGER_OPPOSITE_ATR", dangerDisagreeCandles: "RISK_OBS_DANGER_DISAGREE_CANDLES",
    escalateConfirm: "RISK_OBS_ESCALATE_CONFIRM", clearConfirm: "RISK_OBS_CLEAR_CONFIRM", normalConfirm: "RISK_OBS_NORMAL_CONFIRM",
    clearAdverseAtr: "RISK_OBS_CLEAR_ADVERSE_ATR", evalSeconds: "RISK_OBS_EVAL_SECONDS", staleGraceSeconds: "RISK_OBS_STALE_GRACE_SECONDS",
    errorAfterFails: "RISK_OBS_ERROR_AFTER_FAILS", ltpStaleSeconds: "RISK_OBS_LTP_STALE_SECONDS", backfillTries: "RISK_OBS_BACKFILL_TRIES",
    startRetrySeconds: "RISK_OBS_START_RETRY_SECONDS", sessionStartMin: "RISK_OBS_SESSION_START_MIN", sessionEndMin: "RISK_OBS_SESSION_END_MIN",
    entryToleranceSeconds: "RISK_OBS_ENTRY_TOLERANCE_SECONDS",
};
// engineConfig defaults + per-instrument overrides (RISK_OBS_PARAMS_OVERRIDE JSON, keys as in CFG_KEYS)
function resolveParams(engineConfig, overrides) {
    const p = {};
    for (const [k, ek] of Object.entries(CFG_KEYS)) p[k] = engineConfig[ek];
    for (const [k, v] of Object.entries(overrides || {})) if (k in CFG_KEYS && v !== null && Number.isFinite(Number(v)) && Number(v) >= 0) p[k] = Number(v);
    return p;
}

const fx = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : Number(v).toFixed(d));
const fmtDur = ms => (ms < 90000 ? Math.round(ms / 1000) + "s" : ms < 5400000 ? Math.round(ms / 60000) + "m" : (ms / 3600000).toFixed(1) + "h");
const ACCOUNTING_CAP_SECS = 120;   // longest single interval credited to a state; anything beyond is booked as UNOBSERVED

function createRiskObserver({ context, engineConfig, state, candles, store, tg: tgSend = () => {}, emit: emitRaw = () => {}, clock = { now: () => Date.now() }, fetchRaw, params, marketOpen = () => true, log = () => {},
    timers = { setInterval, clearInterval, setTimeout, clearTimeout }, getEntryMeta = async () => null }) {
    const cfg = params;
    // dashboard / Telegram failures (disconnected WebSocket, bad token) must never reach the evaluation or the trading loop
    // Alert gate: identical alerts are de-duplicated and bursts are rate-limited (one summary when the window ends); failures are contained.
    const gate = createAlertGate({ send: tgSend, now: () => clock.now() });
    const tg = (text, opts) => { try { gate(text, opts); } catch { /* ignore */ } };
    let lastEvalMs = null, startedAt = null;
    const emit = (...a) => { try { emitRaw(...a); } catch { /* ignore */ } };
    const tfMs = 15 * 60000;
    const step1 = context.bandStep ?? engineConfig.BAND_STEP_DEFAULT, step2 = context.bandStep2 ?? engineConfig.BAND_STEP2_DEFAULT;
    const monitor = createDsbMonitor({ step1, step2, tfMs });
    const session = sessionFor(context.exchange, { sessionStartMin: cfg.sessionStartMin, sessionEndMin: cfg.sessionEndMin });
    const feed = createCandleFeed({
        fetchRaw, monitor, tfMs, now: () => clock.now(), staleGraceMs: cfg.staleGraceSeconds * 1000, errorAfterFails: cfg.errorAfterFails,
        session, maxBackfillTries: cfg.backfillTries || 3,
    });
    const perPoint = () => (Number(context.lotMult) || 1) * (Number(context.lots) || 1);
    const nowMs = () => clock.now();

    let tracked = null;            // { id, metrics, openedAt, origin, entryTsSource, originNote, lastAccountedAt, prevCause, hk, lastDsbKey }
    let machine = newMachine();
    let lastSnapEmitAt = 0, lastPersistAt = 0, lastRuntimeEventAt = null, lastPriceAt = null, lastFlatAt = null;
    let health = { status: "STALE", reason: "starting" };                          // REST (15m candle feed)
    let ltp = { status: "NONE", ageMs: null, lastAt: null, staleAfterMs: cfg.ltpStaleSeconds * 1000 };   // live price
    let reconcileNote = null, lastTransition = null, latestSnapshot = null, lastCause = null;
    let busy = false, initState = "idle", initError = null, initFailures = 0;
    let evalTimer = null, retryTimer = null;
    let storeErrors = 0, lastStoreError = null, strictStore = false;
    let lastRestKey = "HEALTHY", lastGapSig = "0", lastBackfillLogged = null;
    const loggedClosures = new Set(), loggedEmpty = new Set();

    // Persistence is best-effort at runtime (a failed SQLite write must never interrupt anything); during start() it is
    // strict so that a failure makes the start fail and be retried instead of running on half-initialised state.
    async function st(op, ...args) {
        try { return await store[op](...args); }
        catch (err) { storeErrors++; lastStoreError = err && err.message ? err.message : String(err); if (strictStore) throw err; try { log(`risk observer store ${op} failed: ${lastStoreError}`); } catch { /* ignore */ } return undefined; }
    }
    const safe = fn => async (...a) => { try { return await fn(...a); } catch (err) { try { log(`risk observer error: ${err && err.message ? err.message : err}`); } catch { /* ignore */ } } };
    const ev = (kind, detail, extra = {}) => st("addEvent", { posId: tracked ? tracked.id : null, ts: nowMs(), kind, detail, ...extra });

    // ── position identity / origin / reconciliation ────────────────────────
    const liveIdentity = () => (state.position ? { side: state.position, entryPrice: Number(state.entryPrice), tradeId: state.openTradeId ?? null, perPoint: perPoint() } : null);
    function identityDiff(row, live) {   // null when the same position, else a reason string
        if (!row || !live) return "no position on one side";
        if (row.side !== live.side) return `side ${row.side} vs ${live.side}`;
        const tol = Math.max(1e-6, (Number(context.tickSize) || 0.05) * 2);
        if (!(Math.abs(row.entryPrice - live.entryPrice) <= tol)) return `entry ${fx(row.entryPrice)} vs ${fx(live.entryPrice)}`;
        if (row.tradeId !== null && row.tradeId !== undefined && live.tradeId !== null && row.tradeId !== live.tradeId) return `trade id ${row.tradeId} vs ${live.tradeId}`;
        if (row.perPoint !== undefined && row.perPoint !== null && Math.abs(row.perPoint - live.perPoint) > 1e-9) return `position size changed (₹/pt ${row.perPoint} vs ${live.perPoint}) — quantity change or partial close; rupee metrics are not comparable`;
        return null;
    }
    function newTracked(id, metrics, extra) { return { id: id ?? null, metrics, openedAt: nowMs(), lastAccountedAt: nowMs(), prevCause: null, hk: { rest: null, ltp: null }, lastDsbKey: null, origin: null, entryTsSource: null, originNote: null, ...extra }; }

    // Adopt a position the engine holds but the observer has no valid record of. Decides the origin from the ENGINE's own
    // trade record (entry time) — never from the moment the observer happened to notice the position.
    async function adopt(live, why) {
        let meta = null, metaErr = null;
        try { meta = await getEntryMeta(); } catch (err) { metaErr = err && err.message ? err.message : String(err); }
        const t = nowMs(), tol = cfg.entryToleranceSeconds * 1000;
        const sideOk = meta && (!meta.side || String(meta.side).toUpperCase() === live.side);
        const idOk = meta && (meta.tradeId == null || live.tradeId == null || Number(meta.tradeId) === Number(live.tradeId));
        const metaOk = !!(meta && Number.isFinite(meta.entryTs) && sideOk && idOk);
        let origin, entryTs, src, note = null;
        if (!metaOk) {
            origin = "uncertain"; entryTs = t; src = "observer-discovery-time";
            note = metaErr ? `engine entry metadata unreadable (${metaErr})` : !meta ? "engine entry metadata unavailable" : "engine trade record does not match the live position (trade id / side)";
            note += " — the real entry time is NOT known; candle and live metrics are PARTIAL";
        } else if (lastFlatAt !== null && lastFlatAt > meta.entryTs + tol) {
            origin = "uncertain"; entryTs = meta.entryTs; src = "engine-trade-record";
            note = `engine entry time ${fmtTs(meta.entryTs)} conflicts with the observer having seen the instrument flat later (${fmtTs(lastFlatAt)}) — entry metadata is inconsistent; metrics are PARTIAL`;
        } else {
            entryTs = meta.entryTs; src = "engine-trade-record";
            const leadIn = t - entryTs;
            if (lastFlatAt !== null && leadIn <= tol) origin = "observed_from_entry";
            else { origin = "discovered_after_entry"; note = `position entered ${fmtTs(entryTs)}; the observer noticed it ${fmtDur(Math.max(0, leadIn))} later${lastFlatAt === null ? " (it was not watching the instrument before)" : ""} — live prices before ${fmtTs(t)} were not observed (candle metrics are rebuilt from recorded candles where they provably cover the window)`; }
        }
        const metrics = createPositionMetrics({ side: live.side, entryPrice: live.entryPrice, perPoint: live.perPoint, entryTs, tradeId: live.tradeId });
        metrics.setLeadIn(Math.max(0, t - entryTs));
        if (origin === "uncertain") metrics.markPartial(note); else if (origin === "discovered_after_entry") metrics.markLivePartial(note);
        const full = origin === "observed_from_entry";
        const id = await st("openPosition", { side: live.side, entryPrice: live.entryPrice, entryTs, tradeId: live.tradeId, openedAt: t, riskState: "NORMAL", metrics: metrics.persistable(), reconciled: full, origin, entryTsSource: src, originNote: note });
        tracked = newTracked(id, metrics, { origin, entryTsSource: src, originNote: note });
        machine = newMachine();
        await ev("POSITION_OPEN", { side: live.side, entryPrice: live.entryPrice, tradeId: live.tradeId, origin, entryTs, entryTsSource: src, discoveredAt: t, leadInMs: Math.max(0, t - entryTs), note, why: why || null, coverage: full ? "observed from entry" : "PARTIAL" });
        return origin;
    }
    async function closeTracking(note) {
        if (!tracked) return;
        const snap = tracked.metrics.snapshot(), id = tracked.id, finalMetrics = tracked.metrics.persistable();
        tracked = null; const lastState = machine.state; machine = newMachine();
        if (id == null) return;
        await st("updatePosition", id, { riskState: lastState, metrics: finalMetrics });
        await st("addEvent", { posId: id, ts: nowMs(), kind: "POSITION_CLOSE", from: lastState, detail: { note, mae: snap.maePts, mfe: snap.mfePts, maeCandlePts: snap.maeCandlePts, maeLivePts: snap.maeLivePts, mfeCandlePts: snap.mfeCandlePts, mfeLivePts: snap.mfeLivePts, peakPnl: snap.peakPnl, maxGiveback: snap.maxGiveback, stateSecs: snap.stateSecs, durations: snap.durations, coverage: snap.coverage, pnl: snap.pnl, giveback: snap.giveback, entryTs: snap.entryTs } });
        await st("closePosition", id, note, nowMs());
    }
    // startup reconciliation against the engine's (already broker-reconciled) position; strict during start()
    async function reconcileInner() {
        const live = liveIdentity();
        const row = await st("getOpenPosition");
        if (!live && !row) { reconcileNote = null; return; }
        if (!live && row) {
            const lastObs = row.metrics && row.metrics.lastObservedAt ? row.metrics.lastObservedAt : null;
            await st("addEvent", { posId: row.id, ts: nowMs(), kind: "RECONCILE", detail: { result: "closed_offline", lastObservedAt: lastObs, why: "the engine has no position but the observer record is open — it was closed while the observer was offline; the exact close time and the final stretch of price action were NOT observed" } });
            await st("closePosition", row.id, "closed while observer offline (close time unknown)", nowMs());
            reconcileNote = "previous observer position closed while the engine was down — its final stretch was not observed (PARTIAL)";
            return;
        }
        const rowIdent = row ? { side: row.side, entryPrice: row.entryPrice, tradeId: row.tradeId, perPoint: row.metrics && row.metrics.perPoint } : null;
        const diff = row ? identityDiff(rowIdent, live) : "no observer record";
        if (live && row && diff === null) {
            const metrics = createPositionMetrics({ side: live.side, entryPrice: live.entryPrice, perPoint: live.perPoint, entryTs: row.entryTs, tradeId: live.tradeId });
            if (row.metrics) metrics.restore(row.metrics);
            const lastObs = metrics.raw.lastObservedAt;
            metrics.markLiveGap();   // the engine was not observed while it was down: live extremes / peak / giveback have a hole
            tracked = newTracked(row.id, metrics, { origin: row.origin || (row.reconciled ? "observed_from_entry" : "uncertain"), entryTsSource: row.entryTsSource, originNote: row.originNote });
            tracked.openedAt = row.openedAt;
            machine = { ...newMachine(), state: ["NORMAL", "WATCH", "DANGER", "RECOVERY"].includes(row.riskState) ? row.riskState : "NORMAL" };
            await ev("RECONCILE", { result: "resumed", state: machine.state, liveGaps: metrics.raw.liveGaps, lastObservedAt: lastObs, offlineMs: lastObs ? Math.max(0, nowMs() - lastObs) : null, origin: tracked.origin });
            reconcileNote = (tracked.origin !== "observed_from_entry" ? `restored position keeps its origin "${tracked.origin}" (metrics may be PARTIAL)` : null);
            return;
        }
        // live position exists but the observer record is missing or belongs to a DIFFERENT position: never resume it
        if (row) await st("closePosition", row.id, `identity mismatch with live position (${diff})`, nowMs());
        const why = row ? `persisted observer position (${row.side} @ ${fx(row.entryPrice)}) does not match the live ${live.side} @ ${fx(live.entryPrice)} (${diff})` : `live ${live.side} @ ${fx(live.entryPrice)} has no observer record`;
        await adopt(live, why);
        await ev("RECONCILE", { result: row ? "identity_mismatch" : "no_record", why, origin: tracked.origin });
        reconcileNote = `${why} — origin "${tracked.origin}"${tracked.origin === "observed_from_entry" ? "" : ", metrics PARTIAL"}${tracked.originNote ? ": " + tracked.originNote : ""}`;
        if (tracked.origin !== "observed_from_entry") tg(`[RISK OBSERVER — ${context.name}]\nReconciliation: ${why}.\nPosition origin: ${tracked.origin}. Observer metrics for this position are PARTIAL; trading is unaffected.`);
    }
    async function syncPosition() {
        const live = liveIdentity();
        if (tracked) {
            const raw = tracked.metrics.raw, diff = live ? identityDiff({ side: raw.side, entryPrice: raw.entryPrice, tradeId: raw.tradeId, perPoint: raw.perPoint }, live) : "closed";
            if (diff !== null) await closeTracking(live ? `position replaced (${diff})` : "position closed");
        }
        if (!tracked && live) await adopt(live, "position appeared while the observer was running");
        if (!live) lastFlatAt = nowMs();
    }

    // ── 1H trend authority: the strategy's own calculation, reproduced read-only ──
    // createDsbDualStrategy: needs rawCandles.length >= ST_ATR_LEN + 5 (warm-up), then haCandles = toHA(rawCandles)
    // (ONE conversion, honouring the process HA switches) and haCandles.slice(-MAX_CANDLES) feeds both steppers, step1 first.
    // Same here — and the already-HA bars are NOT converted again.
    function trend1h() {
        const raw = candles.getRawCandles ? candles.getRawCandles() : [];
        const warm = (engineConfig.ST_ATR_LEN || 10) + 5;
        if (!raw || raw.length < warm) return { c1: "none", c2: "none", dir: "NONE", agree: false, lastTs: raw && raw.length ? new Date(raw[raw.length - 1].date).getTime() || null : null, warmup: true };
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
        if (snap.coverage && (snap.coverage.live === "PARTIAL" || snap.coverage.candle === "PARTIAL")) lines.push("Note: metrics are PARTIAL (see dashboard)");
        lines.push(t.to === "DANGER" || t.to === "WATCH" ? "Action: HOLD — observation only" : t.to === "RECOVERY" ? "Adverse conditions easing — still observing" : "Observer back to NORMAL");
        return lines.join("\n");
    }

    // REST / LTP health transitions are timeline boundaries. While a position is tracked each dimension is logged per position
    // (first evaluation records the starting status so analytics never has to assume it).
    async function dimensionEvents() {
        let changed = false;
        if (tracked) {
            const hk = tracked.hk;
            if (hk.rest !== health.status) {
                const prev = hk.rest; hk.rest = health.status; changed = true;
                await ev("HEALTH", { dim: "rest", dimension: "REST 15m candles", reason: health.reason }, { from: prev, to: health.status });
                if (prev !== null) tg(health.status === "HEALTHY" ? `[RISK OBSERVER — ${context.name}]\nObserver health: HEALTHY again (was ${prev}).` : `[RISK OBSERVER — ${context.name}]\nObserver 15m candle feed health: ${health.status}${health.reason ? ` (${health.reason})` : ""}\nRisk state is frozen while data is unreliable. Trading is unaffected.`);
            }
            if (hk.ltp !== ltp.status) {
                const prev = hk.ltp; hk.ltp = ltp.status; changed = true;
                await ev("HEALTH", { dim: "ltp", dimension: "live price (LTP)", ageMs: ltp.ageMs }, { from: prev, to: ltp.status });
                if (prev !== null && prev !== "CLOSED" && ltp.status !== "CLOSED") tg(ltp.status === "HEALTHY" ? `[RISK OBSERVER — ${context.name}]\nLive price (LTP) HEALTHY again (was ${prev}). Risk classification resumed.` : `[RISK OBSERVER — ${context.name}]\nLive price (LTP) health: ${ltp.status}${ltp.ageMs !== null ? ` (last tick ${Math.round(ltp.ageMs / 1000)}s ago)` : " (no tick received since startup)"}\nRisk state is frozen (shown UNKNOWN) until fresh prices resume. Trading is unaffected.`);
            }
        } else if (health.status !== lastRestKey) {
            const prev = lastRestKey; lastRestKey = health.status;
            await ev("HEALTH", { dim: "rest", dimension: "REST 15m candles", reason: health.reason }, { from: prev, to: health.status });
        }
        return changed;
    }
    // candle-feed facts worth keeping: gaps (detected / resolved), successful backfills, and the EVIDENCE that lets offline
    // calibration tell a holiday / empty slot from missing data. Deduplicated; nothing is logged per evaluation cycle.
    async function feedEvents() {
        const d = feed.diagnostics(), e = feed.evidence(), info = feed.info();
        const sig = d.missingCount ? `${d.missingCount}|${d.missingRanges[0].from}` : "0";
        if (sig !== lastGapSig) {
            await ev("CANDLE_GAP", { state: d.missingCount ? "detected" : "resolved", missingCount: d.missingCount, ranges: d.missingRanges.slice(0, 5), backfillRequests: d.backfillRequests });
            lastGapSig = sig;
        }
        if (info.lastBackfillOkAt && info.lastBackfillOkAt !== lastBackfillLogged) {
            lastBackfillLogged = info.lastBackfillOkAt;
            await ev("BACKFILL", { added: info.lastBackfillFilled, missingAfter: d.missingCount, at: info.lastBackfillOkAt });
        }
        for (const day of e.closures) if (!loggedClosures.has(day)) { loggedClosures.add(day); await st("addEvent", { posId: null, ts: nowMs(), kind: "CLOSURE_EVIDENCE", detail: { type: "closure_day", day, why: "Kite returned no 15m candles for this whole session day when asked" } }); }
        for (const ts of e.brokerEmpty) if (!loggedEmpty.has(ts)) { loggedEmpty.add(ts); await st("addEvent", { posId: null, ts: nowMs(), kind: "CLOSURE_EVIDENCE", detail: { type: "broker_empty", slotTs: ts, why: `Kite repeatedly returned no candle for this slot (${cfg.backfillTries} tries)` } }); }
        let conflicts = []; try { const r = typeof store.takeConflicts === "function" ? store.takeConflicts() : []; if (r && typeof r.then === "function") r.catch(() => {}); else if (Array.isArray(r)) conflicts = r; } catch { /* best effort */ }
        for (const c of conflicts) await ev("CANDLE_CONFLICT", { ...c, why: "a re-delivered candle differs from the persisted one; the persisted candle was kept (no silent history rewrite)" });
    }

    // ── one evaluation ──────────────────────────────────────────────────────
    async function evaluate() { const t0 = nowMs(); try { return await evaluateCore(); } finally { lastEvalMs = nowMs() - t0; } }
    async function evaluateCore() {
        if (busy) return; busy = true;
        try {
            const t = nowMs();
            await syncPosition();

            const res = await feed.poll();    // one request only when the newest candle is late or an internal gap needs backfill
            if (res.candles && res.candles.length) for (const cd of res.candles) await st("markCandle", { ...cd });   // restart-safe record; never overwrites
            try { await feedEvents(); } catch { /* timeline events are best-effort: they must never stop the risk evaluation */ }
            if (tracked) {                    // candle excursions from every completed candle since the ACTUAL entry (also covers time the engine / observer was down)
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

            if (tracked) {   // does the RECORDED candle history provably cover entry → now? (session-aware; evidence-based)
                const ev0 = feed.evidence();
                const cov = coverageReport({ haveTs: new Set(monitor.candles().map(c => c.ts)), fromTs: tracked.metrics.raw.entryTs, toTs: t, tfMs, session, brokerEmpty: ev0.brokerEmpty, closureDays: ev0.closures });
                tracked.metrics.setCandleCoverage(cov.complete, cov.reasons.join("; "));
            }

            const restOk = health.status === "HEALTHY", ltpOk = ltp.status === "HEALTHY";
            const atrOk = atrVal !== null && atrVal > 0;
            // why (if at all) the inputs the risk machine needs are unreliable right now
            const cause = !open ? "closed" : (!restOk && !ltpOk) ? "both" : !restOk ? "rest" : !ltpOk ? "ltp" : !atrOk ? "history" : null;
            lastCause = cause;
            const canClassify = cause === null;
            const displayUnknown = !!tracked && (!restOk || (open && !ltpOk) || (open && !atrOk));

            let snap = null, riskState = tracked ? machine.state : "NORMAL";
            if (tracked) {
                // Duration accounting AFTER the reliability decision: reliable time goes to the state, everything else is booked apart
                const rawDt = Math.max(0, (t - tracked.lastAccountedAt) / 1000); tracked.lastAccountedAt = t;
                const counted = Math.min(ACCOUNTING_CAP_SECS, rawDt), extra = rawDt - counted, ic = tracked.prevCause !== null ? tracked.prevCause : cause;
                if (ic === null) tracked.metrics.addStateTime(machine.state, counted); else if (ic === "closed") tracked.metrics.addMarketClosedTime(counted); else tracked.metrics.addUnknownTime(ic, counted);
                if (extra > 0) tracked.metrics.addUnknownTime("unobserved", extra);   // evaluation stalled: nobody was watching
                tracked.prevCause = cause;
                tracked.metrics.setLastObserved(t);

                snap = tracked.metrics.snapshot();
                snap.atrRatio = atrOk ? snap.currentAdversePts / atrVal : null;
                snap.priceStale = !ltpOk;
                // Never classify on stale / missing data, and never on an old LTP: the machine freezes (counters untouched, last known state kept)
                if (canClassify && snap.lastPrice !== null) {
                    const inputs = { adverseAtr: snap.atrRatio, adverseCandles: snap.adverseCandles, disagreeCandles: dis.candles, oppositeAgree: rel === "opposite" };
                    const out = stepMachine(machine, inputs, cfg);
                    machine = out.machine;
                    if (out.transition) {
                        const tx = out.transition;
                        lastTransition = { ...tx, ts: t };
                        await ev("STATE", { reasons: tx.reasons, skippedWatch: tx.skippedWatch, skipped: tx.skipped, inputs: tx.inputs, confirmations: tx.confirmations, atr15: atrVal, rel, mae: snap.maePts, mfe: snap.mfePts, adversePts: snap.currentAdversePts, pnl: snap.pnl, peakPnl: snap.peakPnl, giveback: snap.giveback, maxGiveback: snap.maxGiveback, trend1h: tr.dir, obs15: last ? { c1: last.c1, c2: last.c2 } : null, coverage: snap.coverage }, { from: tx.from, to: tx.to, ts: t });
                        await st("updatePosition", tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() });
                        tg(transitionMessage(tx, snap, tr, last, rel));
                    }
                }
                riskState = machine.state;
            }
            const hChanged = await dimensionEvents();
            if (tracked && hChanged) tracked.lastDsbKey = null;   // any health change ends the previous DSB reading's validity: force a fresh reading on the next reliable evaluation
            // timeline: record every change of the 1H / 15M DSB picture while a position is observed (only on reliable candle data)
            if (tracked && restOk) {
                const key = `${tr.dir}|${tr.c1}|${tr.c2}|${last ? last.c1 : "-"}|${last ? last.c2 : "-"}|${rel}`;
                if (key !== tracked.lastDsbKey) {
                    tracked.lastDsbKey = key;
                    await ev("DSB", { trend1h: { c1: tr.c1, c2: tr.c2, dir: tr.dir }, obs15: last ? { c1: last.c1, c2: last.c2, relation: rel, disagreeCandles: dis.candles } : null });
                }
            }
            if (tracked && tracked.id != null && t - lastPersistAt > 10000) { lastPersistAt = t; await st("updatePosition", tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() }); }
            publish({ tr, last, dis, rel, atrVal, snap, riskState, displayUnknown, side, open, cause }, t);
        } finally { busy = false; }
    }

    // overall observer health = the worst of REST candles, live price (only while the market is open and a position is observed), start-up
    function overall(open) {
        if (initState === "failed" || health.status === "ERROR") return "ERROR";
        if (health.status !== "HEALTHY" || (open && tracked && ltp.status !== "HEALTHY")) return "STALE";
        return "HEALTHY";
    }
    function publish(x, t) {
        const m = x.snap, gd = feed.diagnostics(), info = feed.info();
        latestSnapshot = {
            mode: "SHADOW — observation only", storeFile: store.file ? require("path").basename(store.file) : null, ts: t, instrument: context.name, tgPrefix: context.tgPrefix, strategy: context.strategy, timeframe: context.timeframe,
            position: state.position || null, entryPrice: state.position ? Number(state.entryPrice) : null, pnl: m && !m.priceStale ? m.pnl : null, pnlStale: !!(m && m.priceStale),
            lastPrice: m ? m.lastPrice : null, lastPriceAt, lastPriceAgeMs: lastPriceAt === null ? null : t - lastPriceAt,
            entry: tracked ? { origin: tracked.origin, entryTs: tracked.metrics.raw.entryTs, entryTsSource: tracked.entryTsSource, leadInMs: tracked.metrics.raw.leadInMs, note: tracked.originNote, trackedSince: tracked.openedAt } : null,
            trend1h: x.tr,
            obs15: { c1: x.last ? x.last.c1 : "none", c2: x.last ? x.last.c2 : "none", relation: x.rel, agree: x.last ? x.last.c1 === x.last.c2 && x.last.c1 !== "none" : false, disagreeCandles: x.dis.candles, disagreeMs: x.dis.durationMs, lastCandleTs: monitor.lastTs(), steps: [step1, step2] },
            riskState: x.displayUnknown ? "UNKNOWN" : x.riskState, lastKnownRiskState: x.riskState, riskReliable: !x.displayUnknown, unreliableCause: x.cause,
            health, restHealth: health, ltpHealth: ltp, candleDiagnostics: gd, overallHealth: overall(x.open), lastBackfillOkAt: info.lastBackfillOkAt,
            init: { state: initState, error: initError, failures: initFailures }, storeHealth: { errors: storeErrors, lastError: lastStoreError, schemaVersion: store.schemaVersion ?? null },
            runtime: { startedAt, lastEvalMs, alerts: gate.stats() },
            reconcileNote, lastTransition,
            metrics: m ? { ...m, atr15: x.atrVal, atrRatio: m.atrRatio } : null,
            freshness: { last15mCandleTs: monitor.lastTs(), last15mFetchOkAt: info.lastOkAt, last1hCandleTs: x.tr.lastTs, lastRuntimeEventAt, lastPriceAt, ltpAgeMs: ltp.ageMs },
            params: cfg,
        };
        if (t - lastSnapEmitAt >= 4000 || x.force) { lastSnapEmitAt = t; emit(context.tgPrefix, "RISKOBS", { snapshot: latestSnapshot }); }
    }
    function publishInitFailure() {
        const t = nowMs();
        latestSnapshot = { mode: "SHADOW — observation only", storeFile: store.file ? require("path").basename(store.file) : null, ts: t, instrument: context.name, tgPrefix: context.tgPrefix, strategy: context.strategy, timeframe: context.timeframe,
            position: state.position || null, entryPrice: state.position ? Number(state.entryPrice) : null, pnl: null, trend1h: { c1: "none", c2: "none", dir: "NONE", agree: false, lastTs: null }, obs15: { c1: "none", c2: "none", relation: null, agree: false, disagreeCandles: 0, disagreeMs: 0, lastCandleTs: null, steps: [step1, step2] },
            riskState: "UNKNOWN", lastKnownRiskState: "NORMAL", riskReliable: false, overallHealth: "ERROR", health: { status: "ERROR", reason: `observer initialisation failed: ${initError}` }, restHealth: { status: "ERROR", reason: `observer initialisation failed: ${initError}` }, ltpHealth: ltp, candleDiagnostics: feed.diagnostics(),
            init: { state: initState, error: initError, failures: initFailures }, storeHealth: { errors: storeErrors, lastError: lastStoreError, schemaVersion: store.schemaVersion ?? null }, reconcileNote, lastTransition, metrics: null, entry: null,
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
                if (typeof store.setMeta === "function") { await store.setMeta("exchange", context.exchange || "MCX"); await store.setMeta("session", JSON.stringify(session)); await store.setMeta("steps", JSON.stringify([step1, step2])); }
                const evid = typeof store.eventsByKind === "function" ? await store.eventsByKind("CLOSURE_EVIDENCE") : [];   // closure / broker-empty evidence survives restarts
                const closures = [], empties = [];
                for (const e of evid) if (e.detail && e.detail.type === "closure_day" && e.detail.day) closures.push(e.detail.day); else if (e.detail && e.detail.type === "broker_empty" && Number.isFinite(e.detail.slotTs)) empties.push(e.detail.slotTs);
                feed.seed({ closures, brokerEmpty: empties }); closures.forEach(d => loggedClosures.add(d)); empties.forEach(d => loggedEmpty.add(d));
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
            const recovered = initFailures > 0;
            initState = "running"; initError = null; startedAt = nowMs();
            await ev("OBSERVER", { event: recovered ? "recovered" : "started", failedAttempts: initFailures });
        } catch (err) {
            strictStore = false;
            initState = "failed"; initFailures++; initError = err && err.message ? err.message : String(err);
            try { log(`risk observer START FAILED (attempt ${initFailures}): ${initError} — retrying in ${cfg.startRetrySeconds}s; trading is unaffected`); } catch { /* ignore */ }
            try { await st("addEvent", { posId: null, ts: nowMs(), kind: "OBSERVER", detail: { event: "start_failed", attempt: initFailures, error: initError } }); } catch { /* ignore */ }
            try { publishInitFailure(); } catch { /* ignore */ }
            clearRetry();
            retryTimer = timers.setTimeout(() => { retryTimer = null; return start().catch(() => {}); }, Math.max(1, cfg.startRetrySeconds) * 1000);
            if (retryTimer && retryTimer.unref) retryTimer.unref();
        }
    }
    async function stop() {
        try {
            clearRetry();
            const wasRunning = initState === "running";
            if (evalTimer) { timers.clearInterval(evalTimer); evalTimer = null; }
            initState = "idle";
            if (tracked && tracked.id != null) { tracked.metrics.setLastObserved(nowMs()); await st("updatePosition", tracked.id, { riskState: machine.state, metrics: tracked.metrics.persistable() }); }
            if (wasRunning) await ev("OBSERVER", { event: "stopped" });
        } catch { /* contained */ }
    }
    const onTick = price => {
        try {
            if (!Number.isFinite(price)) return;
            lastPriceAt = nowMs(); lastRuntimeEventAt = lastPriceAt;
            if (tracked) tracked.metrics.onPrice(price, lastPriceAt);
        } catch { /* never reach the trading loop */ }
    };

    return {
        start, stop, onTick, evaluate: safe(evaluate), reconcile: async () => { strictStore = false; return safe(reconcileInner)(); }, snapshot: () => latestSnapshot,
        _internals: { monitor, feed, get tracked() { return tracked; }, get machine() { return machine; }, get health() { return health; }, get ltp() { return ltp; }, get cause() { return lastCause; }, get initState() { return initState; }, get initFailures() { return initFailures; }, timerCount: () => (evalTimer ? 1 : 0) + (retryTimer ? 1 : 0), get storeErrors() { return storeErrors; } },
    };
}

module.exports = { createRiskObserver, resolveParams, CFG_KEYS };
