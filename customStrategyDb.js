"use strict";
// customStrategyDb.js — global registry of user-built strategy definitions
// (toolbox "Create Your Own Strategy" wizard + webdash strategy builder
// both write here). Deliberately separate from db.js's per-instrument
// createDb(context): a custom strategy is a reusable TEMPLATE, same
// relationship an entry in strategies.js's STRATEGIES object has to the
// instruments that run it — not per-instrument runtime state.
//
// Per-instrument runtime state (position, frozen target/stop, edgeMemory)
// still lives in the existing per-instrument `positions` table via the
// new strategy_state column — see db.js and customStrategyRuntime.js.

const sqlite3 = require("sqlite3").verbose();
const path    = require("path");

const DB_PATH = path.join(__dirname, "custom_strategies.db");
const db      = new sqlite3.Database(DB_PATH);

function initDB() {
    db.run(`
        CREATE TABLE IF NOT EXISTS custom_strategies (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            candle_type TEXT NOT NULL,     -- 'raw' | 'ha'
            timeframe   TEXT NOT NULL,     -- '5m' | '15m' | '30m' | '1h'
            indicators  TEXT NOT NULL,     -- JSON array of indicator blocks
            entry_long  TEXT,              -- JSON condition tree, nullable until step 5 is done
            entry_short TEXT,              -- JSON condition tree, nullable until step 5 is done
            exit_config TEXT,              -- JSON exit block, nullable until step 6 is done
            created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
}
initDB();

function saveStrategy(spec) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO custom_strategies (name, candle_type, timeframe, indicators, entry_long, entry_short, exit_config)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                spec.name, spec.candleType, spec.timeframe,
                JSON.stringify(spec.indicators),
                spec.entryLong  ? JSON.stringify(spec.entryLong)  : null,
                spec.entryShort ? JSON.stringify(spec.entryShort) : null,
                spec.exitConfig ? JSON.stringify(spec.exitConfig) : null,
            ],
            function (err) { err ? reject(err) : resolve(this.lastID); }
        );
    });
}

function listStrategies() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM custom_strategies ORDER BY name`, (err, rows) => {
            if (err) return reject(err);
            resolve(rows.map(rowToSpec));
        });
    });
}

function getStrategyByName(name) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM custom_strategies WHERE name = ?`, [name], (err, row) => {
            if (err) return reject(err);
            resolve(row ? rowToSpec(row) : null);
        });
    });
}

function rowToSpec(row) {
    return {
        id: row.id,
        name: row.name,
        candleType: row.candle_type,
        timeframe: row.timeframe,
        indicators: JSON.parse(row.indicators),
        entryLong:  row.entry_long  ? JSON.parse(row.entry_long)  : null,
        entryShort: row.entry_short ? JSON.parse(row.entry_short) : null,
        exitConfig: row.exit_config ? JSON.parse(row.exit_config) : null,
    };
}

module.exports = { saveStrategy, listStrategies, getStrategyByName };
