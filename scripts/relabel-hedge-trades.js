"use strict";
const fs = require("fs"), path = require("path"), sqlite3 = require("sqlite3");
const { DB_DIR } = require("../data/dbDir");

const APPLY = process.argv.includes("--apply");
const FROM = "DPI_TREND_MEANREV";
// file name (sanitised context.name + candle suffix) -> real strategy label. Order matters: bias before plain dual hedge.
const RULES = [
    [/_price_ma_hedge_/, "PRICE_MA_HEDGE"],
    [/_dual_bias_hedge_/, "DUAL_HEDGE"],
    [/_dual_hedge_/, "DUAL_HEDGE"],
    [/_(core|hedge)_(raw|ha|range)\.db$/, "HEDGE_PAIR"],
];
const labelFor = f => { const n = f.toLowerCase(); for (const [re, l] of RULES) if (re.test(n)) return l; return null; };

const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, e => e ? rej(e) : res()));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const open = f => new Promise((res, rej) => { const d = new sqlite3.Database(f, e => e ? rej(e) : res(d)); });
const close = d => new Promise(res => d.close(() => res()));

(async () => {
    const files = fs.readdirSync(DB_DIR).filter(n => n.endsWith(".db") && labelFor(n));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-"), backupDir = path.join(DB_DIR, "relabel-backup", stamp);
    console.log(`${APPLY ? "APPLY" : "DRY RUN"} — database folder: ${DB_DIR}\n`);
    let total = 0;
    for (const name of files) {
        const label = labelFor(name), file = path.join(DB_DIR, name);
        let db;
        try {
            db = await open(file);
            await run(db, "PRAGMA busy_timeout = 5000");
            const rows = await all(db, "SELECT id, ctx FROM trades WHERE status = 'CLOSED' AND ctx IS NOT NULL");
            const todo = [];
            for (const r of rows) { let j; try { j = JSON.parse(r.ctx); } catch { continue; } if (j && j.strategy === FROM) todo.push({ id: r.id, ctx: JSON.stringify({ ...j, strategy: label }) }); }
            if (!todo.length) { await close(db); continue; }
            console.log(`${name}: ${todo.length} trade(s) ${FROM} -> ${label}`);
            total += todo.length;
            if (APPLY) {
                fs.mkdirSync(backupDir, { recursive: true });
                await run(db, `VACUUM INTO '${path.join(backupDir, name).replace(/'/g, "''")}'`);   // consistent copy even if the file is in WAL mode
                await run(db, "BEGIN");
                for (const t of todo) await run(db, "UPDATE trades SET ctx = ? WHERE id = ?", [t.ctx, t.id]);
                await run(db, "COMMIT");
            }
            await close(db);
        } catch (e) { console.error(`${name}: skipped — ${e.message}`); if (db) await close(db); }
    }
    console.log(`\n${total} trade(s) ${APPLY ? "relabelled" : "would be relabelled (re-run with --apply)"}.${APPLY && total ? `\nBackups: ${backupDir}` : ""}`);
})().catch(e => { console.error(e); process.exit(1); });
