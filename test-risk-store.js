// test-risk-store.js — observer database integrity: versioned migrations, legacy upgrade, rollback, instrument guard,
// corrupt-row tolerance, duplicate candles, deterministic ordering. All on isolated temp databases. Run: node test-risk-store.js
"use strict";
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const sqlite3 = require("sqlite3");
const { createSqliteStore, SCHEMA_VERSION } = require("./riskObserver/riskStore");
const { loadHistoryReadOnly, summarize } = require("./riskObserver/analytics");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rostore-"));
const raw = file => new Promise((res, rej) => { const db = new sqlite3.Database(file, e => (e ? rej(e) : res(db))); });
const exec = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const rows = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const closeDb = db => new Promise(r => db.close(() => r()));
let passed = 0; const t = async (n, f) => { await f(); passed++; console.log("ok  -", n); };

// the ORIGINAL (pre-versioning) schema exactly as shipped in the first Risk Observer commit
async function makeLegacy(file) {
    const db = await raw(file);
    await exec(db, `CREATE TABLE obs_meta (key TEXT PRIMARY KEY, value TEXT)`);
    await exec(db, `CREATE TABLE obs_positions (id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, entry_price REAL NOT NULL, entry_ts INTEGER NOT NULL, trade_id INTEGER, opened_at INTEGER NOT NULL, closed_at INTEGER, close_note TEXT, risk_state TEXT, metrics TEXT, reconciled INTEGER DEFAULT 1)`);
    await exec(db, `CREATE TABLE obs_events (id INTEGER PRIMARY KEY AUTOINCREMENT, pos_id INTEGER, ts INTEGER NOT NULL, kind TEXT NOT NULL, from_state TEXT, to_state TEXT, detail TEXT)`);
    await exec(db, `CREATE TABLE obs_candles (ts INTEGER PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, c1 TEXT, c2 TEXT)`);
    await exec(db, `INSERT INTO obs_positions (side,entry_price,entry_ts,trade_id,opened_at,closed_at,close_note,risk_state,metrics,reconciled) VALUES ('SHORT',100,1000,7,1000,5000,'closed','NORMAL','{"candleMae":2,"liveMae":3,"stateSecs":{"NORMAL":50}}',1)`);
    await exec(db, `INSERT INTO obs_events (pos_id,ts,kind,from_state,to_state,detail) VALUES (1,1500,'STATE','NORMAL','WATCH','{"reasons":["x"]}')`);
    await exec(db, `INSERT INTO obs_candles VALUES (900000,1,2,0,1,NULL,NULL)`);
    await exec(db, `INSERT INTO obs_meta VALUES ('keepme','yes')`);
    await closeDb(db);
}

(async () => {
    await t("fresh database: current schema version, WAL journal, query indexes, instrument stamp", async () => {
        const f = path.join(tmp(), "a_riskobs.db"), s = await createSqliteStore(f, { instrument: "A" }); assert.strictEqual(s.schemaVersion, SCHEMA_VERSION); assert.strictEqual(await s.getMeta("schema_version"), String(SCHEMA_VERSION)); assert.strictEqual(await s.getMeta("instrument"), "A"); await s.close();
        const db = await raw(f); assert.strictEqual((await rows(db, "PRAGMA journal_mode"))[0].journal_mode, "wal");
        const idx = (await rows(db, "SELECT name FROM sqlite_master WHERE type='index'")).map(r => r.name); for (const n of ["idx_obs_events_pos", "idx_obs_events_kind", "idx_obs_positions_open"]) assert(idx.includes(n), n); await closeDb(db);
    });
    await t("LEGACY (v1, unversioned) database is upgraded IN PLACE: all existing rows survive untouched, new columns are NULL", async () => {
        const f = path.join(tmp(), "legacy_riskobs.db"); await makeLegacy(f);
        const s = await createSqliteStore(f, { instrument: "LEG" });
        assert.strictEqual(s.schemaVersion, SCHEMA_VERSION); assert.strictEqual(await s.getMeta("keepme"), "yes");
        const p = (await s.allPositions())[0]; assert.strictEqual(p.side, "SHORT"); assert.strictEqual(p.metrics.candleMae, 2); assert.strictEqual(p.origin, null); assert.strictEqual(p.entryTsSource, null);
        const e = (await s.allEvents())[0]; assert.strictEqual(e.detail.reasons[0], "x"); assert.strictEqual((await s.allCandles()).length, 1);
        await s.close(); const s2 = await createSqliteStore(f, { instrument: "LEG" }); assert.strictEqual((await s2.allPositions()).length, 1, "re-opening must be idempotent"); await s2.close();
        // analytics reads the upgraded file AND the legacy-shaped rows without throwing
        const sum = summarize(await loadHistoryReadOnly(f), { nowMs: 9000 }); assert.strictEqual(sum.sample.positions, 1);
    });
    await t("a failing migration ROLLS BACK completely: version unchanged, no half-added columns, data intact, error surfaced", async () => {
        const f = path.join(tmp(), "bad_riskobs.db"); await makeLegacy(f);
        const db = await raw(f); await exec(db, `CREATE TABLE idx_obs_events_kind (x INTEGER)`); await closeDb(db);   // name clash makes the v2 index step fail AFTER the ALTERs
        await assert.rejects(() => createSqliteStore(f, { instrument: "X" }), /migration to v2 failed/);
        const d2 = await raw(f); const cols = (await rows(d2, "PRAGMA table_info(obs_positions)")).map(c => c.name);
        assert(!cols.includes("origin"), "ALTER must have been rolled back"); assert.strictEqual((await rows(d2, "SELECT value FROM obs_meta WHERE key='schema_version'")).length, 0); assert.strictEqual((await rows(d2, "SELECT count(*) n FROM obs_positions"))[0].n, 1); await closeDb(d2);
    });
    await t("a database from a NEWER schema is refused, never downgraded or modified", async () => {
        const f = path.join(tmp(), "new_riskobs.db"), s = await createSqliteStore(f); await s.setMeta("schema_version", "99"); await s.close();
        await assert.rejects(() => createSqliteStore(f), /newer than this code/);
    });
    await t("instrument guard: a file stamped for one instrument is refused for another (position ids cannot be mixed)", async () => {
        const f = path.join(tmp(), "g_riskobs.db"), a = await createSqliteStore(f, { instrument: "ZINC" }); await a.close();
        await assert.rejects(() => createSqliteStore(f, { instrument: "COPPER" }), /belongs to instrument "ZINC"/); const again = await createSqliteStore(f, { instrument: "ZINC" }); await again.close();
    });
    await t("corrupt JSON in a row is tolerated and counted (no crash, field becomes null)", async () => {
        const f = path.join(tmp(), "c_riskobs.db"); await makeLegacy(f); const db = await raw(f); await exec(db, `UPDATE obs_positions SET metrics='{not json'`); await exec(db, `UPDATE obs_events SET detail='}{'`); await closeDb(db);
        const s = await createSqliteStore(f); const p = (await s.allPositions())[0]; assert.strictEqual(p.metrics, null); assert.strictEqual((await s.allEvents())[0].detail, null); assert(s.stats().corruptRows >= 2); await s.close();
        const h = await loadHistoryReadOnly(f); assert(h.corruptRows >= 2); const sum = summarize(h, { nowMs: 9000 }); assert.strictEqual(sum.positions.length, 1); assert(sum.limitations.some(l => /unparsable/.test(l)));
    });
    await t("duplicate candles are prevented; a DIFFERING re-delivery never overwrites history and is recorded as a conflict", async () => {
        const f = path.join(tmp(), "d_riskobs.db"), s = await createSqliteStore(f);
        assert.strictEqual(await s.markCandle({ ts: 900000, open: 1, high: 2, low: 0.5, close: 1.5 }), true); assert.strictEqual(await s.markCandle({ ts: 900000, open: 1, high: 2, low: 0.5, close: 1.5 }), false); assert.deepStrictEqual(s.takeConflicts(), []);
        assert.strictEqual(await s.markCandle({ ts: 900000, open: 1, high: 9, low: 0.5, close: 1.5 }), false); const c = s.takeConflicts(); assert.strictEqual(c.length, 1); assert.strictEqual(c[0].stored.high, 2); assert.strictEqual(c[0].received.high, 9);
        assert.strictEqual((await s.allCandles()).length, 1); assert.strictEqual((await s.allCandles())[0].high, 2); assert.deepStrictEqual(s.takeConflicts(), []); await s.close();
    });
    await t("event ordering is deterministic: (ts, id) ascending for history, descending for recent; eventsByKind filters", async () => {
        const f = path.join(tmp(), "o_riskobs.db"), s = await createSqliteStore(f);
        await s.addEvent({ ts: 200, kind: "B" }); await s.addEvent({ ts: 100, kind: "A" }); await s.addEvent({ ts: 200, kind: "C" }); await s.addEvent({ ts: 100, kind: "A" });
        assert.deepStrictEqual((await s.allEvents()).map(e => e.kind), ["A", "A", "B", "C"]); assert.deepStrictEqual((await s.recentEvents(10)).map(e => e.kind), ["C", "B", "A", "A"]); assert.strictEqual((await s.eventsByKind("A")).length, 2); await s.close();
    });
    await t("data survives close/reopen (restart recovery) incl. an OPEN position with origin fields", async () => {
        const f = path.join(tmp(), "r_riskobs.db"); let s = await createSqliteStore(f, { instrument: "R" });
        const id = await s.openPosition({ side: "LONG", entryPrice: 50, entryTs: 1, tradeId: 3, openedAt: 2, metrics: { candleMae: 1 }, reconciled: false, origin: "discovered_after_entry", entryTsSource: "engine-trade-record", originNote: "late" }); await s.addEvent({ posId: id, ts: 3, kind: "POSITION_OPEN", detail: { a: 1 } }); await s.close();
        s = await createSqliteStore(f, { instrument: "R" }); const p = await s.getOpenPosition(); assert.strictEqual(p.id, id); assert.strictEqual(p.origin, "discovered_after_entry"); assert.strictEqual(p.reconciled, false); assert.strictEqual(p.originNote, "late"); assert.strictEqual(p.metrics.candleMae, 1); await s.close();
    });
    await t("a reader (dashboard) opened READ-ONLY never blocks or alters the writer's file", async () => {
        const f = path.join(tmp(), "w_riskobs.db"), s = await createSqliteStore(f, { instrument: "W" }); await s.addEvent({ ts: 1, kind: "X" });
        const h = await loadHistoryReadOnly(f); assert.strictEqual(h.events.length, 1); await s.addEvent({ ts: 2, kind: "Y" }); assert.strictEqual((await s.allEvents()).length, 2);
        const ro = await new Promise(r => { const d = new sqlite3.Database(f, sqlite3.OPEN_READONLY, () => r(d)); }); await assert.rejects(() => exec(ro, "INSERT INTO obs_meta VALUES ('z','z')"), /readonly|READONLY/i); await closeDb(ro); await s.close();
    });
    console.log(`\n${passed} store scenarios passed`); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
