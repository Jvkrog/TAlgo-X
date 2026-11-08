// dailyBarReader.js — completed RAW daily bars for a live engine (haCandleReader.js gives Heikin-Ashi only).
// Refreshes when the cache is older than 6h OR was fetched on an earlier IST day (the decision at ~10:00 must see yesterday's
// finished bar, not a copy cached the evening before). The still-forming bar is dropped only if it really is forming.
"use strict";

const { KiteConnect } = require("kiteconnect");
const { fetchDailyCandles } = require("../data/historicalFetch");
const { dropFormingBar, istDay } = require("../utils/formingBar");

const REFRESH_MS = 6 * 60 * 60 * 1000;

function createDailyBarReader({ token, engineConfig, label, lookbackDays = 400, now = () => Date.now() }) {
    let kc = null, bars = [], fetchedAt = 0, lastErrAt = 0;
    const client = () => { if (!kc) kc = new KiteConnect({ api_key: engineConfig.API_KEY }); kc.setAccessToken(engineConfig.getAccessToken()); return kc; };

    async function refresh() {
        const to = new Date(now()), from = new Date(to.getTime() - lookbackDays * 86400000);
        const raw = await fetchDailyCandles({ kc: client(), token, from, to });
        if (!raw || raw.length === 0) throw new Error("API returned 0 bars");
        bars = dropFormingBar(raw, null, to.getTime()).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
        fetchedAt = now();
    }
    async function getCompleted() {
        if (!fetchedAt || now() - fetchedAt > REFRESH_MS || istDay(fetchedAt) !== istDay(now())) {
            try { await refresh(); }
            catch (err) { if (now() - lastErrAt > 5 * 60000) { console.error(`[${label}] daily bars fetch failed: ${err.message} — serving cache (${bars.length} bars)`); lastErrAt = now(); } }
        }
        return bars;
    }
    return { getCompleted, prewarm: () => getCompleted().catch(() => {}) };
}

module.exports = { createDailyBarReader };
