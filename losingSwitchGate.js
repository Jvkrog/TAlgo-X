// losingSwitchGate.js — daily limit on LOSING signal-driven reversals for the Dynamic Step Band family
// (DYNAMIC_BAND, DYNAMIC_MID_COLOR, DYNAMIC_MID_COLOR_HL, ALMA_DSB). A risk overlay only: it never changes
// what the strategy considers a signal, it only decides whether an entry may follow a losing flip exit.
//
// Definitions
//   flip exit   — a strategy's own signal-driven exit (FLIP_REASONS below). Stop-loss, target, EOD and
//                 daily-loss exits are NOT flip exits and never touch the counter.
//   losing      — the flip exit closed at a realised P&L below zero (break-even/profit never counts).
//   n           — losing flip exits so far in the current IST session day.
//   max         — context.maxLosingSwitchesPerDay (null/0 = feature off, nothing changes).
//
// Rules (n counts the exit that just happened)
//   n <= max : the opposite entry is permitted ("reversal permitted").
//   n  > max : this losing flip exit is still taken, but the opposite entry is BLOCKED and the instrument
//              stays FLAT with every entry blocked until the next IST day (cooldown for the rest of the day).
//   So the lock is purely a function of n — nothing extra to persist: n is rebuilt after a restart from the
//   trades table (closed, flip reason, pnl < 0, exit_time inside today's IST day), which also makes
//   duplicate candle processing / retries unable to double-count (a trade row exists once).
//
// Day boundary: IST calendar day, from the strategy clock (backtests replay on candle time).
"use strict";

const FLIP_REASONS = ["LONG REVERSAL", "SHORT REVERSAL", "COLOR FLIP EXIT", "DSB FLIP EXIT"];
const DAY_MS = 24 * 3600 * 1000, IST_MS = 5.5 * 3600 * 1000;
const istDayStartMs = ms => Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
const istDayKey = ms => new Date(ms + IST_MS).toISOString().slice(0, 10);

function createLosingSwitchGate({ context, state, db, clock = { now: () => new Date() }, tag = "DSB" }) {
    let n = 0;
    let dayKey = null;
    const stats = state.losingSwitchStats = state.losingSwitchStats || { losingReversals: 0, blocked: 0, daysExhausted: 0, exhaustedDays: [], blockedDays: [], losingDays: [] };

    const max = () => {
        const m = Number(context.maxLosingSwitchesPerDay);
        return Number.isFinite(m) && m > 0 ? m : null;
    };
    const enabled = () => max() !== null;
    const log = msg => console.log(`[${tag}] ${msg}`);

    // Resets the counter when the IST day has changed since the last call (live: process spanning days;
    // backtest: one continuous replay).
    function rollDay() {
        const k = istDayKey(clock.now().getTime());
        if (dayKey === null) { dayKey = k; return; }
        if (k !== dayKey) {
            dayKey = k;
            if (n > 0 && enabled()) log(`Daily losing-switch counter reset (was ${n})`);
            n = 0;
        }
    }

    // Boot: rebuild today's counter from the trade journal. No-op when the feature is off or the DB
    // can't answer (backtest ledger).
    async function restore() {
        dayKey = istDayKey(clock.now().getTime());
        if (!enabled() || typeof db.countLosingFlipExitsSince !== "function") return;
        try {
            n = await db.countLosingFlipExitsSince(context.tgPrefix, FLIP_REASONS, new Date(istDayStartMs(clock.now().getTime())).toISOString());
            if (n > 0) log(`Losing switches today restored after restart: ${n}/${max()}${n > max() ? " — limit exhausted, entries blocked for today" : ""}`);
        } catch (err) {
            console.warn(`[${tag}] could not restore losing-switch counter: ${err.message}`);
        }
    }

    function isFlipReason(reason) { return FLIP_REASONS.includes(reason); }

    // Call after a flip exit has actually been executed and the position closed (never before).
    function recordFlipExit(reason, pnl, fromSide) {
        if (!enabled() || !isFlipReason(reason)) return;
        rollDay();
        if (!(pnl < 0)) return;                       // profitable / break-even flips are untouched
        n += 1;
        stats.losingReversals += 1;
        stats.losingDays.push(istDayKey(clock.now().getTime()));
        const to = fromSide === "LONG" ? "SHORT" : "LONG";
        log(`Losing reversal: ${fromSide} -> ${to}  (pnl ${pnl.toFixed(2)})`);
        log(`Losing switches today: ${n}/${max()}`);
        if (n <= max()) {
            log("Reversal permitted");
        } else {
            stats.blocked += 1;
            const day = istDayKey(clock.now().getTime());
            stats.blockedDays.push(day);
            if (!stats.exhaustedDays.includes(day)) { stats.exhaustedDays.push(day); stats.daysExhausted += 1; }
            log("Daily losing-switch limit exhausted");
            log("Position exited; opposite entry blocked, no further entries today");
        }
    }

    // True when entries must not happen (limit exhausted for today). Checked before every entry.
    function isLocked() {
        if (!enabled()) return false;
        rollDay();
        return n > max();
    }

    return { restore, recordFlipExit, isLocked, isFlipReason, get count() { return n; }, get max() { return max(); }, stats };
}

module.exports = { createLosingSwitchGate, FLIP_REASONS };
