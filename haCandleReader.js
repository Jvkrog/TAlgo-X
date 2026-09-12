// haCandleReader.js — lazily-refreshed Heikin-Ashi candle color reader for
// an arbitrary (token, timeframe) pair, independent of any running
// strategy's own candle buffer. Built for hedgePairEngine.js, which needs
// to read TWO different timeframes (1d for the core bias, 1h for the
// hedge trigger) off the SAME instrument — neither of which is the
// instrument's own live trading timeframe in the per-instrument
// engine.js/candlePoll.js sense, so there's no existing `candles` buffer
// to reuse. Same reasoning and same caching shape as htfGate.js (own
// KiteConnect client, own cache, refreshed lazily only when actually
// stale, fails safe on any error) — deliberately not reusing htfGate.js
// itself, since that file's isBlocked() bakes in a specific chop+ALMA-band
// condition this has no use for; this only ever needs "what color was the
// last completed candle."
//
// Color convention matches strategies.js's PURE_HA (haSide()): HA close >
// open -> green (bullish), close < open -> red (bearish), close === open
// (doji) -> null, meaning "no read this bar, treat as unchanged."
"use strict";

const fs = require("fs");
const { KiteConnect } = require("kiteconnect");
const { fetchHistoricalCandles, fetchDailyCandles } = require("./historicalFetch");
const { toHA } = require("./indicators");

// Refresh cadence — same "roughly half the bar's own duration" logic
// htfGate.js uses, so the cached last-closed bar is never far behind.
const REFRESH_MS = { "1h": 15 * 60 * 1000, "1d": 6 * 60 * 60 * 1000 };
// Lookback window for the historical fetch — comfortably more bars than
// any caller needs (this module has no indicator warmup of its own, just
// "give me the latest completed HA candle"), while staying inside
// fetchHistoricalCandles'/fetchDailyCandles' own chunking without extra
// API round-trips on the common (cache-hit) path.
const LOOKBACK_DAYS = { "1h": 15, "1d": 90 };

function createHaCandleReader({ token, timeframe, engineConfig, label }) {
    if (!REFRESH_MS[timeframe]) {
        throw new Error(`createHaCandleReader: unsupported timeframe "${timeframe}" (known: ${Object.keys(REFRESH_MS).join(", ")})`);
    }

    let kc = null;
    let haBars = [];   // completed HA candles only, oldest -> newest
    let lastFetchedAt = 0;
    let lastErrorLoggedAt = 0;

    function getClient() {
        if (kc) return kc;
        kc = new KiteConnect({ api_key: engineConfig.API_KEY });
        kc.setAccessToken(fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim());
        return kc;
    }

    async function refresh() {
        const to = new Date();
        const from = new Date(to.getTime() - LOOKBACK_DAYS[timeframe] * 24 * 60 * 60 * 1000);
        const kcInst = getClient();
        const raw = timeframe === "1d"
            ? await fetchDailyCandles({ kc: kcInst, token, from, to })
            : await fetchHistoricalCandles({ kc: kcInst, token, timeframe, from, to });
        if (!raw || raw.length === 0) throw new Error("API returned 0 bars");
        // Drop the still-forming current bar — same no-lookahead convention
        // every other candle consumer in this codebase follows (htfGate.js,
        // preload.js, longCandleGate.js).
        const completed = raw.slice(0, -1);
        haBars = toHA(completed);
        lastFetchedAt = Date.now();
    }

    // Returns { color: "green"|"red"|null, date, close } for the latest
    // COMPLETED HA candle, or null if no data is available yet (fails
    // safe — caller treats null the same as "no read," never as a signal).
    async function getLatest() {
        if (Date.now() - lastFetchedAt > REFRESH_MS[timeframe]) {
            try {
                await refresh();
            } catch (err) {
                if (Date.now() - lastErrorLoggedAt > 5 * 60 * 1000) {
                    console.error(`[${label}] HA reader (${timeframe}) fetch failed: ${err.message} — serving stale/empty cache`);
                    lastErrorLoggedAt = Date.now();
                }
                // Fall through and serve whatever's already cached (possibly
                // still empty on a cold start) — same fail-safe posture as
                // htfGate.js, never throws out of getLatest().
            }
        }
        if (!haBars.length) return null;
        const last = haBars[haBars.length - 1];
        const color = last.close > last.open ? "green" : last.close < last.open ? "red" : null;
        return { color, date: last.date, close: last.close };
    }

    return { getLatest, prewarm: () => getLatest().catch(() => {}) };
}

module.exports = { createHaCandleReader };
