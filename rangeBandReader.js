// rangeBandReader.js — the Dynamic Step Band (DSB) read used by
// dualHedgeEngine.js, computed on RANGE BARS built from 1-minute history.
// This is the signal source of the user's long.js/short.js reference scripts
// (their DSB, `talgoXDynamicStepBand`, run on Heikin Ashi 15m candles — later
// switched to range bars), ported as a shared reader so both legs read ONE
// computation.
//
// PIPELINE (same as the reference scripts):
//   1-minute candles (Kite historical, from a FIXED start date — range bars
//   are path-dependent, so the anchor must not move or every bar would)
//   -> each minute unrolled into a price path: open, then (low, high) if it
//      closed up / (high, low) if it closed down, then close
//   -> makeRangeBars(points, rangeSize)   (completed bars only; the still-
//      forming last bar is dropped)
//   -> DSB state machine over the bars -> color at the last completed bar.
//
// DSB (exact copy of the reference logic; the reference's dummy seed candles
// at price ~100 are NOT ported — mid is seeded from the first real bar's
// open instead, so it never has to "climb" to the instrument's price):
//   mid starts at the first bar's open, high = mid+step, low = mid-step.
//   close > high -> break up, close < low -> break down.
//   flat: first break sets position (mid moves one step with it).
//   long: break up -> mid += step; break down -> flip to short, mid -= step.
//   short: mirror.
//   color: green = long, red = short, white = flat (no breakout yet).
//   Breaks use a 1e-9 tolerance: with rangeSize == step a bar's close lands
//   EXACTLY on the band edge all the time, and float noise must not decide
//   whether that counts as a break (exact touch = no break, as `>` intends).
//
// DATA: minute candles are cached across calls (first call fetches from the
// start date in <=55-day requests — Kite caps 1-minute history at 60 days —
// later calls only from the last cached minute). The bars are always rebuilt
// from the FULL cache, so the result is identical to a from-scratch build.
// The still-forming current minute is excluded (no partial-minute data).
// Fails safe: any fetch error serves the last good state (null on cold start).
"use strict";

const { makeRangeBars } = require("./rangeBars");

const CHUNK_DAYS = 55;
const CHUNK_DELAY_MS = 400;   // stay under Kite's ~3 req/s historical-data limit
const EPS = 1e-9;
const IST_MS = 5.5 * 60 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Kite's from/to are IST wall-clock strings — formatted from epoch ms so the
// server's own timezone never matters.
const fmtIST = ms => new Date(ms + IST_MS).toISOString().replace("T", " ").slice(0, 19);
const parseIST = str => Date.parse(String(str).trim().replace(" ", "T") + "+05:30");

// createDsb(step) — the DSB state machine as an incremental stepper, so a
// backtest can read the band colour after EVERY bar in one pass instead of
// re-running the whole history per bar. dsbFromBars() below is just this
// stepper run over a full bar list — ONE implementation, so live and backtest
// can never disagree about what a bar sequence means.
function createDsb(step) {
    let mid = null, high = null, low = null, position = 0;

    function push(b) {
        if (mid === null) { mid = b.open; high = mid + step; low = mid - step; }
        const breakHigh = b.close > high + EPS;
        const breakLow  = b.close < low  - EPS;

        if (position === 0) {
            if (breakHigh)     { position = 1;  mid += step; }
            else if (breakLow) { position = -1; mid -= step; }
        } else if (position === 1) {
            if (breakHigh)     { mid += step; }
            else if (breakLow) { position = -1; mid -= step; }
        } else {
            if (breakLow)      { mid -= step; }
            else if (breakHigh){ position = 1;  mid += step; }
        }
        high = mid + step;
        low  = mid - step;
    }

    // null until the first bar has been pushed
    function state() {
        if (mid === null) return null;
        const color = position === 1 ? "green" : position === -1 ? "red" : "white";
        return { color, position, mid, high, low };
    }

    return { push, state };
}

function dsbFromBars(bars, step) {
    const dsb = createDsb(step);
    for (const b of bars) dsb.push(b);
    return dsb.state();
}

// Points for makeRangeBars from 1-minute candles (see PIPELINE above).
function candlesToPoints(candles) {
    const pts = [];
    for (const cn of candles) {
        const t = cn.date;
        pts.push({ price: cn.open, time: t });
        if (cn.close >= cn.open) {
            pts.push({ price: cn.low,  time: t });
            pts.push({ price: cn.high, time: t });
        } else {
            pts.push({ price: cn.high, time: t });
            pts.push({ price: cn.low,  time: t });
        }
        pts.push({ price: cn.close, time: t, volume: cn.volume });
    }
    return pts;
}

// createRangeBandReader({ getKc, token, step, rangeSize, startDate, label })
//   getKc      — () => authenticated KiteConnect (market data only)
//   step       — DSB step
//   rangeSize  — range bar size (price units)
//   startDate  — fixed anchor, IST "YYYY-MM-DD HH:mm:ss"
function createRangeBandReader({ getKc, token, step, rangeSize, startDate, label }) {
    const minutes = new Map();   // epoch ms -> candle
    let lastState = null;
    let lastErrorLoggedAt = 0;
    let inflight = null;

    async function refresh() {
        const nowMs   = Date.now();
        const curMin  = Math.floor(nowMs / 60000) * 60000;   // start of the still-forming minute
        let fromMs = parseIST(startDate);
        if (Number.isNaN(fromMs)) throw new Error(`invalid range start date "${startDate}"`);
        if (minutes.size > 0) {
            let last = 0;
            for (const k of minutes.keys()) if (k > last) last = k;
            fromMs = last - 5 * 60 * 1000;   // small overlap, entries just overwrite
        }

        let first = true;
        while (fromMs < nowMs) {
            if (!first) await sleep(CHUNK_DELAY_MS);
            first = false;
            const toMs = Math.min(fromMs + CHUNK_DAYS * 24 * 60 * 60 * 1000, nowMs);
            const part = await getKc().getHistoricalData(token, "minute", fmtIST(fromMs), fmtIST(toMs));
            for (const b of part || []) {
                const t = new Date(b.date).getTime();
                if (t < curMin) minutes.set(t, b);   // completed minutes only
            }
            if (toMs >= nowMs) break;
            fromMs = toMs;
        }
        if (minutes.size === 0) throw new Error("API returned 0 minute candles");

        const ordered = [...minutes.keys()].sort((a, b) => a - b).map(k => minutes.get(k));
        const { bars } = makeRangeBars(candlesToPoints(ordered), rangeSize);   // forming bar dropped
        const state = dsbFromBars(bars, step);
        if (!state) throw new Error(`no completed range bars yet (range ${rangeSize})`);
        lastState = { ...state, bars: bars.length, rangeSize, step };
    }

    // { color, position, mid, high, low, bars, rangeSize, step } for the latest
    // COMPLETED range bar, or null before any data (never a signal on its own).
    async function getLatest() {
        if (!inflight) {
            inflight = refresh().catch(err => {
                if (Date.now() - lastErrorLoggedAt > 5 * 60 * 1000) {
                    console.error(`[${label}] Range band fetch failed: ${err.message} — serving last good state`);
                    lastErrorLoggedAt = Date.now();
                }
            }).finally(() => { inflight = null; });
        }
        await inflight;
        return lastState;
    }

    return { getLatest, prewarm: () => getLatest().catch(() => {}) };
}

module.exports = { createRangeBandReader, dsbFromBars, createDsb, candlesToPoints };
