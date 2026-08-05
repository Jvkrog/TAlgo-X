// candleBuilder.js — live price tracker + raw candle buffer.
//
// CHANGED: `rawCandles` and `livePrice` were module-level `let`s — same
// problem as state.js. Now createCandleBuffer() returns an object holding
// that state, so each running instrument gets its own buffer instance
// instead of sharing one through the module cache.
//
// Raw candles are loaded by preload and appended by candlePoll.
// WebSocket ticks only update livePrice for SL monitoring.
"use strict";

function createCandleBuffer() {
    let rawCandles = [];
    let livePrice  = null;

    return {
        onTick(price)    { livePrice = price; },
        getLivePrice()   { return livePrice; },
        getRawCandles()  { return rawCandles; },
        setRawCandles(c) { rawCandles = c || []; },
    };
}

module.exports = { createCandleBuffer };
