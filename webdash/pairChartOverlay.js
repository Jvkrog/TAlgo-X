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
        // The journals span every contract the pair has traded; the chart shows ONE contract, so keep only that contract's trades
        // (the pair's configured core contract, else the contract of the newest core trade).
        let curCore = p.coreSymbol || null;
        if (!curCore) {
            const cdb = await ai.openRo(g.baseJournal);
            if (cdb) { try { const r0 = await ai.all(cdb, "SELECT instrument FROM trades ORDER BY id DESC LIMIT 1"); curCore = r0[0] && r0[0].instrument || null; } catch { /* no table */ } cdb.close(); }
        }
        for (const [file, role, color] of [[g.baseJournal, "CORE", "#ffb347"], [g.hedgeJournal, "HEDGE", "#5cd6ff"]]) {
            const db = await ai.openRo(file); if (!db) continue;
            const want = role === "CORE" ? curCore : (p.hedgeSymbol || curCore);
            let rows = [];
            try { rows = await ai.all(db, "SELECT instrument, side, entry_price, entry_time, exit_price, exit_time, pnl, status FROM trades ORDER BY id DESC LIMIT 300"); } catch { /* no table yet */ }
            db.close();
            if (want) rows = rows.filter(r => !r.instrument || r.instrument === want);
            for (const r of rows) {
                const inT = Date.parse(r.entry_time), outT = r.exit_time ? Date.parse(r.exit_time) : null, long = r.side === "LONG";
                // Entry-price line for EVERY trade in the window: from the entry bar to the exit bar (or to now while it is still open).
                if (Number.isFinite(inT) && (outT === null || outT >= fromTs) && lines.length < 120) {
                    const a = snap(Math.max(inT, firstT)) ?? firstT, z = outT === null ? lastT : (snap(outT) ?? lastT);
                    if (z > a) lines.push({ name: `${role.toLowerCase()} entry ${r.side} @${r.entry_price}${outT === null ? " (open)" : ""}`, color, width: 1, points: [[a, r.entry_price], [z, r.entry_price]] });
                }
                const st = snap(inT);
                if (st !== null && st >= fromTs - 86400000) markers.push({ t: st, dir: long ? 1 : -1, color, text: `${role[0]} ${long ? "L" : "S"}` });
                if (outT !== null) { const et = snap(outT); if (et !== null && et >= fromTs - 86400000) markers.push({ t: et, dir: long ? -1 : 1, color, text: `${role[0]} X${Number.isFinite(r.pnl) ? ` ${r.pnl >= 0 ? "+" : ""}${Math.round(r.pnl)}` : ""}` }); }
            }
        }
        markers.sort((a, b) => a.t - b.t);
        return { label: "Hedge pair — amber = core, cyan = hedge; arrows = fills (C = core, H = hedge; L/S side, X exit with P&L) — prices are in the line names / axis tags; a horizontal line at every entry price, from the entry to the exit (or now while open)", lines, markers };
    } catch (err) { return { note: "pair markers unavailable: " + err.message }; }
}

// Dual-hedge (two accounts, one instrument): fills + entry-price lines from BOTH accounts' journals on the deployment's contract.
// LONG account = amber, SHORT account = cyan. Merged by the server into the band overlay it already draws.
async function dualEntryOverlay(d, tfBars, fromTs) {
    try {
        const ai = require("../ai/aiReview");
        const slug = String(d.underlying).toLowerCase().replace(/[^a-z0-9]+/g, "_");
        const groups = ai.pairGroups().filter(g => g.kind === "DUAL_HEDGE" && g.instrument === slug);
        if (!groups.length) return { lines: [], markers: [] };
        const times = tfBars.map(b => b.date.getTime()), firstT = times[0], lastT = times[times.length - 1];
        const snap = t => { if (!(t >= firstT)) return null; let lo = 0, hi = times.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t) lo = mid; else hi = mid - 1; } return times[lo]; };
        const lines = [], markers = [];
        let cur = d.longContract || d.contractSymbol || null;
        const jobs = [];
        for (const g of groups) jobs.push([g.longJournal, "LONG-acct", "#ffb347"], [g.shortJournal, "SHORT-acct", "#5cd6ff"]);
        const loaded = [];
        for (const [file, role, color] of jobs) {
            const db = await ai.openRo(file); if (!db) continue;
            let rows = [];
            try { rows = await ai.all(db, "SELECT instrument, side, entry_price, entry_time, exit_price, exit_time, pnl, status FROM trades ORDER BY id DESC LIMIT 300"); } catch { /* no table yet */ }
            db.close(); loaded.push([role, color, rows]);
        }
        if (!cur) { const newest = loaded.flatMap(x => x[2]).sort((a, b) => Date.parse(b.entry_time) - Date.parse(a.entry_time))[0]; cur = newest && newest.instrument || null; }
        for (const [role, color, all] of loaded) {
            const rows = cur ? all.filter(r => !r.instrument || r.instrument === cur) : all;
            for (const r of rows) {
                const inT = Date.parse(r.entry_time), outT = r.exit_time ? Date.parse(r.exit_time) : null, long = r.side === "LONG";
                if (Number.isFinite(inT) && (outT === null || outT >= fromTs) && lines.length < 120) {
                    const a = snap(Math.max(inT, firstT)) ?? firstT, z = outT === null ? lastT : (snap(outT) ?? lastT);
                    if (z > a) lines.push({ name: `${role} entry ${r.side} @${r.entry_price}${outT === null ? " (open)" : ""}`, color, width: 1, points: [[a, r.entry_price], [z, r.entry_price]] });
                }
                const st = snap(inT);
                if (st !== null && st >= fromTs - 86400000) markers.push({ t: st, dir: long ? 1 : -1, color, text: `${role === "LONG-acct" ? "A1" : "A2"} ${long ? "L" : "S"}` });
                if (outT !== null) { const et = snap(outT); if (et !== null && et >= fromTs - 86400000) markers.push({ t: et, dir: long ? -1 : 1, color, text: `${role === "LONG-acct" ? "A1" : "A2"} X${Number.isFinite(r.pnl) ? ` ${r.pnl >= 0 ? "+" : ""}${Math.round(r.pnl)}` : ""}` }); }
            }
        }
        markers.sort((a, b) => a.t - b.t);
        return { lines, markers };
    } catch (err) { return { lines: [], markers: [], note: "dual entries unavailable: " + err.message }; }
}

module.exports = { pairChartOverlay, dualEntryOverlay };
