// candleBuilder.js — live price tracker + candle buffer.
//
// One buffer per running instrument. Candles are loaded by preload and appended by candlePoll
// (time candles) or by the range-bar feed (range mode). WebSocket ticks only update livePrice
// for SL monitoring.
//
// Candle type: the buffer stores the SOURCE series and getRawCandles() returns the VIEW the
// strategy sees. view "native" returns the source untouched (legacy), view "HA" returns a
// Heikin-Ashi version (flagged _ha so strategy-level toHA() doesn't convert twice).
"use strict";

const { toHAAlways } = require("./indicators");

function createCandleBuffer({ view = "native" } = {}) {
    let source = [];
    let cache = null;
    let livePrice = null;

    const viewOf = () => {
        if (view !== "HA") return source;
        if (!cache) cache = toHAAlways(source).map(h => ({ ...h, _ha: true }));
        return cache;
    };

    return {
        onTick(price)    { livePrice = price; },
        getLivePrice()   { return livePrice; },
        getRawCandles()  { return viewOf(); },
        setRawCandles(c) { source = c || []; cache = null; },
        // Append one closed candle (source series) and return the candle as the strategy sees it.
        appendCandle(candle, max) {
            source.push(candle);
            if (max && source.length > max) source.shift();
            cache = null;
            const v = viewOf();
            return v[v.length - 1];
        },
        getSourceCandles() { return source; },
    };
}

module.exports = { createCandleBuffer };
