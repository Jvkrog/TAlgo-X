// hedgePairEngine.js — the daily-HA-core + hourly-HA-hedge strategy,
// discussed and scoped in chat (Sep 2026), for a full-size/mini contract
// pair (NATURALGAS/NATGASMINI, or ZINC/ZINCMINI).
//
// SPEC (as agreed):
//   - CORE leg (full-size contract): once per trading day, at/after
//     TRADE_START_HOUR:TRADE_START_MINUTE, read the latest COMPLETED
//     DAILY Heikin-Ashi candle for that instrument. Green -> LONG 1 lot,
//     red -> SHORT 1 lot, product NRML. Decided ONCE per day and then
//     fixed — never reverses intraday off a later daily or hourly read
//     ("no flipping ... it remains const"). Force-closed every day at
//     EOD ("eod exit only" — this is the position's ONLY automated exit;
//     no target, no stop).
//   - HEDGE leg (mini contract, same underlying): while the core leg is
//     open and the hedge is flat, if the SAME core instrument's latest
//     completed 1-HOUR HA candle turns AGAINST the core's direction,
//     open 5 lots on the mini contract, opposite side of the core (i.e.
//     same side as the adverse hourly read). 5:1 is the real contract
//     ratio for both supported pairs, not an arbitrary size (NATGASMINI
//     250 MMBtu vs NATURALGAS 1250; ZINCMINI 1000kg vs ZINC 5000kg).
//   - UNWIND (config-switchable via UNWIND_MODE_OVERRIDE, default
//     HA_FLIP — the user wants to A/B both live):
//       HA_FLIP  — hourly HA flips back in the core's favor -> hedge
//                  closes, only the core remains.
//       EOD_ONLY — hedge stays on regardless of hourly reads; closes
//                  only at EOD (below), same as the core.
//     Either way, EOD force-closes the hedge leg too, unconditionally —
//     this engine will never leave a naked, unhedged mini position open
//     overnight even under EOD_ONLY, since that's a pure execution
//     backstop, not a strategy choice.
//
// ARCHITECTURE — why this ISN'T a strategies.js entry or a
// customStrategyRuntime.js spec: every engine.js process today owns
// exactly ONE instrument's candles/orders/state. This strategy needs ONE
// process that owns TWO instruments' order flow (core + hedge) and reads
// TWO candle granularities (1d, 1h) off the CORE instrument's price only
// — the hedge leg has no signal of its own, it's a pure execution
// vehicle. That's a new process type, closer to scannerService.js's
// own-PM2-process precedent than to a per-instrument engine.js. Each leg
// still gets its own context/db/orders/state via the exact same
// factories engine.js uses (buildContext, createDb, createOrders,
// createState, createTelegram) — this file is the orchestration on top,
// not a reimplementation of any of that.
//
// NO LIVE WEBSOCKET TICKER — deliberately. Every signal here comes from
// haCandleReader.js's own lazily-cached historical-candle fetch (1d and
// 1h), checked on a plain setInterval poll (HEDGE_PAIR_POLL_MS, default
// 60s) — there's no per-tick SL/target/chop logic in this strategy that
// would need live ticks. Order placement still gets real-time pricing:
// orders.js's own _place() fetches LTP itself for the protected-limit
// band, same as every other engine. Entry/exit prices for THIS engine's
// own PnL bookkeeping (positions.close()/insertOpenTrade() both need a
// price) come from one extra getLTP() REST call at the moment of each
// order — see getLtp() below — since orders.js doesn't return a
// synchronous fill price.
//
// ENV VARS (mirrors engine.js's override-via-env convention):
//   CORE_UNDERLYING          (required) e.g. "NATURALGAS" or "ZINC"
//   HEDGE_UNDERLYING         (required) e.g. "NATGASMINI" or "ZINCMINI"
//   EXCHANGE_OVERRIDE        default "MCX"
//   CORE_LOTS_OVERRIDE       default 1
//   HEDGE_LOTS_OVERRIDE      default 5
//   CORE_LOTMULT_OVERRIDE    required unless the underlying already has a
//                            lotMult override in context.js (NATGASMINI
//                            does; NATURALGAS/ZINC/ZINCMINI do not yet —
//                            see this file's own refuse-to-boot guard,
//                            same reasoning as engine.js's).
//   HEDGE_LOTMULT_OVERRIDE   same as above, for the hedge leg
//   UNWIND_MODE_OVERRIDE     "HA_FLIP" (default) | "EOD_ONLY"
//   HEDGE_PAIR_POLL_MS       default 60000
//
// NOT YET WIRED: toolbox.js / webdash "Add Instrument" UI has no picker
// for this engine — it's started directly (`CORE_UNDERLYING=NATURALGAS
// HEDGE_UNDERLYING=NATGASMINI node hedgePairEngine.js`, or a manual PM2
// entry) until that UI work is scoped separately. Not backtested either
// — runBacktest.js's single-instrument model doesn't fit a two-instrument
// strategy any more than engine.js's live model does; that's a separate
// follow-up, same as the toolbox UI.
"use strict";

const fs = require("fs");
const { KiteConnect } = require("kiteconnect");
const engineConfig = require("./engineConfig");
const c = require("./c");
const { istParts } = require("./istTime");
const { getDefinition, buildContext, defaultEodFor } = require("./context");
const { createCsvRepository } = require("./csvRepository");
const { createInstrumentSource } = require("./instrumentSource");
const { createContractPinStore } = require("./contractPins");
const { resolveCurrent } = require("./instrumentResolution");
const { createTelegram } = require("./telegram");
const { createState } = require("./state");
const { createDb } = require("./db");
const { createOrders } = require("./orders");
const positions = require("./positions");
const { createHaCandleReader } = require("./haCandleReader");

const POLL_MS = Number(process.env.HEDGE_PAIR_POLL_MS) || 60 * 1000;
const UNWIND_MODE = (process.env.UNWIND_MODE_OVERRIDE || "HA_FLIP").toUpperCase();
if (UNWIND_MODE !== "HA_FLIP" && UNWIND_MODE !== "EOD_ONLY") {
    console.error(c.red(`UNWIND_MODE_OVERRIDE "${UNWIND_MODE}" invalid (known: HA_FLIP, EOD_ONLY) — refusing to boot.`));
    process.exit(1);
}

function todayIST() {
    return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
}

async function main() {
    const CORE_UNDERLYING  = process.env.CORE_UNDERLYING;
    const HEDGE_UNDERLYING = process.env.HEDGE_UNDERLYING;
    if (!CORE_UNDERLYING || !HEDGE_UNDERLYING) {
        console.error(c.red("CORE_UNDERLYING and HEDGE_UNDERLYING are both required — refusing to boot."));
        process.exit(1);
    }
    const EXCHANGE_OVERRIDE = process.env.EXCHANGE_OVERRIDE || "MCX";
    const ACCESS_TOKEN = fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim();

    console.log(c.dim(`loading instrument dump (${EXCHANGE_OVERRIDE})...`));
    const kcForDump = new KiteConnect({ api_key: engineConfig.API_KEY });
    kcForDump.setAccessToken(ACCESS_TOKEN);
    const csvFilePath = EXCHANGE_OVERRIDE === "NSE" ? engineConfig.NSE_INSTRUMENT_CSV_PATH : engineConfig.INSTRUMENT_CSV_PATH;
    const csvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({ filePath: csvFilePath, kc: kcForDump, exchange: EXCHANGE_OVERRIDE }).fetchRows,
    });
    await csvRepo.load();
    const pinStore = createContractPinStore();

    // ─── Per-leg boot: resolve contract, build context, wire db/orders/tg,
    // resume any same-day position from a crash restart. Same shape as
    // engine.js's own boot sequence + strategies.js's initSignals(),
    // scoped to ONE leg at a time (called twice, once per instrument).
    async function buildLeg(underlying, legLabel, { lots, lotMultOverride }) {
        const def = getDefinition(underlying, EXCHANGE_OVERRIDE);
        const { contract, source } = resolveCurrent(def.underlying, def, csvRepo, pinStore);
        const context = buildContext(def, contract);
        // Separate tgPrefix -> separate SQLite file (createDb keys off
        // this) and separate Telegram identity per leg, even though both
        // legs of a pair share one underlying's worth of price signal.
        context.tgPrefix = `${context.tgPrefix}_${legLabel}`;
        context.name     = `${context.name} (${legLabel})`;
        context.lots     = lots;
        if (lotMultOverride) context.lotMult = lotMultOverride;
        // Both legs are force-closed by THIS file's own EOD block below,
        // every day, unconditionally, regardless of product type — NRML
        // here is about margin treatment (matching "1 full lot NRML" from
        // the spec), not about whether our bot bothers to exit. MIS's
        // broker-side auto-square-off would ALSO catch either leg as a
        // backstop if our own EOD somehow failed to run — NRML is the
        // deliberately stricter choice, it does NOT get a free pass from
        // the broker the way MIS would.
        context.carryOvernight = true;
        const eod = defaultEodFor("1h", context.exchange);
        context.eodHour   = eod.eodHour;
        context.eodMinute = eod.eodMinute;

        // Same refuse-to-boot guard as engine.js — no fallback to the
        // broker's own lot_size field (a contract COUNT, not a price
        // multiplier — see context.js's header comment for the incident
        // this already caused once).
        if (!context.lotMult) {
            console.error(c.red(`[${context.tgPrefix}] lotMult is not set for ${underlying} — refusing to boot.`));
            console.error(c.red(`  Fix: add a lotMult override for "${underlying}" in context.js's overrides,`));
            console.error(c.red(`  or set ${legLabel === "CORE" ? "CORE_LOTMULT_OVERRIDE" : "HEDGE_LOTMULT_OVERRIDE"} when starting this process.`));
            process.exit(1);
        }

        console.log(c.dim(`[${context.tgPrefix}] resolved contract (${source}): ${context.symbol} (token ${context.token}, lotMult ${context.lotMult}, lots ${context.lots})`));

        const { tg } = createTelegram(context, engineConfig);
        const db     = createDb(context);
        const state  = createState();
        const orders = createOrders(context, tg);

        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            if (saved?.position && saved.entry_date === todayIST()) {
                state.position    = saved.position;
                state.entryPrice  = saved.entry_price;
                const openTrade   = await db.getOpenTrade(context.tgPrefix);
                state.openTradeId = openTrade ? openTrade.id : null;
                console.log(c.yellow(`[${context.tgPrefix}] resumed ${state.position}@${state.entryPrice} from earlier today`));
            } else if (saved?.position) {
                // Both legs are meant to be flat every morning (EOD force-
                // closes both, every day, unconditionally — see below), so
                // a saved position from a PRIOR day means a previous EOD
                // never got to run before this reboot. Flag loudly rather
                // than silently wiping the record — orders.reconcile()
                // right below will also catch a real broker mismatch.
                console.error(c.red(`[${context.tgPrefix}] stale saved position from a PRIOR day (${saved.position}@${saved.entry_price}) — did NOT auto-flatten, verify against the broker manually`));
                tg(`⚠ [${context.tgPrefix}] Stale saved position from a prior day found on boot (${saved.position}@${saved.entry_price}). A previous EOD may have failed to run. Verify against the broker manually.`);
            }
            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);
        } catch (err) {
            console.warn(`[${context.tgPrefix}] boot resume failed: ${err.message}`);
        }
        await orders.reconcile(state);

        return { label: legLabel, context, tg, db, state, orders, ltpKey: `${context.exchange}:${context.symbol}` };
    }

    const core = await buildLeg(CORE_UNDERLYING, "CORE", {
        lots: Number(process.env.CORE_LOTS_OVERRIDE) || 1,
        lotMultOverride: process.env.CORE_LOTMULT_OVERRIDE ? Number(process.env.CORE_LOTMULT_OVERRIDE) : null,
    });
    const hedge = await buildLeg(HEDGE_UNDERLYING, "HEDGE", {
        lots: Number(process.env.HEDGE_LOTS_OVERRIDE) || 5,
        lotMultOverride: process.env.HEDGE_LOTMULT_OVERRIDE ? Number(process.env.HEDGE_LOTMULT_OVERRIDE) : null,
    });

    console.log(c.bold(`HEDGE PAIR  core:${core.context.symbol} (${core.context.lots} lot, NRML)  hedge:${hedge.context.symbol} (${hedge.context.lots} lots, unwind:${UNWIND_MODE})`));
    console.log();

    // Both signal readers key off the CORE instrument's own token — the
    // hedge leg has no signal of its own (see file header).
    const dailyReader  = createHaCandleReader({ token: core.context.token, timeframe: "1d", engineConfig, label: core.context.tgPrefix });
    const hourlyReader = createHaCandleReader({ token: core.context.token, timeframe: "1h", engineConfig, label: core.context.tgPrefix });

    // Read-only client for LTP lookups at our own entry/exit bookkeeping
    // moments — see file header ("NO LIVE WEBSOCKET TICKER").
    const kcForLtp = new KiteConnect({ api_key: engineConfig.API_KEY });
    kcForLtp.setAccessToken(ACCESS_TOKEN);
    async function getLtp(ltpKey) {
        const data = await kcForLtp.getLTP([ltpKey]);
        return data[ltpKey]?.last_price ?? null;
    }

    // The IST calendar day the CORE leg's direction was last decided for —
    // "no flipping ... it remains const": once set for today, checkCoreEntry()
    // below won't touch the core leg again until tomorrow, win or lose,
    // filled or not. Distinct from state.position (which EOD clears every
    // night) — this is what actually enforces "one decision per day."
    let coreDecidedForDate = null;

    async function enterLeg(leg, side, reason) {
        const orderId = await leg.orders.enter(side);
        if (engineConfig.LIVE_ORDERS && orderId === null) {
            console.error(c.red(`[${leg.context.tgPrefix}] ${side} entry FAILED (${reason})`));
            leg.tg(`⚠ [${leg.context.tgPrefix}] ${side} entry FAILED (${reason})`);
            return false;
        }
        const price = (await getLtp(leg.ltpKey).catch(() => null)) || 0;
        leg.state.position    = side;
        leg.state.entryPrice  = price;
        leg.state.openTradeId = await leg.db.insertOpenTrade(leg.context.tgPrefix, leg.context.symbol, side, leg.context.lots, price);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, side, price, `HEDGE_PAIR_${leg.label}`);
        console.log(c.green(`[${leg.context.tgPrefix}] ${side} ENTER (${reason}) @ ${price.toFixed(2)}`));
        leg.tg(`${side} ENTER (${reason}) @ \u20b9${price.toFixed(2)}`);
        return true;
    }

    async function exitLeg(leg, reason) {
        if (!leg.state.position) return true;
        const side = leg.state.position;
        // awaitFill on the EOD path only — same reasoning as lifecycle.js:
        // block until FILLED (or manual-check) has logged, so it lands
        // before the session report below, not after.
        const orderId = await leg.orders.exit(side, { awaitFill: reason === "EOD_FORCE" });
        if (engineConfig.LIVE_ORDERS && orderId === null) {
            console.error(c.red(`[${leg.context.tgPrefix}] ${side} exit FAILED (${reason}) — position left open, NOT marked closed`));
            leg.tg(`⚠ [${leg.context.tgPrefix}] ${side} exit FAILED (${reason}) — position left open, verify manually. MIS auto square-off (if applicable) is the only backstop.`);
            return false;
        }
        const price = (await getLtp(leg.ltpKey).catch(() => null)) ?? leg.state.entryPrice;
        await positions.close(leg.context, leg.state, leg.db, leg.tg, price, reason);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, null, 0);
        return true;
    }

    // ─── CORE: decide once per trading day, off the daily HA reader.
    async function checkCoreEntry() {
        const { hours, minutes } = istParts();
        const pastOpen = hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR && minutes >= engineConfig.TRADE_START_MINUTE);
        if (!pastOpen) return;

        const today = todayIST();
        if (coreDecidedForDate === today) return; // already decided — "no flipping" for the rest of today
        if (core.state.position) { coreDecidedForDate = today; return; } // resumed from a crash-restart — already decided, don't re-enter

        const daily = await dailyReader.getLatest();
        if (!daily || !daily.color) return; // fails safe — no read yet, or a doji: try again next poll, still within today's window

        // Locks in for today the moment we act on a real read — even if
        // the entry order itself fails below, we deliberately do NOT
        // retry later today (matches "decided once, const" — a failed
        // entry means no core position today, not a retry loop).
        coreDecidedForDate = today;
        const side = daily.color === "green" ? "LONG" : "SHORT";
        await enterLeg(core, side, `daily HA ${daily.color}`);
    }

    // ─── HEDGE: triggered by the CORE instrument's 1h HA turning against
    // the core's direction; unwound per UNWIND_MODE.
    async function checkHedge() {
        if (!core.state.position) return; // nothing to hedge
        const hourly = await hourlyReader.getLatest();
        if (!hourly || !hourly.color) return;

        const coreSide  = core.state.position;
        const adverse   = (coreSide === "LONG"  && hourly.color === "red")   || (coreSide === "SHORT" && hourly.color === "green");
        const favorable = (coreSide === "LONG"  && hourly.color === "green") || (coreSide === "SHORT" && hourly.color === "red");

        if (!hedge.state.position && adverse) {
            const hedgeSide = coreSide === "LONG" ? "SHORT" : "LONG"; // opposite the core = same side as the adverse read
            await enterLeg(hedge, hedgeSide, `1h HA ${hourly.color} against ${coreSide} core`);
        } else if (hedge.state.position && UNWIND_MODE === "HA_FLIP" && favorable) {
            await exitLeg(hedge, `1h HA ${hourly.color} back in the core's favor`);
        }
        // UNWIND_MODE === "EOD_ONLY": hedge, once open, is deliberately
        // left alone here regardless of `favorable` — only checkEod()
        // below ever closes it in that mode.
    }

    // ─── EOD — force-close BOTH legs, unconditionally, every day. The
    // core's "eod exit only" spec makes this ITS only automated exit;
    // the hedge is force-closed alongside it as a safety backstop
    // regardless of UNWIND_MODE — never leave a naked, unhedged mini
    // position open overnight.
    let eodDoneForDate = null;
    async function checkEod() {
        const { hours, minutes } = istParts();
        const pastEod = hours > core.context.eodHour ||
            (hours === core.context.eodHour && minutes >= core.context.eodMinute);
        if (!pastEod) return;
        const today = todayIST();
        if (eodDoneForDate === today) return;
        eodDoneForDate = today;

        console.log();
        console.log(c.dim(`EOD  hedge pair  ${new Date().toLocaleString("en-IN", { hour12: false })}`));
        if (hedge.state.position) await exitLeg(hedge, "EOD_FORCE");
        if (core.state.position)  await exitLeg(core,  "EOD_FORCE");

        const coreRealized  = await core.db.getRealizedPnlToday(core.context.tgPrefix);
        const hedgeRealized = await hedge.db.getRealizedPnlToday(hedge.context.tgPrefix);
        const total = coreRealized + hedgeRealized;
        const report = `Hedge Pair EOD — ${today}\ncore   ${core.context.symbol}: ${positions.pnlStr(coreRealized)}\nhedge  ${hedge.context.symbol}: ${positions.pnlStr(hedgeRealized)}\ntotal: ${positions.pnlStr(total)}`;
        console.log(c.bold(report.replace(/\n/g, "   ")));
        console.log();
        await core.tg(report);

        // Next trading day starts fresh — checkCoreEntry() re-decides off
        // that day's own new daily HA candle once coreDecidedForDate no
        // longer matches todayIST().
    }

    async function tick() {
        try {
            await checkEod();
            await checkCoreEntry();
            await checkHedge();
        } catch (err) {
            console.error(c.red(`HEDGE PAIR loop error: ${err.message}`));
        }
    }

    dailyReader.prewarm();
    hourlyReader.prewarm();
    await tick();
    setInterval(tick, POLL_MS);
}

main().catch(err => {
    console.error("BOOT FAILED", err);
    process.exit(1);
});

process.on("uncaughtException",  err => console.error("UNCAUGHT",  err));
process.on("unhandledRejection", err => console.error("UNHANDLED", err));
