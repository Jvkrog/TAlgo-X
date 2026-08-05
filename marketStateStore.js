// marketStateStore.js — persistence for the Market State Engine. Same
// philosophy as db.js: SQLite is the single source of truth, this is the
// only place a Market Profile is durably written.
//
// Deliberately its OWN database file, separate from every instrument's own
// db.js instance (positions/trades). This is a failure-domain boundary,
// not just tidiness — if this file gets corrupted, or the Scanner process
// crashes mid-write, it has zero effect on any running trading engine's
// own ledger. Nothing in engine.js/db.js ever touches this file, and
// nothing here ever touches an instrument's own trades.db.
//
// Two tables:
//   market_profile         — one row per instrument, overwritten in place
//                             (current snapshot only, like db.js's
//                             `positions` table)
//   market_profile_history — append-only, one row per structure.state
//                             TRANSITION only (not every candle) — this is
//                             the durable "regime changed at 11:45" record
"use strict";

const sqlite3 = require("sqlite3").verbose();
const path    = require("path");

function createMarketStateStore(dbPath = path.join(__dirname, "marketState.db")) {
    const db = new sqlite3.Database(dbPath);

    function initDB() {
        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS market_profile (
                    instrument           TEXT PRIMARY KEY,
                    trend_score          INTEGER,
                    trend_direction      TEXT,
                    volatility_score     INTEGER,
                    volatility_state     TEXT,
                    participation_score  INTEGER,
                    structure_state      TEXT,
                    structure_raw_state  TEXT,
                    confidence           INTEGER,
                    updated_at           TEXT
                )
            `);

            db.run(`
                CREATE TABLE IF NOT EXISTS market_profile_history (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    instrument  TEXT NOT NULL,
                    old_state   TEXT,
                    new_state   TEXT NOT NULL,
                    confidence  INTEGER,
                    changed_at  TEXT NOT NULL
                )
            `);
        });
    }

    // saveProfile — always overwrites the single current row for this
    // instrument. Called every candle (every field, not just structure.state,
    // is meant to update continuously — see marketProfiler.js's header for
    // why only structure.state itself is debounced upstream of this call).
    //
    // Returns a Promise the caller CAN await — deliberately not a
    // fire-and-forget stmt.run() the way db.js's savePosition()/saveRegime()
    // are. That exact fire-and-forget shape produced a real, observed race
    // during this file's own testing (two reads of "the same" row moments
    // apart came back with different participation scores, because a
    // trailing write hadn't landed yet) — not a hypothetical concern,
    // caught it happening. Any caller that reads a profile right after
    // writing it (scannerService.js will) needs to be able to await this.
    function saveProfile(instrument, profile) {
        return new Promise((resolve, reject) => {
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO market_profile
                (instrument, trend_score, trend_direction, volatility_score, volatility_state,
                 participation_score, structure_state, structure_raw_state, confidence, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                instrument,
                profile.trend.score, profile.trend.direction,
                profile.volatility.score, profile.volatility.state,
                profile.participation.score,
                profile.structure.state, profile.structure.rawState,
                profile.confidence, profile.updatedAt,
                function (err) { err ? reject(err) : resolve(); }
            );
            stmt.finalize();
        });
    }

    // logTransition — called ONLY when marketProfiler.js reports
    // `changed: true` for this candle. Every other candle, saveProfile()
    // above is the only write.
    function logTransition(instrument, oldState, newState, confidence) {
        return new Promise(resolve => {
            db.run(
                `INSERT INTO market_profile_history (instrument, old_state, new_state, confidence, changed_at)
                 VALUES (?, ?, ?, ?, ?)`,
                [instrument, oldState, newState, confidence, new Date().toISOString()],
                err => {
                    if (err) console.error("marketStateStore  logTransition error:", err.message);
                    resolve();
                }
            );
        });
    }

    function getProfile(instrument) {
        return new Promise(resolve => {
            db.get(
                `SELECT * FROM market_profile WHERE instrument = ?`,
                [instrument],
                (err, row) => resolve(err ? null : rowToProfile(row))
            );
        });
    }

    function getAllProfiles() {
        return new Promise(resolve => {
            db.all(`SELECT * FROM market_profile`, [], (err, rows) => resolve(err ? [] : rows.map(rowToProfile)));
        });
    }

    function getHistory(instrument, limit = 20) {
        return new Promise(resolve => {
            db.all(
                `SELECT * FROM market_profile_history WHERE instrument = ? ORDER BY id DESC LIMIT ?`,
                [instrument, limit],
                (err, rows) => resolve(err ? [] : rows)
            );
        });
    }

    function close() {
        db.close();
    }

    return { initDB, saveProfile, logTransition, getProfile, getAllProfiles, getHistory, close };
}

function rowToProfile(row) {
    if (!row) return null;
    return {
        instrument: row.instrument,
        trend:         { score: row.trend_score,       direction: row.trend_direction },
        volatility:    { score: row.volatility_score,  state: row.volatility_state },
        participation: { score: row.participation_score },
        structure:     { state: row.structure_state,   rawState: row.structure_raw_state },
        confidence: row.confidence,
        updatedAt:  row.updated_at,
    };
}

module.exports = { createMarketStateStore };
