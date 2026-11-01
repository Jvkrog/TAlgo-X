// riskObserver/obsHealth.js — Phase 6: structured observer health from a published snapshot. PURE.
// Levels: OK | DEGRADED | DOWN | UNKNOWN. A snapshot that is silent for too long is DOWN/STALE, never "last known OK".
"use strict";

function observerHealth(snapshot, receivedAt, nowMs, { silentAfterMs = 60000 } = {}) {
    if (!snapshot) return { level: "UNKNOWN", reasons: ["no snapshot received from the observer"], liveness: "UNKNOWN" };
    const ageMs = Number.isFinite(receivedAt) ? nowMs - receivedAt : null, reasons = [], rt = snapshot.runtime || {};
    const silent = ageMs === null || ageMs > silentAfterMs;
    const init = snapshot.init || {}, store = snapshot.storeHealth || {}, rest = (snapshot.restHealth || {}).status, ltp = (snapshot.ltpHealth || {}).status;
    let level = "OK";
    const worse = (l, why) => { reasons.push(why); const r = { OK: 0, DEGRADED: 1, DOWN: 2 }; if (r[l] > r[level]) level = l; };
    if (silent) worse("DOWN", `observer silent for ${ageMs === null ? "an unknown time" : Math.round(ageMs / 1000) + "s"} — data below is NOT live`);
    if (init.state === "failed") worse("DOWN", `observer start failed (${init.failures} attempt(s)): ${init.error || "unknown error"}`);
    else if (init.state && init.state !== "running") worse("DEGRADED", `observer lifecycle: ${init.state}`);
    if (store.errors > 0) worse("DEGRADED", `${store.errors} database write error(s): ${store.lastError || "unknown"}`);
    if (rest && rest !== "HEALTHY") worse("DEGRADED", `15m candle feed ${rest}`);
    if (ltp && ltp !== "HEALTHY" && ltp !== "CLOSED") worse("DEGRADED", `live price ${ltp}`);
    const rec = snapshot.reconcileNote && snapshot.entry && snapshot.entry.origin !== "observed_from_entry" ? `position origin ${snapshot.entry.origin}` : null;
    return {
        level, reasons, liveness: silent ? "SILENT" : "LIVE", snapshotAgeMs: ageMs,
        uptimeMs: Number.isFinite(rt.startedAt) && !silent ? snapshot.ts - rt.startedAt : null, processingLatencyMs: Number.isFinite(rt.lastEvalMs) ? rt.lastEvalMs : null,
        freshness: { candleFetchOkAt: (snapshot.freshness || {}).last15mFetchOkAt ?? null, lastPriceAgeMs: snapshot.lastPriceAgeMs ?? null, backfillOkAt: snapshot.lastBackfillOkAt ?? null },
        database: { schemaVersion: store.schemaVersion ?? null, errors: store.errors || 0, healthy: !(store.errors > 0) }, reconciliation: { healthy: !rec, note: rec, text: snapshot.reconcileNote || null },
        dataReliability: snapshot.riskReliable === false ? "UNRELIABLE" : silent ? "STALE" : "RELIABLE",
    };
}
module.exports = { observerHealth };
