// gapCaptureEngine.js — dual-account, fixed-time gap-capture hedge: TWO
// SEPARATE Kite logins, SAME instrument, one account LONG-only, the other
// SHORT-only — same account-separation idea as dualHedgeEngine.js, but a
// completely different trigger. This engine has NO signal at all: at a
// fixed clock time both legs enter simultaneously (one LONG, one SHORT),
// and a fixed number of minutes later BOTH are force-closed, unconditionally,
// regardless of profit or loss.
//
// SPEC (as given directly):
//   - At/after ENTRY time (default 11:20 IST): enter LONG on the long
//     account and SHORT on the short account, back to back, once per
//     trading day. The point is to sit on both sides of whatever the
//     instrument does right at that moment (e.g. a gap up/down) — one
//     leg is in profit, the other in loss, and because they enter at
//     (near enough) the same instant/price and exit at the same instant/
//     price too, the loss leg is capped by the exact same move that
//     grew the profit leg, rather than left open to run further against
//     the account. Neither leg is monitored for its own P&L in between —
//     unlike dualHedgeEngine.js's per-leg flip/max-loss logic, this
//     engine's only two events, ever, are "enter both" and "exit both".
//   - At/after EXIT time (default 11:25 IST — 5 minutes after entry by
//     default): force-close BOTH legs, unconditionally. Telegram alert
//     per leg (via the existing orders.js/positions.js tg() calls every
//     other engine already sends on entry/exit) plus one combined
//     session-total alert once both are confirmed flat, mirroring
//     hedgePairEngine.js's own combined EOD report.
//   - Decided ONCE per day, like hedgePairEngine.js's core leg ("no
//     flipping") — win or lose, filled or not, this engine does not
//     retry entry later the same day if the entry attempt was already
//     made. Positions do NOT carry overnight (product MIS, unlike
//     dualHedgeEngine.js's NRML) — this is a same-day, same-window
//     round-trip on both legs, not a resting hedge.
//   - Process exits cleanly after the day's force-close + report, same
//     "needs a deliberate morning restart" lifecycle hedgePairEngine.js
//     settled on (Sep 2026) — a fresh PM2 start next trading day gives
//     both legs a clean createState() for free.
//
// ARCHITECTURE: reuses dualHedgeUsers.js's account registry AS-IS (same
// named-Kite-login store dualHedgeEngine.js's toolbox screen already
// manages) and dualHedgeContext.js's resolveDualHedgeLeg(), passing
// tag:"GC" so this engine's tgPrefix/db/telegram namespace (…_GC_LONG /
// …_GC_SHORT) never collides with the band-driven dual-hedge engine's
// own (…_DH_LONG / …_DH_SHORT), even if someone points both at the same
// underlying+users. That does NOT stop the two engines from actually
// placing conflicting broker-side orders on the same account/instrument
// if deliberately run against each other at once — flagged, not blocked,
// same posture dualHedgeContext.js's own header takes.
//
// NO LIVE WEBSOCKET TICKER, no band/HA reader at all — there is no signal
// here to read. A plain setInterval poll (GC_POLL_MS, default 15s —
// tighter than hedgePairEngine.js's 60s default since this engine's
// entire window between entry and exit is only a few minutes wide, so a
// coarser poll risks a visibly late fill on either edge) just checks
// "are we past ENTRY time yet" / "are we past EXIT time yet" every tick,
// same istParts()-based threshold-check shape hedgePairEngine.js's
// checkCoreEntry()/checkEod() already use.
//
// ENV VARS:
//   GC_UNDERLYING             (required) e.g. "NATGASMINI"
//   GC_LONG_USER              (required) name registered via
//                             dualHedgeUsers.js — this account trades LONG
//   GC_SHORT_USER             (required) — this account trades SHORT
//   GC_EXCHANGE_OVERRIDE      default "MCX"
//   GC_LOTS_OVERRIDE          default 1 (both legs); GC_LONG_LOTS_OVERRIDE/
//                             GC_SHORT_LOTS_OVERRIDE for per-leg sizing
//   GC_LOTMULT_OVERRIDE       required unless the underlying already has a
//                             lotMult override in context.js
//   GC_ENTRY_HOUR_OVERRIDE / GC_ENTRY_MINUTE_OVERRIDE   default 11 / 20
//   GC_EXIT_HOUR_OVERRIDE  / GC_EXIT_MINUTE_OVERRIDE    default 11 / 25
//   GC_POLL_MS                default 15000
//   GC_MAX_LOSS_RUPEES_OVERRIDE   optional per-leg safety backstop BEFORE
//                             the fixed exit time — see checkSafetyCut()
//                             below. Unset by default (pure time-only
//                             exit, exactly as specced); set this only if
//                             you also want an early-cut backstop between
//                             entry and the fixed exit.
//   LIVE_ORDERS_OVERRIDE      "true" | "false" — same convention as
//                             engine.js/dualHedgeEngine.js
//
// NOT YET WIRED: no toolbox.js/webdash deploy screen for this engine yet
// (dualHedgeEngine.js's own "G" menu is DH-specific — see toolbox.js line
// ~2423). Start directly, e.g.:
//   GC_UNDERLYING=NATGASMINI GC_LONG_USER=alice GC_SHORT_USER=bob \
//     pm2 start gapCaptureEngine.js --name gapcapture-natgasmini
// Flagged as a scoped follow-up, same as dualHedgeEngine.js's own original
// toolbox/webdash gap before that one got wired up.
"use strict";

const { KiteConnect } = require("kiteconnect");
const engineConfig = require("./engineConfig");
const c = require("./c");
const { istParts } = require("./istTime");
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

const POLL_MS = Number(process.env.GC_POLL_MS) || 15 * 1000;
const ENTRY_HOUR   = Number(process.env.GC_ENTRY_HOUR_OVERRIDE)   || 11;
const ENTRY_MINUTE = process.env.GC_ENTRY_MINUTE_OVERRIDE !== undefined ? Number(process.env.GC_ENTRY_MINUTE_OVERRIDE) : 20;
const EXIT_HOUR    = Number(process.env.GC_EXIT_HOUR_OVERRIDE)    || 11;
const EXIT_MINUTE  = process.env.GC_EXIT_MINUTE_OVERRIDE !== undefined ? Number(process.env.GC_EXIT_MINUTE_OVERRIDE) : 25;
// Optional early-cut backstop — off by default (undefined), see header.
const MAX_LOSS_RUPEES = process.env.GC_MAX_LOSS_RUPEES_OVERRIDE ? Number(process.env.GC_MAX_LOSS_RUPEES_OVERRIDE) : null;

function todayIST() {
    return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
}
function pastClock(hour, minute) {
    const { hours, minutes } = istParts();
    return hours > hour || (hours === hour && minutes >= minute);
}

async function main() {
    const UNDERLYING = process.env.GC_UNDERLYING;
    const LONG_USER  = process.env.GC_LONG_USER;
    const SHORT_USER = process.env.GC_SHORT_USER;
    if (!UNDERLYING || !LONG_USER || !SHORT_USER) {
        console.error(c.red("GC_UNDERLYING, GC_LONG_USER and GC_SHORT_USER are all required — refusing to boot."));
        process.exit(1);
    }
    const EXCHANGE_OVERRIDE = process.env.GC_EXCHANGE_OVERRIDE || "MCX";
    if (!(EXIT_HOUR > ENTRY_HOUR || (EXIT_HOUR === ENTRY_HOUR && EXIT_MINUTE > ENTRY_MINUTE))) {
        console.error(c.red(`Exit time (${EXIT_HOUR}:${String(EXIT_MINUTE).padStart(2, "0")}) must be after entry time (${ENTRY_HOUR}:${String(ENTRY_MINUTE).padStart(2, "0")}) — refusing to boot.`));
        process.exit(1);
    }

    const userMap = {};
    for (const u of listUsers()) userMap[u.name] = u;
    const longUser  = userMap[LONG_USER.toUpperCase()];
    const shortUser = userMap[SHORT_USER.toUpperCase()];
    for (const [label, u] of [["GC_LONG_USER", longUser], ["GC_SHORT_USER", shortUser]]) {
        if (!u || !u.apiKey || !u.accessToken) {
            console.error(c.red(`${label} "${label === "GC_LONG_USER" ? LONG_USER : SHORT_USER}" is not a fully configured account (missing API key or access token) — refusing to boot.`));
            console.error(c.red(`  Fix via toolbox.js's Dual Hedge > Manage Users menu (this engine reuses that same account registry).`));
            process.exit(1);
        }
    }

    if (process.env.LIVE_ORDERS_OVERRIDE !== undefined) {
        engineConfig.LIVE_ORDERS = process.env.LIVE_ORDERS_OVERRIDE === "true";
    }
    console.log(c.bold(engineConfig.LIVE_ORDERS ? c.red("LIVE — real orders will be placed (both accounts)")
                                                  : c.cyan("PAPER — shadow mode, no real orders")));
    console.log(c.dim(`entry ${String(ENTRY_HOUR).padStart(2, "0")}:${String(ENTRY_MINUTE).padStart(2, "0")} IST  →  exit ${String(EXIT_HOUR).padStart(2, "0")}:${String(EXIT_MINUTE).padStart(2, "0")} IST  (both legs, unconditional)`));

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
    // this arbitrarily, same convention as dualHedgeEngine.js.
    const csvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({ filePath: csvFilePath, kc: longKc, exchange: EXCHANGE_OVERRIDE }).fetchRows,
    });
    await csvRepo.load();
    const pinStore = createContractPinStore();

    async function buildLeg(side, user, kc, { lots, lotMultOverride }) {
        let context, source;
        try {
            ({ context, source } = resolveDualHedgeLeg({
                underlying: UNDERLYING, side, userName: user.name, exchange: EXCHANGE_OVERRIDE,
                csvRepo, pinStore, lots, lotMultOverride, tag: "GC",
            }));
        } catch (err) {
            process.exit(1); // dualHedgeContext.js already logged the specific fix
        }

        console.log(c.dim(`[${context.tgPrefix}] resolved contract (${source}): ${context.symbol} (token ${context.token}, lotMult ${context.lotMult}, lots ${context.lots}, account:${user.name})`));

        const { tg } = createTelegram(context, engineConfig);
        const db     = createDb(context);
        db.initDB();
        const state  = createState();
        const orders = createOrders(context, tg, kc); // kcOverride — THIS leg's own account

        try {
            // Same-day-only resume (mirrors hedgePairEngine.js's buildLeg,
            // NOT dualHedgeEngine.js's cross-day resume) — this engine's
            // positions never carry overnight, so a saved position from a
            // PRIOR day means a previous exit never got to run before this
            // reboot, not a live position still in play.
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            if (saved?.position === side && saved.entry_date === todayIST()) {
                state.position    = saved.position;
                state.entryPrice  = saved.entry_price;
                const openTrade   = await db.getOpenTrade(context.tgPrefix);
                state.openTradeId = openTrade ? openTrade.id : null;
                console.log(c.yellow(`[${context.tgPrefix}] resumed ${state.position}@${state.entryPrice} from earlier today`));
            } else if (saved?.position) {
                console.error(c.red(`[${context.tgPrefix}] stale saved position (${saved.position}@${saved.entry_price}, side/day mismatch) — NOT auto-resumed, verify against the broker manually`));
                tg(`⚠ [${context.tgPrefix}] Stale/mismatched saved position found on boot (${saved.position}@${saved.entry_price}). A previous exit may have failed to run, or this is from a prior day. Verify against the broker manually.`);
            }
            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);
        } catch (err) {
            console.warn(`[${context.tgPrefix}] boot resume failed: ${err.message}`);
        }
        await orders.reconcile(state);

        return { side, user, context, tg, db, state, orders, ltpKey: `${context.exchange}:${context.symbol}` };
    }

    const lotMultOverride = process.env.GC_LOTMULT_OVERRIDE ? Number(process.env.GC_LOTMULT_OVERRIDE) : null;
    const defaultLots     = Number(process.env.GC_LOTS_OVERRIDE) || 1;

    const long = await buildLeg("LONG", longUser, longKc, {
        lots: Number(process.env.GC_LONG_LOTS_OVERRIDE) || defaultLots, lotMultOverride,
    });
    const short = await buildLeg("SHORT", shortUser, shortKc, {
        lots: Number(process.env.GC_SHORT_LOTS_OVERRIDE) || defaultLots, lotMultOverride,
    });

    console.log(c.bold(`GAP CAPTURE  ${long.context.symbol}  LONG:${long.user.name} (${long.context.lots} lot)  SHORT:${short.user.name} (${short.context.lots} lot)`));
    console.log();

    // Read-only client for LTP lookups (bookkeeping prices + optional
    // safety-cut uPnL check) — same reasoning as dualHedgeEngine.js's own
    // getLtp(): orders.js's _place() fetches its own LTP internally for
    // order pricing, this is purely for THIS engine's own PnL math.
    async function getLtp(ltpKey) {
        const data = await longKc.getLTP([ltpKey]);
        return data[ltpKey]?.last_price ?? null;
    }

    // "No flipping" — decided once per day, same shape as
    // hedgePairEngine.js's coreDecidedForDate. If EITHER leg resumed a
    // same-day position at boot, treat today as already decided rather
    // than risk entering the still-flat leg late (well past the entry
    // window) into a lopsided, unhedged single-side position — flag it
    // instead so it can be checked manually if it ever actually happens.
    let decidedForDate = null;
    if (long.state.position || short.state.position) {
        decidedForDate = todayIST();
        if (!long.state.position || !short.state.position) {
            console.error(c.red(`ONLY ONE LEG resumed a same-day position (long:${long.state.position || "flat"} short:${short.state.position || "flat"}) — NOT re-entering the flat side today, verify manually.`));
            long.tg(`⚠ [GAP CAPTURE] Only one leg resumed a position on boot — the other was left flat rather than entered late. Verify both accounts manually.`);
        }
    }
    let reportedForDate = null;

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
        leg.state.openTradeId = await leg.db.insertOpenTrade(leg.context.tgPrefix, leg.context.symbol, leg.side, leg.context.lots, price);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, leg.side, price, `GAP_CAPTURE_${leg.side}`);
        console.log(c.bold(`**${leg.side} ENTRY**`));
        console.log(c.green(`[${leg.context.tgPrefix}] ${leg.side} @ price ${price.toFixed(2)}  |  ${reason}`));
        leg.tg(`${leg.side} ENTER (${reason}) @ \u20b9${price.toFixed(2)}`);
        emitEvent(leg.context.tgPrefix, "ENTRY", { side: leg.side, price, trail: null });
        return true;
    }

    async function exitLeg(leg, reason) {
        if (!leg.state.position) return true;
        const side = leg.state.position;
        // awaitFill on the fixed-time exit — block until FILLED (or
        // manual-check) has actually logged, so it lands before the
        // combined session report below, not after (same reasoning
        // lifecycle.js/hedgePairEngine.js's own EOD path uses).
        const orderId = await leg.orders.exit(side, { awaitFill: true });
        if (engineConfig.LIVE_ORDERS && orderId === null) {
            console.error(c.red(`[${leg.context.tgPrefix}] ${side} exit FAILED (${reason}) — position left open, NOT marked closed`));
            leg.tg(`⚠ [${leg.context.tgPrefix}] ${side} exit FAILED (${reason}) — position left open, verify manually. MIS auto square-off is the only backstop.`);
            return false;
        }
        const price = (await getLtp(leg.ltpKey).catch(() => null)) ?? leg.state.entryPrice;
        console.log(c.bold(`**${leg.side} EXIT**`));
        await positions.close(leg.context, leg.state, leg.db, leg.tg, price, reason);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, null, 0);
        return true;
    }

    // ─── ENTRY — both legs, unconditionally, once per day.
    async function checkEntry() {
        if (!pastClock(ENTRY_HOUR, ENTRY_MINUTE)) return;
        const today = todayIST();
        if (decidedForDate === today) return; // already acted today, win or lose — no re-entry
        decidedForDate = today; // lock in before either order fires — a failed entry means no position today, not a retry loop (same convention as hedgePairEngine.js's checkCoreEntry())

        console.log();
        console.log(c.bold("**GAP CAPTURE ENTRY**"));
        await enterLeg(long,  `fixed entry ${String(ENTRY_HOUR).padStart(2, "0")}:${String(ENTRY_MINUTE).padStart(2, "0")} IST`);
        await enterLeg(short, `fixed entry ${String(ENTRY_HOUR).padStart(2, "0")}:${String(ENTRY_MINUTE).padStart(2, "0")} IST`);
    }

    // ─── Optional early-cut backstop — OFF unless GC_MAX_LOSS_RUPEES_OVERRIDE
    // is set (see header). Purely a per-leg safety valve for an abnormal
    // move BEFORE the fixed exit time; the normal, specced exit is
    // checkExit() below regardless of P&L.
    async function checkSafetyCut() {
        if (MAX_LOSS_RUPEES === null) return;
        for (const leg of [long, short]) {
            if (!leg.state.position) continue;
            const price = await getLtp(leg.ltpKey).catch(() => null);
            if (price === null) continue;
            const uPnl = positions.unrealised(leg.context, leg.state, price);
            if (uPnl <= -MAX_LOSS_RUPEES) await exitLeg(leg, `SAFETY CUT (₹${MAX_LOSS_RUPEES})`);
        }
    }

    // ─── EXIT — force-close BOTH legs, unconditionally, regardless of
    // profit or loss, once per day. Retries every tick for as long as
    // EITHER leg is still open past the exit threshold (NOT a once-per-day
    // flag on the attempt itself) — same "don't silently give up for the
    // rest of today on one transient failure" reasoning as
    // hedgePairEngine.js's checkEod() (see that file's Sep 2026 incident
    // note); only the ONE-TIME combined report is gated on a daily flag,
    // and only once both legs are actually confirmed flat.
    async function checkExit() {
        if (!pastClock(EXIT_HOUR, EXIT_MINUTE)) return;
        if (!long.state.position && !short.state.position) return; // already flat — don't spam

        console.log();
        console.log(c.bold("**GAP CAPTURE EXIT**"));
        console.log(c.dim(`EXIT  gap capture  ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}`));
        if (long.state.position)  await exitLeg(long,  "GAP_CAPTURE_EXIT");
        if (short.state.position) await exitLeg(short, "GAP_CAPTURE_EXIT");

        if (long.state.position || short.state.position) {
            console.error(c.red(`EXIT did not fully flatten — long:${long.state.position || "flat"} short:${short.state.position || "flat"} — will retry next tick`));
            return;
        }

        const today = todayIST();
        if (reportedForDate === today) return; // already reported/shut down today
        reportedForDate = today;

        const longRealized  = await long.db.getRealizedPnlToday(long.context.tgPrefix);
        const shortRealized = await short.db.getRealizedPnlToday(short.context.tgPrefix);
        const total = longRealized + shortRealized;
        const report = `Gap Capture EOD — ${today}\nlong   ${long.context.symbol} (${long.user.name}): ${positions.pnlStr(longRealized)}\nshort  ${short.context.symbol} (${short.user.name}): ${positions.pnlStr(shortRealized)}\ntotal: ${positions.pnlStr(total)}`;
        console.log(c.bold(report.replace(/\n/g, "   ")));
        console.log();
        await long.tg(report); // ensure the message is sent before the process exits

        // Clean shutdown after the day's work — same lifecycle
        // hedgePairEngine.js settled on (Sep 2026): needs a deliberate
        // morning restart, not a long-lived process idling until tomorrow.
        console.log(c.bold("*** SHUTDOWN ***"));
        emitEvent(long.context.tgPrefix, "SHUTDOWN", {
            pnl: total, trades: long.state.trades + short.state.trades, positionLeftOpen: false,
        });
        setTimeout(() => process.exit(0), 2000);
    }

    async function tick() {
        try {
            await checkEntry();
            await checkSafetyCut();
            await checkExit();
        } catch (err) {
            console.error(c.red(`GAP CAPTURE loop error: ${err.message}`));
        }
    }

    await tick();
    setInterval(tick, POLL_MS);
}

main().catch(err => {
    console.error("BOOT FAILED", err);
    process.exit(1);
});

process.on("uncaughtException",  err => console.error("UNCAUGHT",  err));
process.on("unhandledRejection", err => console.error("UNHANDLED", err));
