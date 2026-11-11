// historicalFetch: long ranges walk newest-first and stop at the contract's first candle; short ranges unchanged.
"use strict";
const assert = require("assert");
const { fetchHistoricalCandles, fetchDailyCandles } = require("../data/historicalFetch");
const DAY = 86400000, now = Date.UTC(2026, 10, 10), listed = now - 500 * DAY;   // contract has 500 days of data
let calls = 0;
const kc = { getHistoricalData: async (tok, interval, f, to) => {
    calls++; const a = Math.max(Date.parse(f), listed), z = Date.parse(to), out = [];
    for (let t = a; t <= z; t += DAY) out.push({ open: 1, high: 2, low: 1, close: 1.5, date: new Date(t) });
    return out;
} };
(async () => {
    const real = global.setTimeout; global.setTimeout = (fn) => real(fn, 0);   // skip the rate-limit sleeps
    try {
        const r = await fetchHistoricalCandles({ kc, token: 1, timeframe: "1h", from: new Date(now - 3650 * DAY), to: new Date(now) });
        assert.ok(r.length >= 499 && r.length <= 502, "all 500 days returned: " + r.length);
        assert.ok(r[0].date.getTime() - listed < 2 * DAY, "reaches the first candle");
        assert.ok(r.every((c, i) => !i || c.date > r[i - 1].date), "sorted, de-duplicated");
        assert.ok(calls < 20, "stopped early instead of scanning 10 years: " + calls + " calls");
        calls = 0;
        const s = await fetchHistoricalCandles({ kc, token: 1, timeframe: "1h", from: new Date(now - 30 * DAY), to: new Date(now) });
        assert.ok(s.length >= 30 && calls === 1, "short range: one forward chunk, " + calls);
        // Kite refuses a "day" request wider than 2000 days: the daily fetch must split it.
        const strict = { getHistoricalData: async (t, iv, f, to) => { if ((Date.parse(to) - Date.parse(f)) / DAY > 2000) throw new Error("interval exceeds max limit: 2000 days"); return kc.getHistoricalData(t, iv, f, to); } };
        const d = await fetchDailyCandles({ kc: strict, token: 1, from: new Date(now - 3650 * DAY), to: new Date(now) });
        assert.ok(d.length >= 499 && d.length <= 502, "daily: all data, no 2000-day error: " + d.length);
        const src = require("fs").readFileSync(__dirname + "/../webdash/server.js", "utf8");
        assert.ok(/=== "max" \? MAX_HISTORY_DAYS/.test(src) && /chartWindow\(tf, now, req\.query\.range\)/.test(src), "server accepts max for backtest + chart");
        console.log("all passed");
    } finally { global.setTimeout = real; }
})().catch(e => { console.error(e.stack); process.exit(1); });
