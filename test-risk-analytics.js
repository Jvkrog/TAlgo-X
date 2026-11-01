// test-risk-analytics.js — analytics + threshold-evaluation tests (pure, deterministic). Run: node test-risk-analytics.js
"use strict";
const assert = require("assert");
const engineConfig = { ...require("./engineConfig") };
const { resolveParams } = require("./riskObserver/observer");
const { summarize, summarisePosition } = require("./riskObserver/analytics");
const { evaluate, replayPosition, configGrid, formatReport } = require("./riskObserver/calibrate");
const base = resolveParams(engineConfig, {}); Object.freeze(base);
let passed = 0; const t = async (n, f) => { await f(); passed++; console.log("ok  -", n); };
const TF = 900000, T0 = Date.UTC(2026, 9, 28, 4, 0);

let eid = 0;
const ev = (posId, ts, kind, from, to, detail) => ({ id: ++eid, posId, ts, kind, from, to, detail });
const pos = (id, o = {}) => ({ id, side: "SHORT", entryPrice: 100, entryTs: T0, openedAt: T0, closedAt: T0 + 3600000, closeNote: "position closed", reconciled: true, metrics: { candleMae: 3, candleMfe: 1, liveMae: 4, liveMfe: 2, peakPnl: 2000, maxGiveback: 5000, liveGaps: 0, partial: false, stateSecs: { NORMAL: 1000, WATCH: 500, DANGER: 300, RECOVERY: 200 } }, ...o });
const st = (posId, ts, from, to, d = {}) => ev(posId, ts, "STATE", from, to, { reasons: ["r"], inputs: { adverseAtr: 1.5, adverseCandles: 1, disagreeCandles: 0, oppositeAgree: false }, mae: 2, adversePts: 2, giveback: 1000, skippedWatch: false, ...d });
const dsb = (posId, ts, dir, rel) => ev(posId, ts, "DSB", null, null, { trend1h: { c1: "red", c2: "red", dir }, obs15: { c1: "green", c2: "green", relation: rel, disagreeCandles: 0 } });

(async () => {
    await t("summary: WATCH/DANGER/RECOVERY counts, rates and per-position timeline; partial positions excluded and labelled", async () => {
        const events = [
            st(1, T0 + 1e5, "NORMAL", "WATCH"), st(1, T0 + 2e5, "WATCH", "DANGER", { mae: 3.5, inputs: { adverseAtr: 2.2, adverseCandles: 2, disagreeCandles: 0, oppositeAgree: false }, giveback: 4000 }), st(1, T0 + 3e5, "DANGER", "RECOVERY"),
            ev(1, T0 + 3.5e6, "POSITION_CLOSE", null, null, { peakPnl: 2000, maxGiveback: 5000, stateSecs: { NORMAL: 1000, WATCH: 500, DANGER: 300, RECOVERY: 200 } }),
            st(2, T0 + 1e5, "NORMAL", "DANGER", { skippedWatch: true }),   // direct escalation
            st(3, T0 + 1e5, "NORMAL", "WATCH"),                            // belongs to a PARTIAL position
        ];
        const history = { positions: [pos(1), pos(2, { metrics: { ...pos(1).metrics, candleMae: 6, liveMae: 7 } }), pos(3, { reconciled: false })], events, candles: [] };
        const s = summarize(history, { nowMs: T0 + 9e6 });
        assert.strictEqual(s.sample.positions, 3); assert.strictEqual(s.sample.fullyObserved, 2); assert.strictEqual(s.sample.incomplete, 1);
        assert.strictEqual(s.counts.enteredWatch, 1, "partial position's WATCH must not be counted"); assert.strictEqual(s.counts.enteredDanger, 2);
        assert.strictEqual(s.counts.watchToDanger, 1); assert.strictEqual(s.counts.directDanger, 1); assert.strictEqual(s.counts.dangerToRecovery, 1);
        assert.strictEqual(s.rates.watchEscalatedToDanger, 1); assert.strictEqual(s.rates.dangerRecovered, 0.5);
        assert.strictEqual(s.mae.maxPts, 7); assert.strictEqual(s.mfe.maxPts, 2);
        const p1 = s.positions.find(p => p.id === 1); assert.strictEqual(p1.transitions.length, 3); assert.strictEqual(p1.adverseBeforeDangerPts, 3.5); assert.strictEqual(p1.maxGiveback, 5000); assert.strictEqual(p1.dangerRecoveredBeforeClose, true);
        assert.strictEqual(s.positions.find(p => p.id === 3).complete, false); assert(s.positions.find(p => p.id === 3).partialReasons.length);
    });
    await t("summary: small samples are reported as insufficient, never as validated", async () => {
        const s = summarize({ positions: [pos(1)], events: [], candles: [] }, { nowMs: T0 + 9e6 });
        assert.strictEqual(s.sample.sufficient, false); assert(s.limitations.some(l => /Only 1 clean \(fully observed\) closed/.test(l)));
        assert(/not evidence that it predicts/.test(s.earlyWarning.note)); assert(!("predictiveValue" in s.earlyWarning));
    });
    await t("summary: empty history is safe", async () => {
        const s = summarize({ positions: [], events: [], candles: [] }); assert.strictEqual(s.sample.positions, 0); assert.strictEqual(s.mae.avgPts, null); assert.strictEqual(s.rates.dangerRecovered, null);
    });
    // ── Finding D: DSB interval censoring ──
    const hl = (posId, ts, dim, from, to) => ev(posId, ts, "HEALTH", from, to, { dim });
    const okAt = (posId, ts) => [hl(posId, ts, "rest", null, "HEALTHY"), hl(posId, ts, "ltp", null, "HEALTHY")];
    const closeAt = (posId, ts) => ev(posId, ts, "POSITION_CLOSE", null, null, {});
    const P = (o = {}) => pos(1, { closedAt: T0 + 1800000, ...o });
    await t("D: healthy DSB intervals are counted exactly (time-weighted from event timestamps)", async () => {
        const r = summarisePosition(P(), [...okAt(1, T0), dsb(1, T0, "SHORT", "opposite"), dsb(1, T0 + 600000, "SHORT", "disagree"), closeAt(1, T0 + 900000)], T0 + 9e6).dsbRelation;
        assert.strictEqual(r.opposite, 600); assert.strictEqual(r.disagree, 300); assert.strictEqual(r.unknownSecs, 0); assert.strictEqual(r.unobservedSecs, 0);
    });
    await t("D: 1H NOT aligned time is kept out of the aligned/disagree/opposite buckets", async () => {
        const r = summarisePosition(P(), [...okAt(1, T0), dsb(1, T0, "SHORT", "opposite"), dsb(1, T0 + 600000, "LONG", "aligned"), closeAt(1, T0 + 900000)], T0 + 9e6).dsbRelation;
        assert.strictEqual(r.opposite, 600); assert.strictEqual(r.oneHNotAligned, 300); assert.strictEqual(r.aligned, 0);
    });
    await t("D: REST degradation ENDS the reliable interval; the gap is UNKNOWN; recovery starts a NEW interval only with a fresh reading", async () => {
        const r = summarisePosition(P(), [...okAt(1, T0), dsb(1, T0, "SHORT", "opposite"), hl(1, T0 + 300000, "rest", "HEALTHY", "STALE"), hl(1, T0 + 700000, "rest", "STALE", "HEALTHY"), dsb(1, T0 + 700000, "SHORT", "aligned"), closeAt(1, T0 + 1000000)], T0 + 9e6).dsbRelation;
        assert.strictEqual(r.opposite, 300, "old reading must NOT be extended through the degradation"); assert.strictEqual(r.unknownSecs, 400); assert.strictEqual(r.aligned, 300);
    });
    await t("D: recovery WITHOUT a fresh DSB reading does not resurrect the old one", async () => {
        const r = summarisePosition(P(), [...okAt(1, T0), dsb(1, T0, "SHORT", "opposite"), hl(1, T0 + 300000, "rest", "HEALTHY", "STALE"), hl(1, T0 + 600000, "rest", "STALE", "HEALTHY"), closeAt(1, T0 + 900000)], T0 + 9e6).dsbRelation;
        assert.strictEqual(r.opposite, 300); assert.strictEqual(r.unknownSecs, 600);
    });
    await t("D: LTP degradation ends a reliable interval when LTP is required, and not when it is not", async () => {
        const evs = [...okAt(1, T0), dsb(1, T0, "SHORT", "opposite"), hl(1, T0 + 300000, "ltp", "HEALTHY", "STALE"), hl(1, T0 + 600000, "ltp", "STALE", "HEALTHY"), dsb(1, T0 + 600000, "SHORT", "opposite"), closeAt(1, T0 + 900000)];
        const req = summarisePosition(P(), evs, T0 + 9e6, { requireLtp: true }).dsbRelation, nreq = summarisePosition(P(), evs, T0 + 9e6, { requireLtp: false }).dsbRelation;
        assert.strictEqual(req.unknownSecs, 300); assert.strictEqual(req.opposite, 600); assert.strictEqual(nreq.unknownSecs, 0); assert.strictEqual(nreq.opposite, 900);
    });
    await t("D: missing DSB events are not invented (no reading -> everything unknown)", async () => {
        const r = summarisePosition(P(), [...okAt(1, T0), closeAt(1, T0 + 900000)], T0 + 9e6).dsbRelation; assert.strictEqual(r.aligned1hSecs, 0); assert.strictEqual(r.unknownSecs, 900);
    });
    await t("D: unknown initial health (legacy / missing HEALTH events) is not assumed healthy", async () => {
        const r = summarisePosition(P(), [dsb(1, T0, "SHORT", "opposite"), closeAt(1, T0 + 900000)], T0 + 9e6).dsbRelation; assert.strictEqual(r.opposite, 0); assert.strictEqual(r.unknownSecs, 900);
    });
    await t("D: an OPEN position is never extended into the future: only up to what was last observed", async () => {
        const open = P({ closedAt: null, metrics: { ...pos(1).metrics, lastObservedAt: T0 + 400000 } });
        const r = summarisePosition(open, [...okAt(1, T0), dsb(1, T0, "SHORT", "opposite")], T0 + 9e9).dsbRelation;
        assert.strictEqual(r.opposite, 400); assert.strictEqual(r.unknownSecs + r.unobservedSecs, 0);
    });
    await t("D: observer stop/restart: observed until the last heartbeat, then UNOBSERVED offline time, then unknown until a fresh reading", async () => {
        const evs = [...okAt(1, T0), dsb(1, T0, "SHORT", "opposite"), ev(1, T0 + 1000000, "RECONCILE", null, null, { result: "resumed", lastObservedAt: T0 + 300000 }), ...okAt(1, T0 + 1000000), dsb(1, T0 + 1000000, "SHORT", "aligned"), closeAt(1, T0 + 1300000)];
        const r = summarisePosition(P(), evs, T0 + 9e6).dsbRelation;
        assert.strictEqual(r.opposite, 300); assert.strictEqual(r.unobservedSecs, 700); assert.strictEqual(r.aligned, 300);
    });
    await t("D: closed while the observer was offline -> counted only until the last heartbeat, flagged PARTIAL, close time unknown", async () => {
        const evs = [...okAt(1, T0), dsb(1, T0, "SHORT", "opposite"), ev(1, T0 + 5e6, "RECONCILE", null, null, { result: "closed_offline", lastObservedAt: T0 + 200000 })];
        const p = summarisePosition(P({ closedAt: T0 + 5e6 }), evs, T0 + 9e6); assert.strictEqual(p.dsbRelation.opposite, 200); assert.strictEqual(p.complete, false); assert.strictEqual(p.closeTimeKnown, false);
    });
    await t("D: aggregate DSB shares use only reliable aligned time and report unknown / unobserved separately with sample size", async () => {
        const evs = [...okAt(1, T0), dsb(1, T0, "SHORT", "opposite"), hl(1, T0 + 300000, "rest", "HEALTHY", "STALE"), closeAt(1, T0 + 900000)];
        const s = summarize({ positions: [pos(1, { closedAt: T0 + 900000 })], events: evs, candles: [] }, { nowMs: T0 + 9e6 }), r = s.dsbRelationWhile1hAligned;
        assert.strictEqual(r.alignedSecs, 300); assert.strictEqual(r.oppositeShare, 1); assert.strictEqual(r.unknownSecs, 600); assert.strictEqual(r.n, 1); assert.strictEqual(r.reliableShareOfObserved, 300 / 900);
    });
    await t("summary: early-warning section is descriptive (warned vs unwarned MAE side by side with sample sizes)", async () => {
        const events = [st(1, T0 + 1e5, "NORMAL", "WATCH", { mae: 1 })];
        const s = summarize({ positions: [pos(1), pos(2, { metrics: { ...pos(1).metrics, candleMae: 0.5, liveMae: 0.5 } })], events, candles: [] }, { nowMs: T0 + 9e6 });
        assert.strictEqual(s.earlyWarning.warnedPositions, 1); assert.strictEqual(s.earlyWarning.unwarnedPositions, 1); assert.strictEqual(s.earlyWarning.avgFurtherAdverseAfterFirstWarningPts, 3);   // final MAE 4 − 1 at warning
    });

    // ── calibration ──
    const mk = (n, f) => Array.from({ length: n }, (_, i) => { const [o, h, l, c] = f(i); return { ts: T0 + i * TF, open: o, high: h, low: l, close: c }; });
    // flat, then a sustained climb against a SHORT entered at candle 20, then retreat
    const candles = mk(120, i => i < 20 ? [100, 100.3, 99.7, 100] : i < 60 ? [100 + (i - 20) * .3, 100.5 + (i - 20) * .3, 99.9 + (i - 20) * .3, 100.3 + (i - 20) * .3] : [112 - (i - 60) * .3, 112.2 - (i - 60) * .3, 111.5 - (i - 60) * .3, 111.7 - (i - 60) * .3]);
    const histPos = { id: 1, side: "SHORT", entryPrice: 100, entryTs: T0 + 20 * TF, openedAt: T0 + 20 * TF, closedAt: T0 + 100 * TF, closeNote: "closed", reconciled: true, metrics: { liveGaps: 0, partial: false } };
    const hist = { positions: [histPos], events: [], candles };
    await t("calibration: replays recorded candles through the real state machine and reports per-config statistics with limits", async () => {
        const rep = evaluate(hist, { steps: [0.5, 1], base, nowMs: T0 + 200 * TF });
        const d = rep.configurations.find(c => c.name === "defaults").all;
        assert(d.warnings >= 1 && d.dangerEvents >= 1, JSON.stringify(d)); assert(d.avgAdverseAtWarningPts > 0); assert(d.maxAdversePts >= 10);
        assert.strictEqual(rep.sample.sufficient, false); assert(rep.limitations.some(l => /NOT validated/.test(l)));
        assert(rep.configurations.length > 10); assert(/defaults/.test(formatReport(rep)));
    });
    await t("calibration: stricter thresholds never produce more warnings than looser ones (monotonic sanity)", async () => {
        const mkCfg = v => ({ name: "x", cfg: { ...base, watchAdverseAtr: v } });
        const rep = evaluate(hist, { steps: [0.5, 1], base, configs: [mkCfg(0.5), mkCfg(5), mkCfg(50)], nowMs: T0 + 200 * TF });
        const w = rep.configurations.map(c => c.all.warnings); assert(w[0] >= 1); assert(w[2] <= w[0], JSON.stringify(w));
    });
    await t("calibration: no look-ahead — truncating future candles does not change earlier transitions", async () => {
        const { dualReplay } = require("./riskObserver/dsbMonitor");
        const p = { side: "SHORT", entryPrice: 100, entryTs: T0 + 20 * TF, endTs: T0 + 100 * TF };
        const full = replayPosition(p, candles, dualReplay(candles, 0.5, 1), base);
        const cut = candles.slice(0, 50), part = replayPosition({ ...p, endTs: T0 + 50 * TF }, cut, dualReplay(cut, 0.5, 1), base);
        const pick = r => r.transitions.filter(x => x.ts < T0 + 50 * TF).map(x => [x.ts, x.from, x.to]);
        assert.deepStrictEqual(pick(full), pick(part)); assert(part.transitions.length >= 1);
    });
    // ── Finding B: session-aware coverage ──
    const { coverageReport } = require("./riskObserver/coverage");
    const MCX = { startMin: 9 * 60, endMin: 23 * 60 + 30 };
    const IST = 5.5 * 3600000, ist = (y, m, d, hh, mm = 0) => Date.UTC(y, m, d, hh, mm) - IST;
    const dayCandles = (y, m, d) => { const o = []; for (let ts = ist(y, m, d, 9); ts < ist(y, m, d, 23, 30); ts += TF) o.push({ ts, open: 100, high: 100.3, low: 99.7, close: 100 }); return o; };
    const without = (cs, ...tss) => cs.filter(c => !tss.includes(c.ts));
    const bpos = (o = {}) => ({ id: 1, side: "SHORT", entryPrice: 100, entryTs: ist(2026, 9, 27, 10), openedAt: ist(2026, 9, 27, 10), closedAt: ist(2026, 9, 27, 12), closeNote: "closed", reconciled: true, metrics: { liveGaps: 0 }, ...o });   // Tue 27 Oct, 10:00-12:00 IST
    const cal = (positions, candles, o = {}) => evaluate({ positions, events: o.events || [], candles, meta: { session: MCX } }, { steps: [0.5, 1], base, nowMs: ist(2026, 10, 5, 10), includePartial: o.includePartial });
    const tueFull = dayCandles(2026, 9, 27);
    await t("B: a fully covered position is in the clean sample", async () => { const r = cal([bpos()], tueFull); assert.strictEqual(r.sample.positionsUsed, 1); assert.strictEqual(r.sample.excluded.length, 0); });
    await t("B: MISSING FIRST candle after entry -> excluded with the reason", async () => {
        const r = cal([bpos()], without(tueFull, ist(2026, 9, 27, 10))); assert.strictEqual(r.sample.positionsUsed, 0); assert(r.sample.excluded[0].reasons.some(x => /first expected candle/.test(x)), JSON.stringify(r.sample.excluded));
    });
    await t("B: MISSING LAST candle before close -> excluded", async () => {
        const r = cal([bpos()], without(tueFull, ist(2026, 9, 27, 11, 45))); assert.strictEqual(r.sample.positionsUsed, 0); assert(r.sample.excluded[0].reasons.some(x => /last expected candle/.test(x)));
    });
    await t("B: MISSING INTERNAL candles -> excluded", async () => {
        const r = cal([bpos()], without(tueFull, ist(2026, 9, 27, 11), ist(2026, 9, 27, 11, 15))); assert.strictEqual(r.sample.positionsUsed, 0); assert(r.sample.excluded[0].reasons.some(x => /missing inside the window/.test(x)));
    });
    await t("B: a candle gap BEFORE the first recorded candle (history starts after the entry) -> excluded", async () => {
        const r = cal([bpos()], tueFull.filter(c => c.ts >= ist(2026, 9, 27, 11))); assert.strictEqual(r.sample.positionsUsed, 0); assert(r.sample.excluded[0].reasons.some(x => /first expected candle/.test(x)));
    });
    const multi = bpos({ entryTs: ist(2026, 9, 26, 22), openedAt: ist(2026, 9, 26, 22), closedAt: ist(2026, 9, 28, 10) });   // Mon 22:00 -> Wed 10:00, over Tuesday
    const monWed = [...dayCandles(2026, 9, 26), ...dayCandles(2026, 9, 28)];
    await t("B: an ENTIRE missing trading day is NOT assumed to be a holiday -> excluded", async () => {
        const r = cal([multi], monWed); assert.strictEqual(r.sample.positionsUsed, 0); assert(r.sample.excluded[0].reasons.some(x => /no candles at all for session day 2026-10-27 and no closure evidence/.test(x)), JSON.stringify(r.sample.excluded));
    });
    await t("B: the same day WITH recorded closure evidence (confirmed holiday) -> accepted", async () => {
        const evid = [{ id: 1, posId: null, ts: ist(2026, 9, 28, 9), kind: "CLOSURE_EVIDENCE", detail: { type: "closure_day", day: "2026-10-27" } }];
        const r = cal([multi], monWed, { events: evid }); assert.strictEqual(r.sample.positionsUsed, 1, JSON.stringify(r.sample.excluded)); assert.deepStrictEqual(r.sample.evidence.closureDays, ["2026-10-27"]);
    });
    await t("B: weekend and overnight gaps are NOT missing candles", async () => {
        const fri = bpos({ entryTs: ist(2026, 9, 23, 22), openedAt: ist(2026, 9, 23, 22), closedAt: ist(2026, 9, 26, 10) });   // Fri 22:00 -> Mon 10:00
        const r = cal([fri], [...dayCandles(2026, 9, 23), ...dayCandles(2026, 9, 26)]); assert.strictEqual(r.sample.positionsUsed, 1, JSON.stringify(r.sample.excluded));
    });
    await t("B: broker-empty slots count ONLY with recorded evidence", async () => {
        const slot = ist(2026, 9, 27, 11), cs = without(tueFull, slot);
        assert.strictEqual(cal([bpos()], cs).sample.positionsUsed, 0);
        const evid = [{ id: 1, posId: null, ts: ist(2026, 9, 27, 13), kind: "CLOSURE_EVIDENCE", detail: { type: "broker_empty", slotTs: slot } }];
        const r = cal([bpos()], cs, { events: evid }); assert.strictEqual(r.sample.positionsUsed, 1); assert.strictEqual(r.sample.evidence.brokerEmptySlots, 1);
    });
    await t("B: open positions, unknown close time and uncertain entry are excluded from the clean sample", async () => {
        const r = cal([bpos({ id: 1, closedAt: null }), bpos({ id: 2, origin: "uncertain", originNote: "entry unknown" }), bpos({ id: 3 })], tueFull,
            { events: [{ id: 5, posId: 3, ts: ist(2026, 9, 27, 13), kind: "RECONCILE", detail: { result: "closed_offline", lastObservedAt: ist(2026, 9, 27, 11) } }] });
        assert.strictEqual(r.sample.positionsUsed, 0); assert.strictEqual(r.sample.excluded.length, 3);
    });
    await t("B: includePartial adds positions to a SEPARATE labelled exploratory aggregate; the clean sample is unchanged", async () => {
        const cs = without(tueFull, ist(2026, 9, 27, 11)), r = cal([bpos(), bpos({ id: 2 })], cs, { includePartial: true });
        assert.strictEqual(r.sample.positionsUsed, 0); assert.strictEqual(r.sample.partialIncluded, 2); assert(r.sample.partialPositions[0].reasons.length); assert.strictEqual(r.sample.excluded.length, 0);
        assert.strictEqual(r.configurations[0].all.positions, 0); assert.strictEqual(r.configurations[0].partialExploratory.positions, 2); assert(/PARTIAL/.test(r.configurations[0].partialExploratory.label));
    });
    await t("B: coverage module: too-short window, window longer than verifiable, chronological first/last slot maths", async () => {
        assert.strictEqual(coverageReport({ haveTs: [], fromTs: ist(2026, 9, 27, 10, 1), toTs: ist(2026, 9, 27, 10, 14), session: MCX }).expected, 0);
        const c = coverageReport({ haveTs: tueFull.map(x => x.ts), fromTs: ist(2026, 9, 27, 10, 5), toTs: ist(2026, 9, 27, 10, 50), session: MCX });
        assert.strictEqual(c.firstSlot, ist(2026, 9, 27, 10, 15)); assert.strictEqual(c.lastSlot, ist(2026, 9, 27, 10, 30)); assert.strictEqual(c.expected, 2); assert.strictEqual(c.complete, true);
    });
    await t("B: calibration is READ-ONLY — the observer database file is byte-identical after load + evaluate", async () => {
        const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
        const { createSqliteStore } = require("./riskObserver/riskStore"), { loadHistoryReadOnly } = require("./riskObserver/analytics");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-")), file = path.join(dir, "z_riskobs.db"), st = await createSqliteStore(file, { instrument: "Z" });
        for (const c of tueFull) await st.markCandle(c); const id = await st.openPosition({ side: "SHORT", entryPrice: 100, entryTs: ist(2026, 9, 27, 10), openedAt: ist(2026, 9, 27, 10), metrics: {}, reconciled: true, origin: "observed_from_entry" }); await st.closePosition(id, "closed", ist(2026, 9, 27, 12)); await st.close();
        const h = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), before = h();
        const hist = await loadHistoryReadOnly(file); const r = evaluate(hist, { steps: [0.5, 1], base, session: MCX, nowMs: ist(2026, 10, 5, 10) }); assert.strictEqual(r.sample.positionsUsed, 1); assert.strictEqual(h(), before, "database changed");
    });
    await t("calibration: chronological split and production defaults untouched", async () => {
        const many = Array.from({ length: 5 }, (_, i) => ({ ...histPos, id: i + 1, entryTs: T0 + (20 + i) * TF }));
        const rep = evaluate({ positions: many, events: [], candles }, { steps: [0.5, 1], base, nowMs: T0 + 200 * TF });
        assert.strictEqual(rep.sample.earlier, 3); assert.strictEqual(rep.sample.later, 2);
        const before = JSON.stringify(base); configGrid(base); assert.strictEqual(JSON.stringify(base), before); assert.strictEqual(base.watchAdverseAtr, engineConfig.RISK_OBS_WATCH_ADVERSE_ATR);
    });
    console.log(`\n${passed} analytics scenarios passed`); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
