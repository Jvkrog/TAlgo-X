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

    // BUG FIX Sep 2026: this used to be `if (kc) return kc;` — read the
    // access-token file ONCE, ever, and cache the client forever. That's
    // invisible for every other reader (htfGate.js, per-instrument
    // engine.js) because PM2 restarts those processes fresh every morning,
    // so a new process = a new token read. hedgePairEngine.js's readers are
    // the one place that ISN'T true — this process is deliberately
    // long-lived (see hedgePairEngine.js's own header) — so once Kite's
    // access token rotated for a new day, every refresh() here silently
    // kept failing ("Incorrect api_key or access_token") and getLatest()
    // just kept serving its last-successful read from days earlier,
    // forever, with no visible symptom besides a stale `date` on the
    // returned bar. Re-reading the token file on every refresh (a disk
    // read gated behind REFRESH_MS, never hot-path) costs nothing and
    // means a rotated token is picked up the very next refresh cycle.
    function getClient() {
        if (!kc) kc = new KiteConnect({ api_key: engineConfig.API_KEY });
        kc.setAccessToken(engineConfig.getAccessToken());
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

        let completed;
        if (timeframe === "1d") {
            // BUG FIX Sep 2026: this used to be an unconditional
            // slice(0,-1), same as the intraday branch below — assuming
            // the LAST bar in the response is always today's still-
            // forming one. That's a safe assumption for 1h (Kite always
            // has a partial current-hour bar going during market hours),
            // but not for "day": Kite only starts returning a partial bar
            // for today once today's session has actually begun
            // accumulating ticks. Called early enough — or on a day
            // MCX's own session-day boundary for this contract doesn't
            // line up with the IST calendar date the way it does for
            // equities — the last bar in the response can already BE
            // yesterday's true, complete candle. Blindly dropping it then
            // silently used the day BEFORE that as "yesterday" — one full
            // day stale, no error, no visible symptom besides the wrong
            // side getting traded (see this reader's DAILY_HA_BIAS caller
            // for the incident this was diagnosed from). Compare the last
            // bar's own IST calendar date against today's instead — only
            // drop it when they actually match.
            const istDateStr = d => {
                const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
                return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
            };
            const lastBar = raw[raw.length - 1];
            completed = istDateStr(lastBar.date) === istDateStr(to) ? raw.slice(0, -1) : raw;
        } else {
            // Drop the still-forming current bar — same no-lookahead
            // convention every other candle consumer in this codebase
            // follows (htfGate.js, preload.js, longCandleGate.js).
            completed = raw.slice(0, -1);
        }

        haBars = toHA(completed);
        lastFetchedAt = Date.now();
    }

    // Returns { color: "green"|"red"|null, date, close, high, low } for
    // the latest COMPLETED HA candle, or null if no data is available yet
    // (fails safe — caller treats null the same as "no read," never as a
    // signal). high/low added Sep 2026 for DAILY_HA_BIAS's SL level (the
    // previous daily HA candle's own high/low) — additive, every existing
    // caller that only reads .color/.date/.close is unaffected.
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
        return { color, date: last.date, close: last.close, high: last.high, low: last.low };
    }

    return { getLatest, prewarm: () => getLatest().catch(() => {}) };
}

module.exports = { createHaCandleReader };
