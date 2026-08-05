// istTime.js — explicit IST (UTC+5:30) time-of-day extraction, independent
// of the Node process's own local timezone.
//
// Every "is it past X:XX" check in this codebase (trading window open, EOD
// force-close, the pre-open heartbeat) needs IST specifically — MCX/NSE
// sessions are defined in IST, not wherever the process happens to be
// running. Date.prototype.getHours()/getMinutes() read the PROCESS's local
// timezone, not IST — on a server not explicitly set to Asia/Kolkata (the
// default on most cloud boxes, including this sandbox, is UTC), those would
// silently read the wrong hour and every window/EOD check would fire at the
// wrong time.
//
// backtestRun.js already worked around this with its own private copy of
// this exact conversion — confirmed broken without it, by testing on a
// UTC-default box. candlePoll.js's msUntilNextSlotPlus10() does its own
// version of the same conversion for slot-boundary math. This module is
// that conversion, shared, for the live call sites that were still using
// the unsafe process-local read: strategies.js's canEnter() (all four
// strategies), lifecycle.js's EOD check, and engine.js's pre-open
// heartbeat. backtestRun.js and candlePoll.js keep their own private
// copies — they already work, no need to touch them.
"use strict";

function istParts(date = new Date()) {
    const istMs = date.getTime() + (5.5 * 60 * 60 * 1000);
    const ist = new Date(istMs);
    return { hours: ist.getUTCHours(), minutes: ist.getUTCMinutes() };
}

module.exports = { istParts };
