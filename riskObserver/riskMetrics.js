// riskObserver/riskMetrics.js — per-position risk metrics, pure and deterministic (no clock, no I/O).
//   MAE / MFE   — maximum adverse / favourable excursion in PRICE POINTS (not rupees). Two independent sources are kept:
//                  candle-derived (completed 15m candles that OPEN at/after the entry) and live-derived (WebSocket prices
//                  the observer actually saw). They are never merged into one number and carry separate coverage labels.
//   P&L / peak / giveback — unrealised, live-derived only (rupees = points × perPoint).
//   Coverage — what the numbers do NOT cover is recorded, never papered over:
//        candle: sticky origin note (identity / entry metadata uncertain) + dynamic coverage note (recorded candles incomplete)
//        live:   sticky origin note (position discovered after entry / identity uncertain) + count of interruptions
//   Durations — time in NORMAL/WATCH/DANGER/RECOVERY is accumulated ONLY while every required input is reliable. Time
//        with unreliable inputs is kept apart (unknownSecs by cause), as is market-closed time, so a frozen state is
//        never credited with duration it was not actually observed for.
"use strict";

const UNKNOWN_CAUSES = ["rest", "ltp", "both", "history", "unobserved"];

function createPositionMetrics({ side, entryPrice, perPoint, entryTs, tradeId = null }) {
    if (side !== "LONG" && side !== "SHORT") throw new Error("createPositionMetrics: side must be LONG or SHORT");
    const long = side === "LONG";
    const m = {
        side, entryPrice: Number(entryPrice), perPoint: Number(perPoint) || 1, entryTs, tradeId,
        candleMae: 0, candleMfe: 0, liveMae: 0, liveMfe: 0,
        lastPrice: null, currentAdverse: 0, currentFavorable: 0, pnl: null, peakPnl: 0, maxGiveback: 0, giveback: 0,
        adverseCandles: 0, candlesSeen: 0, lastCandleTs: null,
        liveSince: null, liveGaps: 0, leadInMs: null,
        candleOriginNote: null, liveOriginNote: null, candleCovNote: null,   // coverage bookkeeping
        stateSecs: { NORMAL: 0, WATCH: 0, DANGER: 0, RECOVERY: 0 },
        unknownSecs: { rest: 0, ltp: 0, both: 0, history: 0, unobserved: 0 }, marketClosedSecs: 0, lastObservedAt: null,
    };
    const adv = p => (long ? m.entryPrice - p : p - m.entryPrice);   // + = against the position

    // Completed candle (object with ts = open time ms, open/high/low/close). Duplicates and pre-entry candles are ignored.
    function onCandle(cd) {
        if (m.lastCandleTs !== null && cd.ts <= m.lastCandleTs) return false;
        if (cd.ts < m.entryTs) return false;
        m.lastCandleTs = cd.ts; m.candlesSeen++;
        const worst = long ? cd.low : cd.high, best = long ? cd.high : cd.low;
        m.candleMae = Math.max(m.candleMae, adv(worst));
        m.candleMfe = Math.max(m.candleMfe, -adv(best));
        const against = long ? cd.close < cd.open : cd.close > cd.open;
        m.adverseCandles = against ? m.adverseCandles + 1 : 0;
        return true;
    }

    function onPrice(p, ts) {
        if (!Number.isFinite(p)) return;
        m.lastPrice = p;
        if (m.liveSince === null) m.liveSince = Number.isFinite(ts) ? ts : Date.now();
        const a = adv(p);
        m.currentAdverse = Math.max(0, a); m.currentFavorable = Math.max(0, -a);
        m.liveMae = Math.max(m.liveMae, a); m.liveMfe = Math.max(m.liveMfe, -a);
        m.pnl = -a * m.perPoint;
        if (m.pnl > m.peakPnl) m.peakPnl = m.pnl;
        m.giveback = Math.max(0, m.peakPnl - m.pnl);
        if (m.giveback > m.maxGiveback) m.maxGiveback = m.giveback;
    }

    // Live extremes / peak / giveback only cover moments this observer actually saw prices: every interruption is counted.
    function markLiveGap() { m.liveGaps++; }
    function markCandlePartial(note) { m.candleOriginNote = m.candleOriginNote || note; }
    function markLivePartial(note) { m.liveOriginNote = m.liveOriginNote || note; }
    function markPartial(note) { markCandlePartial(note); markLivePartial(note); }                   // identity / entry metadata uncertain
    function setLeadIn(ms) { m.leadInMs = ms; }
    function setCandleCoverage(complete, note) { m.candleCovNote = complete ? null : (note || "recorded 15m candles do not fully cover the position"); }
    function addStateTime(state, secs) { if (m.stateSecs[state] !== undefined && secs > 0) m.stateSecs[state] += secs; }
    function addUnknownTime(cause, secs) { if (UNKNOWN_CAUSES.includes(cause) && secs > 0) m.unknownSecs[cause] += secs; }
    function addMarketClosedTime(secs) { if (secs > 0) m.marketClosedSecs += secs; }
    function setLastObserved(ts) { if (Number.isFinite(ts)) m.lastObservedAt = ts; }
    // how much of the worst adverse move has been won back (0..1); null when there was no adverse move
    function recovery() {
        const mae = Math.max(m.candleMae, m.liveMae);
        return mae > 0 ? Math.min(1, Math.max(0, (mae - m.currentAdverse) / mae)) : null;
    }
    const unknownTotal = () => UNKNOWN_CAUSES.reduce((a, k) => a + m.unknownSecs[k], 0);
    function snapshot() {
        const candlePartial = !!(m.candleOriginNote || m.candleCovNote), livePartial = !!(m.liveOriginNote || m.liveGaps > 0);
        return {
            side: m.side, entryPrice: m.entryPrice, lastPrice: m.lastPrice, pnl: m.pnl,
            maeCandlePts: m.candleMae, mfeCandlePts: m.candleMfe, maeLivePts: m.liveMae, mfeLivePts: m.liveMfe,
            maePts: Math.max(m.candleMae, m.liveMae), mfePts: Math.max(m.candleMfe, m.liveMfe),   // convenience only — see coverage for what each covers
            currentAdversePts: m.currentAdverse, peakPnl: m.peakPnl, giveback: m.giveback, maxGiveback: m.maxGiveback,
            adverseCandles: m.adverseCandles, recovery: recovery(), stateSecs: { ...m.stateSecs },
            durations: { reliableStateSecs: { ...m.stateSecs }, unknownSecs: { ...m.unknownSecs, total: unknownTotal() }, marketClosedSecs: m.marketClosedSecs },
            entryTs: m.entryTs, tradeId: m.tradeId, perPoint: m.perPoint, lastObservedAt: m.lastObservedAt,
            coverage: {
                candle: candlePartial ? "PARTIAL" : "FULL",
                candleNote: candlePartial ? [m.candleOriginNote, m.candleCovNote].filter(Boolean).join("; ") : "completed 15m candles opening at/after entry, none missing",
                live: livePartial ? "PARTIAL" : "FULL",
                liveNote: livePartial ? [m.liveOriginNote, m.liveGaps > 0 ? `${m.liveGaps} interruption(s) in live price observation (stale LTP / restart); extremes, peak P&L and giveback may be understated` : null].filter(Boolean).join("; ") : "continuous live price observation since entry",
                liveSince: m.liveSince, leadInMs: m.leadInMs,
            },
        };
    }
    // Restore from a persisted row (same position only — the caller checks identity)
    const RESTORE = ["candleMae", "candleMfe", "liveMae", "liveMfe", "peakPnl", "maxGiveback", "adverseCandles", "lastCandleTs", "liveSince", "liveGaps", "leadInMs", "candleOriginNote", "liveOriginNote", "candleCovNote", "marketClosedSecs", "lastObservedAt"];
    function restore(row) {
        for (const k of RESTORE) if (row[k] !== undefined && row[k] !== null) m[k] = row[k];
        if (row.partial && !row.candleOriginNote && !row.liveOriginNote) markPartial(row.partialNote || "marked partial by an earlier observer version");   // legacy rows
        if (row.stateSecs) Object.assign(m.stateSecs, row.stateSecs);
        if (row.unknownSecs) for (const k of UNKNOWN_CAUSES) if (Number.isFinite(row.unknownSecs[k])) m.unknownSecs[k] = row.unknownSecs[k];
    }
    function persistable() {
        const o = { perPoint: m.perPoint, stateSecs: { ...m.stateSecs }, unknownSecs: { ...m.unknownSecs } };
        for (const k of RESTORE) o[k] = m[k];
        return o;
    }
    return { onCandle, onPrice, markLiveGap, markPartial, markCandlePartial, markLivePartial, setLeadIn, setCandleCoverage, addStateTime, addUnknownTime, addMarketClosedTime, setLastObserved, snapshot, recovery, restore, persistable, raw: m };
}

module.exports = { createPositionMetrics, UNKNOWN_CAUSES };
