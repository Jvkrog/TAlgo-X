// historicalFetch.js — pulls OHLC candles from Kite's historical-data API
// for a backtest. Chunks long date ranges into requests, since Kite's
// historical endpoint has a per-call date-span cap that gets stricter the
// finer the interval — chunking at a conservative fixed window works for
// all four supported timeframes without needing a per-interval limits
// table that would silently go stale as Kite's own limits change.
"use strict";

const TIMEFRAME_TO_INTERVAL = {
    "5m":  "5minute",
    "15m": "15minute",
    "30m": "30minute",
    "1h":  "60minute",
    "1d":  "day",      // live: evaluated once a day on the last COMPLETED daily bar (see candlePoll.js)
};

// Slot size in minutes — used by candlePoll.js to compute when a candle of
// this timeframe closes (live polling), not just by the backtester's fetch.
const TIMEFRAME_MINUTES = {
    "5m":  5,
    "15m": 15,
    "30m": 30,
    "1h":  60,
    "1d":  1440,
};

const CHUNK_DAYS  = 60;   // conservative — safely under Kite's per-call cap at every supported interval
const MAX_WALK_DAYS = 400;  // ranges longer than this are fetched newest-first and stop at the contract's first candle
const EMPTY_STOP = 3;       // consecutive empty chunks (after data was seen) that mean "history ends here"
const CHUNK_DELAY_MS = 350; // stays comfortably under Kite's ~3 req/sec historical-data rate limit

function timeframeToInterval(timeframe) {
    const interval = TIMEFRAME_TO_INTERVAL[timeframe];
    if (!interval) {
        throw new Error(`historicalFetch: unsupported timeframe "${timeframe}" (known: ${Object.keys(TIMEFRAME_TO_INTERVAL).join(", ")})`);
    }
    return interval;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// fetchHistoricalCandles({ kc, token, timeframe, from, to })
//   kc        — an authenticated KiteConnect instance (caller's responsibility,
//               same as every other module here — this file never touches
//               the access-token file itself)
//   token     — instrument_token to fetch (caller resolves this via the
//               existing csvRepository/instrumentResolution path)
//   timeframe — one of "5m" | "15m" | "30m" | "1h"
//   from, to  — Date objects (or date strings) covering the full range
//
// KNOWN LIMITATION: uses a single instrument_token for the entire range.
// For a range spanning a contract rollover, this only reflects whichever
// contract `token` refers to — it does NOT stitch together multiple
// expiries. Fine for backtesting recent behavior on the current contract;
// not yet a true continuous-contract backtest across rolls.
async function fetchHistoricalCandles({ kc, token, timeframe, from, to }) {
    const interval = timeframeToInterval(timeframe);
    const candles  = [];

    let chunkStart = new Date(from);
    const end       = new Date(to);
    if (chunkStart > end) throw new Error("historicalFetch: `from` is after `to`");

    const pushBars = bars => {
        for (const b of bars || []) {
            candles.push({
                open:  parseFloat(b.open),
                high:  parseFloat(b.high),
                low:   parseFloat(b.low),
                close: parseFloat(b.close),
                date:  new Date(b.date),
                volume: b.volume !== undefined ? parseFloat(b.volume) || 0 : 0,   // same field live candles carry (candlePoll.js); VWAP_SD_BANDS needs it in a backtest
            });
        }
        return (bars || []).length;
    };
    const DAY = 24 * 60 * 60 * 1000;

    if (end.getTime() - chunkStart.getTime() > MAX_WALK_DAYS * DAY) {
        // "Max history" ranges (more than ~a year): walk BACKWARDS from the newest chunk and stop once data has
        // started and then runs out (EMPTY_STOP consecutive empty chunks = before the contract's first candle).
        let cursorEnd = end.getTime(), seenData = false, empties = 0, firstCall = true;
        while (cursorEnd >= chunkStart.getTime()) {
            if (!firstCall) await sleep(CHUNK_DELAY_MS);
            firstCall = false;
            const cs = Math.max(cursorEnd - CHUNK_DAYS * DAY, chunkStart.getTime());
            const n = pushBars(await kc.getHistoricalData(token, interval, new Date(cs).toISOString().split("T")[0], new Date(cursorEnd).toISOString().split("T")[0]));
            if (n > 0) { seenData = true; empties = 0; } else if (seenData && ++empties >= EMPTY_STOP) break;
            cursorEnd = cs - DAY;
        }
    } else {
        let firstChunk = true;
        while (chunkStart <= end) {
            if (!firstChunk) await sleep(CHUNK_DELAY_MS);
            firstChunk = false;

            const chunkEnd = new Date(Math.min(chunkStart.getTime() + CHUNK_DAYS * DAY, end.getTime()));
            pushBars(await kc.getHistoricalData(
                token,
                interval,
                chunkStart.toISOString().split("T")[0],
                chunkEnd.toISOString().split("T")[0]
            ));
            chunkStart = new Date(chunkEnd.getTime() + DAY);
        }
    }

    // Chunk boundaries shouldn't overlap a candle since they're split on day
    // boundaries, but de-dupe by timestamp anyway — cheap insurance against
    // a boundary quirk silently double-counting a candle in the replay.
    const seen = new Set();
    const deduped = [];
    for (const c of candles.sort((a, b) => a.date - b.date)) {
        const key = c.date.getTime();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(c);
    }
    return deduped;
}

// fetchDailyCandles({ kc, token, from, to }) — same call shape as
// fetchHistoricalCandles above, fixed to Kite's "day" interval. Deliberately
// NOT added to TIMEFRAME_TO_INTERVAL/TIMEFRAME_MINUTES — those two lists are
// read directly by toolbox.js's timeframe picker as "cadences a live engine
// can run on," and daily isn't one of those here; it's only used for
// daily-level classification (see toolbox.js's "Trending Instruments").
// Kite's day-interval endpoint doesn't carry the same tight per-call
// date-span cap the intraday intervals do, so no chunking is needed.
async function fetchDailyCandles({ kc, token, from, to }) {
    // Kite rejects a "day" request wider than 2000 days ("interval exceeds max limit") — split wide ranges.
    const DAY = 24 * 60 * 60 * 1000, DAILY_CHUNK = 1900;
    const bars = [];
    let cs = new Date(from).getTime();
    const end = new Date(to).getTime();
    let first = true;
    while (cs <= end) {
        if (!first) await sleep(CHUNK_DELAY_MS);
        first = false;
        const ce = Math.min(cs + DAILY_CHUNK * DAY, end);
        bars.push(...((await kc.getHistoricalData(token, "day", new Date(cs).toISOString().split("T")[0], new Date(ce).toISOString().split("T")[0])) || []));
        cs = ce + DAY;
    }
    const seen = new Set();
    return bars
        .map(b => ({
            open:  parseFloat(b.open),
            high:  parseFloat(b.high),
            low:   parseFloat(b.low),
            close: parseFloat(b.close),
            date:  new Date(b.date),
        }))
        .sort((a, b) => a.date - b.date)
        .filter(c => { const k = c.date.getTime(); if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = { fetchHistoricalCandles, fetchDailyCandles, timeframeToInterval, TIMEFRAME_TO_INTERVAL, TIMEFRAME_MINUTES };
