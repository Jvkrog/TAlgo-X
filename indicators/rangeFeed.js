// rangeFeed.js — range-bar candle source for engines running with candle type RANGE.
//
// Boot: 1-minute history (completed minutes) -> makeRangeBars -> candle buffer (the still-forming
// bar is kept as the builder's seed). Live: every tick feeds the incremental builder; each bar
// the tick completes is returned so the engine can append + process it like a closed candle.
"use strict";

const { createRangeBuilder, makeRangeBars } = require("./rangeBars");
const { candlesToPoints } = require("./rangeBandReader");
const { atr } = require("./indicators");

const HISTORY_DAYS = 15;

function toCandle(b) {
    const t = new Date(b.time instanceof Date ? b.time.getTime() : b.time);
    return { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0, date: String(t) };
}

function createRangeFeed({ context, engineConfig, kc, candles, tg }) {
    let builder = null;
    let lastCumVol = null;
    let rangeSize = context.rangeSize || null;

    async function defaultRange() {
        // Same suggestion the dashboard chart uses: ATR of the instrument's own timeframe, to 0.05.
        const to = new Date();
        const from = new Date(to.getTime() - 5 * 86400000);
        const bars = await kc.getHistoricalData(context.token, engineConfig.HIST_INTERVAL, from.toISOString().split("T")[0], to.toISOString().split("T")[0]);
        const clean = (bars || []).slice(0, -1).map(b => ({ open: +b.open, high: +b.high, low: +b.low, close: +b.close }));
        const a = atr(clean, engineConfig.ST_ATR_LEN);
        return a ? Math.max(0.05, Math.round(a * 20) / 20) : 1;
    }

    async function load() {
        if (!rangeSize) {
            rangeSize = await defaultRange();
            console.log(`[${context.tgPrefix}] RANGE bars: no size set — using ATR default ${rangeSize}`);
        }
        context.rangeSize = rangeSize;
        const to = new Date();
        const from = new Date(to.getTime() - HISTORY_DAYS * 86400000);
        const fmt = d => new Date(d.getTime() + 5.5 * 3600000).toISOString().replace("T", " ").slice(0, 19);
        const mins = (await kc.getHistoricalData(context.token, "minute", fmt(from), fmt(to))) || [];
        const curMin = Math.floor(Date.now() / 60000) * 60000;
        const done = mins
            .map(b => ({ open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume || 0, date: new Date(b.date) }))
            .filter(b => b.date.getTime() < curMin);
        if (!done.length) throw new Error("API returned 0 minute candles");
        const { bars, forming } = makeRangeBars(candlesToPoints(done), rangeSize);
        const list = bars.slice(-engineConfig.MAX_CANDLES).map(toCandle);
        candles.setRawCandles(list);
        builder = createRangeBuilder(rangeSize, forming);
        console.log(`[${context.tgPrefix}] RANGE bars loaded: ${list.length} bars, range ${rangeSize}`);
        return list.length;
    }

    // Returns the candles (source series) completed by this tick.
    function onTick(price, cumVolume) {
        if (!builder) return [];
        let vol = 0;
        if (Number.isFinite(cumVolume)) {
            if (lastCumVol !== null && cumVolume > lastCumVol) vol = cumVolume - lastCumVol;
            lastCumVol = cumVolume;
        }
        return builder.onTick(price, Date.now(), vol).map(toCandle);
    }

    return { load, onTick, getRangeSize: () => rangeSize };
}

module.exports = { createRangeFeed };
