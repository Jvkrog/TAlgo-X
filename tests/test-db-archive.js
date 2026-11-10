// Deleting an instrument moves its database files to databases/deleted/ (never deletes) so a re-deploy can't adopt the old history.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbarch-")); process.env.TALGO_DB_DIR = tmp;
const { archiveInstrumentDbs, DELETED_DIR } = require("../data/dbArchive");
const { ROOT } = require("../data/dbDir");
const touch = (n, d = tmp) => fs.writeFileSync(path.join(d, n), "x");
const ls = d => fs.existsSync(d) ? fs.readdirSync(d).sort() : [];

// DSB native candle = whatever nativeCandleType says; pass explicit RAW to keep the test independent of it
touch("natgasmini_dsb_dual_raw.db"); touch("natgasmini_dsb_dual_raw.db-wal"); touch("natgasmini_dsb_dual_raw.db-shm");
touch("natgasmini_dsb_dual_raw_riskobs.db"); touch("natgasmini_dsb_dual.db");           // legacy name
touch("natgasmini_dsb_dual_ha.db"); touch("zincmini_dsb_dual_raw.db"); touch("custom_strategies.db");
let r = archiveInstrumentDbs({ underlying: "NATGASMINI", strategy: "DSB_DUAL", candleType: "RAW" }, [], new Date("2026-11-10T02:30:00Z"));
assert.deepStrictEqual(r.errors, []);
assert.deepStrictEqual(ls(tmp).filter(f => f !== "deleted"), ["custom_strategies.db", "natgasmini_dsb_dual_ha.db", "zincmini_dsb_dual_raw.db"], "only this deployment's files moved; other candle types / instruments / other DBs untouched");
assert.deepStrictEqual(ls(DELETED_DIR), [
    "natgasmini_dsb_dual__deleted-20261110-023000.db", "natgasmini_dsb_dual_raw__deleted-20261110-023000.db", "natgasmini_dsb_dual_raw__deleted-20261110-023000.db-shm",
    "natgasmini_dsb_dual_raw__deleted-20261110-023000.db-wal", "natgasmini_dsb_dual_raw_riskobs__deleted-20261110-023000.db"]);
// legacy names are KEPT while another deployment of the same instrument + strategy remains
touch("natgasmini_dsb_dual_raw.db"); touch("natgasmini_dsb_dual.db");
r = archiveInstrumentDbs({ underlying: "NATGASMINI", strategy: "DSB_DUAL", candleType: "RAW" }, [{ underlying: "NATGASMINI", strategy: "DSB_DUAL" }], new Date("2026-11-10T03:00:00Z"));
assert.ok(fs.existsSync(path.join(tmp, "natgasmini_dsb_dual.db")), "legacy kept for the sibling deployment"); assert.ok(!fs.existsSync(path.join(tmp, "natgasmini_dsb_dual_raw.db")));
// same name archived twice never clobbers (distinct timestamps), nothing to move is a no-op, never throws
assert.strictEqual(ls(DELETED_DIR).filter(f => f.startsWith("natgasmini_dsb_dual_raw__")).length >= 4, true);
assert.deepStrictEqual(archiveInstrumentDbs({ underlying: "NOPE", strategy: "X", candleType: "RAW" }), { moved: [], errors: [] });
// project-root legacy copy (db.js would re-copy it into databases/) is archived too
touch("copper_dsb_dual.db", ROOT);
r = archiveInstrumentDbs({ underlying: "COPPER", strategy: "DSB_DUAL", candleType: "RAW" }, []);
assert.ok(!fs.existsSync(path.join(ROOT, "copper_dsb_dual.db")) && ls(DELETED_DIR).some(f => f.startsWith("root_copper_dsb_dual__deleted")), "root legacy copy archived");
fs.rmSync(path.join(DELETED_DIR, ls(DELETED_DIR).find(f => f.startsWith("root_copper"))));
// wiring
const cli = fs.readFileSync(__dirname + "/../toolbox.js", "utf8"), web = fs.readFileSync(__dirname + "/../webdash/server.js", "utf8");
assert.ok(cli.includes("archiveInstrumentDbs(p, procs.filter") && web.includes("archiveInstrumentDbs(p, procs.filter"), "both delete paths archive AFTER pm2 delete succeeds");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS db archive"); process.exit(0);
