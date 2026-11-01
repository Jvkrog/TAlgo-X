// riskObserver/priceMonitor.js — authoritative 15m candle feed for the observer (Kite historical REST).
// It never builds candles from ticks and never treats a still-forming candle as completed.
//   - completed = open time + timeframe <= now (the forming bar Kite returns is dropped)
//   - duplicates are ignored (dsbMonitor dedupes by timestamp too)
//   - ONE request only when something is missing (newest candle late, or an internal gap) — throttled
//   - INTERNAL GAP DETECTION: the candle sequence is checked slot by slot against the exchange session, so a missing
//     candle in the middle is found even when the newest candle is present. Overnight / weekend / out-of-session slots
//     are never "missing"; a session day with no candles at all is probed ONCE and, if Kite has none, recorded as a closure
//     (exchange holiday), not as missing data.
//   - BACKFILL asks Kite for the missing range, de-duplicates, and gives up on a slot after `maxBackfillTries` empty
//     answers: such a slot is reported as `brokerEmpty` (e.g. a 15m interval with no trades) — still VISIBLE in
//     diagnostics (history is flagged incomplete), but it no longer blocks health forever.
//   - health (REST feed only): HEALTHY | GAPS | STALE | ERROR. Live-price (LTP) health is tracked by the observer, separately.
"use strict";

const IST_MS = 5.5 * 3600 * 1000;
const DAY_MS = 86400000;
const fmtIST = ms => new Date(ms + IST_MS).toISOString().replace("T", " ").slice(0, 19);   // Kite wants IST wall-clock strings
const istDayKey = ms => new Date(ms + IST_MS).toISOString().slice(0, 10);

// Exchange session (IST minutes from midnight) in which 15m candles are EXPECTED, Mon-Fri.
//   MCX 09:00-23:30, NSE 09:15-15:30. Override with params sessionStartMin / sessionEndMin.
function sessionFor(exchange, overrides = {}) {
    const nse = exchange === "NSE";
    return {
        startMin: Number.isFinite(overrides.sessionStartMin) ? overrides.sessionStartMin : (nse ? 9 * 60 + 15 : 9 * 60),
        endMin: Number.isFinite(overrides.sessionEndMin) ? overrides.sessionEndMin : (nse ? 15 * 60 + 30 : 23 * 60 + 30),
    };
}
function isSessionSlot(ts, session) {
    const d = new Date(ts + IST_MS), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return mins >= session.startMin && mins < session.endMin;
}

// createCandleFeed({ fetchRaw(fromStr, toStr) -> Promise<bars[]>, monitor, tfMs, now, session, ... })
function createCandleFeed({ fetchRaw, monitor, tfMs = 15 * 60000, now = () => Date.now(), initialDays = 8, staleGraceMs = 180000, errorAfterFails = 3,
    session = sessionFor("MCX"), maxBackfillTries = 3, backfillGapMs = 30000, maxGapSlotsReported = 200 }) {
    const f = { fails: 0, lastOkAt: null, lastError: null, lastRequestAt: 0, requests: 0, backfillRequests: 0, lastBackfillAt: 0 };
    const tries = new Map();          // slot ts -> empty backfill answers so far
    const brokerEmpty = new Set();    // slots Kite confirmed it has no candle for (kept visible in diagnostics)
    const closures = new Set();       // IST day keys with no candles at all after a probe (holidays)
    const probedDays = new Set();
    // open time of the newest candle that should be complete AND lies inside an exchange session (nothing is expected
    // overnight / at weekends, so a closed market neither triggers tail requests nor looks late)
    const expectedTs = (t = now()) => { let ts = Math.floor(t / tfMs) * tfMs - tfMs; for (let i = 0; i < 4 * 96 && !isSessionSlot(ts, session); i++) ts -= tfMs; return ts; };

    function normalise(b) {
        const ts = new Date(b.date).getTime();
        return { ts, open: parseFloat(b.open), high: parseFloat(b.high), low: parseFloat(b.low), close: parseFloat(b.close) };
    }
    const completedOnly = (list, t) => list.map(normalise).filter(c => Number.isFinite(c.ts) && c.ts + tfMs <= t);

    // Missing session slots strictly BETWEEN the first and last cached candle (the tail is the staleness check's job).
    function gaps() {
        const have = new Set(monitor.candles().map(c => c.ts));
        const first = monitor.firstTs(), last = monitor.lastTs();
        const missing = [], closedHits = [];
        if (first === null || last === null) return { missing, brokerEmptyList: [...brokerEmpty].sort((a, b) => a - b), closures: [...closures], ranges: [], count: 0 };
        // which IST days have at least one cached candle
        const dayHas = new Set(); for (const ts of have) dayHas.add(istDayKey(ts));
        for (let s = first + tfMs; s < last; s += tfMs) {
            if (have.has(s) || !isSessionSlot(s, session) || brokerEmpty.has(s)) continue;
            const day = istDayKey(s);
            if (closures.has(day)) continue;
            if (!dayHas.has(day) && probedDays.has(day)) { closures.add(day); continue; }   // probed once, Kite had nothing -> holiday / closure
            missing.push(s);
            if (missing.length > 5000) break;
        }
        // contiguous ranges for diagnostics
        const ranges = [];
        for (const s of missing) { const r = ranges[ranges.length - 1]; if (r && s - r.to === tfMs) r.to = s; else ranges.push({ from: s, to: s }); }
        return { missing, ranges, count: missing.length, brokerEmptyList: [...brokerEmpty].sort((a, b) => a - b), closures: [...closures] };
    }

    async function request(fromMs, toMs, kind) {
        f.lastRequestAt = now(); f.requests++; if (kind === "backfill") { f.backfillRequests++; f.lastBackfillAt = now(); }
        try {
            const bars = await fetchRaw(fmtIST(fromMs), fmtIST(toMs));
            const completed = completedOnly(bars || [], now());
            const added = monitor.addCandles(completed);
            f.fails = 0; f.lastOkAt = now(); f.lastError = null;
            return { ok: true, added, candles: completed };
        } catch (err) {
            f.fails++; f.lastError = err && err.message ? err.message : String(err);
            return { ok: false, added: 0, error: f.lastError };
        }
    }

    // Backfill the oldest unresolved gap range with one request. Returns a result or null when nothing to do / throttled.
    async function backfill() {
        const g = gaps();
        if (!g.count || now() - f.lastBackfillAt < backfillGapMs) return null;
        const range = g.ranges[0];
        const res = await request(range.from - tfMs, range.to + 2 * tfMs, "backfill");
        if (!res.ok) return { ...res, backfilled: 0 };
        const gotTs = new Set(res.candles.map(c => c.ts));
        let filled = 0;
        for (let s = range.from; s <= range.to; s += tfMs) {
            if (!isSessionSlot(s, session)) continue;
            if (gotTs.has(s)) { filled++; continue; }
            const day = istDayKey(s);
            // a whole session day absent from cache AND from the answer: probe done -> closure (holiday), counted once
            const dayCached = monitor.candles().some(c => istDayKey(c.ts) === day);
            if (!dayCached) { probedDays.add(day); continue; }
            const n = (tries.get(s) || 0) + 1; tries.set(s, n);
            if (n >= maxBackfillTries) brokerEmpty.add(s);
        }
        return { ...res, backfilled: filled };
    }

    // Returns { requested, added, error, backfilled }. minGapMs throttles retries while the newest candle is late.
    async function poll({ minGapMs = 25000 } = {}) {
        const t = now(), last = monitor.lastTs();
        if (last === null || last < expectedTs(t)) {
            if (t - f.lastRequestAt < minGapMs) return { requested: false, added: 0, error: null };
            const from = last === null ? t - initialDays * DAY_MS : last - tfMs;
            const res = await request(from, t, "tail");
            return { requested: true, added: res.added, error: res.ok ? null : res.error, candles: res.candles };
        }
        const bf = await backfill();     // up to date at the tail: repair internal gaps (throttled)
        if (!bf) return { requested: false, added: 0, error: null };
        return { requested: true, added: bf.added, error: bf.ok ? null : bf.error, backfilled: bf.backfilled, candles: bf.candles };
    }

    function diagnostics() {
        const g = gaps(), fmt = ms => new Date(ms).toISOString();
        return {
            missingCount: g.count,
            missingRanges: g.ranges.slice(0, 20).map(r => ({ from: fmt(r.from), to: fmt(r.to), candles: (r.to - r.from) / tfMs + 1 })),
            brokerEmptyCount: g.brokerEmptyList.length, brokerEmptyRecent: g.brokerEmptyList.slice(-10).map(fmt),
            closures: g.closures.slice(-10), incomplete: g.count > 0 || g.brokerEmptyList.length > 0,
            backfillRequests: f.backfillRequests, requests: f.requests, lastBackfillAt: f.lastBackfillAt || null, firstTs: monitor.firstTs(), lastTs: monitor.lastTs(),
        };
    }

    // REST-feed health. marketOpen: whether a new completed candle is expected right now (decided by the caller).
    function health(marketOpen) {
        const t = now(), last = monitor.lastTs(), d = diagnostics();
        const base = { missingCount: d.missingCount, brokerEmptyCount: d.brokerEmptyCount };
        if (f.fails >= errorAfterFails) return { status: "ERROR", reason: `15m fetch failed ${f.fails}x: ${f.lastError}`, ...base };
        if (last === null) return { status: marketOpen ? "STALE" : "HEALTHY", reason: "no completed 15m candles yet", ...base };
        if (marketOpen) {
            const exp = expectedTs(t);
            if (last < exp && t > exp + tfMs + staleGraceMs) return { status: "STALE", reason: `latest 15m candle ${new Date(last).toISOString()} is behind ${new Date(exp).toISOString()}`, ...base };
        }
        if (d.missingCount > 0) {
            const r = d.missingRanges[0];
            return { status: "GAPS", reason: `${d.missingCount} completed 15m candle(s) missing inside the history (first gap ${r.from} .. ${r.to}); backfill ${f.backfillRequests ? "attempted " + f.backfillRequests + "x" : "pending"}`, ...base };
        }
        return { status: "HEALTHY", reason: null, ...base, incomplete: d.brokerEmptyCount > 0 };
    }
    return { poll, health, expectedTs, diagnostics, gaps, info: () => ({ ...f }) };
}

module.exports = { createCandleFeed, fmtIST, sessionFor, isSessionSlot };
