// riskObserver/riskStore.js — persistence for the Risk Observer. Its OWN SQLite file per instrument
// (<instrument>_<strategy>_<candle>_riskobs.db inside databases/): the trading database is never touched, so the
// observer can't corrupt or migrate trading state. A memory store with the same interface backs the unit tests.
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

async function createSqliteStore(file) {
    const db = await openSqlite(file);
    await run(db, `CREATE TABLE IF NOT EXISTS obs_meta (key TEXT PRIMARY KEY, value TEXT)`);
    await run(db, `CREATE TABLE IF NOT EXISTS obs_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, entry_price REAL NOT NULL, entry_ts INTEGER NOT NULL, trade_id INTEGER,
        opened_at INTEGER NOT NULL, closed_at INTEGER, close_note TEXT, risk_state TEXT, metrics TEXT, reconciled INTEGER DEFAULT 1)`);
    await run(db, `CREATE TABLE IF NOT EXISTS obs_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, pos_id INTEGER, ts INTEGER NOT NULL, kind TEXT NOT NULL, from_state TEXT, to_state TEXT, detail TEXT)`);
    await run(db, `CREATE TABLE IF NOT EXISTS obs_candles (ts INTEGER PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, c1 TEXT, c2 TEXT)`);
    const json = v => (v === undefined ? null : JSON.stringify(v));
    return {
        kind: "sqlite", file,
        async getMeta(k) { const r = await all(db, `SELECT value FROM obs_meta WHERE key=?`, [k]); return r.length ? r[0].value : null; },
        async setMeta(k, v) { await run(db, `INSERT OR REPLACE INTO obs_meta (key,value) VALUES (?,?)`, [k, String(v)]); },
        async getOpenPosition() {
            const r = await all(db, `SELECT * FROM obs_positions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1`);
            if (!r.length) return null;
            const x = r[0]; return { id: x.id, side: x.side, entryPrice: x.entry_price, entryTs: x.entry_ts, tradeId: x.trade_id, openedAt: x.opened_at, riskState: x.risk_state, metrics: x.metrics ? JSON.parse(x.metrics) : null, reconciled: !!x.reconciled };
        },
        async openPosition(p) { const r = await run(db, `INSERT INTO obs_positions (side,entry_price,entry_ts,trade_id,opened_at,risk_state,metrics,reconciled) VALUES (?,?,?,?,?,?,?,?)`, [p.side, p.entryPrice, p.entryTs, p.tradeId ?? null, p.openedAt, p.riskState || "NORMAL", json(p.metrics), p.reconciled === false ? 0 : 1]); return r.lastID; },
        async updatePosition(id, patch) { await run(db, `UPDATE obs_positions SET risk_state=COALESCE(?,risk_state), metrics=COALESCE(?,metrics) WHERE id=?`, [patch.riskState ?? null, patch.metrics ? json(patch.metrics) : null, id]); },
        async closePosition(id, note, ts) { await run(db, `UPDATE obs_positions SET closed_at=?, close_note=? WHERE id=? AND closed_at IS NULL`, [ts, note || null, id]); },
        async addEvent(e) { await run(db, `INSERT INTO obs_events (pos_id,ts,kind,from_state,to_state,detail) VALUES (?,?,?,?,?,?)`, [e.posId ?? null, e.ts, e.kind, e.from ?? null, e.to ?? null, json(e.detail)]); },
        async recentEvents(limit = 100) { return (await all(db, `SELECT * FROM obs_events ORDER BY id DESC LIMIT ?`, [limit])).map(x => ({ id: x.id, posId: x.pos_id, ts: x.ts, kind: x.kind, from: x.from_state, to: x.to_state, detail: x.detail ? JSON.parse(x.detail) : null })); },
        // candle de-duplication across restarts: true when the candle is new
        async markCandle(c) { const r = await run(db, `INSERT OR IGNORE INTO obs_candles (ts,open,high,low,close,c1,c2) VALUES (?,?,?,?,?,?,?)`, [c.ts, c.open, c.high, c.low, c.close, c.c1 ?? null, c.c2 ?? null]); return r.changes > 0; },
        async lastCandleTs() { const r = await all(db, `SELECT MAX(ts) AS t FROM obs_candles`); return r[0] && r[0].t !== null ? r[0].t : null; },
        close() { return new Promise(res => db.close(() => res())); },
    };
}

function createMemoryStore() {
    const meta = new Map(), positions = [], events = [], candles = new Map(); let pid = 0, eid = 0;
    return {
        kind: "memory",
        async getMeta(k) { return meta.has(k) ? meta.get(k) : null; }, async setMeta(k, v) { meta.set(k, String(v)); },
        async getOpenPosition() { const p = [...positions].reverse().find(x => x.closedAt == null); return p ? JSON.parse(JSON.stringify(p)) : null; },
        async openPosition(p) { const row = { id: ++pid, side: p.side, entryPrice: p.entryPrice, entryTs: p.entryTs, tradeId: p.tradeId ?? null, openedAt: p.openedAt, riskState: p.riskState || "NORMAL", metrics: p.metrics || null, reconciled: p.reconciled !== false, closedAt: null }; positions.push(row); return row.id; },
        async updatePosition(id, patch) { const p = positions.find(x => x.id === id); if (p) { if (patch.riskState) p.riskState = patch.riskState; if (patch.metrics) p.metrics = patch.metrics; } },
        async closePosition(id, note, ts) { const p = positions.find(x => x.id === id); if (p && p.closedAt == null) { p.closedAt = ts; p.closeNote = note; } },
        async addEvent(e) { events.push({ id: ++eid, posId: e.posId ?? null, ts: e.ts, kind: e.kind, from: e.from ?? null, to: e.to ?? null, detail: e.detail ?? null }); },
        async recentEvents(limit = 100) { return events.slice(-limit).reverse(); },
        async markCandle(c) { if (candles.has(c.ts)) return false; candles.set(c.ts, c); return true; },
        async lastCandleTs() { return candles.size ? Math.max(...candles.keys()) : null; },
        async close() {}, _positions: positions, _events: events,
    };
}

module.exports = { createSqliteStore, createMemoryStore, riskDbPath, riskDbBase };
