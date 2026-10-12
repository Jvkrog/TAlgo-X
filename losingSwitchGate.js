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
    const stats = state.losingSwitchStats = state.losingSwitchStats || { losingReversals: 0, blocked: 0, daysExhausted: 0, exhaustedDays: [], blockedDays: [], losingDays: [], losingTrades: 0, tradeLimitDays: [], tradeBlocked: 0, tradeBlockedDays: [] };

    const max = () => {
        const m = Number(context.maxLosingSwitchesPerDay);
        return Number.isFinite(m) && m > 0 ? m : null;
    };
    const enabled = () => max() !== null;
    // Second, independent limit: losing trades of ANY exit reason per IST day (stop-loss, target, flip, ...).
    // Once the Nth losing trade closes, no further entries until the next session.
    let nt = 0;
    const maxT = () => {
        const m = Number(context.maxLosingTradesPerDay);
        return Number.isFinite(m) && m > 0 ? m : null;
    };
    const tradesEnabled = () => maxT() !== null;
    // Persist a limiter event for the AI review (best-effort, never throws, no-op for the backtest ledger).
    const note = (kind, detail) => { try { if (typeof db.logRiskEvent === "function") db.logRiskEvent(context.tgPrefix, istDayKey(clock.now().getTime()), kind, detail); } catch { /* observer only */ } };
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
            nt = 0;
        }
    }

    // Boot: rebuild today's counter from the trade journal. No-op when the feature is off or the DB
    // can't answer (backtest ledger).
    async function restore() {
        dayKey = istDayKey(clock.now().getTime());
        const since = new Date(istDayStartMs(clock.now().getTime())).toISOString();
        if (tradesEnabled() && typeof db.countLosingTradesSince === "function") {
            try {
                nt = await db.countLosingTradesSince(context.tgPrefix, since);
                if (nt > 0) log(`Losing trades today restored after restart: ${nt}/${maxT()}${nt >= maxT() ? " — limit reached, entries blocked for today" : ""}`);
            } catch (err) { console.warn(`[${tag}] could not restore losing-trade counter: ${err.message}`); }
        }
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
            if (stats.exhaustedDays.length && stats.blockedDays.filter(d => d === day).length === 1) note("LOSING_REVERSALS_LIMIT", { count: n, max: max(), reason, pnl });
            log("Position exited; opposite entry blocked, no further entries today");
        }
    }

    // Every closed position (any exit reason) reports here through positions.close -> state.onClose.
    function onClose(reason, pnl) {
        if (!tradesEnabled() || !(pnl < 0)) return;
        rollDay();
        nt += 1;
        stats.losingTrades += 1;
        log(`Losing trades today: ${nt}/${maxT()} (${reason}, pnl ${pnl.toFixed(2)})`);
        if (nt === maxT()) {
            const day = istDayKey(clock.now().getTime());
            if (!stats.tradeLimitDays.includes(day)) stats.tradeLimitDays.push(day);
            log("Daily losing-trade limit reached; no further entries today");
            note("LOSING_TRADES_LIMIT", { count: nt, max: maxT(), reason, pnl });
        }
    }
    const prevOnClose = state.onClose;
    state.onClose = (reason, pnl) => { if (typeof prevOnClose === "function") prevOnClose(reason, pnl); onClose(reason, pnl); };

    function tradesLocked() { return tradesEnabled() && (rollDay(), nt >= maxT()); }
    function reversalsLocked() { return enabled() && (rollDay(), n > max()); }

    // True when entries must not happen (either limit exhausted for today). Checked before every entry.
    function isLocked() { return reversalsLocked() || tradesLocked(); }

    function lockMessage(side) {
        if (tradesLocked()) {
            stats.tradeBlocked += 1; stats.tradeBlockedDays.push(istDayKey(clock.now().getTime()));
            return `${side} entry blocked — daily losing-trade limit reached (${nt}/${maxT()}); no entries until the next session`;
        }
        return `${side} entry blocked — daily losing-switch limit exhausted (${n}/${max()}); no entries until the next session`;
    }

    return { restore, recordFlipExit, isLocked, lockMessage, isFlipReason, get count() { return n; }, get max() { return max(); }, get tradeCount() { return nt; }, stats };
}

module.exports = { createLosingSwitchGate, FLIP_REASONS };
