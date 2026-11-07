// A journal-write failure after a live entry must not throw (callers set the stop-loss right after insertOpenTrade).
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
process.env.TALGO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "talgo-db-"));
const sqlite3 = require("sqlite3");
const { createDb } = require("../data/db");
const ctx = { name: "T", strategy: "X", tgPrefix: "T", candleType: "raw", token: 1, symbol: "S" };
(async () => {
    const d = createDb(ctx); d.initDB();
    await new Promise(r => setTimeout(r, 300));                     // let initDB finish
    const id = await d.insertOpenTrade("T", "S", "LONG", 1, 100);
    assert(id > 0, "normal insert returns an id");
    const file = fs.readdirSync(process.env.TALGO_DB_DIR).find(f => f.endsWith(".db"));
    await new Promise(r => { const x = new sqlite3.Database(path.join(process.env.TALGO_DB_DIR, file)); x.run("DROP TABLE trades", () => x.close(r)); });
    const err = console.error; let logged = 0; console.error = () => { logged++; };
    const bad = await d.insertOpenTrade("T", "S", "LONG", 1, 100);   // must resolve, not reject
    console.error = err;
    assert.strictEqual(bad, null); assert.strictEqual(logged, 1);
    console.log("PASS insertOpenTrade resolves null (no throw) on persistent DB failure");
    process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
