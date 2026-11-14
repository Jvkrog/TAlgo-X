// priceMaHedgeController.js — the DECISIONS of the Price-MA dual-account hedge. No timers, no Kite, no orders of its own;
// priceMaHedgeEngine.js injects broker.enter / broker.exit (which place the order, CONFIRM the fill and update leg.state)
// and a clock. Kept separate so the whole state machine is unit-tested with fakes (like dualBiasHedgeController.js).
//
// FOUR sub-legs on the same instrument (an account can hold an MIS row and an NRML row of one contract at the same time):
//     LONG_BASE   LONG  account  LONG  MIS    — opened once per day at the base-entry time, kept to EOD
//     SHORT_BASE  SHORT account  SHORT MIS    — likewise
//     LONG_HEDGE  LONG  account  SHORT NRML   — the hedge against a falling market   (RED)
//     SHORT_HEDGE SHORT account  LONG  NRML   — the hedge against a rising market    (GREEN)
// GREEN: the SHORT account's SHORT MIS is the loser -> that account opens a LONG NRML hedge (SHORT_HEDGE).
// RED:   the LONG  account's LONG  MIS is the loser -> that account opens a SHORT NRML hedge (LONG_HEDGE).
// A colour change closes the old hedge FIRST (awaited + confirmed flat) and only then opens the new one; if the exit is
// not confirmed nothing new is opened and the next tick retries. NEUTRAL (or no / stale signal) never touches a hedge.
// EOD (from eodHour:eodMinute): hedges first, then both bases, retried every tick until every leg is flat; no new entries.
//
// A leg is { key, account, kind, side, blocked, state:{position}, context }. broker.enter(leg, why) / broker.exit(leg, why)
// resolve true ONLY on a confirmed fill/flat (state is already updated by then); false leaves everything as it was.
"use strict";

// hedgeMode "PNL" (alternative to the MA-slope colour): each base is hedged against ITS OWN loss, evaluated once per IST minute —
//     base P&L (points, vs its entry) < -pnlBand  -> open that account's NRML hedge (LONG_BASE -> LONG_HEDGE short, SHORT_BASE -> SHORT_HEDGE long)
//     base P&L > +pnlBand and the hedge is open   -> close the hedge; in between nothing changes.
// The two accounts are independent, so both hedges can be open at once. getPrice() -> { price, atMs } | null. pnlSmooth N averages the
// last N once-a-minute P&L samples before the test (1 = the raw latest value).
function createPriceMaHedgeController({ legs, broker, clock, baseHour, baseMinute, eodHour, eodMinute, maxSignalAgeMs = 150 * 1000, hedgeMode = "SLOPE", getPrice = () => null, pnlBand = 0, pnlSmooth = 1, log = () => {} }) {
    const { LONG_BASE, SHORT_BASE, LONG_HEDGE, SHORT_HEDGE } = legs;
    if (!(LONG_BASE && SHORT_BASE && LONG_HEDGE && SHORT_HEDGE)) throw new Error("priceMaHedgeController: needs LONG_BASE, SHORT_BASE, LONG_HEDGE, SHORT_HEDGE");
    const baseMin = baseHour * 60 + baseMinute, eodMin = eodHour * 60 + eodMinute;
    if (!(eodMin > baseMin)) throw new Error("priceMaHedgeController: EOD must be after the base-entry time");
    const bases = [LONG_BASE, SHORT_BASE], hedges = [LONG_HEDGE, SHORT_HEDGE];
    const all = [...hedges, ...bases];

    let sig = null;                         // { signal: "GREEN"|"RED"|"NEUTRAL", atMs }
    let baseEnteredOn = {};                 // legKey -> IST date its base was taken (a base is taken ONCE per day)
    let busy = false;
    const warned = new Set();
    const warnOnce = (k, m) => { if (!warned.has(k)) { warned.add(k); log(m); } };

    function setSignal(signal, atMs) { sig = { signal, atMs }; }
    const PNL = String(hedgeMode).toUpperCase() === "PNL";
    if (!(pnlBand >= 0)) throw new Error("priceMaHedgeController: pnlBand must be >= 0");
    const smoothN = Math.max(1, Math.floor(Number(pnlSmooth) || 1));
    let pnlSamples = { LONG_BASE: [], SHORT_BASE: [] }, lastEval = { today: null, min: -1 };

    async function pnlHedges(t, nowMin) {
        if (lastEval.today === t.today && lastEval.min === nowMin) return "OK";      // once per IST minute (retried within it only if an order was left pending)
        const q = getPrice();
        if (!q || !(q.price > 0) || t.nowMs - q.atMs > maxSignalAgeMs) { warnOnce(`pxstale:${t.today}:${nowMin}`, "[HEDGE_CONTROLLER] no fresh price — hedge check skipped"); return "OK"; }
        let pending = false;
        for (const [base, hedge, dir] of [[LONG_BASE, LONG_HEDGE, 1], [SHORT_BASE, SHORT_HEDGE, -1]]) {
            if (!base.state.position) { pnlSamples[base.key] = []; continue; }
            const arr = pnlSamples[base.key]; arr.push(dir * (q.price - base.state.entryPrice)); if (arr.length > smoothN) arr.shift();
            const v = arr.reduce((a, b) => a + b, 0) / arr.length;
            if (v < -pnlBand && !hedge.state.position) {
                if (hedge.blocked) { warnOnce(`blk:${hedge.key}`, `[HEDGE_CONTROLLER] ${hedge.key} is BLOCKED (${hedge.blockedReason || "see boot log"}) — no hedge`); continue; }
                log(`[HEDGE_CONTROLLER] Mode=PNL ${base.key} P&L=${v.toFixed(2)}pts Action=OPEN_${hedge.side}_NRML Account=${hedge.account}_ACCOUNT`);
                const ok = await broker.enter(hedge, "BASE LOSS HEDGE"); if (!(ok && hedge.state.position)) pending = true;
            } else if (v > pnlBand && hedge.state.position) {
                log(`[HEDGE_CONTROLLER] Mode=PNL ${base.key} P&L=${v.toFixed(2)}pts Action=EXIT_${hedge.side}_NRML Account=${hedge.account}_ACCOUNT`);
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

            if (PNL) return await pnlHedges(t, nowMin);

            // 2) hedge — only from a FRESH GREEN/RED signal; NEUTRAL / none / stale leaves the current hedge untouched
            if (!sig || sig.signal === "NEUTRAL") return "OK";
            if (t.nowMs - sig.atMs > maxSignalAgeMs) { warnOnce(`stale:${sig.atMs}`, `[HEDGE_CONTROLLER] signal ${sig.signal} is stale (${Math.round((t.nowMs - sig.atMs) / 1000)}s old) — no hedge action`); return "OK"; }
            const want = sig.signal === "GREEN" ? SHORT_HEDGE : LONG_HEDGE;
            const stale = want === SHORT_HEDGE ? LONG_HEDGE : SHORT_HEDGE;
            const loserBase = want === SHORT_HEDGE ? SHORT_BASE : LONG_BASE;

            if (stale.state.position) {
                log(`[HEDGE_CONTROLLER] Signal=${sig.signal} Action=EXIT_${stale.side}_NRML Account=${stale.account}_ACCOUNT`);
                if (!(await exitLeg(stale, `${sig.signal} FLIP`))) return "EXIT_PENDING";   // never open the new hedge on top of an unconfirmed one
            }
            if (want.state.position) return "OK";                                            // duplicate colour: already hedged
            if (want.blocked) { warnOnce(`blk:${want.key}`, `[HEDGE_CONTROLLER] ${want.key} is BLOCKED (${want.blockedReason || "see boot log"}) — no hedge`); return "OK"; }
            if (!loserBase.state.position) { warnOnce(`nobase:${loserBase.key}:${t.today}`, `[HEDGE_CONTROLLER] ${loserBase.key} is not open — nothing to hedge yet`); return "OK"; }
            log(`[HEDGE_CONTROLLER] Signal=${sig.signal} Action=OPEN_${want.side}_NRML Account=${want.account}_ACCOUNT`);
            await broker.enter(want, `${sig.signal} HEDGE`);
            return "OK";
        } finally { busy = false; }
    }

    return {
        tick, setSignal,
        getState: () => ({ baseEnteredOn: { ...baseEnteredOn } }),
        restore: s => { if (s && s.baseEnteredOn) baseEnteredOn = { ...s.baseEnteredOn }; if (!s || !s.baseEnteredOn || !Object.keys(s.baseEnteredOn).length) { pnlSamples = { LONG_BASE: [], SHORT_BASE: [] }; lastEval = { today: null, min: -1 }; } },
        markBaseEntered: (leg, today) => { baseEnteredOn[leg.key] = today; },
        activeHedge: () => hedges.find(l => l.state.position) || null,
        activeHedges: () => hedges.filter(l => l.state.position),
    };
}

module.exports = { createPriceMaHedgeController };
