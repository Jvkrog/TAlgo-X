// htfGate.js — higher-timeframe confirmation gate. Universal, every
// strategy (including custom_strategies), same as chopGate.js/
// volumeGate.js/longCandleGate.js/doubleOrderGate.js.
//
// BLOCKS an entry when, on the higher timeframe (context.htfTimeframe,
// "1h" or "1d" — independent of and usually coarser than the instrument's
// own trading timeframe):
//   1. Choppiness Index is BELOW context.htfChopMax (default
//      engineConfig.HTF_CHOP_MAX_DEFAULT, 58) — the OPPOSITE direction
//      from chopGate.js's own filter. chopGate.js blocks ABOVE its
//      threshold (high chop = ranging/choppy = don't trade it). Here, a
//      LOW chop value means the higher timeframe itself is trending, not
//      ranging.
//   2. AND (if context.htfBandBlockEnabled !== false, the default) the
//      close still sits inside that higher timeframe's own ALMA
//      high/low band (almaLow < close < almaHigh, same construction as
//      ALMA_BAND's — see strategies.js) — i.e. that higher-timeframe trend
//      has not actually broken out of its own band yet. Set
//      htfBandBlockEnabled: false to drop this clause entirely — the gate
//      then blocks purely on condition 1 (chop) for as long as it holds,
//      not just until the band breaks. Configurable since Sep 2026.
// Both conditions together read as: "the bigger picture is trending, but
// hasn't confirmed a breakout" — entering the (finer) strategy timeframe
// right now would be trading ahead of / against an unconfirmed
// higher-timeframe move. If the HTF is choppy/ranging itself (chop >=
// threshold), or it's already broken out of its band, this gate does not
// apply — those cases are either already covered by the entry-timeframe's
// own chop filter, or are exactly the confirmed-breakout case entries are
// supposed to happen on.
//
// Own KiteConnect client + own candle cache per instrument, same pattern
// preload.js already uses — deliberately NOT reusing the instrument's own
// `candles` buffer (that's the strategy's OWN timeframe; this needs a
// DIFFERENT, coarser one). Cache is refreshed lazily, only when actually
// stale, right when isBlocked() is called (i.e. at an actual entry
// attempt) — no separate polling loop, no change to candlePoll.js's
// timing-sensitive main loop. Refresh interval is half the HTF bar's own
// duration (30 min for "1h", 12h for "1d") — frequent enough that the
// cached last-closed bar is never far behind, far too infrequent to
// meaningfully add to Kite API call volume.
//
// Fails SAFE: any fetch/parse/compute error, or not-yet-enough bars,
// returns false (never blocks) — same "insufficient data never blocks"
// convention every other gate here already follows. Logs the failure once
// per occurrence (not spammed every candle) so a persistently broken fetch
// is still visible.
"use strict";

const fs = require("fs");
const { KiteConnect } = require("kiteconnect");
const { fetchHistoricalCandles, fetchDailyCandles } = require("./historicalFetch");
const { choppinessIndex, alma } = require("./indicators");

const REFRESH_MS = { "1h": 30 * 60 * 1000, "1d": 12 * 60 * 60 * 1000 };

function createHtfGate({ context, engineConfig, tg }) {
    let kc = null;
    let bars = [];
    let lastFetchedAt = 0;
    let lastErrorLoggedAt = 0;

    function getClient() {
        if (kc) return kc;
        kc = new KiteConnect({ api_key: engineConfig.API_KEY });
        kc.setAccessToken(fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim());
        return kc;
    }

    async function refresh(timeframe) {
        const to = new Date();
        // 30 days of "1h" bars is already ~180 of them — far more than the
        // ~30 the chop period + ALMA band need — and fits in ONE
        // un-chunked fetchHistoricalCandles call (its CHUNK_DAYS is 60), so
        // the one time this cache is actually stale it doesn't land a
        // multi-second chunked fetch on the entry path. "1d" needs a wider
        // window for the same bar count, but Kite's day interval has no
        // per-call date-span cap to chunk around in the first place.
        const lookbackDays = timeframe === "1d" ? 200 : 30;
        const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
        const kc = getClient();
        const raw = timeframe === "1d"
            ? await fetchDailyCandles({ kc, token: context.token, from, to })
            : await fetchHistoricalCandles({ kc, token: context.token, timeframe: "1h", from, to });
        if (!raw || raw.length === 0) throw new Error("API returned 0 bars");
        // Drop the still-forming current bar, same as preload.js.
        bars = raw.slice(0, -1);
        lastFetchedAt = Date.now();
    }

    async function isBlocked() {
        if (context.htfGateEnabled === false) return false;
        const timeframe = context.htfTimeframe || engineConfig.HTF_GATE_TIMEFRAME_DEFAULT;
        const refreshMs = REFRESH_MS[timeframe] || REFRESH_MS[engineConfig.HTF_GATE_TIMEFRAME_DEFAULT];

        if (Date.now() - lastFetchedAt > refreshMs) {
            try {
                await refresh(timeframe);
            } catch (err) {
                if (Date.now() - lastErrorLoggedAt > 5 * 60 * 1000) {
                    console.error(`[${context.tgPrefix}] HTF gate fetch failed (${timeframe}): ${err.message} — not blocking`);
                    lastErrorLoggedAt = Date.now();
                }
                return false; // stale or empty cache — never block on missing data
            }
        }

        const period  = context.htfChopPeriod ?? engineConfig.HTF_CHOP_LEN_DEFAULT;
        const almaLen = engineConfig.HTF_ALMA_LEN_DEFAULT;
        if (bars.length < Math.max(period, almaLen) + 1) return false;

        const chopArr = choppinessIndex(bars, period);
        const chopVal = chopArr[chopArr.length - 1];
        if (chopVal === null || chopVal === undefined) return false;

        const chopMax = context.htfChopMax ?? engineConfig.HTF_CHOP_MAX_DEFAULT;
        if (!(chopVal < chopMax)) return false; // HTF itself is choppy/ranging — this gate doesn't apply

        // ALMA-band check — now independently configurable (was previously
        // fused into the AND below with no way to run the chop condition
        // on its own). Default true = unchanged prior behavior. When
        // false, the gate's block decision drops the band clause entirely
        // and blocks purely on the chop condition above — i.e. it blocks
        // for as long as the higher timeframe stays in a low-chop/
        // trending state, not just until price breaks its own band.
        if (context.htfBandBlockEnabled === false) return true;

        const highs = bars.map(b => b.high);
        const lows  = bars.map(b => b.low);
        const almaHigh = alma(highs, almaLen, engineConfig.HTF_ALMA_OFFSET_DEFAULT, engineConfig.HTF_ALMA_SIGMA_DEFAULT);
        const almaLow  = alma(lows,  almaLen, engineConfig.HTF_ALMA_OFFSET_DEFAULT, engineConfig.HTF_ALMA_SIGMA_DEFAULT);
        if (almaHigh === null || almaLow === null) return false;

        const close = bars[bars.length - 1].close;
        return close > almaLow && close < almaHigh; // still inside the band -> block
    }

    return { isBlocked, prewarm: () => isBlocked().catch(() => {}) };
}

module.exports = { createHtfGate };
