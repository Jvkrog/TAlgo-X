// priceMaHedgeController.js — the DECISIONS of the dual-account base-loss hedge. No timers, no Kite, no orders of its own;
// priceMaHedgeEngine.js injects broker.enter / broker.exit (which place the order, CONFIRM the fill and update leg.state),
// a clock and a price feed. Kept separate so the whole state machine is unit-tested with fakes (like dualBiasHedgeController.js).
//
// FOUR sub-legs on the same instrument (an account can hold an MIS row and an NRML row of one contract at the same time):
//     LONG_BASE   LONG  account  LONG                 — opened once (per day, until it exists) at the base-entry time
//     SHORT_BASE  SHORT account  SHORT
//     LONG_HEDGE  LONG  account  SHORT   — hedges a losing LONG_BASE
//     SHORT_HEDGE SHORT account  LONG    — hedges a losing SHORT_BASE
// Each base is hedged against ITS OWN loss, evaluated once per IST minute at the latest price:
//     base P&L (points, vs its entry) < -pnlBand  -> open that account's hedge
//     base P&L > +pnlBand and its hedge is open   -> close the hedge; in between nothing changes.
// The two accounts are independent, so both hedges can be open at once. pnlSmooth N averages the last N once-a-minute P&L samples
// before the test (1 = the raw latest value). A failed/unconfirmed order leaves everything as it was and is retried within the minute.
//
// carry (the standard mode): the BASES are NRML (opened once, never closed by the engine, picked up again on every start) and the HEDGES
// are MIS (a separate broker row, so selling against a losing NRML base does not close it). At EOD only the MIS hedge is closed (before
// the broker's square-off, which would cost more); from EOD on there are no entries (EOD_DONE). carry=false is the day mode: MIS bases +
// NRML hedges, everything flattened at EOD (hedges first).
//
// A leg is { key, account, kind, side, blocked, state:{position, entryPrice}, context }. broker.enter(leg, why) / broker.exit(leg, why)
// resolve true ONLY on a confirmed fill/flat (state is already updated by then); false leaves everything as it was.
"use strict";

function createPriceMaHedgeController({ legs, broker, clock, baseHour, baseMinute, eodHour, eodMinute, maxPriceAgeMs = 150 * 1000, carry = false, getPrice = () => null, pnlBand = 0, pnlSmooth = 1, log = () => {} }) {
    const { LONG_BASE, SHORT_BASE, LONG_HEDGE, SHORT_HEDGE } = legs;
    if (!(LONG_BASE && SHORT_BASE && LONG_HEDGE && SHORT_HEDGE)) throw new Error("priceMaHedgeController: needs LONG_BASE, SHORT_BASE, LONG_HEDGE, SHORT_HEDGE");
    const baseMin = baseHour * 60 + baseMinute, eodMin = eodHour * 60 + eodMinute;
    if (!(eodMin > baseMin)) throw new Error("priceMaHedgeController: EOD must be after the base-entry time");
    const bases = [LONG_BASE, SHORT_BASE], hedges = [LONG_HEDGE, SHORT_HEDGE];
    const all = [...hedges, ...bases];

        let baseEnteredOn = {};                 // legKey -> IST date its base was taken (a base is taken ONCE per day)
    let busy = false;
    const warned = new Set();
    const warnOnce = (k, m) => { if (!warned.has(k)) { warned.add(k); log(m); } };

    const hp = l => (l.context && l.context.product) || (carry ? "MIS" : "NRML");
    if (!(pnlBand >= 0)) throw new Error("priceMaHedgeController: pnlBand must be >= 0");
    const smoothN = Math.max(1, Math.floor(Number(pnlSmooth) || 1));
    let pnlSamples = { LONG_BASE: [], SHORT_BASE: [] }, lastEval = { today: null, min: -1 };

    async function pnlHedges(t, nowMin) {
        if (lastEval.today === t.today && lastEval.min === nowMin) return "OK";      // once per IST minute (retried within it only if an order was left pending)
        const q = getPrice();
        if (!q || !(q.price > 0) || t.nowMs - q.atMs > maxPriceAgeMs) { warnOnce(`pxstale:${t.today}:${nowMin}`, "[HEDGE_CONTROLLER] no fresh price — hedge check skipped"); return "OK"; }
        let pending = false;
        for (const [base, hedge, dir] of [[LONG_BASE, LONG_HEDGE, 1], [SHORT_BASE, SHORT_HEDGE, -1]]) {
            if (!base.state.position) { pnlSamples[base.key] = []; continue; }
            const arr = pnlSamples[base.key]; arr.push(dir * (q.price - base.state.entryPrice)); if (arr.length > smoothN) arr.shift();
            const v = arr.reduce((a, b) => a + b, 0) / arr.length;
            if (v < -pnlBand && !hedge.state.position) {
                if (hedge.blocked) { warnOnce(`blk:${hedge.key}`, `[HEDGE_CONTROLLER] ${hedge.key} is BLOCKED (${hedge.blockedReason || "see boot log"}) — no hedge`); continue; }
                log(`[HEDGE_CONTROLLER] ${base.key} P&L=${v.toFixed(2)}pts Action=OPEN_${hedge.side}_${hp(hedge)} Account=${hedge.account}_ACCOUNT`);
                const ok = await broker.enter(hedge, "BASE LOSS HEDGE"); if (!(ok && hedge.state.position)) pending = true;
            } else if (v > pnlBand && hedge.state.position) {
                log(`[HEDGE_CONTROLLER] ${base.key} P&L=${v.toFixed(2)}pts Action=EXIT_${hedge.side}_${hp(hedge)} Account=${hedge.account}_ACCOUNT`);
                if (!(await exitLeg(hedge, "BASE BACK IN PROFIT"))) pending = true;
            }
        }
        if (!pending) lastEval = { today: t.today, min: nowMin };
        return pending ? "EXIT_PENDING" : "OK";
    }

    async function exitLeg(leg, why) {
        if (!leg.state.position) return true;
        const ok = await broker.exit(leg, why);
        return ok && !leg.state.position;
    }

    async function eod() {
        if (carry) {                                          // only the MIS hedge is flattened; the NRML bases stay
            for (const leg of hedges) if (leg.state.position) await exitLeg(leg, "EOD");
            return hedges.every(l => !l.state.position) ? "EOD_DONE" : "EOD_PENDING";
        }
        for (const leg of hedges) if (leg.state.position) await exitLeg(leg, "EOD");
        if (hedges.every(l => !l.state.position)) for (const leg of bases) if (leg.state.position) await exitLeg(leg, "EOD");
        return all.every(l => !l.state.position) ? "EOD_DONE" : "EOD_PENDING";
    }

    async function tick() {
        if (busy) return "BUSY";            // one decision cycle at a time — orders are never placed from two overlapping ticks
        busy = true;
        try {
            const t = clock();
            const nowMin = t.hours * 60 + t.minutes;
            if (nowMin >= eodMin) return await eod();
            if (nowMin < baseMin) return "WAITING";

            // 1) base positions, once per day
            for (const leg of bases) {
                if (leg.blocked) { warnOnce(`blk:${leg.key}`, `[HEDGE_CONTROLLER] ${leg.key} is BLOCKED (${leg.blockedReason || "see boot log"}) — not entered`); continue; }
                if (leg.state.position || baseEnteredOn[leg.key] === t.today) continue;
                const ok = await broker.enter(leg, "BASE");
                if (ok && leg.state.position) baseEnteredOn[leg.key] = t.today;
            }

            return await pnlHedges(t, nowMin);
        } finally { busy = false; }
    }

    return {
        tick,
        getState: () => ({ baseEnteredOn: { ...baseEnteredOn } }),
        restore: s => { if (s && s.baseEnteredOn) baseEnteredOn = { ...s.baseEnteredOn }; if (!s || !s.baseEnteredOn || !Object.keys(s.baseEnteredOn).length) { pnlSamples = { LONG_BASE: [], SHORT_BASE: [] }; lastEval = { today: null, min: -1 }; } },
        markBaseEntered: (leg, today) => { baseEnteredOn[leg.key] = today; },
        activeHedge: () => hedges.find(l => l.state.position) || null,
        activeHedges: () => hedges.filter(l => l.state.position),
    };
}

module.exports = { createPriceMaHedgeController };
