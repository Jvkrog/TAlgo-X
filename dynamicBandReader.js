// dynamicBandReader.js — lazily-refreshed Dynamic Band ("DYNAMIC_MID_COLOR")
// color reader for an arbitrary (token, timeframe) pair, independent of any
// running strategy's own candle buffer. Built for hedgePairEngine.js's
// checkHedge(), which needs a second, less noisy directional read to
// confirm the core instrument's own 1h HA candle color before triggering
// or unwinding the hedge — same reasoning and same caching shape as
// haCandleReader.js/htfGate.js (own KiteConnect client, own cache,
// refreshed lazily only when actually stale, fails safe on any error).
//
// WHY THIS EXISTS: raw HA candle color flips on every candle it forms,
// including a single small counter-colored candle inside a trend that
// hasn't actually reversed — a real case seen live: daily HA said SHORT,
// but one small green 1h HA candle briefly appeared, which alone would
// have triggered a false hedge entry. The Dynamic Band only flips when
// price actually breaks out of its step-width band (see
// createDynamicMidColorStrategy in strategies.js — same state machine,
// replayed here as a pure function, kept as an exact copy since
// strategies.js has no exported API surface for it). Requiring the band
// color to also agree before treating the HA read as a real signal is
// what filters that kind of single-candle noise out.
//
// Color convention matches createDynamicMidColorStrategy's directionColor():
// "green" while the replayed position is LONG (or before any breakout has
// ever happened — "no white", defaults green), "red" while SHORT.
"use strict";

const fs = require("fs");
const { KiteConnect } = require("kiteconnect");
const { fetchHistoricalCandles } = require("./historicalFetch");

// Exact copy of createDynamicMidColorStrategy's replayHistory() in
// strategies.js — if that strategy's band mechanics ever change, this
// copy needs the same change made here too, or the two will drift apart
// and this reader's "confirmation" stops actually matching what
// DYNAMIC_MID_COLOR would show on a live chart for the same instrument.
function replayBandColor(rawCandles, bandStep) {
    if (!rawCandles || rawCandles.length === 0) return null;

    let mid = rawCandles[0].close;
    let high = mid + bandStep;
    let low = mid - bandStep;
    let position = null;

    for (let i = 1; i < rawCandles.length; i++) {
        const close = rawCandles[i].close;
        const breakHigh = close > high;
        const breakLow = close < low;

        if (position === "LONG") {
            if (breakHigh) { mid += bandStep; }
            else if (breakLow) { position = "SHORT"; mid -= bandStep; }
        } else if (position === "SHORT") {
            if (breakLow) { mid -= bandStep; }
            else if (breakHigh) { position = "LONG"; mid += bandStep; }
        } else {
            if (breakHigh) { position = "LONG"; mid += bandStep; }
            else if (breakLow) { position = "SHORT"; mid -= bandStep; }
        }
        high = mid + bandStep;
        low = mid - bandStep;
    }

    // No white: same convention as createDynamicMidColorStrategy's
    // directionColor() — defaults green until the first real breakout,
    // then tracks whichever side the replay last flipped to.
    const color = position === "SHORT" ? "red" : "green";
    return { color, bandMid: mid, bandHigh: high, bandLow: low, position };
}

// Refresh cadence / lookback — identical to haCandleReader.js's own
// constants (same "roughly half the bar's own duration" reasoning, same
// window comfortably larger than any warmup this module needs).
const REFRESH_MS = { "1h": 15 * 60 * 1000, "1d": 6 * 60 * 60 * 1000 };
const LOOKBACK_DAYS = { "1h": 15, "1d": 90 };

function createDynamicBandReader({ token, timeframe, bandStep, engineConfig, label }) {
    if (!REFRESH_MS[timeframe]) {
        throw new Error(`createDynamicBandReader: unsupported timeframe "${timeframe}" (known: ${Object.keys(REFRESH_MS).join(", ")})`);
    }
    // Same fallback every strategy factory uses: context.bandStep ??
    // engineConfig.BAND_STEP_DEFAULT.
    const step = bandStep ?? engineConfig.BAND_STEP_DEFAULT;

    let kc = null;
    let lastState = null;
    let lastFetchedAt = 0;
    let lastErrorLoggedAt = 0;

    // Same fix as haCandleReader.js's getClient() (see its comment) — this
    // reader lives in the same long-lived hedgePairEngine.js process, so it
    // has the identical stale-token exposure. Re-read the token file on
    // every refresh instead of caching it from the first read.
    function getClient() {
        if (!kc) kc = new KiteConnect({ api_key: engineConfig.API_KEY });
        kc.setAccessToken(fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim());
        return kc;
    }

    async function refresh() {
        const to = new Date();
        const from = new Date(to.getTime() - LOOKBACK_DAYS[timeframe] * 24 * 60 * 60 * 1000);
        const kcInst = getClient();
        const raw = await fetchHistoricalCandles({ kc: kcInst, token, timeframe, from, to });
        if (!raw || raw.length === 0) throw new Error("API returned 0 bars");
        // Drop the still-forming current bar — same no-lookahead convention
        // haCandleReader.js/htfGate.js/preload.js/longCandleGate.js all
        // follow. DYNAMIC_MID_COLOR itself uses raw closes, not HA — the
        // band breaks on real price, so this reader replays raw candles
        // unmodified (no toHA() here, unlike haCandleReader.js).
        const completed = raw.slice(0, -1);
        lastState = replayBandColor(completed, step);
        lastFetchedAt = Date.now();
    }

    // Returns { color, bandMid, bandHigh, bandLow, position } for the
    // latest COMPLETED bar's replayed band state, or null if no data is
    // available yet (fails safe — caller treats null the same as "no
    // read," never as a signal).
    async function getLatest() {
        if (Date.now() - lastFetchedAt > REFRESH_MS[timeframe]) {
            try {
                await refresh();
            } catch (err) {
                if (Date.now() - lastErrorLoggedAt > 5 * 60 * 1000) {
                    console.error(`[${label}] Dynamic band reader (${timeframe}) fetch failed: ${err.message} — serving stale/empty cache`);
                    lastErrorLoggedAt = Date.now();
                }
                // Fall through and serve whatever's already cached
                // (possibly still empty on a cold start) — same fail-safe
                // posture as haCandleReader.js, never throws out of
                // getLatest().
            }
        }
        return lastState;
    }

    return { getLatest, prewarm: () => getLatest().catch(() => {}) };
}

module.exports = { createDynamicBandReader };
