// backtestSL.js — intrabar SL check for the backtester.
//
// This is candlePoll.js's checkSL() logic, copied rather than reused,
// because candlePoll.js's factory constructs a live KiteConnect client and
// reads the access-token file unconditionally at the top of
// createCandlePoll() — even though checkSL() itself never touches either.
// Instantiating createCandlePoll() just to get checkSL would force a
// backtest to depend on a live access token file existing, for a piece of
// logic that has zero live-broker dependency. A small, deliberate
// duplication of one ~15-line function beats that coupling.
//
// The one real difference from live: candlePoll's checkSL runs on every
// WebSocket tick, so it sees the exact price that crossed the trail. A
// backtest only has OHLC per candle, so this checks the candle's high/low
// against the trail instead — and assumes the SL is hit BEFORE any
// favorable move within that same candle (worst-case ordering). This is a
// standard, deliberate backtesting assumption (see the architecture doc's
// §6) — reversing it would optimistically bias every result.
"use strict";
const { scalpRules, rupeesToPoints } = require("./scalpRules");

function createBacktestSL({ context, engineConfig, state, slStore, orders, positionsClose, db, tg }) {
    // Mirrors candlePoll.checkSL(price) exactly, except it's fed a candle's
    // high/low instead of a single tick price, and picks whichever of the
    // two represents "the SL got touched" for the current side.
    async function checkSL(candle) {
        const { trail } = slStore.getTrail();
        if (!engineConfig.ENGINE_ENABLED || !state.position || trail === null) return;

        // Worst-case intrabar ordering: LONG uses the candle's low (the
        // most adverse point the price reached), SHORT uses the high.
        const touchPrice = state.position === "LONG" ? candle.low : candle.high;

        const breached =
            (state.position === "LONG"  && touchPrice < trail) ||
            (state.position === "SHORT" && touchPrice > trail);
        if (!breached) return;

        tg(`🛑 ${state.position} STOP @ ₹${trail.toFixed(2)}`);
        const ordered = await orders.slExit(state.position);
        if (engineConfig.LIVE_ORDERS && ordered === null) {
            // Never actually taken in a backtest (LIVE_ORDERS is always
            // false) — kept for interface parity with candlePoll.checkSL.
            console.error(`SL order failed — position NOT cleared, manual exit required`);
            return;
        }

        // Fill at the trail price itself, not the candle's high/low — the
        // stop order fills at (approximately) the trigger price, not at the
        // worst point of the candle. This is a modeling choice, same as
        // orders.js's real slExit doesn't control fill price either (Kite
        // does) — trail price is the standard, conservative approximation.
        await positionsClose(trail, "SL_ST");
        db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
        slStore.clearTrail();
    }

    // Scalp target (context.scalpTargetRupees, DSB family): intrabar high/low vs entry +/- rupees/(lotMult*lots). Run
    // BEFORE the candle's own signal processing, for a position carried into this candle (a trade opened at this candle's
    // close can't have hit a target inside it). Worst-case ordering as for SL: if the stop was also touched in this
    // candle it wins and the target is skipped. Fills at the target price.
    async function checkTarget(candle) {
        if (!context.scalpTargetRupees || context.targetPoints || !engineConfig.ENGINE_ENABLED || !state.position || !state.entryPrice) return false;
        const sr = scalpRules(context, state);
        const long = state.position === "LONG";
        // Post-scalp-hit fixed rupee stop (scalpNextMode "SL"): checked first, worst-case ordering (stop wins).
        if (sr.slRupees) {
            const sp = rupeesToPoints(context, sr.slRupees);
            const stopLevel = long ? state.entryPrice - sp : state.entryPrice + sp;
            if (long ? candle.low <= stopLevel : candle.high >= stopLevel) {
                tg(`🛑 ${state.position} SCALP STOP ₹${sr.slRupees} @ ₹${stopLevel.toFixed(2)}`);
                await positionsClose(stopLevel, "SCALP_SL");
                db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                slStore.clearTrail();
                return true;
            }
        }
        if (!sr.targetRupees) return false;   // post-hit rule "no target"
        const points = rupeesToPoints(context, sr.targetRupees);
        const level = long ? state.entryPrice + points : state.entryPrice - points;
        const hit = long ? candle.high >= level : candle.low <= level;
        if (!hit) return false;
        const { trail } = slStore.getTrail();
        if (trail !== null && (long ? candle.low < trail : candle.high > trail)) return false;   // stop touched first
        tg(`🎯 ${state.position} SCALP TARGET @ ₹${level.toFixed(2)}`);
        await positionsClose(level, "SCALP_TP");
        db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
        slStore.clearTrail();
        return true;
    }

    return { checkSL, checkTarget };
}

module.exports = { createBacktestSL };
