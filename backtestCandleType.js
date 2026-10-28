// backtestCandleType.js — turns the fetched time candles into the series the chosen candle type
// runs on (see candleType.js). HA: Heikin-Ashi of the same bars (flagged _ha so strategy-level
// toHA() doesn't convert twice). RANGE: range bars built from 1-minute history over the same span.
"use strict";

const { toHAAlways, atr } = require("./indicators");
const { makeRangeBars } = require("./rangeBars");
const { candlesToPoints } = require("./rangeBandReader");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchMinuteCandles({ kc, token, from, to }) {
    const out = [];
    const CHUNK = 30 * 86400000;
    let start = new Date(from).getTime();
    const end = new Date(to).getTime();
    let first = true;
    while (start <= end) {
        if (!first) await sleep(350);
        first = false;
        const stop = Math.min(start + CHUNK, end);
        const f = d => new Date(d + 5.5 * 3600000).toISOString().replace("T", " ").slice(0, 19);
        const bars = (await kc.getHistoricalData(token, "minute", f(start), f(stop))) || [];
        for (const b of bars) out.push({ open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume || 0, date: new Date(b.date) });
        start = stop + 1000;
    }
    const seen = new Set();
    return out.sort((a, b) => a.date - b.date).filter(b => { const k = b.date.getTime(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function suggestRange(rawCandles, atrLen) {
    const a = atr(rawCandles, atrLen);
    return a ? Math.max(0.05, Math.round(a * 20) / 20) : 1;
}

// returns { candles, rangeSize|null }
async function buildSeries({ view, rawCandles, kc, token, from, to, rangeSize, atrLen }) {
    if (view === "HA") {
        return { candles: toHAAlways(rawCandles).map((h, i) => ({ ...h, _ha: true, volume: rawCandles[i].volume })), rangeSize: null };
    }
    if (view === "RANGE") {
        const size = rangeSize || suggestRange(rawCandles, atrLen);
        const mins = await fetchMinuteCandles({ kc, token, from, to });
        if (!mins.length) throw new Error("backtest: no 1-minute history returned — cannot build range bars");
        const { bars } = makeRangeBars(candlesToPoints(mins), size);
        const candles = bars.map(b => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, date: new Date(b.time instanceof Date ? b.time.getTime() : b.time) }));
        return { candles, rangeSize: size };
    }
    return { candles: rawCandles, rangeSize: null };
}

module.exports = { buildSeries, fetchMinuteCandles };
