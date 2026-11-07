// backtestCandleFeed.js — replay driver over a pre-fetched historical OHLC
// array, stands in for candleBuilder.js during a backtest.
//
// Implements candleBuilder.js's exact interface (onTick, getLivePrice,
// getRawCandles, setRawCandles) so anything expecting a live candle buffer
// works unmodified — plus two backtest-only methods (advance/hasNext) that
// the replay loop in backtester/run.js drives directly; nothing in
// strategies.js calls these, only the runner does.
//
// One deliberate simplification: getLivePrice() here returns the most
// recently revealed candle's close, not a true intra-candle tick price —
// a backtest only has OHLC, there's no finer-grained feed to draw from.
// This is the same "close is the signal price" assumption processCandle()
// already makes everywhere live, just extended to the SL-check price too
// (see backtestSL.js for the intrabar high/low touch check, which is where
// this distinction actually matters).
"use strict";

function createBacktestCandleFeed(historicalCandles) {
    let cursor     = 0;   // index into historicalCandles of the next one to reveal
    let rawCandles = [];  // candles revealed so far — same growing-buffer shape live uses

    return {
        // Live-interface methods — no-op/derived here, real ones live.
        onTick() { /* no finer-grained tick feed exists in a backtest */ },
        getLivePrice()  { return rawCandles.length ? rawCandles[rawCandles.length - 1].close : null; },
        getRawCandles() { return rawCandles; },
        setRawCandles(c) { rawCandles = c || []; },

        // Backtest-only — drives the replay, not part of candleBuilder.js's
        // interface, not touched by any strategy.
        advance() {
            if (cursor >= historicalCandles.length) return null;
            const candle = historicalCandles[cursor++];
            rawCandles.push(candle);
            return candle;
        },
        hasNext() { return cursor < historicalCandles.length; },
        totalCandles() { return historicalCandles.length; },
    };
}

module.exports = { createBacktestCandleFeed };
