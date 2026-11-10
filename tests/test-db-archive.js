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
// hedge pair + dual hedge legs (dbNoStrategy names)
const { archiveLegDbs, hedgePairLegNames, dualHedgeLegNames } = require("../data/dbArchive");
touch("natgasmini_core_raw.db"); touch("natgasmini_core_raw.db-wal"); touch("zincmini_hedge_raw.db"); touch("natgasmini(core)_dpi_trend_meanrev.db");
touch("natgasmini_dual_bias_hedge_long_acc1_range.db"); touch("natgasmini_dual_bias_hedge_short_acc2_range.db"); touch("natgasmini_dual_hedge_long_acc1_range.db");
const pair = { name: "P1", coreUnderlying: "NATGASMINI", hedgeUnderlying: "ZINCMINI" };
r = archiveLegDbs(hedgePairLegNames(pair), [], new Date("2026-11-10T04:00:00Z"));
assert.deepStrictEqual(r.errors, []); assert.strictEqual(r.moved.length, 4, "core db + wal + hedge db + legacy-named core db");
assert.ok(!ls(tmp).some(f => /natgasmini_core|zincmini_hedge|natgasmini\(core\)/.test(f)));
const dual = { name: "D1", underlying: "NATGASMINI", longUser: "acc1", shortUser: "acc2" };
r = archiveLegDbs(dualHedgeLegNames(dual), [{ underlying: "NATGASMINI", longUser: "acc1", shortUser: "zzz" }].flatMap(dualHedgeLegNames), new Date("2026-11-10T04:00:00Z"));
assert.deepStrictEqual(ls(tmp).filter(f => /_dual_(bias_)?hedge_/.test(f)), ["natgasmini_dual_bias_hedge_long_acc1_range.db", "natgasmini_dual_hedge_long_acc1_range.db"], "a leg still used by another deployment (same LONG account) is kept; the unshared SHORT leg moved");
assert.ok(ls(tmp).every(f => f !== "natgasmini_dual_bias_hedge_short_acc2_range.db"));
// wiring
const cli = fs.readFileSync(__dirname + "/../toolbox.js", "utf8"), web = fs.readFileSync(__dirname + "/../webdash/server.js", "utf8");
assert.ok(cli.includes("archiveLegDbs(hedgePairLegNames(gone)") && cli.includes("archiveLegDbs(dualHedgeLegNames(gone)") && web.includes("archiveLegDbs(hedgePairLegNames(gone)") && web.includes("archiveLegDbs(dualHedgeLegNames(gone)"));
assert.ok(cli.includes("archiveInstrumentDbs(p, procs.filter") && web.includes("archiveInstrumentDbs(p, procs.filter"), "both delete paths archive AFTER pm2 delete succeeds");
// nothing may log after the SHUTDOWN banner: the flag is raised BEFORE the banner, and the engine's candle wrapper / hedge watcher honour it
const life = fs.readFileSync(__dirname + "/../core/lifecycle.js", "utf8"), eng = fs.readFileSync(__dirname + "/../engine.js", "utf8");
assert.ok(life.indexOf("_shutdown = true;   // from here nothing else may log") < life.indexOf('console.log(c.bold("*** SHUTDOWN ***"))'), "shutdown flag set before the banner");
assert.ok(eng.includes("if (lifecycleInstance.isShutdown()) return;   // shutdown banner already printed") && eng.includes("// ... but no hedged/unhedged log lines"), "engine honours it");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS db archive"); process.exit(0);
