// db.js — persistence: positions, regime, trades. Per-instrument.
//
// CHANGED: was a module-level singleton that read `config.INST_NAME` at
// require-time to build DB_NAME (natgasmini.db / zincmini.db / etc). That
// meant one process = one DB file, which happened to work but only because
// nothing else in the codebase ever asked for two instruments in one
// process. Now createDb(context) opens (and initializes) a DB scoped to
// whatever context it's given — engine.js calls this once per running
// instrument, same as createState()/createCandleBuffer().
//
// The `engine` column/param already existed as a generic label — it's just
// no longer implicitly "FAST". Callers now pass context.tgPrefix.
"use strict";

const sqlite3 = require("sqlite3").verbose();
const path    = require("path");

function createDb(context) {
    // Fail loud, not silently wrong (same reasoning as engine.js's lotMult/
    // tickSize boot guards): a missing strategy here would otherwise
    // silently produce a filename like "zincmini_undefined.db" instead of
    // catching the real problem.
    if (!context.strategy) {
        throw new Error(`createDb: context.strategy is not set for "${context.name}" — refusing to guess a DB filename`);
    }

    // DB filename derived from instrument AND strategy — was instrument-only
    // (natgasmini.db / zincmini.db / etc), which meant switching strategies
    // on the same instrument shared one SQLite file, and specifically one
    // `positions` row (UNIQUE(engine, instrument_token), where engine =
    // context.tgPrefix = the instrument name, not strategy-specific).
    // savePosition() does INSERT OR REPLACE on that row, so running
    // MA_SLOPE_SCALP on ZINCMINI after MA_SLOPE had would silently
    // overwrite/adopt the other strategy's saved position and open-trade
    // history on the next restart — a real cross-strategy data-overlap bug,
    // not just a cosmetic one. Now: zincmini_ma_slope.db vs
    // zincmini_ma_slope_scalp.db, fully separate files/tables.
    // context.strategy is guaranteed set before createDb() is called in
    // engine.js (context.js sets it from def.strategy, or engine.js
    // overrides it from STRATEGY_OVERRIDE — either way, before this runs).
    // NOTE: this does NOT migrate old instrument-only .db files (zincmini.db
    // etc already on disk) — their trade history stays where it is, under
    // the old filename, and won't be picked up under the new naming. If you
    // want to keep continuity for whichever strategy was actually running
    // there, rename that file to match the new pattern before restarting;
    // I didn't do it automatically since I don't know which strategy each
    // existing file's history actually belongs to.
    const DB_NAME = context.name.toLowerCase().replace(/\s+/g, "") + "_" +
                    context.strategy.toLowerCase().replace(/\s+/g, "") + ".db";
    const DB_PATH = path.join(__dirname, DB_NAME);
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
                    position_source  TEXT,
                    target_points    REAL,
                    target_regime    TEXT,
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

            // Migration: add position_source if upgrading from a schema that
            // predates the TREND/MEANREV split.
            db.run(`ALTER TABLE positions ADD COLUMN position_source TEXT`, err => {
                if (err && !err.message.includes("duplicate column")) {
                    console.error("DB migration error:", err.message);
                }
            });

            // Migration: add target_points/target_regime if upgrading from a
            // schema that predates TARGET_MODE=adaptive. Only ever populated
            // for a position opened under adaptive mode — see candlePoll.js's
            // checkTarget() and adaptiveTarget.js; NULL for every FIXED-mode
            // position, same as before this migration existed.
            db.run(`ALTER TABLE positions ADD COLUMN target_points REAL`, err => {
                if (err && !err.message.includes("duplicate column")) {
                    console.error("DB migration error:", err.message);
                }
            });
            db.run(`ALTER TABLE positions ADD COLUMN target_regime TEXT`, err => {
                if (err && !err.message.includes("duplicate column")) {
                    console.error("DB migration error:", err.message);
                }
            });

            // Migration: add strategy_state for custom-strategy runtime
            // state (frozen target/stop, edgeMemory for state_flips_to
            // conditions — see customStrategyRuntime.js). Hardcoded
            // strategies never populate this — NULL for all of them,
            // same "only populated by the feature that needs it" pattern
            // as target_points/target_regime above.
            db.run(`ALTER TABLE positions ADD COLUMN strategy_state TEXT`, err => {
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

            // Authoritative trade ledger — never deleted. trade_date used for
            // EOD / boot-recovery queries; full history kept for analytics.
            db.run(`
                CREATE TABLE IF NOT EXISTS trades (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    engine       TEXT    NOT NULL,
                    instrument   TEXT    NOT NULL,
                    side         TEXT    NOT NULL,
                    qty          INTEGER NOT NULL,
                    entry_price  REAL    NOT NULL,
                    entry_time   TEXT    NOT NULL,
                    exit_price   REAL,
                    exit_time    TEXT,
                    pnl          REAL,
                    exit_reason  TEXT,
                    status       TEXT    NOT NULL DEFAULT 'OPEN',
                    trade_date   TEXT    NOT NULL,
                    created_at   TEXT    DEFAULT CURRENT_TIMESTAMP,
                    updated_at   TEXT    DEFAULT CURRENT_TIMESTAMP
                )
            `);
        });
    }

    function insertOpenTrade(engine, instrument, side, qty, entryPrice) {
        const now   = new Date();
        const today = now.toISOString().split("T")[0];
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO trades (engine, instrument, side, qty, entry_price, entry_time, status, trade_date)
                 VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
                [engine, instrument, side, qty, entryPrice, now.toISOString(), today],
                function (err) { err ? reject(err) : resolve(this.lastID); }
            );
        });
    }

    function closeTrade(id, exitPrice, pnl, exitReason) {
        if (!id) return Promise.resolve();
        return new Promise(resolve => {
            db.run(
                `UPDATE trades
                 SET exit_price = ?, exit_time = ?, pnl = ?, exit_reason = ?, status = 'CLOSED', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [exitPrice, new Date().toISOString(), pnl, exitReason, id],
                err => {
                    if (err) console.error("DB closeTrade error:", err.message);
                    resolve();
                }
            );
        });
    }

    function getOpenTrade(engine) {
        return new Promise(resolve => {
            db.get(
                `SELECT * FROM trades WHERE engine = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1`,
                [engine],
                (err, row) => resolve(err ? null : (row || null))
            );
        });
    }

    function getRealizedPnlToday(engine) {
        const today = new Date().toISOString().split("T")[0];
        return new Promise(resolve => {
            db.get(
                `SELECT COALESCE(SUM(pnl), 0) AS total FROM trades
                 WHERE engine = ? AND status = 'CLOSED' AND trade_date = ?`,
                [engine, today],
                (err, row) => resolve(err ? 0 : row.total)
            );
        });
    }

    function getTradesForDate(engine, dateStr) {
        return new Promise(resolve => {
            db.all(
                `SELECT * FROM trades WHERE engine = ? AND trade_date = ? ORDER BY id ASC`,
                [engine, dateStr],
                (err, rows) => resolve(err ? [] : rows)
            );
        });
    }

    // targetPoints/targetRegime — new OPTIONAL trailing params. Every
    // existing call site (16+ across strategies.js/candlePoll.js) passes
    // only the first 6 args, so these arrive as undefined there — normalized
    // to null below via the same `|| null` pattern positionSource already
    // uses, and forced to null whenever position is null (closed/flat),
    // same reasoning as entry_date/position_source above: a frozen adaptive
    // target belongs to a SPECIFIC open position, never to "flat".
    function savePosition(engine, token, symbol, position, entryPrice, positionSource, targetPoints, targetRegime, strategyState) {
        const today = new Date().toISOString().split("T")[0];
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO positions
            (engine, instrument_token, symbol, position, entry_price, entry_date, position_source, target_points, target_regime, strategy_state, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        stmt.run(
            engine, token, symbol, position, entryPrice || 0,
            position ? today : null,
            position ? (positionSource || null) : null,
            position ? (targetPoints || null) : null,
            position ? (targetRegime || null) : null,
            // strategyState: JSON blob from customStrategyRuntime.js's
            // edgeMemory, undefined for every existing call site (still
            // only 6-8 args) — falls through to null exactly like
            // targetPoints/targetRegime did when those were added.
            position ? (strategyState || null) : null
        );
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

    return {
        initDB, savePosition, loadPosition, saveRegime, loadRegime, clearAllPositions,
        insertOpenTrade, closeTrade, getOpenTrade, getRealizedPnlToday, getTradesForDate,
    };
}

module.exports = { createDb };
