// candleBuilder.js — live price tracker only
// Raw candles are loaded by preload and appended by candlePoll.
// WebSocket ticks only update livePrice for SL monitoring.
"use strict";

let rawCandles = [];
let livePrice  = null;

function onTick(price)     { livePrice = price; }
function getLivePrice()    { return livePrice; }
function getRawCandles()   { return rawCandles; }
function setRawCandles(c)  { rawCandles = c || []; }

module.exports = { onTick, getLivePrice, getRawCandles, setRawCandles };
