// riskObserver/riskStore.js — persistence for the Risk Observer. Its OWN SQLite file per instrument
// (<instrument>_<strategy>_<candle>_riskobs.db inside databases/): the trading database is never touched, so the
// observer can't corrupt or migrate trading state. A memory store with the same interface backs the unit tests.
//
// Integrity rules:
//   * VERSIONED, TRANSACTIONAL migrations (obs_meta.schema_version). Each step runs in one transaction; a failed step rolls
//     back and leaves the file at the previous version. Steps only ADD (tables / columns / indexes) — no data is ever
//     dropped, reset or rewritten, and legacy (v1, pre-versioning) files are upgraded in place.
//   * WAL journal + busy timeout, so a dashboard reader (opened read-only) never blocks the writer.
//   * One file per instrument and an instrument guard: a file stamped for another instrument is refused, so position ids
//     can never be mixed across instruments.
//   * Candles are INSERT-OR-IGNORE: a persisted candle is never overwritten. A later differing value is only RECORDED as a
//     conflict (takeConflicts) for an explicit decision — there is no silent history rewrite.
//   * Corrupt JSON in a row is tolerated (field becomes null, counted in stats().corruptRows).
//   * Event ordering is deterministic: (ts, id).
"use strict";

const path = require("path");

function openSqlite(file) {
    const sqlite3 = require("sqlite3").verbose();
    return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, err => (err ? reject(err) : resolve(db))); });
}
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

function riskDbPath(dbDir, baseName) { return path.join(dbDir, `${baseName}_riskobs.db`); }
// Same base naming as db.js (instrument_strategy_candle) so the observer file sits beside the trading DB it observes.
function riskDbBase(context) {
    const { candleSuffix } = require("../candleType");
    return `${context.name.toLowerCase().replace(/\s+/g, "")}_${context.strategy.toLowerCase().replace(/\s+/g, "")}_${candleSuffix(context.candleType)}`;
}

const SCHEMA_VERSION = 2;
// Additive migrations only. v1 = the original (unversioned) schema; v2 = origin columns + query indexes.
const MIGRATIONS = [
    { v: 1, steps: [
        `CREATE TABLE IF NOT EXISTS obs_meta (key TEXT PRIMARY KEY, value TEXT)`,
        `CREATE TABLE IF NOT EXISTS obs_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, entry_price REAL NOT NULL, entry_ts INTEGER NOT NULL, trade_id INTEGER,
            opened_at INTEGER NOT NULL, closed_at INTEGER, close_note TEXT, risk_state TEXT, metrics TEXT, reconciled INTEGER DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS obs_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, pos_id INTEGER, ts INTEGER NOT NULL, kind TEXT NOT NULL, from_state TEXT, to_state TEXT, detail TEXT)`,
        `CREATE TABLE IF NOT EXISTS obs_candles (ts INTEGER PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, c1 TEXT, c2 TEXT)`,
    ] },
    { v: 2, columns: [["obs_positions", "origin", "TEXT"], ["obs_positions", "entry_ts_source", "TEXT"], ["obs_positions", "origin_note", "TEXT"]], steps: [
        `CREATE INDEX IF NOT EXISTS idx_obs_events_pos ON obs_events (pos_id, ts, id)`,
        `CREATE INDEX IF NOT EXISTS idx_obs_events_kind ON obs_events (kind, ts)`,
        `CREATE INDEX IF NOT EXISTS idx_obs_positions_open ON obs_positions (closed_at, entry_ts)`,
    ] },
];

async function migrate(db) {
    await run(db, `CREATE TABLE IF NOT EXISTS obs_meta (key TEXT PRIMARY KEY, value TEXT)`);
    const row = (await all(db, `SELECT value FROM obs_meta WHERE key='schema_version'`))[0];
    let cur = row ? Number(row.value) : ((await all(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='obs_positions'`)).length ? 1 : 0);   // legacy file without a version = v1
    if (!Number.isFinite(cur)) cur = 0;
    if (cur > SCHEMA_VERSION) throw new Error(`observer database is schema v${cur}, newer than this code (v${SCHEMA_VERSION}) — refusing to open`);
    for (const m of MIGRATIONS) {
        if (m.v <= cur) continue;
        await run(db, "BEGIN IMMEDIATE");
        try {
            for (const sql of m.steps.filter(x => /^CREATE TABLE/.test(x))) await run(db, sql);
            for (const [tbl, col, type] of m.columns || []) { const cols = (await all(db, `PRAGMA table_info(${tbl})`)).map(c => c.name); if (!cols.includes(col)) await run(db, `ALTER TABLE ${tbl} ADD COLUMN ${col} ${type}`); }
            for (const sql of m.steps.filter(x => !/^CREATE TABLE/.test(x))) await run(db, sql);
            await run(db, `INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('schema_version', ?)`, [String(m.v)]);
            await run(db, "COMMIT");
        } catch (err) { try { await run(db, "ROLLBACK"); } catch { /* already rolled back */ } throw new Error(`observer database migration to v${m.v} failed: ${err.message}`); }
        cur = m.v;
    }
    return cur;
}

const EVT_EPS = 1e-9;
const sameCandle = (a, b) => ["open", "high", "low", "close"].every(k => Math.abs(Number(a[k]) - Number(b[k])) <= EVT_EPS + 1e-9 * Math.abs(Number(a[k])));

async function createSqliteStore(file, { instrument = null } = {}) {
    const db = await openSqlite(file);
    let stats = { corruptRows: 0 }; const conflicts = new Map();
    try {
        try { await run(db, "PRAGMA journal_mode=WAL"); } catch { /* e.g. unsupported filesystem — rollback journal still correct */ }
        await run(db, "PRAGMA busy_timeout=5000");
        const version = await migrate(db);
        if (instrument) {
            const cur = (await all(db, `SELECT value FROM obs_meta WHERE key='instrument'`))[0];
            if (cur && cur.value !== instrument) throw new Error(`observer database belongs to instrument "${cur.value}", not "${instrument}" — refusing to mix position records`);
            if (!cur) await run(db, `INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('instrument', ?)`, [instrument]);
        }
        var schemaVersion = version;
    } catch (err) { await new Promise(r => db.close(() => r())); throw err; }
    const json = v => (v === undefined ? null : JSON.stringify(v));
    const parse = s => { if (s === null || s === undefined) return null; try { return JSON.parse(s); } catch { stats.corruptRows++; return null; } };
    const posRow = x => ({ id: x.id, side: x.side, entryPrice: x.entry_price, entryTs: x.entry_ts, tradeId: x.trade_id, openedAt: x.opened_at, closedAt: x.closed_at, closeNote: x.close_note, riskState: x.risk_state, metrics: parse(x.metrics), reconciled: !!x.reconciled, origin: x.origin ?? null, entryTsSource: x.entry_ts_source ?? null, originNote: x.origin_note ?? null });
    const evRow = x => ({ id: x.id, posId: x.pos_id, ts: x.ts, kind: x.kind, from: x.from_state, to: x.to_state, detail: parse(x.detail) });
    return {
        kind: "sqlite", file, schemaVersion, stats: () => ({ ...stats }),
        async getMeta(k) { const r = await all(db, `SELECT value FROM obs_meta WHERE key=?`, [k]); return r.length ? r[0].value : null; },
        async setMeta(k, v) { await run(db, `INSERT OR REPLACE INTO obs_meta (key,value) VALUES (?,?)`, [k, String(v)]); },
        async getOpenPosition() { const r = await all(db, `SELECT * FROM obs_positions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1`); return r.length ? posRow(r[0]) : null; },
        async openPosition(p) { const r = await run(db, `INSERT INTO obs_positions (side,entry_price,entry_ts,trade_id,opened_at,risk_state,metrics,reconciled,origin,entry_ts_source,origin_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [p.side, p.entryPrice, p.entryTs, p.tradeId ?? null, p.openedAt, p.riskState || "NORMAL", json(p.metrics), p.reconciled === false ? 0 : 1, p.origin ?? null, p.entryTsSource ?? null, p.originNote ?? null]); return r.lastID; },
        async updatePosition(id, patch) { await run(db, `UPDATE obs_positions SET risk_state=COALESCE(?,risk_state), metrics=COALESCE(?,metrics) WHERE id=?`, [patch.riskState ?? null, patch.metrics ? json(patch.metrics) : null, id]); },
        async closePosition(id, note, ts) { await run(db, `UPDATE obs_positions SET closed_at=?, close_note=? WHERE id=? AND closed_at IS NULL`, [ts, note || null, id]); },
        async addEvent(e) { await run(db, `INSERT INTO obs_events (pos_id,ts,kind,from_state,to_state,detail) VALUES (?,?,?,?,?,?)`, [e.posId ?? null, e.ts, e.kind, e.from ?? null, e.to ?? null, json(e.detail)]); },
        async recentEvents(limit = 100) { return (await all(db, `SELECT * FROM obs_events ORDER BY ts DESC, id DESC LIMIT ?`, [limit])).map(evRow); },
        async eventsByKind(kind) { return (await all(db, `SELECT * FROM obs_events WHERE kind=? ORDER BY ts, id`, [kind])).map(evRow); },
        // read APIs for analytics / calibration
        async allPositions() { return (await all(db, `SELECT * FROM obs_positions ORDER BY id`)).map(posRow); },
        async allEvents() { return (await all(db, `SELECT * FROM obs_events ORDER BY ts, id`)).map(evRow); },
        async allCandles() { return all(db, `SELECT ts,open,high,low,close FROM obs_candles ORDER BY ts`); },
        // never overwrites: a persisted candle keeps its recorded values; a differing re-delivery is only remembered as a conflict
        async markCandle(c) {
            const ex = (await all(db, `SELECT open,high,low,close FROM obs_candles WHERE ts=?`, [c.ts]))[0];
            if (ex) { if (!sameCandle(ex, c)) conflicts.set(c.ts, { ts: c.ts, stored: ex, received: { open: c.open, high: c.high, low: c.low, close: c.close } }); return false; }
            await run(db, `INSERT OR IGNORE INTO obs_candles (ts,open,high,low,close,c1,c2) VALUES (?,?,?,?,?,?,?)`, [c.ts, c.open, c.high, c.low, c.close, c.c1 ?? null, c.c2 ?? null]);
            return true;
        },
        takeConflicts() { const v = [...conflicts.values()]; conflicts.clear(); return v; },
        async lastCandleTs() { const r = await all(db, `SELECT MAX(ts) AS t FROM obs_candles`); return r[0] && r[0].t !== null ? r[0].t : null; },
        close() { return new Promise(res => db.close(() => res())); },
    };
}

function createMemoryStore({ instrument = null } = {}) {
    const meta = new Map(), positions = [], events = [], candles = new Map(), conflicts = new Map(); let pid = 0, eid = 0;
    if (instrument) meta.set("instrument", instrument);
    const clone = o => JSON.parse(JSON.stringify(o));
    return {
        kind: "memory", schemaVersion: SCHEMA_VERSION, stats: () => ({ corruptRows: 0 }),
        async getMeta(k) { return meta.has(k) ? meta.get(k) : null; }, async setMeta(k, v) { meta.set(k, String(v)); },
        async getOpenPosition() { const p = [...positions].reverse().find(x => x.closedAt == null); return p ? clone(p) : null; },
        async openPosition(p) { const row = { id: ++pid, side: p.side, entryPrice: p.entryPrice, entryTs: p.entryTs, tradeId: p.tradeId ?? null, openedAt: p.openedAt, riskState: p.riskState || "NORMAL", metrics: p.metrics || null, reconciled: p.reconciled !== false, origin: p.origin ?? null, entryTsSource: p.entryTsSource ?? null, originNote: p.originNote ?? null, closedAt: null }; positions.push(row); return row.id; },
        async updatePosition(id, patch) { const p = positions.find(x => x.id === id); if (p) { if (patch.riskState) p.riskState = patch.riskState; if (patch.metrics) p.metrics = patch.metrics; } },
        async closePosition(id, note, ts) { const p = positions.find(x => x.id === id); if (p && p.closedAt == null) { p.closedAt = ts; p.closeNote = note; } },
        async addEvent(e) { events.push({ id: ++eid, posId: e.posId ?? null, ts: e.ts, kind: e.kind, from: e.from ?? null, to: e.to ?? null, detail: e.detail ?? null }); },
        async recentEvents(limit = 100) { return clone(events).sort((a, b) => b.ts - a.ts || b.id - a.id).slice(0, limit); },
        async eventsByKind(kind) { return clone(events.filter(e => e.kind === kind)).sort((a, b) => a.ts - b.ts || a.id - b.id); },
        async allPositions() { return clone(positions); },
        async allEvents() { return clone(events).sort((a, b) => a.ts - b.ts || a.id - b.id); },
        async allCandles() { return [...candles.values()].sort((a, b) => a.ts - b.ts).map(c => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close })); },
        async markCandle(c) { const ex = candles.get(c.ts); if (ex) { if (!sameCandle(ex, c)) conflicts.set(c.ts, { ts: c.ts, stored: { open: ex.open, high: ex.high, low: ex.low, close: ex.close }, received: { open: c.open, high: c.high, low: c.low, close: c.close } }); return false; } candles.set(c.ts, { ...c }); return true; },
        takeConflicts() { const v = [...conflicts.values()]; conflicts.clear(); return v; },
        async lastCandleTs() { return candles.size ? Math.max(...candles.keys()) : null; },
        async close() {}, _positions: positions, _events: events,
    };
}

module.exports = { createSqliteStore, createMemoryStore, riskDbPath, riskDbBase, SCHEMA_VERSION, MIGRATIONS };
