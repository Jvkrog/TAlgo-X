#!/usr/bin/env node
// Remove never-happened trades (e.g. an order the exchange rejected that an older build booked as filled) from the hedge-pair journals,
// WITHOUT touching any open position: only CLOSED trades can be removed, OPEN rows and the saved positions table are never changed.
//
//   node scripts/void-trades.js                      list the last 3 days of trades of every hedge-pair journal (ids to pick from)
//   node scripts/void-trades.js --days 7             longer window
//   node scripts/void-trades.js --void 12,15         dry run: shows what would be removed
//   node scripts/void-trades.js --void 12,15 --apply backs the file up to databases/void-backup/<UTC stamp>/, then deletes those rows
//   (add --file <name.db> if the same id exists in more than one journal)
//
// Run it with the engine stopped (after EOD it is). The realized P&L the engine reports is summed from this table, so it corrects itself.
"use strict";
const fs = require("fs"), path = require("path"), sqlite3 = require("sqlite3");
const { DB_DIR } = require("../data/dbDir");
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes("--apply"), DAYS = Number(arg("--days")) || 3, ONLY = arg("--file");
const IDS = (arg("--void") || "").split(",").map(s => s.trim()).filter(Boolean).map(Number);
if (IDS.some(n => !Number.isInteger(n) || n <= 0)) { console.error("--void takes ids like 12,15"); process.exit(1); }
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, e => e ? rej(e) : res()));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const open = f => new Promise((res, rej) => { const d = new sqlite3.Database(f, e => e ? rej(e) : res(d)); });
const close = d => new Promise(res => d.close(() => res()));
(async () => {
    const files = fs.readdirSync(DB_DIR).filter(n => /_(core|hedge)_(raw|ha|range)\.db$/i.test(n) && (!ONLY || n === ONLY));
    const since = new Date(Date.now() - DAYS * 864e5 + 5.5 * 36e5).toISOString().slice(0, 10);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-"), backupDir = path.join(DB_DIR, "void-backup", stamp);
    console.log(`${IDS.length ? (APPLY ? "APPLY" : "DRY RUN") : "LIST"} — ${DB_DIR}\n`);
    let removed = 0;
    for (const name of files) {
        const db = await open(path.join(DB_DIR, name));
        try {
            await run(db, "PRAGMA busy_timeout = 5000");
            const rows = await all(db, "SELECT id, side, entry_price, entry_time, exit_price, exit_time, pnl, exit_reason, status, trade_date FROM trades WHERE trade_date >= ? ORDER BY id", [since]);
            if (!IDS.length) {
                if (!rows.length) continue;
                console.log(name);
                for (const r of rows) console.log(`  #${r.id}  ${r.trade_date}  ${r.side.padEnd(5)} in ${r.entry_price} ${String(r.entry_time).slice(-8)}  out ${r.exit_price ?? "-"} ${r.exit_time ? String(r.exit_time).slice(-8) : ""}  pnl ${r.pnl ?? "-"}  ${r.status}  ${r.exit_reason || ""}`);
                continue;
            }
            const hit = rows.filter(r => IDS.includes(r.id));
            if (!hit.length) continue;
            const open_ = hit.filter(r => r.status !== "CLOSED");
            if (open_.length) { console.log(`${name}: #${open_.map(r => r.id)} is OPEN — refusing (the live position is never touched here)`); continue; }
            console.log(`${name}: ${APPLY ? "removing" : "would remove"} ${hit.map(r => `#${r.id} (${r.side} ${r.entry_price}→${r.exit_price}, pnl ${r.pnl}, ${r.exit_reason})`).join("; ")}`);
            removed += hit.length;
            if (APPLY) {
                fs.mkdirSync(backupDir, { recursive: true });
                await run(db, `VACUUM INTO '${path.join(backupDir, name).replace(/'/g, "''")}'`);
                for (const r of hit) await run(db, "DELETE FROM trades WHERE id = ? AND status = 'CLOSED'", [r.id]);
            }
        } finally { await close(db); }
    }
    if (IDS.length) console.log(`\n${removed} trade(s) ${APPLY ? "removed" : "would be removed (re-run with --apply)"}.${APPLY && removed ? `\nBackup: ${backupDir}` : ""}`);
})().catch(e => { console.error(e); process.exit(1); });
