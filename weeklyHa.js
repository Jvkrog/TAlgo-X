// weeklyHa.js — weekly Heikin-Ashi candles built from DAILY bars, for the Weekly HA Bias option of DAILY_HA_BIAS.
// Kite has no weekly interval, so a week is Monday..Sunday (IST calendar days) aggregated from daily candles:
// open = first day's open, high/low = extremes, close = last day's close. Heikin-Ashi is then taken over the weekly bars.
// Pure functions + a live reader with the same getLatest() shape as haCandleReader.js (plus getWeekSoFar()).
"use strict";

const { toHAAlways } = require("./indicators");

const istDayStr = d => new Date((d instanceof Date ? d : new Date(d)).getTime() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
// Monday (YYYY-MM-DD) of the week that contains the given IST day string.
function weekStartKey(dayStr) {
    const d = new Date(dayStr + "T00:00:00Z"), dow = (d.getUTCDay() + 6) % 7;   // Mon = 0
    return new Date(d.getTime() - dow * 86400000).toISOString().split("T")[0];
}
function aggregate(dailyBars) {
    const weeks = new Map();
    for (const b of dailyBars) {
        const k = weekStartKey(istDayStr(b.date)), w = weeks.get(k);
        if (!w) weeks.set(k, { weekKey: k, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close });
        else { w.high = Math.max(w.high, b.high); w.low = Math.min(w.low, b.low); w.close = b.close; }
    }
    return [...weeks.values()].sort((a, b) => a.weekKey < b.weekKey ? -1 : 1);
}
// The last COMPLETED week as a HA candle, as of `todayStr` (a week is complete once today is in a later week).
// Daily bars dated today or later are ignored — never look ahead. Returns null when there is no completed week.
function latestCompletedWeekly(dailyBars, todayStr) {
    const cur = weekStartKey(todayStr);
    const bars = dailyBars.filter(b => istDayStr(b.date) < todayStr);
    const weekly = aggregate(bars).filter(w => w.weekKey < cur);
    if (!weekly.length) return null;
    const ha = toHAAlways(weekly), last = ha[ha.length - 1];
    return { color: last.close > last.open ? "green" : last.close < last.open ? "red" : null, date: last.date, open: last.open, close: last.close, high: last.high, low: last.low };
}
// This week's days BEFORE today, as one raw weekly bar ({open, high, low}) — null on the week's first trading day.
function weekSoFar(dailyBars, todayStr) {
    const cur = weekStartKey(todayStr), mine = dailyBars.filter(b => { const d = istDayStr(b.date); return d < todayStr && weekStartKey(d) === cur; });
    if (!mine.length) return null;
    const w = aggregate(mine)[0];
    return { open: w.open, high: w.high, low: w.low };
}

// Live reader. Daily bars are refetched when stale (6h) or when the IST day changes.
function createWeeklyHaReader({ token, engineConfig, label, now = () => new Date() }) {
    const { KiteConnect } = require("kiteconnect");
    const { fetchDailyCandles } = require("./historicalFetch");
    let kc = null, bars = [], fetchedAt = 0, fetchedDay = null, lastErr = 0;
    async function refresh() {
        if (!kc) kc = new KiteConnect({ api_key: engineConfig.API_KEY });
        kc.setAccessToken(engineConfig.getAccessToken());
        const to = now(), from = new Date(to.getTime() - 220 * 86400000);
        const raw = await fetchDailyCandles({ kc, token, from, to });
        if (!raw || !raw.length) throw new Error("API returned 0 bars");
        bars = raw; fetchedAt = Date.now(); fetchedDay = istDayStr(to);
    }
    async function ensure() {
        if (Date.now() - fetchedAt > 6 * 3600 * 1000 || fetchedDay !== istDayStr(now())) {
            try { await refresh(); } catch (e) { if (Date.now() - lastErr > 5 * 60 * 1000) { console.error(`[${label}] weekly HA reader fetch failed: ${e.message} — serving stale/empty cache`); lastErr = Date.now(); } }
        }
    }
    return {
        getLatest: async () => { await ensure(); return latestCompletedWeekly(bars, istDayStr(now())); },
        getWeekSoFar: async () => { await ensure(); return weekSoFar(bars, istDayStr(now())); },
        prewarm: () => ensure().catch(() => {}),
    };
}

module.exports = { weekStartKey, aggregate, latestCompletedWeekly, weekSoFar, createWeeklyHaReader };
