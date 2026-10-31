// riskObserver/riskMetrics.js — per-position excursion / profit-giveback tracker. Pure data, no I/O.
//
// Two sources are kept SEPARATE on purpose:
//   candle*  — from COMPLETED 15m candle highs/lows (authoritative, only candles that opened at/after the entry)
//   live*    — from the live LTP stream (finer, but only what this process actually saw)
// Prices are in price POINTS; P&L is in RUPEES = points * perPoint (lotMult * lots), same as positions.js.
"use strict";

function createPositionMetrics({ side, entryPrice, perPoint, entryTs, tradeId = null }) {
    if (side !== "LONG" && side !== "SHORT") throw new Error("createPositionMetrics: side must be LONG or SHORT");
    const long = side === "LONG";
    const m = {
        side, entryPrice: Number(entryPrice), perPoint: Number(perPoint) || 1, entryTs, tradeId,
        candleMae: 0, candleMfe: 0, liveMae: 0, liveMfe: 0,
        lastPrice: null, currentAdverse: 0, currentFavorable: 0, pnl: null, peakPnl: 0, maxGiveback: 0, giveback: 0,
        adverseCandles: 0, candlesSeen: 0, lastCandleTs: null,
        stateSecs: { NORMAL: 0, WATCH: 0, DANGER: 0, RECOVERY: 0 },
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

    function onPrice(p) {
        if (!Number.isFinite(p)) return;
        m.lastPrice = p;
        const a = adv(p);
        m.currentAdverse = Math.max(0, a); m.currentFavorable = Math.max(0, -a);
        m.liveMae = Math.max(m.liveMae, a); m.liveMfe = Math.max(m.liveMfe, -a);
        m.pnl = -a * m.perPoint;
        if (m.pnl > m.peakPnl) m.peakPnl = m.pnl;
        m.giveback = Math.max(0, m.peakPnl - m.pnl);
        if (m.giveback > m.maxGiveback) m.maxGiveback = m.giveback;
    }

    function addStateTime(state, secs) { if (m.stateSecs[state] !== undefined && secs > 0) m.stateSecs[state] += secs; }
    // how much of the worst adverse move has been won back (0..1); null when there was no adverse move
    function recovery() {
        const mae = Math.max(m.candleMae, m.liveMae);
        return mae > 0 ? Math.min(1, Math.max(0, (mae - m.currentAdverse) / mae)) : null;
    }
    function snapshot() {
        return {
            side: m.side, entryPrice: m.entryPrice, lastPrice: m.lastPrice, pnl: m.pnl,
            maeCandlePts: m.candleMae, mfeCandlePts: m.candleMfe, maeLivePts: m.liveMae, mfeLivePts: m.liveMfe,
            maePts: Math.max(m.candleMae, m.liveMae), mfePts: Math.max(m.candleMfe, m.liveMfe),
            currentAdversePts: m.currentAdverse, peakPnl: m.peakPnl, giveback: m.giveback, maxGiveback: m.maxGiveback,
            adverseCandles: m.adverseCandles, recovery: recovery(), stateSecs: { ...m.stateSecs },
            entryTs: m.entryTs, tradeId: m.tradeId,
        };
    }
    // Restore from a persisted row (same position only — the caller checks identity)
    function restore(row) {
        for (const k of ["candleMae", "candleMfe", "liveMae", "liveMfe", "peakPnl", "maxGiveback", "adverseCandles", "lastCandleTs"]) if (row[k] !== undefined && row[k] !== null) m[k] = row[k];
        if (row.stateSecs) Object.assign(m.stateSecs, row.stateSecs);
    }
    function persistable() {
        return { candleMae: m.candleMae, candleMfe: m.candleMfe, liveMae: m.liveMae, liveMfe: m.liveMfe, peakPnl: m.peakPnl, maxGiveback: m.maxGiveback, adverseCandles: m.adverseCandles, lastCandleTs: m.lastCandleTs, stateSecs: { ...m.stateSecs } };
    }
    return { onCandle, onPrice, addStateTime, snapshot, recovery, restore, persistable, raw: m };
}

module.exports = { createPositionMetrics };
