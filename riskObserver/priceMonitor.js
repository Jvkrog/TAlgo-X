// riskObserver/priceMonitor.js — authoritative 15m candle feed for the observer (Kite historical REST), plus the
// adverse-price helpers. It never builds candles from ticks and never treats a still-forming candle as completed.
//   - completed = open time + timeframe <= now (the forming bar Kite returns is dropped)
//   - duplicates are ignored (dsbMonitor dedupes by timestamp too)
//   - one request only when the newest expected candle is missing (no polling of an up-to-date feed)
//   - health: HEALTHY | STALE | ERROR, separate from the trading risk state
"use strict";

const IST_MS = 5.5 * 3600 * 1000;
const fmtIST = ms => new Date(ms + IST_MS).toISOString().replace("T", " ").slice(0, 19);   // Kite wants IST wall-clock strings

// createCandleFeed({ fetchRaw(fromStr, toStr) -> Promise<bars[]>, monitor, tfMs, now, initialDays, staleGraceMs, errorAfterFails })
function createCandleFeed({ fetchRaw, monitor, tfMs = 15 * 60000, now = () => Date.now(), initialDays = 8, staleGraceMs = 180000, errorAfterFails = 3 }) {
    const f = { fails: 0, lastOkAt: null, lastError: null, lastRequestAt: 0, requests: 0 };
    const expectedTs = (t = now()) => Math.floor(t / tfMs) * tfMs - tfMs;   // open time of the newest candle that should be complete

    function normalise(b) {
        const ts = new Date(b.date).getTime();
        return { ts, open: parseFloat(b.open), high: parseFloat(b.high), low: parseFloat(b.low), close: parseFloat(b.close) };
    }

    // Returns { requested, added, error }. minGapMs throttles retries while the candle is late (rate-limit friendly).
    async function poll({ minGapMs = 25000 } = {}) {
        const t = now(), last = monitor.lastTs();
        if (last !== null && last >= expectedTs(t)) return { requested: false, added: 0, error: null };
        if (t - f.lastRequestAt < minGapMs) return { requested: false, added: 0, error: null };
        f.lastRequestAt = t; f.requests++;
        try {
            const from = last === null ? t - initialDays * 86400000 : last - tfMs;
            const bars = await fetchRaw(fmtIST(from), fmtIST(t));
            const completed = (bars || []).map(normalise).filter(c => c.ts + tfMs <= t);
            const added = monitor.addCandles(completed);
            f.fails = 0; f.lastOkAt = t; f.lastError = null;
            return { requested: true, added, error: null, candles: completed };
        } catch (err) {
            f.fails++; f.lastError = err && err.message ? err.message : String(err);
            return { requested: true, added: 0, error: f.lastError };
        }
    }

    // marketOpen: whether a new completed candle is expected right now (session hours/weekday decided by the caller)
    function health(marketOpen) {
        const t = now(), last = monitor.lastTs();
        if (f.fails >= errorAfterFails) return { status: "ERROR", reason: `15m fetch failed ${f.fails}x: ${f.lastError}` };
        if (last === null) return { status: marketOpen ? "STALE" : "HEALTHY", reason: "no completed 15m candles yet" };
        if (marketOpen) {
            const exp = expectedTs(t);
            if (last < exp && t > exp + tfMs + staleGraceMs) return { status: "STALE", reason: `latest 15m candle ${new Date(last).toISOString()} is behind ${new Date(exp).toISOString()}` };
        }
        return { status: "HEALTHY", reason: null };
    }
    return { poll, health, expectedTs, info: () => ({ ...f }) };
}

module.exports = { createCandleFeed, fmtIST };
