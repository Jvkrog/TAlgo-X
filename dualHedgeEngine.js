// dualHedgeEngine.js — dual-account hedging: TWO SEPARATE Kite logins
// trading the SAME instrument off the SAME Dynamic Mid band signal, one
// account LONG-only, the other SHORT-only. Positions carry overnight
// (NRML) — this engine has no EOD force-close at all, unlike
// hedgePairEngine.js's core/hedge legs.
//
// ORIGIN: modeled directly on two manually-written reference scripts
// (short.js/long.js) the user built and ran as separate paired accounts —
// this formalizes that same idea (one account long, the other short, on
// the same band) into toolbox/webdash-managed infrastructure instead of
// two hand-run scripts. Was briefly implemented as a strategies.js entry
// (DYNAMIC_MID_COLOR_SHORT_HOLD, single-account, short-only) — REMOVED
// once the actual requirement turned out to be genuinely cross-account,
// not a single-account strategy variant.
//
// PER-LEG SPEC (mirrors short.js/long.js's own hedged_position logic):
//   - LONG leg: enters LONG the moment the shared band color turns green
//     while flat. Never opens or reverses into SHORT — this account only
//     ever holds LONG or flat.
//   - SHORT leg: mirror — enters SHORT on red while flat, never LONG.
//   - Once a leg is holding a position and the band flips AGAINST it
//     (LONG + color turns red, or SHORT + color turns green): that leg's
//     max-loss cut arms FOR THE FIRST TIME right at that moment (see
//     MAX_LOSS_RUPEES below) — NOT from entry. Before any flip, there is
//     NO exit condition at all besides the take-profit rule below; this
//     was an explicit correction from the user after an earlier version
//     of this logic (single-account DYNAMIC_MID_COLOR_SHORT_HOLD) armed
//     it unconditionally from entry — reasoning given directly: "sl
//     should only be only when flipped cause we dont close position
//     (closing makes it losing trade)" — i.e. don't cut a position that's
//     merely pulled back but hasn't actually reversed against the band;
//     only once it has, is a loss-cap warranted.
//   - From the moment a leg has flipped at least once (stays true for the
//     rest of that position's life, even if price later moves back
//     favorable and un-flips): every tick, if currently in profit ->
//     EXIT (take profit); if loss has reached MAX_LOSS_RUPEES -> EXIT
//     (cut loss); otherwise -> HOLD. Matches turn-1's original spec
//     ("check whether position is in profit or loss if not in profit
//     hold... when in profit and flips then you can exit") plus the
//     max-loss addition on top.
//   - No chop/volume/long-candle/HTF/daily-HA gates on either leg (same
//     reasoning the removed strategy had — see dualHedgeContext.js: a
//     single-direction leg could otherwise be blocked from ever trading
//     its own side by a gate meant for a strategy that trades both ways).
//
// ARCHITECTURE — why this is its own process, not two engine.js runs:
// the SAME band signal drives both legs and must never be computed twice
// (a tiny timing skew between two independent replays could make the two
// legs disagree about whether a flip has happened) — so it's read ONCE
// per tick from a single shared dynamicBandReader.js instance and applied
// to both legs' own independent position state. This is the same
// "shared reader, per-leg state" shape hedgePairEngine.js already
// established for its own core/hedge legs — see that file's header.
//
// NO LIVE WEBSOCKET TICKER, and NO frequent REST polling either — this
// engine runs strictly on the band signal's own 15-minute cadence, same
// as the removed single-account DYNAMIC_MID_COLOR_SHORT_HOLD strategy did
// via processCandle: one check per completed 15m candle, nothing faster.
// An earlier version of this file polled every 15s "for responsiveness"
// (reusing hedgePairEngine.js's own no-ticker rationale) — that was an
// unrequested deviation and has been removed: entries, the take-profit/
// max-loss evaluation once flipped, AND the heartbeat log line below all
// happen exactly once per 15-minute slot, scheduled the same way
// candlePoll.js schedules a live engine.js strategy's own candle-close
// check (msUntilNextSlot15Plus10() below is that same slot-boundary-plus-
// buffer math, just inlined here rather than shared, since this engine
// has no candle buffer of its own to hang a shared helper off of).
//
// GAP CAPTURE (optional feature of THIS engine — DH_GAP_CAPTURE=true; there
// is no separate gap-capture engine/menu/process). It is an END-OF-DAY step
// (modeled on the user's short.js/long.js reference scripts: "PROFIT REALIZED"
// at 23:20, fresh entry at 23:21, "Saving Position", shutdown at 23:25). At
// the gap-capture time (default 23:20 IST) the band logic stops for the rest
// of the day and this sequence runs instead —
//   1. REALIZE: any position either leg is holding is force-closed (awaited
//      until filled) so today's trades are booked as realized P&L. Entry does
//      not proceed until BOTH legs are confirmed flat (retried each poll) —
//      never stacks a fresh order on top of an open one.
//   2. ENTER: LONG on the long user's account, SHORT on the short user's
//      account, right after, once per day. These positions are CARRIED
//      OVERNIGHT (NRML) and saved like any other dual-hedge position — the
//      point is to be positioned for the next session's gap.
//   3. QUIT: at the quit time (default 23:25 IST) a Telegram report goes out
//      (realized P&L today per leg, positions left open) and the process
//      exits cleanly with the positions still open (needs a deliberate PM2
//      start on the next trading day, where the normal band logic resumes
//      with them). Nothing is closed at quit.
// The clock checks run on their own DH_GC_POLL_MS poll (default 15s) because
// 23:20/23:25 don't fall on the 15-minute band slots; that poll never
// evaluates the band. If the process is started after the quit time, gap
// capture is skipped for that day and the normal band logic keeps running.
//
// CREDENTIALS: dualHedgeUsers.js — separate from engineConfig.js's single
// global API_KEY/ACCESS_TOKEN (see that file's header for why). Market
// data (instrument dump, the shared band reader, LTP polling for uPnL
// checks) is account-agnostic on Kite's API, so this engine arbitrarily
// uses the LONG leg's own client for all of that — ORDERS for each leg
// always go through that leg's OWN client (orders.js's new kcOverride
// param, added for this).
//
// ENV VARS:
//   DH_UNDERLYING            (required) e.g. "NATGASMINI"
//   DH_LONG_USER              (required) name registered via
//                             dualHedgeUsers.js — this account trades LONG
//   DH_SHORT_USER             (required) — this account trades SHORT
//   DH_EXCHANGE_OVERRIDE      default "MCX"
//   DH_LOTS_OVERRIDE          default 1 (both legs; see DH_LONG_LOTS_OVERRIDE/
//                             DH_SHORT_LOTS_OVERRIDE for per-leg sizing)
//   DH_LONG_LOTS_OVERRIDE / DH_SHORT_LOTS_OVERRIDE   per-leg, else DH_LOTS_OVERRIDE
//   DH_LOTMULT_OVERRIDE       required unless the underlying already has a
//                             lotMult override in context.js
//   DH_BAND_STEP_OVERRIDE     optional, else engineConfig.BAND_STEP_DEFAULT
//   DH_MAX_LOSS_RUPEES_OVERRIDE   default 3000
//   DH_GAP_CAPTURE            "true" enables gap capture (see above), default off
//   DH_GC_HOUR_OVERRIDE       / DH_GC_MINUTE_OVERRIDE         realize + enter, default 23 / 20 (IST)
//   DH_GC_QUIT_HOUR_OVERRIDE  / DH_GC_QUIT_MINUTE_OVERRIDE    quit (positions stay open), default 23 / 25
//   DH_GC_POLL_MS             default 15000
//   LIVE_ORDERS_OVERRIDE      "true" | "false" — same convention as engine.js
//
// NOT YET WIRED: webdash has no panel for this yet (toolbox.js's new
// Dual Hedge screen does — see toolbox.js's dualHedgeScreen()) — flagged
// as a scoped follow-up, same as hedgePairEngine.js's own original
// toolbox/webdash gap.
"use strict";

const { KiteConnect } = require("kiteconnect");
const engineConfig = require("./engineConfig");
const c = require("./c");
const { createCsvRepository } = require("./csvRepository");
const { createInstrumentSource } = require("./instrumentSource");
const { createContractPinStore } = require("./contractPins");
const { resolveDualHedgeLeg } = require("./dualHedgeContext");
const { listUsers } = require("./dualHedgeUsers");
const { createTelegram } = require("./telegram");
const { createState } = require("./state");
const { createDb } = require("./db");
const { createOrders } = require("./orders");
const positions = require("./positions");
const { emitEvent } = require("./eventBridge");
const { istParts, todayIST } = require("./istTime");
const { createDynamicBandReader } = require("./dynamicBandReader");

const MAX_LOSS_RUPEES = Number(process.env.DH_MAX_LOSS_RUPEES_OVERRIDE) || 3000;
const GAP_CAPTURE = process.env.DH_GAP_CAPTURE === "true";
const envNum = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v))) ? Number(v) : d;
const GC_HOUR         = envNum(process.env.DH_GC_HOUR_OVERRIDE, 23);
const GC_MINUTE       = envNum(process.env.DH_GC_MINUTE_OVERRIDE, 20);
const GC_QUIT_HOUR    = envNum(process.env.DH_GC_QUIT_HOUR_OVERRIDE, 23);
const GC_QUIT_MINUTE  = envNum(process.env.DH_GC_QUIT_MINUTE_OVERRIDE, 25);
const GC_POLL_MS      = envNum(process.env.DH_GC_POLL_MS, 15 * 1000);
const hhmm = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
function pastClock(hour, minute) {
    const { hours, minutes } = istParts();
    return hours > hour || (hours === hour && minutes >= minute);
}
const SLOT_MINUTES = 15; // fixed — matches the shared band reader's own "15m" timeframe below

async function main() {
    const UNDERLYING = process.env.DH_UNDERLYING;
    const LONG_USER   = process.env.DH_LONG_USER;
    const SHORT_USER  = process.env.DH_SHORT_USER;
    if (!UNDERLYING || !LONG_USER || !SHORT_USER) {
        console.error(c.red("DH_UNDERLYING, DH_LONG_USER and DH_SHORT_USER are all required — refusing to boot."));
        process.exit(1);
    }
    const EXCHANGE_OVERRIDE = process.env.DH_EXCHANGE_OVERRIDE || "MCX";
    if (GAP_CAPTURE && !(GC_QUIT_HOUR > GC_HOUR || (GC_QUIT_HOUR === GC_HOUR && GC_QUIT_MINUTE > GC_MINUTE))) {
        console.error(c.red(`Gap capture quit time (${hhmm(GC_QUIT_HOUR, GC_QUIT_MINUTE)}) must be after gap capture time (${hhmm(GC_HOUR, GC_MINUTE)}) — refusing to boot.`));
        process.exit(1);
    }

    const userMap = {};
    for (const u of listUsers()) userMap[u.name] = u;
    const longUser  = userMap[LONG_USER.toUpperCase()];
    const shortUser = userMap[SHORT_USER.toUpperCase()];
    for (const [label, u] of [["DH_LONG_USER", longUser], ["DH_SHORT_USER", shortUser]]) {
        if (!u || !u.apiKey || !u.accessToken) {
            console.error(c.red(`${label} "${label === "DH_LONG_USER" ? LONG_USER : SHORT_USER}" is not a fully configured dual-hedge user (missing API key or access token) — refusing to boot.`));
            console.error(c.red(`  Fix via toolbox.js's Dual Hedge > Manage Users menu.`));
            process.exit(1);
        }
    }

    if (process.env.LIVE_ORDERS_OVERRIDE !== undefined) {
        engineConfig.LIVE_ORDERS = process.env.LIVE_ORDERS_OVERRIDE === "true";
    }
    console.log(c.bold(engineConfig.LIVE_ORDERS ? c.red("LIVE — real orders will be placed (both accounts)")
                                                  : c.cyan("PAPER — shadow mode, no real orders")));

    function kcFor(user) {
        const kc = new KiteConnect({ api_key: user.apiKey });
        kc.setAccessToken(user.accessToken);
        return kc;
    }
    const longKc  = kcFor(longUser);
    const shortKc = kcFor(shortUser);

    console.log(c.dim(`loading instrument dump (${EXCHANGE_OVERRIDE})...`));
    const csvFilePath = EXCHANGE_OVERRIDE === "NSE" ? engineConfig.NSE_INSTRUMENT_CSV_PATH : engineConfig.INSTRUMENT_CSV_PATH;
    // Market data is account-agnostic — the LONG user's client is used for
    // this arbitrarily (see file header).
    const csvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({ filePath: csvFilePath, kc: longKc, exchange: EXCHANGE_OVERRIDE }).fetchRows,
    });
    await csvRepo.load();
    const pinStore = createContractPinStore();

    async function buildLeg(side, user, kc, { lots, lotMultOverride, bandStepOverride }) {
        let context, source;
        try {
            ({ context, source } = resolveDualHedgeLeg({
                underlying: UNDERLYING, side, userName: user.name, exchange: EXCHANGE_OVERRIDE,
                csvRepo, pinStore, lots, lotMultOverride, bandStepOverride,
            }));
        } catch (err) {
            // dualHedgeContext.js logs the lotMult fix itself; anything else
            // (e.g. a ReferenceError) must NOT exit silently — that hid the
            // crash loop where the process died right after the instrument dump.
            console.error(c.red(`[${side}] leg resolve failed: ${err.stack || err.message}`));
            process.exit(1);
        }

        console.log(c.dim(`[${context.tgPrefix}] resolved contract (${source}): ${context.symbol} (token ${context.token}, lotMult ${context.lotMult}, lots ${context.lots}, account:${user.name})`));

        const { tg } = createTelegram(context, engineConfig);
        const db     = createDb(context);
        db.initDB();
        const state  = createState();
        state.flipped = false; // extra field on top of createState()'s usual shape — see checkLeg() below
        const orders = createOrders(context, tg, kc); // kcOverride — THIS leg's own account, not the global one

        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            if (saved?.position === side) {
                state.position   = saved.position;
                state.entryPrice = saved.entry_price;
                const openTrade  = await db.getOpenTrade(context.tgPrefix);
                state.openTradeId = openTrade ? openTrade.id : null;
                // state.flipped is NOT persisted (see file header's
                // NO LIVE WEBSOCKET TICKER section / known tradeoff) — a
                // restart while already past the flip point re-arms the
                // max-loss cut from scratch rather than immediately, same
                // accepted risk profile hedgePairEngine.js's own resume
                // logic has for anything it doesn't explicitly persist.
                console.log(c.yellow(`[${context.tgPrefix}] resumed ${state.position}@${state.entryPrice} (flip-state not restored — will re-arm on the next real flip)`));
            } else if (saved?.position) {
                console.error(c.red(`[${context.tgPrefix}] stale saved position (${saved.position}@${saved.entry_price}) doesn't match this leg's own side (${side}) — NOT auto-resumed, verify against the broker manually`));
                tg(`⚠ [${context.tgPrefix}] Stale/mismatched saved position found on boot (${saved.position}@${saved.entry_price}). Verify against the broker manually.`);
            }
            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);
        } catch (err) {
            console.warn(`[${context.tgPrefix}] boot resume failed: ${err.message}`);
        }
        await orders.reconcile(state);

        return { side, user, context, tg, db, state, orders, ltpKey: `${context.exchange}:${context.symbol}` };
    }

    const bandStepOverride = process.env.DH_BAND_STEP_OVERRIDE ? Number(process.env.DH_BAND_STEP_OVERRIDE) : null;
    const lotMultOverride  = process.env.DH_LOTMULT_OVERRIDE ? Number(process.env.DH_LOTMULT_OVERRIDE) : null;
    const defaultLots      = Number(process.env.DH_LOTS_OVERRIDE) || 1;

    const long = await buildLeg("LONG", longUser, longKc, {
        lots: Number(process.env.DH_LONG_LOTS_OVERRIDE) || defaultLots,
        lotMultOverride, bandStepOverride,
    });
    const short = await buildLeg("SHORT", shortUser, shortKc, {
        lots: Number(process.env.DH_SHORT_LOTS_OVERRIDE) || defaultLots,
        lotMultOverride, bandStepOverride,
    });

    console.log(c.bold(`DUAL HEDGE  ${long.context.symbol}  LONG:${long.user.name} (${long.context.lots} lot)  SHORT:${short.user.name} (${short.context.lots} lot)  maxLoss:₹${MAX_LOSS_RUPEES} (armed only once flipped)`));
    console.log();

    // Shared band signal — read ONCE per tick, applied to both legs. See
    // file header for why this must not be computed independently twice.
    const bandReader = createDynamicBandReader({
        token: long.context.token, timeframe: "15m", bandStep: long.context.bandStep, engineConfig, label: "DUAL_HEDGE",
    });

    // Read-only client for LTP lookups (uPnL checks + entry/exit
    // bookkeeping prices) — same reasoning as hedgePairEngine.js's own
    // getLtp(): orders.js's _place() fetches its own LTP internally for
    // order pricing, this is purely for THIS engine's own PnL math.
    async function getLtp(ltpKey) {
        const data = await longKc.getLTP([ltpKey]);
        return data[ltpKey]?.last_price ?? null;
    }

    async function enterLeg(leg, reason) {
        const orderId = await leg.orders.enter(leg.side);
        if (engineConfig.LIVE_ORDERS && orderId === null) {
            console.error(c.red(`[${leg.context.tgPrefix}] ${leg.side} entry FAILED (${reason})`));
            leg.tg(`⚠ [${leg.context.tgPrefix}] ${leg.side} entry FAILED (${reason})`);
            return false;
        }
        const price = (await getLtp(leg.ltpKey).catch(() => null)) || 0;
        leg.state.position    = leg.side;
        leg.state.entryPrice  = price;
        leg.state.flipped     = false;
        leg.state.openTradeId = await leg.db.insertOpenTrade(leg.context.tgPrefix, leg.context.symbol, leg.side, leg.context.lots, price);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, leg.side, price, `DUAL_HEDGE_${leg.side}`);
        console.log(c.bold(`**${leg.side} ENTRY**`));
        console.log(c.green(`[${leg.context.tgPrefix}] ${leg.side} @ price ${price.toFixed(2)}  |  ${reason}`));
        leg.tg(`${leg.side} ENTER (${reason}) @ \u20b9${price.toFixed(2)}`);
        emitEvent(leg.context.tgPrefix, "ENTRY", { side: leg.side, price, trail: null });
        return true;
    }

    async function exitLeg(leg, reason, { awaitFill = false } = {}) {
        if (!leg.state.position) return true;
        const side = leg.state.position;
        // awaitFill (gap capture only): block until FILLED has logged so the
        // fill lands before the combined session report / next step.
        const orderId = await leg.orders.exit(side, awaitFill ? { awaitFill: true } : undefined);
        if (engineConfig.LIVE_ORDERS && orderId === null) {
            console.error(c.red(`[${leg.context.tgPrefix}] ${side} exit FAILED (${reason}) — position left open, NOT marked closed`));
            leg.tg(`⚠ [${leg.context.tgPrefix}] ${side} exit FAILED (${reason}) — position left open, verify manually.`);
            return false;
        }
        const price = (await getLtp(leg.ltpKey).catch(() => null)) ?? leg.state.entryPrice;
        console.log(c.bold(`**${leg.side} EXIT**`));
        await positions.close(leg.context, leg.state, leg.db, leg.tg, price, reason);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, null, 0);
        leg.state.flipped = false;
        return true;
    }

    // ─── Per-leg decision — see file header's PER-LEG SPEC for the full
    // rationale. `color` is this tick's shared band read ("green"|"red").
    async function checkLeg(leg, color) {
        const favorable = leg.side === "LONG" ? "green" : "red";
        const adverse    = leg.side === "LONG" ? "red"   : "green";

        if (!leg.state.position) {
            if (color === favorable) await enterLeg(leg, `band ${color}`);
            // color === adverse while flat -> no action, this leg only ever trades its own side
            return;
        }

        if (!leg.state.flipped) {
            if (color !== adverse) return; // still normal continuation — nothing to evaluate yet
            leg.state.flipped = true;
            console.log(c.yellow(`[${leg.context.tgPrefix}] ${leg.side} FLIPPED (band turned ${color}) — max-loss cut (₹${MAX_LOSS_RUPEES}) now armed; was unprotected before this, by design`));
        }

        // Once flipped=true it STAYS true for the rest of this position's
        // life (see header) — every tick from here on gets evaluated for
        // profit/loss REGARDLESS of what color does next (a later
        // favorable/un-flip tick must still be checked for take-profit,
        // not just adverse-color ticks — this was a real bug caught on
        // review: an early `if (color !== adverse) return` here would have
        // silently skipped the profit check on exactly the ticks where a
        // take-profit exit is most likely to actually fire).
        const price = await getLtp(leg.ltpKey).catch(() => null);
        if (price === null) return; // couldn't price it this tick — re-check next poll, don't guess
        const uPnl = positions.unrealised(leg.context, leg.state, price);

        if (uPnl > 0) {
            await exitLeg(leg, "PROFITABLE FLIP EXIT");
        } else if (uPnl <= -MAX_LOSS_RUPEES) {
            await exitLeg(leg, `MAX LOSS EXIT (₹${MAX_LOSS_RUPEES})`);
        }
        // else: hold — "we dont close position (closing makes it losing trade)"
    }

    // ─── Web dashboard live pane + console heartbeat — one line per leg,
    // once per 15-minute tick (see msUntilNextSlot15Plus10() below for why
    // that's the cadence, not a faster poll).
    async function emitLivePnl() {
        const ts = new Date().toLocaleTimeString("en-IN", { hour12: false });
        for (const leg of [long, short]) {
            const price = await getLtp(leg.ltpKey).catch(() => null);
            if (price === null) continue;
            const uPnl = leg.state.position ? positions.unrealised(leg.context, leg.state, price) : 0;
            const session = (leg.state.pnl || 0) + uPnl;
            emitEvent(leg.context.tgPrefix, "TICK", {
                price, uPnl, session, position: leg.state.position, entryPrice: leg.state.entryPrice || null,
            });
            const posStr = leg.state.position ? `${leg.state.position}@${leg.state.entryPrice.toFixed(2)}${leg.state.flipped ? " (flipped)" : ""}` : "flat";
            const fmt = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
            const color = leg.state.position ? (uPnl >= 0 ? c.green : c.red) : c.dim;
            console.log(color(`[${leg.context.tgPrefix}] ${ts}  price ${price.toFixed(2).padStart(9)}  ${posStr.padEnd(24)}  uPnL:${fmt(uPnl).padStart(7)}  session:${fmt(session).padStart(8)}`));
        }
    }

    // ─── GAP CAPTURE (DH_GAP_CAPTURE=true) — see file header. From the
    // gap-capture time on, the band logic is off until the process quits.
    let gcDoneForDate    = null;  // realize+enter finished (or attempted) today
    let gcSkippedForDate = null;  // started after the quit time -> missed, band logic carries on
    let gcReportedForDate = null;
    if (GAP_CAPTURE) {
        console.log(c.dim(`gap capture ON  realize + enter ${hhmm(GC_HOUR, GC_MINUTE)} IST (positions carry overnight)  →  quit ${hhmm(GC_QUIT_HOUR, GC_QUIT_MINUTE)} IST`));
    }

    function gapWindowActive() {
        if (!GAP_CAPTURE) return false;
        if (gcSkippedForDate === todayIST()) return false;
        return pastClock(GC_HOUR, GC_MINUTE);
    }

    async function gapEnter() {
        const today = todayIST();
        if (gcDoneForDate === today) return;
        if (pastClock(GC_QUIT_HOUR, GC_QUIT_MINUTE)) {
            gcSkippedForDate = today;
            console.error(c.red(`GAP CAPTURE  window (${hhmm(GC_HOUR, GC_MINUTE)}–${hhmm(GC_QUIT_HOUR, GC_QUIT_MINUTE)} IST) already passed — skipping gap capture today, band logic continues`));
            long.tg(`⚠ [GAP CAPTURE] Window already passed when the engine started — skipped today.`);
            return;
        }

        // 1. Realize today's trades — never stack a new order on an open one.
        if (long.state.position || short.state.position) {
            console.log();
            console.log(c.bold("**GAP CAPTURE — REALIZING TODAY'S TRADES**"));
            if (long.state.position)  await exitLeg(long,  "GAP CAPTURE — REALIZE", { awaitFill: true });
            if (short.state.position) await exitLeg(short, "GAP CAPTURE — REALIZE", { awaitFill: true });
            if (long.state.position || short.state.position) {
                console.error(c.red(`GAP CAPTURE  realize did not fully flatten (long:${long.state.position || "flat"} short:${short.state.position || "flat"}) — entry held back, retrying next poll`));
                return;
            }
        }

        // 2. Enter — locked in before either order fires, so a failed entry
        // means no position tonight, not a retry loop.
        gcDoneForDate = today;
        console.log();
        console.log(c.bold("**GAP CAPTURE ENTRY**"));
        const reason = `gap capture ${hhmm(GC_HOUR, GC_MINUTE)} IST (carry overnight)`;
        await enterLeg(long,  reason);
        await enterLeg(short, reason);
    }

    async function gapQuit() {
        const today = todayIST();
        if (gcDoneForDate !== today) return;                       // realize/enter hasn't completed yet
        if (!pastClock(GC_QUIT_HOUR, GC_QUIT_MINUTE)) return;
        if (gcReportedForDate === today) return;
        gcReportedForDate = today;

        const longRealized  = await long.db.getRealizedPnlToday(long.context.tgPrefix);
        const shortRealized = await short.db.getRealizedPnlToday(short.context.tgPrefix);
        const total = longRealized + shortRealized;
        const open  = `long:${long.state.position ? `${long.state.position}@${long.state.entryPrice}` : "flat"}  short:${short.state.position ? `${short.state.position}@${short.state.entryPrice}` : "flat"}`;
        const report = `Dual Hedge (gap capture) EOD — ${today}\nlong   ${long.context.symbol} (${long.user.name}): realized ${positions.pnlStr(longRealized)}\nshort  ${short.context.symbol} (${short.user.name}): realized ${positions.pnlStr(shortRealized)}\ntotal realized: ${positions.pnlStr(total)}\nleft open overnight — ${open}`;
        console.log(c.bold(report.replace(/\n/g, "   ")));
        console.log();
        await long.tg(report);

        console.log(c.bold("Saving Position."));
        console.log(c.bold("*** NORMAL SHUTDOWN ***"));
        emitEvent(long.context.tgPrefix, "SHUTDOWN", {
            pnl: total, trades: long.state.trades + short.state.trades,
            positionLeftOpen: !!(long.state.position || short.state.position),
        });
        setTimeout(() => process.exit(0), 2000);
    }

    async function gapTick() {
        try {
            if (!gapWindowActive()) return;
            await gapEnter();
            await gapQuit();
        } catch (err) {
            console.error(c.red(`GAP CAPTURE loop error: ${err.message}`));
        }
    }

    async function tick() {
        try {
            if (gapWindowActive()) {
                // Band logic is off for the rest of the day (see GAP CAPTURE in the header).
                await emitLivePnl();
                return;
            }
            const band = await bandReader.getLatest();
            if (!band || !band.color) { console.log(c.dim("DUAL HEDGE  no band read yet — will retry next 15m slot")); return; }
            await checkLeg(long, band.color);
            await checkLeg(short, band.color);
            await emitLivePnl();
        } catch (err) {
            console.error(c.red(`DUAL HEDGE loop error: ${err.message}`));
        }
    }

    // ─── 15-minute slot-boundary scheduling — same shape and same +10s
    // publish-lag buffer as candlePoll.js's own msUntilNextSlotPlus10()/
    // scheduleNext() (see that file), just inlined here rather than
    // imported, since this engine has no candle buffer of its own to hang
    // a shared helper off. Runs exactly once per completed 15m candle —
    // not a faster poll — because the band signal (and therefore every
    // decision a leg makes) only actually changes on that cadence; polling
    // faster would just re-evaluate the same unchanged signal.
    function msUntilNextSlot15Plus10() {
        const now   = new Date();
        const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
        const ist   = new Date(istMs);
        const secInSlot = (ist.getUTCMinutes() % SLOT_MINUTES) * 60 + ist.getUTCSeconds();
        const msToNextClose = (SLOT_MINUTES * 60 - secInSlot) * 1000 - ist.getUTCMilliseconds();
        return msToNextClose + 10 * 1000;
    }

    function scheduleNextTick() {
        setTimeout(async () => { await tick(); scheduleNextTick(); }, msUntilNextSlot15Plus10());
    }

    bandReader.prewarm();
    await tick();
    scheduleNextTick();
    if (GAP_CAPTURE) {
        await gapTick();
        setInterval(gapTick, GC_POLL_MS);
    }
}

main().catch(err => {
    console.error("BOOT FAILED", err);
    process.exit(1);
});

process.on("uncaughtException",  err => console.error("UNCAUGHT",  err));
process.on("unhandledRejection", err => console.error("UNHANDLED", err));
