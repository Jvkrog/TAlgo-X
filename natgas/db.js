// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'talgo.db');
const db = new sqlite3.Database(DB_PATH);

function initDB() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                engine TEXT NOT NULL,           -- "SLOW" or "FAST"
                instrument_token INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                position TEXT,                  -- "LONG", "SHORT", NULL
                entry_price REAL,
                sl_price REAL,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(engine, instrument_token)
            )
        `);
        console.log("[DB] Positions table ready");
    });
}

function savePosition(engine, instrument_token, symbol, position, entry_price, sl_price) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO positions 
        (engine, instrument_token, symbol, position, entry_price, sl_price, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(engine, instrument_token, symbol, position, entry_price || 0, sl_price || 0);
    stmt.finalize();
}

async function loadPosition(engine, instrument_token) {
    return new Promise((resolve) => {
        db.get(
            "SELECT * FROM positions WHERE engine = ? AND instrument_token = ?",
            [engine, instrument_token],
            (err, row) => {
                if (err) {
                    console.error("[DB] Load error:", err.message);
                    resolve(null);
                } else {
                    resolve(row);
                }
            }
        );
    });
}

// Only clear if explicitly called (e.g., manual square-off)
function clearAllPositions() {
    db.run("DELETE FROM positions", (err) => {
        if (err) console.error("[DB] Clear error:", err.message);
        else console.log("[DB] All positions cleared manually");
    });
}

module.exports = {
    initDB,
    savePosition,
    loadPosition,
    clearAllPositions
};