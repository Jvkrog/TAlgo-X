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
};

// Slot size in minutes — used by candlePoll.js to compute when a candle of
// this timeframe closes (live polling), not just by the backtester's fetch.
const TIMEFRAME_MINUTES = {
    "5m":  5,
    "15m": 15,
    "30m": 30,
    "1h":  60,
};

const CHUNK_DAYS  = 60;   // conservative — safely under Kite's per-call cap at every supported interval
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

    let firstChunk = true;
    while (chunkStart <= end) {
        if (!firstChunk) await sleep(CHUNK_DELAY_MS);
        firstChunk = false;

        const chunkEnd = new Date(Math.min(
            chunkStart.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000,
            end.getTime()
        ));

        const bars = await kc.getHistoricalData(
            token,
            interval,
            chunkStart.toISOString().split("T")[0],
            chunkEnd.toISOString().split("T")[0]
        );

        for (const b of bars || []) {
            candles.push({
                open:  parseFloat(b.open),
                high:  parseFloat(b.high),
                low:   parseFloat(b.low),
                close: parseFloat(b.close),
                date:  new Date(b.date),
            });
        }

        chunkStart = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000);
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
    const bars = await kc.getHistoricalData(
        token,
        "day",
        new Date(from).toISOString().split("T")[0],
        new Date(to).toISOString().split("T")[0]
    );
    return (bars || [])
        .map(b => ({
            open:  parseFloat(b.open),
            high:  parseFloat(b.high),
            low:   parseFloat(b.low),
            close: parseFloat(b.close),
            date:  new Date(b.date),
        }))
        .sort((a, b) => a.date - b.date);
}

module.exports = { fetchHistoricalCandles, fetchDailyCandles, timeframeToInterval, TIMEFRAME_TO_INTERVAL, TIMEFRAME_MINUTES };
