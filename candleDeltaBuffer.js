"use strict";
// candleDeltaBuffer.js — per-candle buyVolume/sellVolume/delta/CVD history,
// built from live-tick estimates (tickVolumeDelta.js) and rolled into
// per-candle-interval snapshots aligned with candleBuilder.js's rawCandles
// (same instance-per-instrument pattern as candleBuilder.js's
// createCandleBuffer() — one of these per running instrument, not a module
// singleton).
//
// Deliberately a SEPARATE module from candleBuilder.js rather than adding
// fields onto its existing candle objects — rawCandles come from the
// broker's historical-candle REST API (candlePoll.js's fetchLastCandle),
// which has no concept of buy/sell split; deltaHistory here is a parallel,
// index-aligned array populated from a completely different data source
// (the live WebSocket tick stream). Keeping them separate keeps that
// distinction explicit instead of quietly merging two data sources with
// very different reliability/estimation characteristics into one object.

const { createTickDeltaAccumulator } = require("./tickVolumeDelta");

function createCandleDeltaBuffer() {
    const accumulator = createTickDeltaAccumulator();
    let deltaHistory = []; // [{date, buyVolume, sellVolume, delta, deltaPercent, cvd}], index-aligned to rawCandles
    let cvd = 0;

    function onTick(price, cumulativeVolume) {
        accumulator.onTick(price, cumulativeVolume);
    }

    function resync() {
        accumulator.resync();
    }

    // Called right after candlePoll.js appends a newly-completed raw
    // candle — snapshots whatever the live tick accumulator gathered
    // during that just-finished interval, computes this candle's delta%
    // (needs the candle's own broker-reported total volume, not the
    // tick-accumulated buy+sell — those two totals will rarely match
    // exactly, since the accumulator only sees ticks that actually reached
    // this process, while the broker's candle volume is the true exchange
    // total; delta% intentionally uses the authoritative exchange volume
    // as its denominator, not the estimate's own total) and CVD, and resets
    // the accumulator for the candle now forming.
    function rollCandle(candle) {
        const { buyVolume, sellVolume, delta } = accumulator.snapshotAndReset();
        const totalVolume = candle.volume || 0;
        const deltaPercent = totalVolume > 0 ? (delta / totalVolume) * 100 : 0;
        cvd += delta;

        const entry = { date: candle.date, buyVolume, sellVolume, delta, deltaPercent, cvd };
        deltaHistory.push(entry);
        if (deltaHistory.length > 500) deltaHistory.shift(); // same bounded-history shape as MAX_CANDLES elsewhere — this is a live-derived series, not the authoritative trades ledger, so trimming is safe

        return entry;
    }

    // Live read of the CURRENTLY FORMING candle's accumulated delta —
    // useful for relative-volume-of-forming-candle style checks without
    // waiting for the candle to close. Does NOT roll or reset anything.
    function getLiveDelta() {
        return accumulator.peek();
    }

    function getDeltaHistory() {
        return deltaHistory;
    }

    function getCvd() {
        return cvd;
    }

    // Called once at boot (initSignals) — this platform runs one PM2
    // process per trading day per instrument (same assumption
    // maxDailyLoss/sessionTargetRupees's boot-time state.pnl seeding
    // already relies on), so a fresh process boot IS the session boundary;
    // there's no separate cross-midnight reset path to build on top of
    // that pattern.
    function resetSession() {
        deltaHistory = [];
        cvd = 0;
    }

    return { onTick, resync, rollCandle, getLiveDelta, getDeltaHistory, getCvd, resetSession };
}

module.exports = { createCandleDeltaBuffer };
