// riskObserver/dsbMonitor.js — independent 15m Dual-DSB observation. Own candle store, own steppers; shares NO mutable
// indicator state with the primary strategy. Uses the existing createBandStepper (dynamicBandReader.js) on Heikin-Ashi
// candles with the same DSB 1 / DSB 2 steps as the 1H DSB_DUAL — the same indicator code, not an approximation.
"use strict";

const { createBandStepper } = require("../dynamicBandReader");
const { toHAAlways } = require("../indicators");

const colorOf = st => (st && st.position === "LONG" ? "green" : st && st.position === "SHORT" ? "red" : "none");

// Dual DSB read of a bar series: per-bar colours for both bands (so streaks can be derived) + the latest state.
function dualReplay(bars, step1, step2) {
    const ha = toHAAlways(bars);
    const s1 = createBandStepper(step1), s2 = createBandStepper(step2);
    const rows = [];
    for (let i = 0; i < ha.length; i++) {
        s1.push(ha[i]); s2.push(ha[i]);
        rows.push({ ts: bars[i].ts, c1: colorOf(s1.state()), c2: colorOf(s2.state()) });
    }
    return rows;
}

// How a colour pair relates to a position: aligned / disagree / opposite / undecided
function relation(side, c1, c2) {
    if (c1 === "none" || c2 === "none") return "undecided";
    const want = side === "LONG" ? "green" : "red", opp = side === "LONG" ? "red" : "green";
    if (c1 === want && c2 === want) return "aligned";
    if (c1 === opp && c2 === opp) return "opposite";
    return "disagree";
}

// createDsbMonitor({ step1, step2, tfMs, maxBars })
//   addCandles(list) — completed candles only ({ts,open,high,low,close}); duplicates ignored; returns number newly added
function createDsbMonitor({ step1, step2, tfMs = 15 * 60000, maxBars = 600 }) {
    const byTs = new Map();
    let rows = [], dirty = false;
    function addCandles(list) {
        let n = 0;
        for (const c of list) {
            if (!Number.isFinite(c.ts) || ![c.open, c.high, c.low, c.close].every(Number.isFinite)) continue;
            if (byTs.has(c.ts)) continue;
            byTs.set(c.ts, c); n++;
        }
        if (n) {
            if (byTs.size > maxBars) for (const k of [...byTs.keys()].sort((a, b) => a - b).slice(0, byTs.size - maxBars)) byTs.delete(k);
            dirty = true;
        }
        return n;
    }
    const ordered = () => [...byTs.values()].sort((a, b) => a.ts - b.ts);
    function recompute() { if (dirty) { rows = dualReplay(ordered(), step1, step2); dirty = false; } return rows; }
    function latest() { const r = recompute(); return r.length ? r[r.length - 1] : null; }
    // Disagreement streak = trailing completed candles where both colours are known and differ; durationMs from the first of them
    function disagreement() {
        const r = recompute(); let n = 0;
        for (let i = r.length - 1; i >= 0; i--) { if (r[i].c1 !== "none" && r[i].c2 !== "none" && r[i].c1 !== r[i].c2) n++; else break; }
        return { candles: n, durationMs: n ? (r[r.length - 1].ts + tfMs) - r[r.length - n].ts : 0 };
    }
    return { addCandles, latest, disagreement, size: () => byTs.size, lastTs: () => (byTs.size ? Math.max(...byTs.keys()) : null), candles: ordered };
}

module.exports = { createDsbMonitor, dualReplay, relation, colorOf };
