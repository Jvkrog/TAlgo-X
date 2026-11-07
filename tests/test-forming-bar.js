"use strict";
const assert = require("assert");
const { dropFormingBar, intervalToMs } = require("../utils/formingBar");
const { calendarDayPolicy } = require("../data/rollPolicies");
const IST = s => new Date(s + "+05:30").getTime();
const bar = s => ({ date: new Date(s + "+05:30"), close: 1 });
assert.strictEqual(intervalToMs("15minute"), 900000); assert.strictEqual(intervalToMs("minute"), 60000); assert.strictEqual(intervalToMs("day"), null);
// intraday: mid-session the 10:15 bar is forming at 10:20 -> dropped; at 10:30 it is complete -> kept
const bars = [bar("2026-11-06T10:00:00"), bar("2026-11-06T10:15:00")];
assert.strictEqual(dropFormingBar(bars, 900000, IST("2026-11-06T10:20:00")).length, 1);
assert.strictEqual(dropFormingBar(bars, 900000, IST("2026-11-06T10:30:00")).length, 2);
// pre-market next morning: last bar (yesterday 23:15) is complete -> kept (old code threw it away)
const night = [bar("2026-11-06T23:00:00"), bar("2026-11-06T23:15:00")];
assert.strictEqual(dropFormingBar(night, 900000, IST("2026-11-07T08:50:00")).length, 2);
// daily: today's bar is forming -> dropped; pre-open the newest bar is yesterday's -> kept
assert.strictEqual(dropFormingBar([bar("2026-11-05T00:00:00"), bar("2026-11-06T00:00:00")], null, IST("2026-11-06T12:00:00")).length, 1);
assert.strictEqual(dropFormingBar([bar("2026-11-05T00:00:00"), bar("2026-11-06T00:00:00")], null, IST("2026-11-07T08:50:00")).length, 2);
assert.deepStrictEqual(dropFormingBar([], 900000), []);
// roll policy uses the IST day: 00:30 IST on the 20th is still the 19th on a UTC clock
const fut = [{ expiry: new Date("2026-11-27"), s: "NOV" }, { expiry: new Date("2026-12-31"), s: "DEC" }];
const pol = calendarDayPolicy(20);
assert.strictEqual(pol.select(fut, new Date("2026-11-19T19:00:00Z")).s, "DEC");   // 00:30 IST on the 20th
assert.strictEqual(pol.select(fut, new Date("2026-11-19T10:00:00Z")).s, "NOV");   // 15:30 IST on the 19th
console.log("PASS forming-bar + roll-policy IST handling");
