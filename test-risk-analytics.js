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
        assert.strictEqual(s.sample.sufficient, false); assert(s.limitations.some(l => /Only 1 fully observed closed/.test(l)));
        assert(/not evidence that it predicts/.test(s.earlyWarning.note)); assert(!("predictiveValue" in s.earlyWarning));
    });
    await t("summary: empty history is safe", async () => {
        const s = summarize({ positions: [], events: [], candles: [] }); assert.strictEqual(s.sample.positions, 0); assert.strictEqual(s.mae.avgPts, null); assert.strictEqual(s.rates.dangerRecovered, null);
    });
    await t("summary: 15M relation while 1H aligned is time-weighted from DSB events only", async () => {
        const events = [dsb(1, T0, "SHORT", "opposite"), dsb(1, T0 + 600000, "SHORT", "disagree"), dsb(1, T0 + 900000, "LONG", "aligned")];   // last: 1H NOT aligned -> excluded
        const p = summarisePosition(pos(1, { closedAt: T0 + 1800000 }), events, T0 + 9e6);
        assert.strictEqual(p.relWhile1hAligned.opposite, 600); assert.strictEqual(p.relWhile1hAligned.disagree, 300); assert.strictEqual(p.oneHAlignedSecs, 900);
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
    await t("calibration: partial or uncovered positions are excluded (and listed) unless explicitly included", async () => {
        const h2 = { positions: [histPos, { ...histPos, id: 2, reconciled: false }, { ...histPos, id: 3, entryTs: T0 + 500 * TF, closedAt: T0 + 510 * TF }], events: [], candles };
        const rep = evaluate(h2, { steps: [0.5, 1], base, nowMs: T0 + 900 * TF });
        assert.strictEqual(rep.sample.positionsUsed, 1); assert.strictEqual(rep.sample.excluded.length, 2); assert(rep.sample.excluded.every(e => e.reasons.length));
        assert.strictEqual(evaluate(h2, { steps: [0.5, 1], base, includePartial: true, nowMs: T0 + 900 * TF }).sample.positionsUsed >= 2, true);
    });
    await t("calibration: chronological split and production defaults untouched", async () => {
        const many = Array.from({ length: 5 }, (_, i) => ({ ...histPos, id: i + 1, entryTs: T0 + (20 + i) * TF }));
        const rep = evaluate({ positions: many, events: [], candles }, { steps: [0.5, 1], base, nowMs: T0 + 200 * TF });
        assert.strictEqual(rep.sample.earlier, 3); assert.strictEqual(rep.sample.later, 2);
        const before = JSON.stringify(base); configGrid(base); assert.strictEqual(JSON.stringify(base), before); assert.strictEqual(base.watchAdverseAtr, engineConfig.RISK_OBS_WATCH_ADVERSE_ATR);
    });
    console.log(`\n${passed} analytics scenarios passed`); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
