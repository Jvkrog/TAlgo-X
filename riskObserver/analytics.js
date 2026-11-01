// riskObserver/analytics.js — historical risk analytics over the observer's OWN SQLite history (obs_positions /
// obs_events). Read-only: it never touches the trading database and has no access to any engine object.
//
// It describes what happened; it does NOT claim predictive value. A warning that preceded a loss is not evidence that
// the warning "worked", so the early-warning section only reports what followed warnings next to the same figures for
// positions that never warned, with sample sizes. No realised P&L is ever inferred from unrealised observer metrics.
//
// Clean vs partial: a position enters the CLEAN aggregates only when BOTH its candle-derived and live-derived metrics are
// complete (observed from entry, no interruption, recorded candles provably cover it). Everything else is PARTIAL: listed
// with reasons and summarised separately, never mixed into the clean figures. Aggregates use CLOSED positions; open
// positions are provisional and reported apart.
//
// DSB relation time is CENSORED: an interval counts only while the 15M reading is trustworthy (REST healthy and, when
// required, LTP healthy). Health changes, observer stop/restart and offline gaps are explicit boundaries; time after a
// boundary without a fresh reading is UNKNOWN, time nobody observed is UNOBSERVED — neither is ever counted as aligned,
// disagreeing or opposite, and nothing is extended into the future for an open position.
"use strict";

const MIN_CLOSED_FULL_SAMPLE = 10;   // below this the aggregates are descriptive only and flagged insufficient

// Read-only load of a *_riskobs.db file (used by the dashboard server and the CLI). Tolerates older schemas / missing tables.
function loadHistoryReadOnly(file) {
    const sqlite3 = require("sqlite3").verbose();
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, err => {
            if (err) return reject(err);
            let fatal = null;
            const q = (sql, must) => new Promise(res => db.all(sql, [], (e, r) => { if (e && must && !fatal) fatal = e; res(e ? [] : r); }));
            const parse = (s, c) => { if (s === null || s === undefined) return null; try { return JSON.parse(s); } catch { c.corrupt++; return null; } };
            const c = { corrupt: 0 };
            Promise.all([q("SELECT * FROM obs_positions ORDER BY id", true), q("SELECT * FROM obs_events ORDER BY ts, id"), q("SELECT ts,open,high,low,close FROM obs_candles ORDER BY ts"), q("SELECT key,value FROM obs_meta")])
                .then(([p, e, cs, mt]) => {
                    db.close();
                    if (fatal) return reject(fatal);   // unreadable / not an observer database — never present it as "no history"
                    const meta = {}; for (const r of mt) meta[r.key] = r.value;
                    for (const k of ["session", "steps"]) if (meta[k]) { try { meta[k] = JSON.parse(meta[k]); } catch { meta[k] = null; c.corrupt++; } }
                    resolve({
                        meta,
                        positions: p.map(x => ({ id: x.id, side: x.side, entryPrice: x.entry_price, entryTs: x.entry_ts, tradeId: x.trade_id, openedAt: x.opened_at, closedAt: x.closed_at, closeNote: x.close_note, riskState: x.risk_state, metrics: parse(x.metrics, c), reconciled: !!x.reconciled, origin: x.origin ?? null, entryTsSource: x.entry_ts_source ?? null, originNote: x.origin_note ?? null })),
                        events: e.map(x => ({ id: x.id, posId: x.pos_id, ts: x.ts, kind: x.kind, from: x.from_state, to: x.to_state, detail: parse(x.detail, c) })),
                        candles: cs, corruptRows: c.corrupt });
                })
                .catch(er => { try { db.close(); } catch { /* ignore */ } reject(er); });
        });
    });
}
async function loadHistoryFromStore(store) { return { meta: {}, positions: await store.allPositions(), events: await store.allEvents(), candles: await store.allCandles(), corruptRows: store.stats ? store.stats().corruptRows : 0 }; }

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const max = a => (a.length ? Math.max(...a) : null);
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = v => (v && typeof v === "object" ? v : {});
const pct = (x, y) => (y > 0 ? x / y : null);
const evOrder = (a, b) => a.ts - b.ts || (a.id || 0) - (b.id || 0);

// 15M-relation-while-1H-aligned time for ONE position, with explicit boundaries. requireLtp: a degraded live price also
// invalidates the reading (matches the observer, which does not classify risk without a fresh LTP).
function relationIntervals(pos, mine, observedUntil, { requireLtp = true } = {}) {
    const out = { aligned: 0, disagree: 0, opposite: 0, undecided: 0, oneHNotAligned: 0, unknownSecs: 0, unobservedSecs: 0 };
    let cursor = (mine.find(e => e.kind === "POSITION_OPEN") || { ts: pos.openedAt }).ts;
    if (!Number.isFinite(cursor)) cursor = mine.length ? mine[0].ts : null;
    if (cursor === null) return out;
    let reading = null, restOk = null, ltpOk = null;   // null = not (yet) known => unreliable. Nothing is assumed healthy.
    const reliable = () => reading !== null && restOk === true && (!requireLtp || ltpOk === true);
    const account = toTs => {
        if (!(toTs > cursor)) return;
        const covered = Math.max(cursor, Math.min(toTs, observedUntil));
        const secs = (covered - cursor) / 1000;
        if (secs > 0) {
            if (reliable()) { if (reading.aligned1h) out[reading.rel in out ? reading.rel : "undecided"] += secs; else out.oneHNotAligned += secs; } else out.unknownSecs += secs;
        }
        if (toTs > covered) out.unobservedSecs += (toTs - covered) / 1000;
        cursor = toTs;
    };
    for (const e of mine) {
        const d = obj(e.detail);
        if (e.kind === "DSB") { account(e.ts); const t1 = obj(d.trend1h), o15 = d.obs15 ? obj(d.obs15) : null; reading = { aligned1h: t1.dir === pos.side, rel: o15 && typeof o15.relation === "string" ? o15.relation : "undecided" }; }
        else if (e.kind === "HEALTH") {
            if (d.dim === "ltp" && !requireLtp) { ltpOk = e.to === "HEALTHY" || e.to === "CLOSED"; continue; }   // LTP not required for the 15M reading: not a boundary
            account(e.ts);
            if (d.dim === "rest") restOk = e.to === "HEALTHY";
            else if (d.dim === "ltp") ltpOk = e.to === "HEALTHY" || e.to === "CLOSED";
            reading = null;   // a required health change invalidates the previous reading; a fresh DSB event must follow
        } else if (e.kind === "OBSERVER" && d.event === "stopped") { account(e.ts); reading = null; restOk = null; ltpOk = null; }
        else if (e.kind === "RECONCILE" && d.result === "resumed") {
            const L = num(d.lastObservedAt);
            if (L !== null && L < e.ts && L >= cursor) { account(L); out.unobservedSecs += (e.ts - cursor) / 1000; cursor = e.ts; }   // observed until L, offline (UNOBSERVED) from L until the resume
            else account(e.ts);
            reading = null; restOk = null; ltpOk = null;
        } else if (e.kind === "RECONCILE" && d.result === "closed_offline") { const L = num(d.lastObservedAt); if (L !== null) account(Math.min(L, e.ts)); return out; }
        else if (e.kind === "POSITION_CLOSE") { account(e.ts); return out; }
    }
    account(observedUntil);   // open (or unclosed) position: never extended beyond what was actually observed
    return out;
}

// One position's coherent timeline + metrics, built only from recorded facts.
function summarisePosition(pos, evs, nowMs, opts = {}) {
    const mine = evs.filter(e => e && e.posId === pos.id && Number.isFinite(e.ts)).sort(evOrder);
    const closeEv = mine.find(e => e.kind === "POSITION_CLOSE"), cd = obj(closeEv && closeEv.detail);
    const offlineEv = mine.find(e => e.kind === "RECONCILE" && obj(e.detail).result === "closed_offline");
    const m = obj(pos.metrics);
    const closed = pos.closedAt != null;
    const lastEventTs = mine.length ? mine[mine.length - 1].ts : pos.openedAt;
    const heartbeat = num(m.lastObservedAt);
    const observedUntil = closeEv ? closeEv.ts : offlineEv ? (num(obj(offlineEv.detail).lastObservedAt) ?? lastEventTs) : Math.max(heartbeat ?? 0, lastEventTs ?? 0, Number.isFinite(pos.openedAt) ? pos.openedAt : 0);
    const states = mine.filter(e => e.kind === "STATE");

    // ── completeness: candle-derived and live-derived metrics are judged SEPARATELY; clean = both ──
    const origin = pos.origin || (pos.reconciled ? "observed_from_entry" : "uncertain");   // legacy rows: the old reconciled flag
    const candleReasons = [], liveReasons = [];
    if (origin === "uncertain") { const r = pos.originNote || "entry metadata / identity uncertain"; candleReasons.push(r); liveReasons.push(r); }
    if (m.candleOriginNote && origin !== "uncertain") candleReasons.push(m.candleOriginNote);
    if (m.candleCovNote) candleReasons.push(m.candleCovNote);
    if (origin === "discovered_after_entry") liveReasons.push(pos.originNote || m.liveOriginNote || "position discovered after entry");
    if (m.liveOriginNote && origin !== "uncertain" && origin !== "discovered_after_entry") liveReasons.push(m.liveOriginNote);
    if ((m.liveGaps || 0) > 0) liveReasons.push(`${m.liveGaps} interruption(s) in live price observation`);
    if (offlineEv) { const r = "closed while the observer was offline — the final stretch and close time were not observed"; candleReasons.push(r); liveReasons.push(r); }
    if (m.partial && !m.candleOriginNote && !m.liveOriginNote && !candleReasons.length) { candleReasons.push(m.partialNote || "marked partial"); liveReasons.push(m.partialNote || "marked partial"); }
    const candleComplete = candleReasons.length === 0, liveComplete = liveReasons.length === 0;
    const partialReasons = [...new Set([...candleReasons, ...liveReasons])];

    const reached = s => states.some(e => e.to === s);
    const firstOf = s => states.find(e => e.to === s) || null;
    const danger = firstOf("DANGER");
    const warn = states.find(e => e.to === "WATCH" || e.to === "DANGER") || null;
    const wd = e => obj(e && e.detail);
    const finalMae = Math.max(num(m.candleMae) ?? 0, num(m.liveMae) ?? 0), finalMfe = Math.max(num(m.candleMfe) ?? 0, num(m.liveMfe) ?? 0);
    const stateSecs = cd.stateSecs ? cd.stateSecs : m.stateSecs || null;
    const unknownSecs = obj(cd.durations).unknownSecs || m.unknownSecs || null;
    const marketClosedSecs = num(obj(cd.durations).marketClosedSecs) ?? num(m.marketClosedSecs);
    const rel = relationIntervals(pos, mine, observedUntil, { requireLtp: opts.requireLtp !== false });
    return {
        id: pos.id, side: pos.side, entryPrice: pos.entryPrice, entryTs: pos.entryTs, closedAt: pos.closedAt, closeNote: pos.closeNote, status: closed ? "CLOSED" : "OPEN",
        origin, entryTsSource: pos.entryTsSource ?? null, closeTimeKnown: !offlineEv,
        observedSecs: Math.max(0, (observedUntil - pos.openedAt) / 1000),
        complete: candleComplete && liveComplete, candleComplete, liveComplete, partialReasons, candleReasons, liveReasons,
        maeCandlePts: num(m.candleMae), mfeCandlePts: num(m.candleMfe), maeLivePts: num(m.liveMae), mfeLivePts: num(m.liveMfe), maePts: finalMae, mfePts: finalMfe,
        peakPnl: num(cd.peakPnl) ?? num(m.peakPnl), maxGiveback: num(cd.maxGiveback) ?? num(m.maxGiveback),
        stateSecs, unknownSecs, marketClosedSecs,
        visitedWatch: reached("WATCH"), visitedDanger: reached("DANGER"),
        watchToDanger: states.some(e => e.from === "WATCH" && e.to === "DANGER"),
        directDanger: states.some(e => e.to === "DANGER" && wd(e).skippedWatch === true),
        dangerToRecovery: states.some(e => e.from === "DANGER" && e.to === "RECOVERY"),
        dangerRecoveredBeforeClose: states.some(e => e.from === "DANGER" && e.to === "RECOVERY") && (states.length ? states[states.length - 1].to !== "DANGER" : false),
        transitions: states.map(e => ({ ts: e.ts, from: e.from, to: e.to, skippedWatch: !!wd(e).skippedWatch, reasons: Array.isArray(wd(e).reasons) ? wd(e).reasons : [], adverseAtr: num(obj(wd(e).inputs).adverseAtr), adversePts: num(wd(e).adversePts), maeAtTransition: num(wd(e).mae), giveback: num(wd(e).giveback), pnl: num(wd(e).pnl) })),
        firstWarning: warn ? { state: warn.to, ts: warn.ts, adversePts: num(wd(warn).adversePts), adverseAtr: num(obj(wd(warn).inputs).adverseAtr), maeAtWarning: num(wd(warn).mae), giveback: num(wd(warn).giveback) } : null,
        adverseBeforeDangerPts: danger ? num(wd(danger).mae) : null, adverseBeforeDangerAtr: danger ? num(obj(wd(danger).inputs).adverseAtr) : null,
        givebackAtDanger: danger ? num(wd(danger).giveback) : null,
        dsbRelation: { ...rel, reliableSecs: rel.aligned + rel.disagree + rel.opposite + rel.undecided + rel.oneHNotAligned, aligned1hSecs: rel.aligned + rel.disagree + rel.opposite + rel.undecided },
        timeline: mine.map(e => ({ ts: e.ts, kind: e.kind, from: e.from, to: e.to, detail: e.detail })),
    };
}

function aggregateSet(set) {
    const count = f => set.filter(f).length, mm = f => set.map(f).filter(v => v !== null);
    const warned = set.filter(p => p.visitedWatch || p.visitedDanger), calm = set.filter(p => !p.visitedWatch && !p.visitedDanger), dangerSet = set.filter(p => p.visitedDanger);
    const st = { NORMAL: 0, WATCH: 0, DANGER: 0, RECOVERY: 0 }, unk = { rest: 0, ltp: 0, both: 0, history: 0, unobserved: 0 }; let closedSecs = 0;
    for (const p of set) { if (p.stateSecs) for (const k of Object.keys(st)) st[k] += num(p.stateSecs[k]) || 0; if (p.unknownSecs) for (const k of Object.keys(unk)) unk[k] += num(p.unknownSecs[k]) || 0; closedSecs += p.marketClosedSecs || 0; }
    const rel = { aligned: 0, disagree: 0, opposite: 0, undecided: 0, oneHNotAligned: 0, unknownSecs: 0, unobservedSecs: 0 };
    for (const p of set) for (const k of Object.keys(rel)) rel[k] += p.dsbRelation[k] || 0;
    const al = rel.aligned + rel.disagree + rel.opposite + rel.undecided, rl = al + rel.oneHNotAligned, tot = rl + rel.unknownSecs + rel.unobservedSecs;
    const after = warned.map(p => (p.firstWarning && p.firstWarning.maeAtWarning !== null ? p.maePts - p.firstWarning.maeAtWarning : null)).filter(v => v !== null);
    return {
        n: set.length,
        counts: { enteredWatch: count(p => p.visitedWatch), enteredDanger: count(p => p.visitedDanger), watchToDanger: count(p => p.watchToDanger), directDanger: count(p => p.directDanger), dangerToRecovery: count(p => p.dangerToRecovery), dangerRecoveredBeforeClose: count(p => p.dangerRecoveredBeforeClose) },
        rates: { watchEscalatedToDanger: pct(count(p => p.watchToDanger), count(p => p.visitedWatch)), watchN: count(p => p.visitedWatch), dangerRecovered: pct(count(p => p.dangerToRecovery), count(p => p.visitedDanger)), dangerN: count(p => p.visitedDanger) },
        mae: { avgPts: avg(mm(p => p.maePts)), maxPts: max(mm(p => p.maePts)), n: mm(p => p.maePts).length },
        mfe: { avgPts: avg(mm(p => p.mfePts)), maxPts: max(mm(p => p.mfePts)), n: mm(p => p.mfePts).length },
        maeSplit: { candleAvg: avg(mm(p => p.maeCandlePts)), liveAvg: avg(mm(p => p.maeLivePts)) },
        peakPnl: { avg: avg(mm(p => p.peakPnl)), max: max(mm(p => p.peakPnl)), n: mm(p => p.peakPnl).length },
        giveback: { avgMax: avg(mm(p => p.maxGiveback)), max: max(mm(p => p.maxGiveback)), n: mm(p => p.maxGiveback).length, avgAtDanger: avg(dangerSet.map(p => p.givebackAtDanger).filter(v => v !== null)) },
        adverseAtWarning: { avgPts: avg(warned.map(p => p.firstWarning && p.firstWarning.adversePts).filter(v => v !== null && v !== undefined)), avgAtr: avg(warned.map(p => p.firstWarning && p.firstWarning.adverseAtr).filter(v => v !== null && v !== undefined)), n: warned.length },
        adverseBeforeDanger: { avgPts: avg(dangerSet.map(p => p.adverseBeforeDangerPts).filter(v => v !== null)), avgAtr: avg(dangerSet.map(p => p.adverseBeforeDangerAtr).filter(v => v !== null)), n: dangerSet.length },
        stateSecs: st, unknownSecs: { ...unk, total: Object.values(unk).reduce((a, b) => a + b, 0) }, marketClosedSecs: closedSecs,
        dsbRelationWhile1hAligned: { n: set.length, alignedSecs: al, secs: { aligned: rel.aligned, disagree: rel.disagree, opposite: rel.opposite, undecided: rel.undecided }, disagreeShare: pct(rel.disagree, al), oppositeShare: pct(rel.opposite, al),
            oneHNotAlignedSecs: rel.oneHNotAligned, unknownSecs: rel.unknownSecs, unobservedSecs: rel.unobservedSecs, reliableShareOfObserved: pct(rl, tot) },
        earlyWarning: { warnedPositions: warned.length, unwarnedPositions: calm.length, avgFurtherAdverseAfterFirstWarningPts: avg(after), positionsWithFurtherAdverse: after.filter(v => v > 1e-9).length, positionsMeasured: after.length,
            avgFinalMaeWarned: avg(warned.map(p => p.maePts)), avgFinalMaeUnwarned: avg(calm.map(p => p.maePts)),
            note: "Descriptive only. A warning preceding an adverse move is not evidence that it predicts one: the same MAE figures are shown for positions that never warned, the samples are small and not randomised, and no realised P&L is recorded by the observer. Do not treat this as validation." },
    };
}

function summarize(history, { nowMs = Date.now(), minSample = MIN_CLOSED_FULL_SAMPLE, requireLtp = true } = {}) {
    const integrity = { skippedPositions: 0, skippedEvents: 0, corruptRows: history.corruptRows || 0 };
    const goodPos = (history.positions || []).filter(p => { const ok = p && (p.side === "LONG" || p.side === "SHORT") && Number.isFinite(p.openedAt) && Number.isFinite(p.entryTs); if (!ok) integrity.skippedPositions++; return ok; });
    const goodEv = (history.events || []).filter(e => { const ok = e && Number.isFinite(e.ts); if (!ok) integrity.skippedEvents++; return ok; });
    const positions = goodPos.map(p => summarisePosition(p, goodEv, nowMs, { requireLtp }));
    const closed = positions.filter(p => p.status === "CLOSED"), open = positions.filter(p => p.status === "OPEN");
    const cleanClosed = closed.filter(p => p.complete), partialAll = positions.filter(p => !p.complete);
    const clean = aggregateSet(cleanClosed), partial = aggregateSet(partialAll.filter(p => p.status === "CLOSED"));
    const limitations = [];
    if (cleanClosed.length < minSample) limitations.push(`Only ${cleanClosed.length} clean (fully observed) closed position(s); at least ${minSample} are needed before aggregates are more than anecdotes.`);
    if (partialAll.length) limitations.push(`${partialAll.length} position(s) are PARTIAL (see reasons) and are excluded from the clean aggregates.`);
    if (open.length) limitations.push(`${open.length} position(s) still open — reported separately and provisional.`);
    if (integrity.skippedPositions || integrity.skippedEvents || integrity.corruptRows) limitations.push(`Malformed history was skipped (${integrity.skippedPositions} position(s), ${integrity.skippedEvents} event(s), ${integrity.corruptRows} unparsable field(s)).`);
    limitations.push("State times and DSB relations come from observer events only; periods when the observer was down or its data unreliable are reported as UNKNOWN / UNOBSERVED, never as a state.");
    limitations.push("The observer records unrealised metrics only: no realised P&L is inferred.");
    return {
        generatedAt: nowMs,
        sample: { positions: positions.length, closed: closed.length, open: open.length, clean: cleanClosed.length, closedFullyObserved: cleanClosed.length, partial: partialAll.length, incomplete: partialAll.length, fullyObserved: positions.filter(p => p.complete).length, candleCompleteOnly: positions.filter(p => p.candleComplete && !p.liveComplete).length, sufficient: cleanClosed.length >= minSample, minSample },
        ...clean,            // the headline numbers are the CLEAN closed sample (n shown in each block)
        clean, partial: { ...partial, positions: partialAll.map(p => ({ id: p.id, status: p.status, side: p.side, origin: p.origin, reasons: p.partialReasons })) },
        openProvisional: { n: open.length, positions: open.map(p => ({ id: p.id, side: p.side, complete: p.complete, maePts: p.maePts, visitedWatch: p.visitedWatch, visitedDanger: p.visitedDanger })) },
        integrity, limitations, positions,
    };
}

module.exports = { loadHistoryReadOnly, loadHistoryFromStore, summarisePosition, summarize, relationIntervals, MIN_CLOSED_FULL_SAMPLE };
