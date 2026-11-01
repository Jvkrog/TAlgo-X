// riskObserver/coverage.js — session-aware proof that recorded 15m candles cover a time window.
// Shared by the live observer (candle-metric coverage) and the offline calibration (clean-sample test).
//
// A window [fromTs, toTs) is COMPLETE only when every expected exchange-session slot inside it has a recorded candle,
// or the slot is explained by EVIDENCE:
//   * brokerEmpty — Kite was asked repeatedly and confirmed it has no candle for that slot, or
//   * closureDays — the exchange day was probed and Kite has no candles for it at all (holiday / closure).
// A missing slot WITHOUT evidence is a gap, never assumed to be a holiday. Weekends / overnight are not session slots.
// Conservative: when completeness cannot be established, complete === false.
"use strict";

const { isSessionSlot } = require("./priceMonitor");
const IST_MS = 5.5 * 3600 * 1000;
const dayKey = ts => new Date(ts + IST_MS).toISOString().slice(0, 10);
const fmt = ts => new Date(ts + IST_MS).toISOString().replace("T", " ").slice(0, 16) + " IST";

function coverageReport({ haveTs, fromTs, toTs, tfMs = 15 * 60000, session, brokerEmpty = [], closureDays = [], maxSlots = 20000 }) {
    const have = haveTs instanceof Set ? haveTs : new Set(haveTs), be = brokerEmpty instanceof Set ? brokerEmpty : new Set(brokerEmpty), cd = closureDays instanceof Set ? closureDays : new Set(closureDays);
    const firstSlot = Math.ceil(fromTs / tfMs) * tfMs;                 // first candle that OPENS at/after the window start
    const lastSlot = Math.floor(toTs / tfMs) * tfMs - tfMs;            // last candle that is COMPLETE by the window end
    const out = { complete: true, expected: 0, have: 0, missing: [], brokerEmptySlots: 0, closureSlots: 0, firstSlot, lastSlot, reasons: [], missingDays: [] };
    if (!(toTs > fromTs) || lastSlot < firstSlot) { out.note = "no completed 15m candle slot inside the window"; return out; }
    if ((lastSlot - firstSlot) / tfMs > maxSlots) { out.complete = false; out.reasons.push("window too long to verify"); return out; }
    const perDay = new Map();   // day -> { expected, missing }
    let firstExpected = null, lastExpected = null;
    for (let s = firstSlot; s <= lastSlot; s += tfMs) {
        if (!isSessionSlot(s, session)) continue;
        const day = dayKey(s);
        if (cd.has(day)) { out.closureSlots++; continue; }
        out.expected++; if (firstExpected === null) firstExpected = s; lastExpected = s;
        const d = perDay.get(day) || { expected: 0, missing: 0 }; d.expected++; perDay.set(day, d);
        if (have.has(s)) { out.have++; continue; }
        if (be.has(s)) { out.brokerEmptySlots++; continue; }
        out.missing.push(s); d.missing++;
    }
    out.firstExpected = firstExpected; out.lastExpected = lastExpected;
    if (out.missing.length) {
        out.complete = false;
        const m = out.missing;
        if (firstExpected !== null && m[0] === firstExpected) out.reasons.push(`first expected candle ${fmt(firstExpected)} is missing`);
        if (lastExpected !== null && m[m.length - 1] === lastExpected) out.reasons.push(`last expected candle ${fmt(lastExpected)} is missing`);
        for (const [day, d] of perDay) if (d.missing === d.expected) { out.missingDays.push(day); out.reasons.push(`no candles at all for session day ${day} and no closure evidence (not assumed to be a holiday)`); }
        const internal = m.filter(s => s !== firstExpected && s !== lastExpected && !out.missingDays.includes(dayKey(s))).length;
        if (internal) out.reasons.push(`${internal} candle(s) missing inside the window`);
        if (!out.reasons.length) out.reasons.push(`${m.length} expected candle(s) missing`);
    }
    return out;
}

module.exports = { coverageReport, dayKey, fmt };
