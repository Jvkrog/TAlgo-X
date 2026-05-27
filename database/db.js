// db.js — persistence: positions and regime
"use strict";

const sqlite3 = require("sqlite3").verbose();
const path    = require("path");

const DB_PATH = path.join(__dirname, "talgo.db");
const db      = new sqlite3.Database(DB_PATH);

function initDB() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS positions (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                engine           TEXT    NOT NULL,
                instrument_token INTEGER NOT NULL,
                symbol           TEXT    NOT NULL,
                position         TEXT,
                entry_price      REAL,
                entry_date       TEXT,
                updated_at       TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(engine, instrument_token)
            )
        `);

        // Migration: add entry_date if upgrading from older schema
        db.run(`ALTER TABLE positions ADD COLUMN entry_date TEXT`, err => {
            if (err && !err.message.includes("duplicate column")) {
                console.error("DB migration error:", err.message);
            }
        });

        // Only regime needs to survive restarts.
        // Everything else is recomputed from API candles on boot.
        db.run(`
            CREATE TABLE IF NOT EXISTS regime (
                instrument_token INTEGER PRIMARY KEY,
                slow_regime      INTEGER DEFAULT 0,
                updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);
    });
}

function savePosition(engine, token, symbol, position, entryPrice) {
    const today = new Date().toISOString().split("T")[0];
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO positions
        (engine, instrument_token, symbol, position, entry_price, entry_date, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(engine, token, symbol, position, entryPrice || 0, position ? today : null);
    stmt.finalize();
}

async function loadPosition(engine, token) {
    return new Promise(resolve => {
        db.get(
            "SELECT * FROM positions WHERE engine = ? AND instrument_token = ?",
            [engine, token],
            (err, row) => resolve(err ? null : (row || null))
        );
    });
}

function saveRegime(token, slowRegime) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO regime (instrument_token, slow_regime, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(token, slowRegime);
    stmt.finalize();
}

async function loadRegime(token) {
    return new Promise(resolve => {
        db.get(
            "SELECT * FROM regime WHERE instrument_token = ?",
            [token],
            (err, row) => resolve(err ? null : (row || null))
        );
    });
}

function clearAllPositions() {
    db.run("DELETE FROM positions", err => {
        if (err) console.error("DB clear error:", err.message);
        else console.log("DB  positions cleared");
    });
}

module.exports = { initDB, savePosition, loadPosition, saveRegime, loadRegime, clearAllPositions };
