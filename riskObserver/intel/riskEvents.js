// riskObserver/intel/riskEvents.js — Phase 3: risk-event lifecycle engine. Deterministic; the clock is passed in.
// Lifecycle per (position, kind):  OPEN -> (UPDATE on severity change) -> CLEAR after `clearAfter` consecutive evaluations without it.
// Deduplication: an already-open kind emits nothing unless severity changes. Persistence is injected and CONTAINED: a failing
// persist() never throws into the caller. Events are informational records — nothing consumes them to act on a position.
"use strict";
const { SEVERITY } = require("./assess");

function createRiskEventEngine({ persist = null, clearAfter = 2, cooldownMs = 0, onError = null } = {}) {
    const active = new Map();   // key -> { kind, severity, openedAt, absent, lastEmitTs }
    const closedAt = new Map(); // key -> ts of last CLEAR (cooldown for re-open noise)
    let persistErrors = 0;
    const out = (list, e) => { list.push(e); if (persist) { try { const r = persist(e); if (r && typeof r.catch === "function") r.catch(err => { persistErrors++; if (onError) try { onError(err); } catch { /* contained */ } }); } catch (err) { persistErrors++; if (onError) try { onError(err); } catch { /* contained */ } } } };

    // assessment: output of assess(); posKey identifies the position (engine + id). Returns the lifecycle events produced this call.
    function process(posKey, assessment) {
        const list = [], ts = assessment.ts, seen = new Set();
        if (assessment.classification === "UNKNOWN" && assessment.events.every(e => e.kind === "DATA_UNRELIABLE" || e.kind === "POSITION_RECONCILIATION_WARNING")) { /* unknown assessments still record their data-health events below, but never CLEAR real risk kinds */ }
        const unknown = assessment.classification === "UNKNOWN";
        for (const e of assessment.events) {
            const key = posKey + "|" + e.kind; seen.add(key);
            const cur = active.get(key);
            if (!cur) {
                const cd = closedAt.get(key); if (cd !== undefined && ts - cd < cooldownMs) continue;
                active.set(key, { kind: e.kind, severity: e.severity, openedAt: ts, absent: 0 });
                out(list, { lifecycle: "OPEN", posKey, kind: e.kind, severity: e.severity, ts, evidence: e.evidence, explanation: e.explanation, informational: true });
            } else {
                cur.absent = 0;
                if (SEVERITY[e.severity] !== SEVERITY[cur.severity]) { const from = cur.severity; cur.severity = e.severity; out(list, { lifecycle: "UPDATE", posKey, kind: e.kind, severity: e.severity, previousSeverity: from, ts, evidence: e.evidence, explanation: e.explanation, informational: true }); }
            }
        }
        for (const [key, cur] of [...active]) {
            if (!key.startsWith(posKey + "|") || seen.has(key)) continue;
            // An UNKNOWN assessment carries no evidence either way: it must neither clear nor confirm real risk events.
            if (unknown && cur.kind !== "DATA_UNRELIABLE") continue;
            cur.absent++;
            if (cur.absent >= clearAfter) { active.delete(key); closedAt.set(key, ts); out(list, { lifecycle: "CLEAR", posKey, kind: cur.kind, severity: cur.severity, ts, openedAt: cur.openedAt, informational: true, explanation: `${cur.kind} no longer present for ${clearAfter} evaluations.` }); }
        }
        return list;
    }
    // A position closing ends all its events (so nothing stays "active" for a flat instrument).
    function closePosition(posKey, ts) {
        const list = [];
        for (const [key, cur] of [...active]) if (key.startsWith(posKey + "|")) { active.delete(key); closedAt.set(key, ts); out(list, { lifecycle: "CLEAR", posKey, kind: cur.kind, severity: cur.severity, ts, openedAt: cur.openedAt, informational: true, explanation: "position closed" }); }
        return list;
    }
    return { process, closePosition, activeKinds: posKey => [...active.keys()].filter(k => k.startsWith(posKey + "|")).map(k => k.split("|")[1]), stats: () => ({ active: active.size, persistErrors }) };
}
module.exports = { createRiskEventEngine };
