// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'talgo_zinc.db');
const db = new sqlite3.Database(DB_PATH);

function initDB() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                engine TEXT NOT NULL DEFAULT 'FAST',
                instrument_token INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                position TEXT,
                entry_price REAL,
                sl_price REAL,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(engine, instrument_token)
            )
        `);
        console.log("[DB] Zinc Positions table ready");
    });
}

function savePosition(instrument_token, symbol, position, entry_price, sl_price = 0) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO positions 
        (engine, instrument_token, symbol, position, entry_price, sl_price, updated_at)
        VALUES ('FAST', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(instrument_token, symbol, position, entry_price || 0, sl_price);
    stmt.finalize();
}

async function loadPosition(instrument_token) {
    return new Promise((resolve) => {
        db.get(
            "SELECT * FROM positions WHERE engine = 'FAST' AND instrument_token = ?",
            [instrument_token],
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

function clearAllPositions() {
    db.run("DELETE FROM positions WHERE engine = 'FAST'", (err) => {
        if (err) console.error("[DB] Clear error:", err.message);
        else console.log("[DB] All Zinc positions cleared");
    });
}

module.exports = {
    initDB,
    savePosition,
    loadPosition,
    clearAllPositions
};