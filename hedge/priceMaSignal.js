"use strict";

const MIN_MS = 60 * 1000;
const round6 = x => Math.round(x * 1e6) / 1e6;   // averages of identical prices must compare exactly equal

function createPriceMaSignal({ minSlope = 0, confirmMinutes = 1, maxGapMinutes = 2, log = () => {} } = {}) {
    if (!(minSlope >= 0)) throw new Error("priceMaSignal: minSlope must be >= 0");
    if (!(Number.isInteger(confirmMinutes) && confirmMinutes >= 1)) throw new Error("priceMaSignal: confirmMinutes must be a whole number >= 1");

    let bucketMin = null, ticks = [];
    let prev = null;                    // { minute, ma } — last completed MA we may compare against
    let signal = null;                  // standing signal: "GREEN" | "RED" | null (null = none yet)
    let pendingRaw = null, pendingCount = 0;

    function closeMinute() {
        if (bucketMin === null) return null;
        const minute = bucketMin, n = ticks.length;
        const vals = ticks; ticks = []; bucketMin = null;
        if (n === 0) return null;       // defensive: an empty minute never yields an MA
        const ma = round6(vals.reduce((a, b) => a + b, 0) / n);

        if (prev && minute - prev.minute > maxGapMinutes) {
            log(`[PRICE_MA] gap of ${minute - prev.minute} min since the last MA — previous MA discarded, new baseline`);
            prev = null; pendingRaw = null; pendingCount = 0;
        }
        const previousMa = prev ? prev.ma : null;
        prev = { minute, ma };
        if (previousMa === null) return { minute, ma, prevMa: null, slope: null, n, raw: null, signal, transition: false, from: signal };

        const slope = round6(ma - previousMa);
        const raw = Math.abs(slope) <= minSlope ? "NEUTRAL" : slope > 0 ? "GREEN" : "RED";
        const from = signal;
        if (raw === "NEUTRAL") { pendingRaw = null; pendingCount = 0; }
        else if (raw === signal) { pendingRaw = null; pendingCount = 0; }
        else {
            pendingCount = raw === pendingRaw ? pendingCount + 1 : 1;
            pendingRaw = raw;
            if (pendingCount >= confirmMinutes) { signal = raw; pendingRaw = null; pendingCount = 0; }
        }
        return { minute, ma, prevMa: previousMa, slope, n, raw, signal, transition: signal !== from, from };
    }

    // Returns an array of completed-minute events (0 or 1 normally).
    function addTick(price, tsMs) {
        if (!(typeof price === "number" && Number.isFinite(price) && price > 0)) return [];
        const m = Math.floor(tsMs / MIN_MS);
        const out = [];
        if (bucketMin !== null && m < bucketMin) return out;           // late / out-of-order tick of a closed minute: ignore
        if (bucketMin !== null && m > bucketMin) { const ev = closeMinute(); if (ev) out.push(ev); }
        if (bucketMin === null) bucketMin = m;
        ticks.push(price);
        return out;
    }

    // Close the open minute once the wall clock has moved past it (quiet market: no later tick would do it).
    function flush(nowMs) {
        if (bucketMin !== null && Math.floor(nowMs / MIN_MS) > bucketMin) { const ev = closeMinute(); return ev ? [ev] : []; }
        return [];
    }

    return {
        addTick, flush,
        getSignal: () => signal,
        getState: () => ({ prev, signal }),
        restore: s => { if (s && s.prev && Number.isFinite(s.prev.ma) && Number.isFinite(s.prev.minute)) prev = { minute: s.prev.minute, ma: s.prev.ma }; if (s && (s.signal === "GREEN" || s.signal === "RED")) signal = s.signal; },
    };
}

module.exports = { createPriceMaSignal };
