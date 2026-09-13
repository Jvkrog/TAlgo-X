// dailyHaGate.js — universal daily-HA directional gate.
//
// Unlike chopGate.js/volumeGate.js/longCandleGate.js/doubleOrderGate.js/
// htfGate.js — each wired individually into every one of the 20+ entry
// points across strategies.js AND customStrategyRuntime.js — this one is
// wired ONCE, directly into orders.js's enter() (the single funnel every
// strategy, hardcoded or custom, already calls to actually place an
// entry order). That makes it genuinely universal, including any future
// strategy nobody remembers to wire a gate into by hand, at the cost of
// not being visible in backtestRun.js's replay (backtestBroker.js's
// enter() is a dumb stub that never calls orders.js at all — the other
// 5 gates ARE checked in every backtest because their checks live
// in-line in strategies.js itself, before orders.enter() is ever called;
// this one, living inside orders.js, is a live-only gate for now).
//
// BLOCKS an entry whose SIDE disagrees with the previous COMPLETED daily
// Heikin-Ashi candle's color: green -> only LONG allowed (blocks SHORT),
// red -> only SHORT allowed (blocks LONG). Doji or no data yet -> fails
// safe, never blocks — same convention every other gate here follows.
//
// On by default (opt-out via context.dailyHaGateEnabled === false), same
// posture as htfGate.js/longCandleGate.js. One deliberate exception:
// hedgePairEngine.js sets this false on its HEDGE leg's context
// specifically (see hedgePairContext.js) — that leg's entire purpose is
// to open COUNTER to the current daily-HA-implied direction when the
// hourly read disagrees with the core, so this gate would otherwise
// block the hedge from ever doing its job. The CORE leg keeps it on
// (harmlessly redundant — the core's own entry logic already IS the
// daily HA decision, so this gate can never actually disagree with it).
//
// Reuses the KiteConnect client orders.js already creates for this
// context — no separate client/access-token read. Own candle cache,
// refreshed lazily, same "half the bar's own duration" cadence
// haCandleReader.js/htfGate.js already use for a daily bar (12h).
"use strict";

const { fetchDailyCandles } = require("./historicalFetch");
const { toHA } = require("./indicators");

const REFRESH_MS    = 12 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 90;

function createDailyHaGate({ context, kc }) {
    let haBars = [];
    let lastFetchedAt = 0;
    let lastErrorLoggedAt = 0;

    async function refresh() {
        const to   = new Date();
        const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
        const raw  = await fetchDailyCandles({ kc, token: context.token, from, to });
        if (!raw || raw.length === 0) throw new Error("API returned 0 bars");
        // Drop the still-forming current bar — same convention every other
        // candle consumer here follows (htfGate.js, haCandleReader.js,
        // preload.js).
        haBars = toHA(raw.slice(0, -1));
        lastFetchedAt = Date.now();
    }

    // side: "LONG" | "SHORT" — the entry orders.js's enter() is about to
    // place. Returns true if THIS side should be blocked.
    async function isBlocked(side) {
        if (context.dailyHaGateEnabled === false) return false;

        if (Date.now() - lastFetchedAt > REFRESH_MS) {
            try {
                await refresh();
            } catch (err) {
                if (Date.now() - lastErrorLoggedAt > 5 * 60 * 1000) {
                    console.error(`[${context.tgPrefix}] daily HA gate fetch failed: ${err.message} — not blocking`);
                    lastErrorLoggedAt = Date.now();
                }
                return false; // stale or empty cache — never block on missing data
            }
        }
        if (!haBars.length) return false;

        const last  = haBars[haBars.length - 1];
        const color = last.close > last.open ? "green" : last.close < last.open ? "red" : null;
        if (!color) return false; // doji -> no directional read, never blocks

        return (color === "green" && side === "SHORT") || (color === "red" && side === "LONG");
    }

    return { isBlocked, prewarm: () => isBlocked("LONG").catch(() => {}) };
}

module.exports = { createDailyHaGate };
