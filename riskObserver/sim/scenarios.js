// riskObserver/sim/scenarios.js — Phase 5: configurable stress scenarios. PURE, deterministic (no randomness, no clock).
// A scenario transforms a historical/synthetic CLOSED-candle series and/or declares data-health interruptions. The result is
// always labelled SIMULATED. Nothing here has any access to orders, positions, brokers, sockets or databases.
"use strict";

const clone = cs => cs.map(c => ({ ...c }));
// Shift every candle from index i on by `delta` (a gap: the following prices live on a new level), preserving each bar's shape.
const shiftFrom = (cs, i, delta) => { for (let k = i; k < cs.length; k++) { cs[k].open += delta; cs[k].high += delta; cs[k].low += delta; cs[k].close += delta; } };
const scaleRange = (c, f) => { const mid = (c.open + c.close) / 2; c.high = mid + (c.high - mid) * f; c.low = mid + (c.low - mid) * f; c.open = mid + (c.open - mid) * f; c.close = mid + (c.close - mid) * f; };

// type → apply(candles, params, ctx{ side }) => { candles, health: [{fromTs,toTs,cause}], restarts: [ts], slippagePts }
const TYPES = {
    adverse_gap: (cs, p, { side }) => { const i = Math.max(0, Math.min(cs.length - 1, p.atIndex)); const delta = (side === "LONG" ? -1 : 1) * Math.abs(p.points); shiftFrom(cs, i, delta); return {}; },
    volatility_expansion: (cs, p) => { for (let k = Math.max(0, p.fromIndex); k < Math.min(cs.length, p.fromIndex + (p.length ?? cs.length)); k++) scaleRange(cs[k], p.factor); return {}; },
    sideways: (cs, p) => { const a = Math.max(0, p.fromIndex), lvl = cs[Math.max(0, a - 1)].close, amp = p.amplitude; for (let k = a; k < Math.min(cs.length, a + p.length); k++) { const dir = (k - a) % 2 ? 1 : -1; cs[k].open = lvl; cs[k].close = lvl + dir * amp * 0.5; cs[k].high = lvl + amp; cs[k].low = lvl - amp; } if (a + p.length < cs.length) shiftFrom(cs, a + p.length, lvl - cs[a + p.length].open); return {}; },
    rapid_reversal: (cs, p, { side }) => { const i = Math.max(1, Math.min(cs.length - 1, p.atIndex)); const dir = side === "LONG" ? -1 : 1; for (let k = i; k < Math.min(cs.length, i + (p.length ?? 3)); k++) { const mv = dir * Math.abs(p.pointsPerBar); cs[k].open = cs[k - 1].close; cs[k].close = cs[k].open + mv; cs[k].high = Math.max(cs[k].open, cs[k].close) + Math.abs(mv) * 0.1; cs[k].low = Math.min(cs[k].open, cs[k].close) - Math.abs(mv) * 0.1; } const end = Math.min(cs.length, i + (p.length ?? 3)); if (end < cs.length) shiftFrom(cs, end, cs[end - 1].close - cs[end].open); return {}; },
    slippage: (cs, p) => ({ slippagePts: Math.abs(p.points) }),   // applied to entry AND exit fills by the simulator (adverse both ways)
    delayed_data: (cs, p) => ({ health: [{ fromTs: cs[Math.max(0, p.fromIndex)].ts, toTs: cs[Math.min(cs.length - 1, p.fromIndex + p.bars - 1)].ts, cause: "rest" }] }),
    missing_candles: (cs, p) => { const drop = new Set(p.indices || []); const kept = cs.filter((_, i) => !drop.has(i)); cs.length = 0; cs.push(...kept); return { missingTs: [...drop] }; },
    ws_interruption: (cs, p) => ({ health: [{ fromTs: cs[Math.max(0, p.fromIndex)].ts, toTs: cs[Math.min(cs.length - 1, p.fromIndex + p.bars - 1)].ts, cause: "ltp" }] }),
    rest_failure: (cs, p) => ({ health: [{ fromTs: cs[Math.max(0, p.fromIndex)].ts, toTs: cs[Math.min(cs.length - 1, p.fromIndex + p.bars - 1)].ts, cause: "rest" }] }),
    observer_restart: (cs, p) => ({ restarts: [cs[Math.max(0, Math.min(cs.length - 1, p.atIndex))].ts] }),
};

// steps: [{ type, ...params }]  — applied in order to a COPY; the input series is never modified.
function applyScenario(candles, steps, ctx) {
    if (!Array.isArray(candles)) throw new Error("applyScenario: candles must be an array");
    const cs = clone(candles), res = { candles: cs, health: [], restarts: [], slippagePts: 0, missingTs: [], applied: [] };
    for (const s of steps || []) {
        const f = TYPES[s && s.type]; if (!f) throw new Error(`unknown scenario type: ${s && s.type}`);
        const before = cs.map(c => c.ts), r = f(cs, s, ctx || {}) || {};
        if (r.health) res.health.push(...r.health); if (r.restarts) res.restarts.push(...r.restarts); if (r.slippagePts) res.slippagePts += r.slippagePts;
        if (s.type === "missing_candles") res.missingTs.push(...(s.indices || []).map(i => before[i]).filter(Number.isFinite));
        res.applied.push(s.type);
    }
    res.label = "SIMULATED"; return res;
}
module.exports = { applyScenario, SCENARIO_TYPES: Object.keys(TYPES) };
