// Dual-hedge chart overlay: both accounts' fills + entry lines, current contract only.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), sqlite3 = require("sqlite3");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dco-")); process.env.TALGO_DB_DIR = dir;
const mk = (f, rows) => new Promise(r => { const d = new sqlite3.Database(path.join(dir, f)); d.serialize(() => {
    d.run("CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT,instrument TEXT,side TEXT,entry_price REAL,entry_time TEXT,exit_price REAL,exit_time TEXT,pnl REAL,status TEXT)");
    for (const x of rows) d.run("INSERT INTO trades(instrument,side,entry_price,entry_time,exit_price,exit_time,pnl,status) VALUES(?,?,?,?,?,?,?,?)", x); d.close(r); }); });
(async () => {
    await mk("zincmini_dual_hedge_long_acc1_raw.db", [["ZINCMINIOLD", "LONG", 300, "2026-11-23T03:40:00.000Z", 301, "2026-11-23T03:50:00.000Z", 50, "CLOSED"], ["ZINCMINI25DECFUT", "LONG", 388, "2026-11-23T04:00:00.000Z", null, null, null, "OPEN"]]);
    await mk("zincmini_dual_hedge_short_acc2_raw.db", [["ZINCMINI25DECFUT", "SHORT", 389, "2026-11-23T04:05:00.000Z", null, null, null, "OPEN"]]);
    const t0 = Date.parse("2026-11-23T03:30:00.000Z"), bars = Array.from({ length: 60 }, (_, i) => ({ date: new Date(t0 + i * 300000), open: 388, high: 389, low: 387, close: 388 }));
    const { dualEntryOverlay } = require("../webdash/pairChartOverlay");
    const ov = await dualEntryOverlay({ underlying: "ZINCMINI", longContract: "ZINCMINI25DECFUT" }, bars, t0);
    assert.strictEqual(ov.markers.length, 2, "one entry per account on the current contract; old contract excluded");
    assert.strictEqual(ov.lines.length, 2);
    assert.ok(ov.markers.some(m => /^A1 L$/.test(m.text) && m.dir === 1) && ov.markers.some(m => /^A2 S$/.test(m.text) && m.dir === -1));
    assert.ok(!ov.lines.some(l => /300/.test(l.name)));
    console.log("dual chart overlay test passed"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
