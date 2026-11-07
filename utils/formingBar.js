// formingBar.js — drop the still-forming last bar from a historical fetch, but ONLY if it really is still forming.
// The old code always dropped the last bar; fetched before the session opens (or after it closes) that bar is a
// COMPLETED one, so a whole real candle was silently thrown away.
"use strict";

const istDay = ms => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);

// "15minute" -> 900000, "minute" -> 60000, "60minute" -> 3600000, "day" / unknown -> null
function intervalToMs(interval) {
    const m = /^(\d*)minute$/.exec(String(interval || ""));
    return m ? (m[1] ? Number(m[1]) : 1) * 60000 : null;
}

// bars: [{ date, ... }] oldest -> newest (date = bar OPEN time). intervalMs null = daily bars (forming = today's IST date).
function dropFormingBar(bars, intervalMs, nowMs = Date.now()) {
    if (!bars || bars.length === 0) return bars || [];
    const open = new Date(bars[bars.length - 1].date).getTime();
    if (!Number.isFinite(open)) return bars.slice(0, -1);                    // can't tell — keep the old behaviour
    const forming = intervalMs ? open + intervalMs > nowMs : istDay(open) >= istDay(nowMs);
    return forming ? bars.slice(0, -1) : bars;
}

module.exports = { dropFormingBar, intervalToMs, istDay };
