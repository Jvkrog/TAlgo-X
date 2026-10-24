// hedgePairEngine.js — the daily-HA-core + hourly-HA-hedge strategy,
// discussed and scoped in chat (Sep 2026), for a full-size/mini contract
// pair (NATURALGAS/NATGASMINI, or ZINC/ZINCMINI).
//
// SPEC (REDESIGNED Oct 2026 — supersedes the earlier daily-HA-core design):
//   - CORE leg (full-size contract): ONE position, LONG or SHORT, the side
//     being picked by the DAILY Dynamic Step Band (daily Heikin-Ashi candles, last
//     COMPLETED bar: green -> LONG, red -> SHORT). Opened
//     once at/after 10:00 IST when the core is flat, product NRML, then held
//     as one continuing trade: NOT force-closed at EOD, carried overnight
//     and across days. The bot never exits it by itself (no target/stop).
//   - HEDGE leg (mini contract, same underlying): driven ONLY by the
//     Dynamic Step Band (1h Heikin-Ashi candles) on the CORE instrument.
//       * DSB flips AGAINST the core's direction (core LONG & band red, or
//         core SHORT & band green) and hedge is flat -> open the hedge
//         (HEDGE_LOTS, default 5 per core lot) on the opposite side.
//       * DSB comes back in the core's favour -> hedge closes; the core
//         simply carries on.
//   - UNWIND (UNWIND_MODE_OVERRIDE):
//       HA_FLIP  (default; name kept for compatibility) — hedge closes when
//                the band returns to the core's favour. May carry overnight.
//       EOD_ONLY — hedge stays on regardless of the band and is closed at
//                EOD (the core is still carried).
//   - EOD: nothing is force-closed. At the EOD time the engine reports the
//     unrealised P&L of what is still open, then exits cleanly (PM2 leaves it
//     stopped; restart it each morning after refreshing the access token —
//     open positions are resumed from the db). 5:1 is the real contract ratio
//     for both supported pairs (NATGASMINI 250 vs NATURALGAS 1250; ZINCMINI
//     1000kg vs ZINC 5000kg).
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
//   LIVE_ORDERS_OVERRIDE     "true" | "false" — same per-process override
//                            convention as engine.js; unset = engineConfig's
//                            own default (paper/false)
//
// NOT YET WIRED: toolbox.js / webdash "Add Instrument" UI has no picker
// for this engine — it's started directly (`CORE_UNDERLYING=NATURALGAS
// HEDGE_UNDERLYING=NATGASMINI node hedgePairEngine.js`, or a manual PM2
// entry) until that UI work is scoped separately. Not backtested either
// — runBacktest.js's single-instrument model doesn't fit a two-instrument
// strategy any more than engine.js's live model does; that's a separate
// follow-up, same as the toolbox UI.
"use strict";
require("./plainLog").install();   // PM2 .log files plain; coloured copy goes to a -color.log sidecar for the dashboard / toolbox


const { KiteConnect } = require("kiteconnect");
const engineConfig = require("./engineConfig");
const c = require("./c");
const { istParts } = require("./istTime");
const { createCsvRepository } = require("./csvRepository");
const { createInstrumentSource } = require("./instrumentSource");
const { createContractPinStore } = require("./contractPins");
const { resolveHedgePairLeg } = require("./hedgePairContext");
const { createTelegram } = require("./telegram");
const { createState } = require("./state");
const { createDb } = require("./db");
const { createOrders } = require("./orders");
const positions = require("./positions");
const { emitEvent } = require("./eventBridge"); // web dashboard live log/tick stream only, see eventBridge.js header
const { createHaCandleReader } = require("./haCandleReader");
const { createDynamicBandReader } = require("./dynamicBandReader");

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
    const ACCESS_TOKEN = engineConfig.getAccessToken();

    // Live/paper mode — set per-process by the toolbox/webdash deploy flow,
    // same pattern as engine.js's own LIVE_ORDERS_OVERRIDE handling. Safe to
    // mutate here: each PM2 process is its own OS process with its own
    // require() cache, so this never leaks across instruments/pairs.
    if (process.env.LIVE_ORDERS_OVERRIDE !== undefined) {
        engineConfig.LIVE_ORDERS = process.env.LIVE_ORDERS_OVERRIDE === "true";
    }
    console.log(c.bold(engineConfig.LIVE_ORDERS ? c.red("LIVE — real orders will be placed (both legs)")
                                                  : c.cyan("PAPER — shadow mode, no real orders")));

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
        // Contract/context resolution is shared with backtestHedgePair.js
        // via hedgePairContext.js — see that file's header for why. Throws
        // on a missing lotMult instead of returning an error code; caught
        // right below and turned into the same refuse-to-boot process.exit(1)
        // this file always used.
        let context, source;
        try {
            ({ context, source } = resolveHedgePairLeg({
                underlying, legLabel, exchange: EXCHANGE_OVERRIDE, csvRepo, pinStore, lots, lotMultOverride,
            }));
        } catch (err) {
            process.exit(1); // hedgePairContext.js already logged the specific fix
        }

        console.log(c.dim(`[${context.tgPrefix}] resolved contract (${source}): ${context.symbol} (token ${context.token}, lotMult ${context.lotMult}, lots ${context.lots})`));

        const { tg } = createTelegram(context, engineConfig);
        const db     = createDb(context);
        db.initDB(); // BUG FIX Sep 2026: was missing here (engine.js calls this right after createDb() too — see its line ~419) — without it, createDb() opens/creates the .db FILE but never runs CREATE TABLE, so every query against a fresh hedge-pair DB failed with "SQLITE_ERROR: no such table: trades" the first time any leg tried to log a trade.
        const state  = createState();
        const orders = createOrders(context, tg);

        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            if (saved?.position) {
                // Positions are carried overnight now (NRML), so a saved one
                // from a prior day is the normal case, not an error.
                state.position    = saved.position;
                state.entryPrice  = saved.entry_price;
                const openTrade   = await db.getOpenTrade(context.tgPrefix);
                state.openTradeId = openTrade ? openTrade.id : null;
                console.log(c.yellow(`[${context.tgPrefix}] resumed ${state.position}@${state.entryPrice} (entered ${saved.entry_date || "earlier"})`));
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

    console.log(c.bold(`HEDGE PAIR  core:${core.context.symbol} (side from daily DSB, ${core.context.lots} lot, NRML, carried)  hedge:${hedge.context.symbol} (${hedge.context.lots} lots, unwind:${UNWIND_MODE})`));
    console.log();

    // Both signal readers key off the CORE instrument's own token — the
    // hedge leg has no signal of its own (see file header).
    const hourlyReader = createHaCandleReader({ token: core.context.token, timeframe: "1h", engineConfig, label: core.context.tgPrefix });
    // Confirmation filter for checkHedge() — see dynamicBandReader.js's own
    // header for why raw 1h HA color alone is too noisy on its own.
    // Daily DSB on daily Heikin-Ashi candles — decides the core's side (once, at entry).
    const dailyBandReader = createDynamicBandReader({ token: core.context.token, timeframe: "1d", bandStep: core.context.bandStep, engineConfig, label: core.context.tgPrefix, ha: true });
    const bandReader   = createDynamicBandReader({ token: core.context.token, timeframe: "1h", bandStep: core.context.bandStep, engineConfig, label: core.context.tgPrefix, ha: true });

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
        // Explicit **CORE ENTRY**/**HEDGE ENTRY** tag — requested directly:
        // with both legs' enter/exit lines interleaved in one log stream,
        // scanning which leg a given line belongs to was too easy to miss.
        console.log(c.bold(`**${leg.label} ENTRY**`));
        console.log(c.green(`[${leg.context.tgPrefix}] ${side} @ price ${price.toFixed(2)}  |  ${reason}`));
        leg.tg(`${side} ENTER (${reason}) @ \u20b9${price.toFixed(2)}`);
        // Same event every other strategy's doEnter() emits (see
        // strategies.js) — without this, entries were invisible on
        // webdash's live log/WS stream even though they logged fine to
        // console and Telegram (reported directly; exitLeg() below didn't
        // have this gap, since positions.close() already emits its own
        // "EXIT" event internally).
        emitEvent(leg.context.tgPrefix, "ENTRY", { side, price, trail: null });
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
        // Same reasoning as the entry tag above.
        console.log(c.bold(`**${leg.label} EXIT**`));
        await positions.close(leg.context, leg.state, leg.db, leg.tg, price, reason);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, null, 0);
        return true;
    }

    // ─── CORE: opens the side given by the daily DSB, once, when flat; then carried (see header).
    // Entry time fixed at 10:00 IST specifically for this strategy
    // (explicitly requested — NOT engineConfig.TRADE_START_HOUR/MINUTE's
    // 9:15, the general market-open constant every other strategy uses;
    // hardcoded here so changing it doesn't touch anything else). Also
    // matches backtestHedgePair.js's same hardcoded 10:00, for parity.
    const CORE_ENTRY_HOUR = 10, CORE_ENTRY_MINUTE = 0;
    async function checkCoreEntry() {
        const { hours, minutes } = istParts();
        const pastOpen = hours > CORE_ENTRY_HOUR ||
            (hours === CORE_ENTRY_HOUR && minutes >= CORE_ENTRY_MINUTE);
        if (!pastOpen) return;

        const today = todayIST();
        if (coreDecidedForDate === today) return; // already decided — "no flipping" for the rest of today
        if (core.state.position) { coreDecidedForDate = today; return; } // resumed from a crash-restart — already decided, don't re-enter

        const daily = await dailyBandReader.getLatest();
        if (!daily || !daily.color) return; // no read yet — retry next poll
        // Locks in for today the moment we act — a failed entry means no
        // core position today, not a retry loop.
        coreDecidedForDate = today;
        const side = daily.color === "green" ? "LONG" : "SHORT";
        await enterLeg(core, side, `daily DSB ${daily.color}`);
    }

    // ─── HEDGE: driven by the 1h HA Dynamic Step Band on the CORE instrument.
    // Opens when the band flips against the core; closes when it comes back
    // in the core's favour (per UNWIND_MODE).
    async function checkHedge() {
        if (!core.state.position) return; // nothing to hedge
        const band = await bandReader.getLatest();
        if (!band || !band.color) return; // no read yet (cold start / fetch error) = no action
        const bandColor = band.color;
        const coreSide = core.state.position;
        const adverse   = (coreSide === "LONG" && bandColor === "red")   || (coreSide === "SHORT" && bandColor === "green");
        const favorable = (coreSide === "LONG" && bandColor === "green") || (coreSide === "SHORT" && bandColor === "red");

        if (!hedge.state.position && adverse) {
            const hedgeSide = coreSide === "LONG" ? "SHORT" : "LONG";
            await enterLeg(hedge, hedgeSide, `1h HA DSB ${bandColor} against ${coreSide} core`);
        } else if (hedge.state.position && UNWIND_MODE === "HA_FLIP" && favorable) {
            await exitLeg(hedge, `1h HA DSB ${bandColor} back in the core's favor`);
        }
    }

    // ─── EOD — NOTHING is force-closed on the core (it is one continuing
    // NRML trade). Under UNWIND_MODE EOD_ONLY the hedge is closed here.
    // Then report unrealised P&L of whatever is still open and exit cleanly.
    let eodReportedForDate = null;
    async function checkEod() {
        const { hours, minutes } = istParts();
        const pastEod = hours > core.context.eodHour ||
            (hours === core.context.eodHour && minutes >= core.context.eodMinute);
        if (!pastEod) return;
        const today = todayIST();
        if (eodReportedForDate === today) return;

        console.log();
        console.log(c.bold("**EOD**"));
        console.log(c.dim(`EOD  hedge pair  ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}`));
        if (hedge.state.position && UNWIND_MODE === "EOD_ONLY") {
            const ok = await exitLeg(hedge, "EOD_FORCE");
            if (!ok) { console.error(c.red("EOD hedge close failed — will retry next tick")); return; }
        }
        eodReportedForDate = today;

        const lines = [`Hedge Pair EOD — ${today}`];
        let total = 0;
        for (const leg of [core, hedge]) {
            const realized = await leg.db.getRealizedPnlToday(leg.context.tgPrefix);
            let u = 0, open = "flat";
            if (leg.state.position) {
                const px = await getLtp(leg.ltpKey).catch(() => null);
                u = px !== null ? positions.unrealised(leg.context, leg.state, px) : 0;
                open = `${leg.state.position} still OPEN (uPnL ${px !== null ? positions.pnlStr(u) : "-"})`;
            }
            total += realized + u;
            lines.push(`${leg.label.toLowerCase()} ${leg.context.symbol}: realized ${positions.pnlStr(realized)} | ${open}`);
        }
        lines.push(`total (incl. unrealised): ${positions.pnlStr(total)}`);
        if (core.state.position) lines.push("Core carried overnight (NRML). Restart the engine before the next open.");
        const report = lines.join("\n");
        console.log(c.bold(report.replace(/\n/g, "   ")));
        console.log();
        await core.tg(report);

        console.log(c.bold("*** SHUTDOWN ***"));
        emitEvent(core.context.tgPrefix, "SHUTDOWN", {
            pnl: total, trades: core.state.trades + hedge.state.trades,
            positionLeftOpen: !!(core.state.position || hedge.state.position),
        });
        setTimeout(() => process.exit(0), 2000);
    }

    // ─── Hourly PnL log — one line per newly-completed 1h bar (not per
    // 60s poll — hourlyReader's own bar date is the de-dupe key, so this
    // fires once per hour regardless of POLL_MS). Core is always logged;
    // hedge is appended only while it actually has a position open — no
    // "hedge: flat" noise every hour it isn't in play.
    let lastHourlyLoggedTs = null;
    let lastLoggedDayKey = null;
    async function logHourlyPnl() {
        const hourly = await hourlyReader.getLatest();
        if (!hourly) return;
        const key = hourly.date.getTime();
        if (lastHourlyLoggedTs === key) return;
        lastHourlyLoggedTs = key;

        // **STARTING** banner — one per new calendar day, printed the
        // first time a bar from that day is logged, so the log stream is
        // easy to scan for where each session begins.
        const dayKey = new Date(hourly.date.getTime() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
        if (lastLoggedDayKey !== dayKey) {
            lastLoggedDayKey = dayKey;
            console.log();
            console.log(c.bold(`**STARTING** ${dayKey}`));
        }

        let line = `[HOURLY ${hourly.date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })} IST] core ${core.context.symbol}: `;
        if (core.state.position) {
            const corePrice = await getLtp(core.ltpKey).catch(() => null);
            const coreUpnl  = corePrice !== null ? positions.unrealised(core.context, core.state, corePrice) : null;
            line += `${core.state.position} uPnL ${coreUpnl !== null ? positions.pnlStr(coreUpnl) : "-"}`;
        } else {
            line += "flat";
        }

        if (hedge.state.position) {
            const hedgePrice = await getLtp(hedge.ltpKey).catch(() => null);
            const hedgeUpnl  = hedgePrice !== null ? positions.unrealised(hedge.context, hedge.state, hedgePrice) : null;
            line += `  |  hedge ${hedge.context.symbol}: ${hedge.state.position} uPnL ${hedgeUpnl !== null ? positions.pnlStr(hedgeUpnl) : "-"}`;
        }
        // hedge flat -> no hedge segment at all, per spec.

        console.log(c.dim(line));
    }

    // Web dashboard live log/PnL panes — emits one TICK per leg every
    // POLL_MS (default 60s), same event type/shape strategies.js's
    // per-candle TICK already uses (webdash's WS handler needed no changes
    // to pick these up). Deliberately still REST-polled via the existing
    // getLtp(), not a new WS ticker — see file header "NO LIVE WEBSOCKET
    // TICKER", which is about not needing per-tick SL/target logic, not
    // about the dashboard; 2 extra LTP calls per POLL_MS tick doesn't
    // change that. Emits even while flat (uPnl 0) — the point isn't just
    // the number, it's a regular heartbeat proving this process is still
    // alive and reporting, same as it read as "silent"/spammy-looking
    // before (see checkEod()'s SHUTDOWN comment and marketDataHealth.js —
    // same class of "is this actually still running" confusion, different
    // engine).
    async function emitLivePnl() {
        for (const leg of [core, hedge]) {
            // Fetched every cycle regardless of position — msg.price feeds
            // the log line's price column (undefined there reads as "NaN",
            // worse than one extra LTP call), and a flat leg still showing
            // a live price is itself part of the "still alive" heartbeat.
            const price = await getLtp(leg.ltpKey).catch(() => null);
            if (price === null) continue; // couldn't price it this cycle — skip rather than emit a false 0
            const uPnl = leg.state.position ? positions.unrealised(leg.context, leg.state, price) : 0;
            const session = (leg.state.pnl || 0) + uPnl;
            emitEvent(leg.context.tgPrefix, "TICK", {
                price, uPnl, session, position: leg.state.position, entryPrice: leg.state.entryPrice || null,
            });
        }
    }

    async function tick() {
        try {
            await checkEod();
            await checkCoreEntry();
            await checkHedge();
            await logHourlyPnl();
            await emitLivePnl();
        } catch (err) {
            console.error(c.red(`HEDGE PAIR loop error: ${err.message}`));
        }
    }

    hourlyReader.prewarm();
    dailyBandReader.prewarm();
    bandReader.prewarm();
    await tick();
    setInterval(tick, POLL_MS);
}

main().catch(err => {
    console.error("BOOT FAILED", err);
    process.exit(1);
});

process.on("uncaughtException",  err => console.error("UNCAUGHT",  err));
process.on("unhandledRejection", err => console.error("UNHANDLED", err));
