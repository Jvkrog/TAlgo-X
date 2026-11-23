// Hedge-pair chart overlay: core/hedge fills become markers snapped to bars; open core/hedge entry prices become lines.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), sqlite3 = require("sqlite3");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pco-")); process.env.TALGO_DB_DIR = dir;
const mk = (f, rows) => new Promise(r => { const d = new sqlite3.Database(path.join(dir, f)); d.serialize(() => {
    d.run("CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT,instrument TEXT,side TEXT,entry_price REAL,entry_time TEXT,exit_price REAL,exit_time TEXT,pnl REAL,status TEXT)");
    for (const x of rows) d.run("INSERT INTO trades(instrument,side,entry_price,entry_time,exit_price,exit_time,pnl,status) VALUES(?,?,?,?,?,?,?,?)", x); d.close(r); }); });
(async () => {
    await mk("natgasmini_core_raw.db", [["NATGASMINI25NOVFUT", "SHORT", 295.5, "2026-11-23T03:40:00.000Z", 300, "2026-11-23T03:50:00.000Z", -450, "CLOSED"], ["NATGASMINI25DECFUT", "LONG", 338.6, "2026-11-23T04:00:07.000Z", null, null, null, "OPEN"]]);
    await mk("natgasmini_hedge_raw.db", [["NATGASMINI25DECFUT", "SHORT", 337.3, "2026-11-23T05:45:02.000Z", 335.6, "2026-11-23T06:20:00.000Z", 425, "CLOSED"], ["NATGASMINI25DECFUT", "SHORT", 336, "2026-11-23T07:02:00.000Z", null, null, null, "OPEN"]]);
    const t0 = Date.parse("2026-11-23T03:30:00.000Z"), bars = Array.from({ length: 60 }, (_, i) => ({ date: new Date(t0 + i * 300000), open: 338, high: 339, low: 337, close: 338 }));
    const { pairChartOverlay } = require("../webdash/pairChartOverlay");
    const ov = await pairChartOverlay({ underlying: "NATGASMINI" }, bars, t0);
    assert.ok(!ov.lines.some(l => /295.5/.test(l.name)), "previous contract trades are not plotted on the current contract");
    assert.ok(ov.markers && ov.lines, ov.note || "overlay built");
    const m = ov.markers; assert.strictEqual(m.length, 1 + 2 + 1 - 0, "core entry + hedge entry + hedge exit + 2nd hedge entry = 4");
    assert.ok(m.every(x => x.t % 300000 === t0 % 300000), "markers snapped to 5m bar starts");
    assert.ok(m.some(x => /^C L$/.test(x.text) && x.dir === 1), "core long entry arrow up");
    assert.ok(m.some(x => /^H X \+425$/.test(x.text) && x.dir === 1), "closed SHORT hedge exit = buy arrow");
    assert.strictEqual(ov.lines.length, 3, "one entry-price line per trade: core (open), hedge (closed), hedge (open)");
    const closed = ov.lines.find(l => /hedge entry SHORT @337.3$/.test(l.name)); assert.ok(closed && closed.points[1][0] < ov.lines.find(l => /core/.test(l.name)).points[1][0], "closed hedge line ends at its exit bar, the open core runs to now");
    assert.ok(ov.lines.every(l => l.width === 1 && l.points.length === 2));
    const none = await pairChartOverlay({ underlying: "ZZZ" }, bars, t0);
    assert.ok(none.note || none.markers, "unknown underlying doesn't throw");
    console.log("pair chart overlay test passed"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
