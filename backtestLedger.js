// backtestLedger.js — in-memory stand-in for db.js, used only by the
// backtester. Mirrors db.js's exported function names and signatures
// exactly (savePosition, loadPosition, insertOpenTrade, closeTrade,
// getOpenTrade, getRealizedPnlToday, getTradesForDate, saveRegime,
// loadRegime, clearAllPositions, initDB) so a strategy factory can't tell
// the difference between this and a real db.js instance.
//
// Two things deliberately differ from db.js's real behavior, both on
// purpose:
//   - Every timestamp uses the injected clock (candle time), not
//     `new Date()` (wall time) — a backtest replaying March 2024 needs its
//     trade rows dated March 2024, not today.
//   - loadPosition() always resolves null. A backtest always starts flat —
//     there is no "previous session" to resume into. This also means
//     initSignals()'s RESUME_INTRADAY_ONLY branch never fires during a
//     backtest, which is exactly what's wanted.
//
// Storage is a single in-memory array, scoped to one createBacktestLedger()
// call — never touches a sqlite file, so a backtest run can NEVER collide
// with (or corrupt) the live trading database. This isolation is the whole
// point of this file existing instead of just reusing db.js with a fake path.
"use strict";

function createBacktestLedger({ clock }) {
    let nextId = 1;
    const trades = [];   // every trade this run has opened, open or closed
    let position = null; // mirrors db.js's single-row-per-(engine,token) positions table

    function initDB() { /* no schema to create — nothing persists to disk */ }

    function insertOpenTrade(engine, instrument, side, qty, entryPrice) {
        const now = clock.now();
        const trade = {
            id: nextId++,
            engine, instrument, side, qty,
            entry_price: entryPrice,
            entry_time:  now.toISOString(),
            exit_price:  null,
            exit_time:   null,
            pnl:         null,
            exit_reason: null,
            status:      "OPEN",
            trade_date:  now.toISOString().split("T")[0],
        };
        trades.push(trade);
        return Promise.resolve(trade.id);
    }

    function closeTrade(id, exitPrice, pnl, exitReason) {
        if (!id) return Promise.resolve();
        const trade = trades.find(t => t.id === id);
        if (trade) {
            trade.exit_price  = exitPrice;
            trade.exit_time   = clock.now().toISOString();
            trade.pnl         = pnl;
            trade.exit_reason = exitReason;
            trade.status      = "CLOSED";
        }
        return Promise.resolve();
    }

    function getOpenTrade(engine) {
        for (let i = trades.length - 1; i >= 0; i--) {
            if (trades[i].engine === engine && trades[i].status === "OPEN") {
                return Promise.resolve(trades[i]);
            }
        }
        return Promise.resolve(null);
    }

    function getRealizedPnlToday(engine) {
        const today = clock.now().toISOString().split("T")[0];
        const total = trades
            .filter(t => t.engine === engine && t.status === "CLOSED" && t.trade_date === today)
            .reduce((sum, t) => sum + (t.pnl || 0), 0);
        return Promise.resolve(total);
    }

    function getTradesForDate(engine, dateStr) {
        return Promise.resolve(trades.filter(t => t.engine === engine && t.trade_date === dateStr));
    }

    function savePosition(engine, token, symbol, pos, entryPrice, positionSource) {
        position = { engine, token, symbol, position: pos, entry_price: entryPrice || 0, position_source: pos ? (positionSource || null) : null };
    }

    // Always flat on load — see file header.
    function loadPosition() {
        return Promise.resolve(null);
    }

    // Unused by any strategy today (the regime table predates the
    // DPI TREND/MEANREV split) — kept as no-ops only for interface parity
    // with db.js, in case something starts calling them.
    function saveRegime() {}
    function loadRegime() { return Promise.resolve(null); }

    function clearAllPositions() { trades.length = 0; position = null; }

    // NOT part of db.js's interface — backtest-only. backtester/run.js reads
    // this once the replay loop finishes to hand trades to metrics.js.
    function getAllTrades() { return trades.slice(); }

    return {
        initDB, savePosition, loadPosition, saveRegime, loadRegime, clearAllPositions,
        insertOpenTrade, closeTrade, getOpenTrade, getRealizedPnlToday, getTradesForDate,
        getAllTrades,
    };
}

module.exports = { createBacktestLedger };
