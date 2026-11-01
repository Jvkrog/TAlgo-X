// riskObserver/analytics.js — historical risk analytics over the observer's OWN SQLite history (obs_positions /
// obs_events). Read-only: it never touches the trading database and has no access to any engine object.
//
// It describes what happened; it does NOT claim predictive value. A warning that preceded a loss is not evidence that
// the warning "worked" (the position may have lost anyway, or the move may have come regardless), so the early-warning
// section only reports what followed warnings next to the same figures for positions that never warned, with sample sizes.
"use strict";

const MIN_CLOSED_FULL_SAMPLE = 10;   // below this the aggregates are descriptive only and flagged insufficient

// Read-only load of a *_riskobs.db file (used by the dashboard server and the CLI).
function loadHistoryReadOnly(file) {
    const sqlite3 = require("sqlite3").verbose();
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, err => {
            if (err) return reject(err);
            const q = sql => new Promise((res, rej) => db.all(sql, [], (e, r) => (e ? rej(e) : res(r))));
            Promise.all([q("SELECT * FROM obs_positions ORDER BY id"), q("SELECT * FROM obs_events ORDER BY id"), q("SELECT ts,open,high,low,close FROM obs_candles ORDER BY ts")])
                .then(([p, e, c]) => { db.close(); resolve({
                    positions: p.map(x => ({ id: x.id, side: x.side, entryPrice: x.entry_price, entryTs: x.entry_ts, tradeId: x.trade_id, openedAt: x.opened_at, closedAt: x.closed_at, closeNote: x.close_note, riskState: x.risk_state, metrics: x.metrics ? JSON.parse(x.metrics) : null, reconciled: !!x.reconciled })),
                    events: e.map(x => ({ id: x.id, posId: x.pos_id, ts: x.ts, kind: x.kind, from: x.from_state, to: x.to_state, detail: x.detail ? JSON.parse(x.detail) : null })),
                    candles: c }); })
                .catch(er => { try { db.close(); } catch { /* ignore */ } reject(er); });
        });
    });
}
async function loadHistoryFromStore(store) { return { positions: await store.allPositions(), events: await store.allEvents(), candles: await store.allCandles() }; }

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const max = a => (a.length ? Math.max(...a) : null);
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

// One position's coherent timeline + metrics, built only from recorded facts.
function summarisePosition(pos, evs, nowMs) {
    const mine = evs.filter(e => e.posId === pos.id).sort((a, b) => a.ts - b.ts || a.id - b.id);
    const closeEv = mine.find(e => e.kind === "POSITION_CLOSE");
    const cd = (closeEv && closeEv.detail) || {};
    const m = pos.metrics || {};
    const states = mine.filter(e => e.kind === "STATE");
    const closed = pos.closedAt != null;
    const endTs = closed ? pos.closedAt : nowMs;
    const partialReasons = [];
    if (!pos.reconciled) partialReasons.push("started mid-position or identity could not be reconciled");
    if (mine.some(e => e.kind === "RECONCILE" && e.detail && e.detail.result === "uncertain")) partialReasons.push("reconciliation uncertain");
    if (m.partial) partialReasons.push(m.partialNote || "metrics flagged partial");
    if ((m.liveGaps || 0) > 0) partialReasons.push(`${m.liveGaps} interruption(s) in live price observation`);
    const reached = s => states.some(e => e.to === s);
    const firstOf = s => states.find(e => e.to === s) || null;
    const watch = firstOf("WATCH"), danger = firstOf("DANGER");
    const warn = states.find(e => e.to === "WATCH" || e.to === "DANGER") || null;
    const finalMae = num(Math.max(num(m.candleMae) ?? 0, num(m.liveMae) ?? 0)), finalMfe = num(Math.max(num(m.candleMfe) ?? 0, num(m.liveMfe) ?? 0));
    const stateSecs = cd && cd.stateSecs ? cd.stateSecs : m.stateSecs || null;

    // time-weighted 15M relation while the 1H Dual DSB was aligned with the position (recorded DSB events only)
    const rel = { aligned: 0, disagree: 0, opposite: 0, undecided: 0 }; let oneHAlignedSecs = 0;
    const dsb = mine.filter(e => e.kind === "DSB");
    for (let i = 0; i < dsb.length; i++) {
        const a = dsb[i], b = dsb[i + 1], to = b ? b.ts : endTs, secs = Math.max(0, (to - a.ts) / 1000);
        const aligned1h = a.detail && a.detail.trend1h && a.detail.trend1h.dir === pos.side;
        if (!aligned1h) continue;
        oneHAlignedSecs += secs;
        const r = a.detail.obs15 ? a.detail.obs15.relation : null;
        rel[r in rel ? r : "undecided"] += secs;
    }
    return {
        id: pos.id, side: pos.side, entryPrice: pos.entryPrice, entryTs: pos.entryTs, closedAt: pos.closedAt, closeNote: pos.closeNote, status: closed ? "CLOSED" : "OPEN",
        observedSecs: Math.max(0, (endTs - pos.openedAt) / 1000),
        complete: partialReasons.length === 0, partialReasons,
        maeCandlePts: num(m.candleMae), mfeCandlePts: num(m.candleMfe), maeLivePts: num(m.liveMae), mfeLivePts: num(m.liveMfe), maePts: finalMae, mfePts: finalMfe,
        peakPnl: num(cd.peakPnl) ?? num(m.peakPnl), maxGiveback: num(cd.maxGiveback) ?? num(m.maxGiveback),
        stateSecs,
        visitedWatch: reached("WATCH"), visitedDanger: reached("DANGER"),
        watchToDanger: states.some(e => e.from === "WATCH" && e.to === "DANGER"),
        directDanger: states.some(e => e.to === "DANGER" && e.detail && e.detail.skippedWatch === true),
        dangerToRecovery: states.some(e => e.from === "DANGER" && e.to === "RECOVERY"),
        dangerRecoveredBeforeClose: states.some(e => e.from === "DANGER" && e.to === "RECOVERY") && (states.length ? states[states.length - 1].to !== "DANGER" : false),
        transitions: states.map(e => ({ ts: e.ts, from: e.from, to: e.to, skippedWatch: !!(e.detail && e.detail.skippedWatch), reasons: (e.detail && e.detail.reasons) || [], adverseAtr: e.detail && e.detail.inputs ? num(e.detail.inputs.adverseAtr) : null, adversePts: e.detail ? num(e.detail.adversePts) : null, maeAtTransition: e.detail ? num(e.detail.mae) : null, giveback: e.detail ? num(e.detail.giveback) : null, pnl: e.detail ? num(e.detail.pnl) : null })),
        firstWarning: warn ? { state: warn.to, ts: warn.ts, adversePts: warn.detail ? num(warn.detail.adversePts) : null, adverseAtr: warn.detail && warn.detail.inputs ? num(warn.detail.inputs.adverseAtr) : null, maeAtWarning: warn.detail ? num(warn.detail.mae) : null, giveback: warn.detail ? num(warn.detail.giveback) : null } : null,
        adverseBeforeDangerPts: danger && danger.detail ? num(danger.detail.mae) : null, adverseBeforeDangerAtr: danger && danger.detail && danger.detail.inputs ? num(danger.detail.inputs.adverseAtr) : null,
        givebackAtDanger: danger && danger.detail ? num(danger.detail.giveback) : null,
        oneHAlignedSecs, relWhile1hAligned: rel,
        timeline: mine.map(e => ({ ts: e.ts, kind: e.kind, from: e.from, to: e.to, detail: e.detail })),
    };
}

function summarize(history, { nowMs = Date.now(), minSample = MIN_CLOSED_FULL_SAMPLE } = {}) {
    const positions = history.positions.map(p => summarisePosition(p, history.events, nowMs));
    const closed = positions.filter(p => p.status === "CLOSED"), open = positions.filter(p => p.status === "OPEN");
    const usable = positions.filter(p => p.complete);                    // fully observed (any status)
    const closedFull = closed.filter(p => p.complete);                    // the statistically cleanest sample
    const count = (arr, f) => arr.filter(f).length;
    const warned = usable.filter(p => p.visitedWatch || p.visitedDanger), calm = usable.filter(p => !p.visitedWatch && !p.visitedDanger);
    const dangerSet = usable.filter(p => p.visitedDanger);
    const stateTotals = { NORMAL: 0, WATCH: 0, DANGER: 0, RECOVERY: 0 };
    for (const p of usable) if (p.stateSecs) for (const k of Object.keys(stateTotals)) stateTotals[k] += num(p.stateSecs[k]) || 0;
    const relTot = { aligned: 0, disagree: 0, opposite: 0, undecided: 0 }; let alignedTot = 0;
    for (const p of usable) { alignedTot += p.oneHAlignedSecs; for (const k of Object.keys(relTot)) relTot[k] += p.relWhile1hAligned[k]; }
    const pct = (x, y) => (y > 0 ? x / y : null);

    // early-warning descriptive comparison (NOT a predictive claim)
    const after = warned.map(p => (p.firstWarning && p.firstWarning.maeAtWarning !== null && p.maePts !== null ? p.maePts - p.firstWarning.maeAtWarning : null)).filter(v => v !== null);
    const early = {
        warnedPositions: warned.length, unwarnedPositions: calm.length,
        avgFurtherAdverseAfterFirstWarningPts: avg(after), positionsWithFurtherAdverse: after.filter(v => v > 1e-9).length, positionsMeasured: after.length,
        avgFinalMaeWarned: avg(warned.map(p => p.maePts).filter(v => v !== null)), avgFinalMaeUnwarned: avg(calm.map(p => p.maePts).filter(v => v !== null)),
        note: "Descriptive only. A warning preceding an adverse move is not evidence that it predicts one: the same MAE figures are shown for positions that never warned, the samples are small and not randomised, and no realised P&L is recorded by the observer. Do not treat this as validation.",
    };
    const limitations = [];
    if (closedFull.length < minSample) limitations.push(`Only ${closedFull.length} fully observed closed position(s); at least ${minSample} are needed before aggregates are more than anecdotes.`);
    const incomplete = positions.length - usable.length; if (incomplete) limitations.push(`${incomplete} position(s) excluded from the aggregates because their metrics are PARTIAL (see each position's reasons).`);
    if (open.length) limitations.push(`${open.length} position(s) still open — their figures are provisional.`);
    limitations.push("State times and DSB relations come from observer events only; periods when the observer was down or its data unreliable are not covered.");
    return {
        generatedAt: nowMs, sample: { positions: positions.length, closed: closed.length, open: open.length, fullyObserved: usable.length, closedFullyObserved: closedFull.length, incomplete, sufficient: closedFull.length >= minSample, minSample },
        counts: { enteredWatch: count(usable, p => p.visitedWatch), enteredDanger: count(usable, p => p.visitedDanger), watchToDanger: count(usable, p => p.watchToDanger), directDanger: count(usable, p => p.directDanger), dangerToRecovery: count(usable, p => p.dangerToRecovery), dangerRecoveredBeforeClose: count(usable, p => p.dangerRecoveredBeforeClose) },
        rates: { watchEscalatedToDanger: pct(count(usable, p => p.watchToDanger), count(usable, p => p.visitedWatch)), dangerRecovered: pct(count(usable, p => p.dangerToRecovery), count(usable, p => p.visitedDanger)) },
        mae: { avgPts: avg(usable.map(p => p.maePts).filter(v => v !== null)), maxPts: max(usable.map(p => p.maePts).filter(v => v !== null)) },
        mfe: { avgPts: avg(usable.map(p => p.mfePts).filter(v => v !== null)), maxPts: max(usable.map(p => p.mfePts).filter(v => v !== null)) },
        giveback: { avgMax: avg(usable.map(p => p.maxGiveback).filter(v => v !== null)), max: max(usable.map(p => p.maxGiveback).filter(v => v !== null)), avgAtDanger: avg(dangerSet.map(p => p.givebackAtDanger).filter(v => v !== null)) },
        adverseBeforeDanger: { avgPts: avg(dangerSet.map(p => p.adverseBeforeDangerPts).filter(v => v !== null)), avgAtr: avg(dangerSet.map(p => p.adverseBeforeDangerAtr).filter(v => v !== null)), n: dangerSet.length },
        stateSecs: stateTotals,
        dsbRelationWhile1hAligned: { totalSecs: alignedTot, secs: relTot, disagreeShare: pct(relTot.disagree, alignedTot), oppositeShare: pct(relTot.opposite, alignedTot) },
        earlyWarning: early, limitations, positions,
    };
}

module.exports = { loadHistoryReadOnly, loadHistoryFromStore, summarisePosition, summarize, MIN_CLOSED_FULL_SAMPLE };
