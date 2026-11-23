"use strict";
// Hedge-pair chart overlay from the pair's SQLite journals: core entry price as a line while the core is open, the hedge entry price while
// a hedge is on, and a marker for every core / hedge fill in the window (markers snap to the bar they happened in).
async function pairChartOverlay(p, tfBars, fromTs) {
    try {
        const ai = require("../ai/aiReview");
        const slug = String(p.underlying).toLowerCase().replace(/[^a-z0-9]+/g, "_");
        const groups = ai.pairGroups().filter(g => g.kind === "HEDGE_PAIR");
        const g = groups.find(x => x.instrument === slug) || (groups.length === 1 ? groups[0] : null);
        if (!g) return { note: "no journals found for this hedge pair yet — markers appear after its first trade" };
        const times = tfBars.map(b => b.date.getTime()), firstT = times[0], lastT = times[times.length - 1];
        const snap = t => { if (!(t >= firstT)) return null; let lo = 0, hi = times.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t) lo = mid; else hi = mid - 1; } return times[lo]; };
        const lines = [], markers = [];
        for (const [file, role, color] of [[g.baseJournal, "CORE", "#ffb347"], [g.hedgeJournal, "HEDGE", "#5cd6ff"]]) {
            const db = await ai.openRo(file); if (!db) continue;
            let rows = [];
            try { rows = await ai.all(db, "SELECT side, entry_price, entry_time, exit_price, exit_time, pnl, status FROM trades ORDER BY id DESC LIMIT 300"); } catch { /* no table yet */ }
            db.close();
            for (const r of rows) {
                const inT = Date.parse(r.entry_time), outT = r.exit_time ? Date.parse(r.exit_time) : null, long = r.side === "LONG";
                if (r.status === "OPEN" && Number.isFinite(inT)) lines.push({ name: `${role.toLowerCase()} entry ${r.side} @${r.entry_price}`, color, width: 1, points: [[Math.max(snap(Math.max(inT, fromTs)) ?? firstT, firstT), r.entry_price], [lastT, r.entry_price]] });
                const st = snap(inT);
                if (st !== null && st >= fromTs - 86400000) markers.push({ t: st, dir: long ? 1 : -1, color, text: `${role} ${long ? "L" : "S"} @${r.entry_price}` });
                if (outT !== null) { const et = snap(outT); if (et !== null && et >= fromTs - 86400000) markers.push({ t: et, dir: long ? -1 : 1, color, text: `${role} X @${r.exit_price}${Number.isFinite(r.pnl) ? ` (${r.pnl >= 0 ? "+" : ""}${Math.round(r.pnl)})` : ""}` }); }
            }
        }
        markers.sort((a, b) => a.t - b.t);
        return { label: "Hedge pair — amber = core, cyan = hedge; arrows = fills from the pair's journals; lines = entry price of an open core / hedge", lines, markers };
    } catch (err) { return { note: "pair markers unavailable: " + err.message }; }
}

module.exports = { pairChartOverlay };
