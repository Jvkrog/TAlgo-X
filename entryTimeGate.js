// entryTimeGate.js — universal "no new entries before HH:MM IST" gate for every
// strategy EXCEPT DAILY_HA_BIAS (which has its own once-a-day entry time,
// context.dailyBiasEntryHour/Minute). Config: context.entryTimeHour/Minute
// (env ENTRY_TIME_OVERRIDE "HH:MM"); null = off (no restriction). Wired into the
// dailyHa.isBlocked() hook every strategy already calls before entering (live:
// dailyHaGate.js, backtest: backtestRun.js), so it needs no per-strategy edits.
// Only blocks NEW entries — exits, stops and targets are untouched.
"use strict";

const { istParts } = require("./istTime");

function isBeforeEntryTime(context, now = new Date()) {
    if (context.entryTimeHour === null || context.entryTimeHour === undefined) return false;
    const { hours, minutes } = istParts(now);
    return hours < context.entryTimeHour || (hours === context.entryTimeHour && minutes < (context.entryTimeMinute ?? 0));
}

module.exports = { isBeforeEntryTime };
