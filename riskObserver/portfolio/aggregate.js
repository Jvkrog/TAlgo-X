// riskObserver/portfolio/aggregate.js — Phase 4: portfolio-level exposure, concentration, drawdown, correlation. PURE.
// Inputs are SNAPSHOTS handed in by the caller (read-only); nothing here can reach a broker, an order or an engine.
// Every number is labelled by provenance: "broker" (reported by the broker) vs "estimate" (derived here). Nothing is invented:
// missing/stale inputs make a value null with a reason, and are counted in `unreliable`.
"use strict";

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const keyOf = p => [p.engine, p.instrument, p.layer || "-", p.id ?? "-"].join("|");

// positions: [{ engine, instrument, layer: "FAST"|"SLOW"|null, id, side: "LONG"|"SHORT", lastPrice, perPoint (₹ per price point, qty-inclusive),
//               pnl (₹, unrealised), pnlSource: "broker"|"estimate", reliable: bool, priceAgeMs }]
// capital: { value, source: "broker"|"configured" } | null
function aggregate(positions, capital = null) {
    const seen = new Map(), duplicates = [], used = [];
    for (const p of Array.isArray(positions) ? positions : []) {
        if (!p || (p.side !== "LONG" && p.side !== "SHORT")) { duplicates.push({ reason: "malformed", position: p && keyOf(p) }); continue; }
        const k = keyOf(p); if (seen.has(k)) { duplicates.push({ reason: "duplicate", key: k }); continue; } seen.set(k, true); used.push(p);
    }
    const rows = used.map(p => {
        const price = num(p.lastPrice), pp = num(p.perPoint), reliable = p.reliable !== false && price !== null && pp !== null;
        const notional = price !== null && pp !== null ? Math.abs(price * pp) : null;   // ESTIMATE: price × (qty × multiplier)
        return { key: keyOf(p), engine: p.engine, instrument: p.instrument, layer: p.layer || null, side: p.side, sign: p.side === "LONG" ? 1 : -1, notional, pnl: num(p.pnl), pnlSource: p.pnlSource || "estimate", reliable };
    });
    const rel = rows.filter(r => r.reliable && r.notional !== null);
    const gross = rel.reduce((a, r) => a + r.notional, 0);
    const group = (field) => { const m = new Map(); for (const r of rel) { const k = r[field] ?? "-"; const g = m.get(k) || { key: k, positions: 0, gross: 0, net: 0, pnl: 0 }; g.positions++; g.gross += r.notional; g.net += r.sign * r.notional; g.pnl += r.pnl ?? 0; m.set(k, g); } return [...m.values()].map(g => ({ ...g, share: gross > 0 ? g.gross / gross : null })).sort((a, b) => b.gross - a.gross || String(a.key).localeCompare(String(b.key))); };
    const byInstrument = group("instrument"), byEngine = group("engine"), byLayer = group("layer");
    const hhi = gross > 0 ? byInstrument.reduce((a, g) => a + g.share * g.share, 0) : null;
    const pnls = rows.filter(r => r.reliable && r.pnl !== null);
    return {
        positions: rows.length, reliablePositions: rel.length, unreliable: rows.filter(r => !r.reliable).map(r => r.key), duplicatesRejected: duplicates,
        gross: { value: gross, provenance: "estimate", note: "price × perPoint at the last observed price; not a broker margin figure" },
        // Net is only a meaningful number within ONE instrument; across instruments it is reported by instrument and the pooled value is flagged.
        netByInstrument: byInstrument.map(g => ({ instrument: g.key, net: g.net, direction: g.net > 0 ? "LONG" : g.net < 0 ? "SHORT" : "FLAT" })),
        netPooled: { value: rel.reduce((a, r) => a + r.sign * r.notional, 0), meaningful: byInstrument.length <= 1, note: byInstrument.length > 1 ? "pooled across different instruments — not a hedge/exposure measure" : null },
        byInstrument, byEngine, byLayer,
        concentration: { top: byInstrument[0] ? { instrument: byInstrument[0].key, share: byInstrument[0].share } : null, hhi, level: hhi === null ? "UNKNOWN" : hhi >= 0.6 ? "HIGH" : hhi >= 0.35 ? "MODERATE" : "LOW" },
        pnl: { value: pnls.length === rows.length ? pnls.reduce((a, r) => a + r.pnl, 0) : null, partialValue: pnls.reduce((a, r) => a + r.pnl, 0), complete: pnls.length === rows.length && rows.length > 0, provenance: pnls.every(r => r.pnlSource === "broker") && pnls.length ? "broker" : "estimate" },
        capitalUtilisation: capital && num(capital.value) > 0 ? { value: gross / capital.value, provenance: "estimate", capitalSource: capital.source || "unknown", note: "gross notional ÷ capital, not margin utilisation" } : { value: null, reason: "no reliable capital figure supplied" },
    };
}

// Streaming drawdown: peak and drawdown are computed from RELIABLE complete samples only. An unreliable sample is recorded as an
// unknown interval — it neither raises the peak nor is treated as a loss/recovery.
function createDrawdownTracker() {
    let peak = null, peakTs = null, last = null, unknownSamples = 0, samples = 0, maxDd = 0, maxDdTs = null, lastTs = null;
    return {
        update(ts, snapshot) {   // snapshot: { pnl: number|null, complete: bool, contributions: { engine: pnl } }
            if (!Number.isFinite(ts) || (lastTs !== null && ts < lastTs)) return { accepted: false, reason: "non-monotonic or invalid timestamp" };
            lastTs = ts; samples++;
            if (!snapshot || snapshot.complete !== true || num(snapshot.pnl) === null) { unknownSamples++; return { accepted: true, known: false, peak, drawdown: last ? last.drawdown : null }; }
            if (peak === null || snapshot.pnl > peak) { peak = snapshot.pnl; peakTs = ts; }
            const dd = peak - snapshot.pnl; if (dd > maxDd) { maxDd = dd; maxDdTs = ts; }
            last = { ts, pnl: snapshot.pnl, drawdown: dd, contributions: snapshot.contributions || {} };
            return { accepted: true, known: true, peak, drawdown: dd };
        },
        state: () => ({ peak, peakTs, current: last, maxDrawdown: maxDd, maxDrawdownTs: maxDdTs, samples, unknownSamples, note: "drawdown measured from the peak of RELIABLE aggregate unrealised P&L samples; unknown samples are excluded" }),
    };
}

// Pearson correlation of simple returns on SYNCHRONISED bars. Refuses (never invents) when overlap is too thin or sampling differs.
function correlation(a, b, { minOverlap = 30, minCoverage = 0.8 } = {}) {
    const mapB = new Map((b || []).filter(x => x && Number.isFinite(x.ts) && Number.isFinite(x.close)).map(x => [x.ts, x.close]));
    const ts = (a || []).filter(x => x && Number.isFinite(x.ts) && Number.isFinite(x.close) && mapB.has(x.ts)).map(x => x.ts).sort((p, q) => p - q);
    const union = new Set([...(a || []).map(x => x.ts), ...mapB.keys()]).size, coverage = union ? ts.length / union : 0;
    if (ts.length < minOverlap + 1) return { status: "INSUFFICIENT", overlap: ts.length, coverage, reason: `only ${ts.length} synchronised bars (< ${minOverlap + 1})` };
    if (coverage < minCoverage) return { status: "INSUFFICIENT", overlap: ts.length, coverage, reason: `bars overlap on only ${(coverage * 100).toFixed(0)}% of timestamps (asynchronous/missing data)` };
    const ca = new Map(a.map(x => [x.ts, x.close])), ra = [], rb = [];
    for (let i = 1; i < ts.length; i++) { const p0 = ca.get(ts[i - 1]), p1 = ca.get(ts[i]), q0 = mapB.get(ts[i - 1]), q1 = mapB.get(ts[i]); if (p0 > 0 && q0 > 0) { ra.push(p1 / p0 - 1); rb.push(q1 / q0 - 1); } }
    const n = ra.length, ma = ra.reduce((x, y) => x + y, 0) / n, mb = rb.reduce((x, y) => x + y, 0) / n;
    let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const da = ra[i] - ma, db = rb[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    if (saa === 0 || sbb === 0) return { status: "INSUFFICIENT", overlap: ts.length, coverage, reason: "one series has zero variance" };
    return { status: "OK", value: sab / Math.sqrt(saa * sbb), overlap: ts.length, returns: n, coverage, note: "correlation of bar-to-bar returns over the overlap window; association only, not causation, and unstable across regimes" };
}

// Shared-risk view: positions on instruments whose measured correlation is strong AND whose direction makes them add (or offset) risk.
function sharedRisk(rows, corr, { threshold = 0.7 } = {}) {
    const out = [], sig = new Map(); for (const r of rows) { const g = sig.get(r.instrument) || { instrument: r.instrument, net: 0 }; g.net += r.sign * (r.notional || 0); sig.set(r.instrument, g); }
    const list = [...sig.values()].sort((a, b) => a.instrument.localeCompare(b.instrument));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const c = corr[list[i].instrument + "|" + list[j].instrument] || corr[list[j].instrument + "|" + list[i].instrument];
        if (!c || c.status !== "OK") { out.push({ pair: [list[i].instrument, list[j].instrument], status: "UNKNOWN", reason: c ? c.reason : "no correlation measured" }); continue; }
        if (Math.abs(c.value) < threshold) continue;
        const same = Math.sign(list[i].net) * Math.sign(list[j].net) * Math.sign(c.value);   // >0: moves together AND positions point the same effective way
        out.push({ pair: [list[i].instrument, list[j].instrument], correlation: c.value, effect: same > 0 ? "COMPOUNDING" : same < 0 ? "OFFSETTING" : "NEUTRAL", overlap: c.overlap, note: c.note });
    }
    return out;
}
module.exports = { aggregate, createDrawdownTracker, correlation, sharedRisk };
