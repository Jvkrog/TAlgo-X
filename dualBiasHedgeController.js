// dualBiasHedgeController.js — the DECISIONS of the dual-account bias hedge
// (daily-HA-bias core + Dynamic-Band hedge, flat at EOD), with no timers, no
// Kite and no order placement of its own. dualBiasHedgeEngine.js wires it to
// the real readers / orders / clock; backtestDualHedge.js's replayBiasHedge()
// implements the same rules over historical bars, and the two are tested
// against each other (same data in -> same trades out), which is the point of
// keeping this logic separate from the engine's plumbing.
//
// RULES (see backtestDualHedge.js's BIAS HEDGE header for the long version):
//   CORE   once per IST day, at/after entryHour:entryMinute, from the latest
//          COMPLETED daily HA candle (dailyReader.getLatest()): green -> the
//          LONG account takes the core position, red -> the SHORT account.
//          Decided once ("it remains const"): a doji / no read leaves the day
//          undecided and it is retried on the next tick until EOD. No target,
//          no stop.
//   HEDGE  while the core is open and the OTHER account is flat: when the
//          Dynamic Band (bandReader.getLatest()) is AGAINST the core (core
//          LONG -> red, core SHORT -> green) that account enters the opposite
//          side. State-based: a band already adverse when the core opens
//          hedges on the same tick.
//   UNWIND BAND_FLIP: the band back in the core's favour closes the hedge (it
//          re-opens if the band turns adverse again). EOD_ONLY: held to EOD.
//   EOD    from eodHour:eodMinute on, both accounts are force-closed, hedge
//          first, retried every tick until both are flat; no new entries after
//          EOD.
//
// A "leg" here is { side: "LONG"|"SHORT", state: { position }, role }, where
// role is "CORE" | "HEDGE" | null and is owned by this controller (set after a
// successful entry, cleared after a successful exit; markResumed() restores it
// after a restart). Injected enterLeg(leg, role, reason) / exitLeg(leg, reason,
// opts) only place/book the orders and return true on success; a failed
// entry/exit leaves state.position untouched.
"use strict";

function createBiasHedgeController({
    long, short, dailyReader, bandReader, enterLeg, exitLeg, clock,
    entryHour = 10, entryMinute = 0, eodHour, eodMinute,
    unwindMode = "BAND_FLIP", log = () => {},
}) {
    if (unwindMode !== "BAND_FLIP" && unwindMode !== "EOD_ONLY") {
        throw new Error(`createBiasHedgeController: unwindMode must be BAND_FLIP or EOD_ONLY (got ${unwindMode})`);
    }
    if (!(Number.isFinite(eodHour) && Number.isFinite(eodMinute))) throw new Error("createBiasHedgeController: eodHour/eodMinute are required");
    const entryMin = entryHour * 60 + entryMinute, eodMin = eodHour * 60 + eodMinute;
    if (!(eodMin > entryMin)) throw new Error("createBiasHedgeController: EOD must be after the core entry time");

    const legs = [long, short];
    const other = leg => (leg === long ? short : long);
    const coreLeg = () => legs.find(l => l.role === "CORE" && l.state.position) || null;
    let coreDecidedForDate = null;
    let noReadNotedFor = null;

    // After a restart: put a recovered position back under the right role. A
    // recovered CORE counts as today's decision (never re-decided, never a
    // second core) — the same guard hedgePairEngine.js has.
    function markResumed(leg, role, today) {
        leg.role = role;
        if (role === "CORE") coreDecidedForDate = today;
    }

    async function checkCoreEntry(t) {
        if (t.hours * 60 + t.minutes < entryMin) return null;
        if (coreDecidedForDate === t.today) return null;
        if (coreLeg()) { coreDecidedForDate = t.today; return null; }

        const daily = await dailyReader.getLatest();
        if (!daily || !daily.color) {
            if (noReadNotedFor !== t.today) { noReadNotedFor = t.today; log(`no usable daily HA read yet (doji / no data) — core undecided, retrying until EOD`); }
            return null;
        }
        // Locked in the moment we act on a real read, even if the order fails —
        // a failed entry means no core today, not a retry loop.
        coreDecidedForDate = t.today;
        const leg = daily.color === "green" ? long : short;
        const ok = await enterLeg(leg, "CORE", `daily HA ${daily.color}`);
        if (!ok) return null;
        leg.role = "CORE";
        return { action: "CORE_ENTRY", leg, color: daily.color };
    }

    async function checkHedge() {
        const core = coreLeg();
        if (!core) return null;
        const band = await bandReader.getLatest();
        if (!band || !band.color) return null;   // no read -> no decision
        const hedge = other(core);
        const coreSide = core.state.position;
        const adverse = coreSide === "LONG" ? band.color === "red" : band.color === "green";

        if (!hedge.state.position && adverse) {
            const ok = await enterLeg(hedge, "HEDGE", `band ${band.color} against ${coreSide} core`);
            if (!ok) return null;
            hedge.role = "HEDGE";
            return { action: "HEDGE_ENTRY", leg: hedge, color: band.color };
        }
        if (hedge.state.position && unwindMode === "BAND_FLIP" && !adverse) {
            const ok = await exitLeg(hedge, "BAND_FLIP_UNWIND");
            if (!ok) return null;
            hedge.role = null;
            return { action: "HEDGE_UNWIND", leg: hedge, color: band.color };
        }
        return null;   // EOD_ONLY: a hedge, once open, is left alone until EOD
    }

    // Hedge first, then core — never leave a naked core behind a still-open hedge
    // if only one exit succeeds. Returns true once BOTH accounts are flat.
    async function checkEod() {
        const open = legs.filter(l => l.state.position).sort((a, b) => (b.role === "HEDGE") - (a.role === "HEDGE"));
        for (const leg of open) {
            if (await exitLeg(leg, "EOD_FORCE", { awaitFill: true })) leg.role = null;
        }
        return !legs.some(l => l.state.position);
    }

    // One decision pass. Returns "ACTIVE" (normal), "EOD_PENDING" (past EOD, a
    // position is still open — retry next tick) or "EOD_DONE" (past EOD and flat).
    async function tick() {
        const t = clock();
        if (t.hours * 60 + t.minutes >= eodMin) return (await checkEod()) ? "EOD_DONE" : "EOD_PENDING";
        await checkCoreEntry(t);
        await checkHedge();
        return "ACTIVE";
    }

    return { tick, markResumed, coreLeg, checkEod };
}

module.exports = { createBiasHedgeController };
