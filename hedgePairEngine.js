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
//   CORE_CARRY_OVERRIDE      "true" (default) NRML carry | "false" MIS, core+hedge closed at EOD
//   CORE_SYMBOL_OVERRIDE / HEDGE_SYMBOL_OVERRIDE  optional exact tradingsymbol (e.g. ZINC26NOVFUT) instead of the roll policy's contract
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
//   HEDGE_RULE               "DSB" (default: the 1h Dynamic Band hedge above) | "BASE_LOSS" — SAME instrument, ONE account: the core is an NRML position taken the
//                            moment the algo is turned on, on the colour of the last completed DAILY Heikin-Ashi candle (green LONG / red SHORT); the hedge is an
//                            opposite MIS position (HEDGE_UNDERLYING = CORE_UNDERLYING, hedge lots default = core lots) opened when the core's P&L (points vs entry)
//                            is below -HEDGE_PNL_BAND at a check and closed when it is above +band; checks run every HEDGE_CHECK_MINUTES (default 5) on
//                            clock-aligned minutes. At EOD the hedge AND the NRML core are closed (hedge first). Logs a status block every check.
//   HEDGE_CHECK_MINUTES / HEDGE_PNL_BAND   BASE_LOSS only (defaults 5 / 0)
//   HEDGE_PAIR_POLL_MS       default 60000 (BASE_LOSS: 1000 — prices come only from the websocket there, never REST getLTP)
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
require("./utils/plainLog").install();   // PM2 .log files plain; coloured copy goes to a -color.log sidecar for the dashboard / toolbox


const { KiteConnect, KiteTicker } = require("kiteconnect");
const engineConfig = require("./core/engineConfig");
const c = require("./utils/c");
const { istParts } = require("./utils/istTime");
const { createCsvRepository } = require("./data/csvRepository");
const { createInstrumentSource } = require("./data/instrumentSource");
const { createContractPinStore } = require("./data/contractPins");
const { resolveHedgePairLeg } = require("./hedge/hedgePairContext");
const { createTelegram } = require("./utils/telegram");
const { createState } = require("./core/state");
const { createDb } = require("./data/db");
const { createOrders } = require("./core/orders");
const positions = require("./core/positions");
const { emitEvent } = require("./core/eventBridge"); // web dashboard live log/tick stream only, see eventBridge.js header
const { createHaCandleReader } = require("./indicators/haCandleReader");
const { createDynamicBandReader } = require("./indicators/dynamicBandReader");

const POLL_MS = Number(process.env.HEDGE_PAIR_POLL_MS) || (String(process.env.HEDGE_RULE || "").toUpperCase() === "BASE_LOSS" ? 1000 : 60 * 1000);   // BASE_LOSS: 1s poll over websocket ticks so a check lands right at its clock slot
// CORE_CARRY_OVERRIDE: "true" (default) = NRML, core carried overnight; "false" = MIS, core (and hedge) closed at EOD.
const CARRY = process.env.CORE_CARRY_OVERRIDE !== "false";
const UNWIND_MODE = (process.env.UNWIND_MODE_OVERRIDE || "HA_FLIP").toUpperCase();
if (UNWIND_MODE !== "HA_FLIP" && UNWIND_MODE !== "EOD_ONLY") {
    console.error(c.red(`UNWIND_MODE_OVERRIDE "${UNWIND_MODE}" invalid (known: HA_FLIP, EOD_ONLY) — refusing to boot.`));
    process.exit(1);
}

const HEDGE_RULE = String(process.env.HEDGE_RULE || "DSB").toUpperCase();
if (HEDGE_RULE !== "DSB" && HEDGE_RULE !== "BASE_LOSS") { console.error(c.red(`HEDGE_RULE "${HEDGE_RULE}" invalid (known: DSB, BASE_LOSS) — refusing to boot.`)); process.exit(1); }
const BL = HEDGE_RULE === "BASE_LOSS";
const CHECK_MIN = Number(process.env.HEDGE_CHECK_MINUTES || 5), PNL_BAND = Number(process.env.HEDGE_PNL_BAND || 0);
if (BL && !(Number.isInteger(CHECK_MIN) && CHECK_MIN >= 1 && CHECK_MIN <= 60)) { console.error(c.red("HEDGE_CHECK_MINUTES must be a whole number 1-60 — refusing to boot.")); process.exit(1); }
if (BL && !(PNL_BAND >= 0)) { console.error(c.red("HEDGE_PNL_BAND must be >= 0 — refusing to boot.")); process.exit(1); }
const CORE_SIDE = String(process.env.CORE_SIDE_OVERRIDE || "").toUpperCase();
if (BL && CORE_SIDE !== "LONG" && CORE_SIDE !== "SHORT") { console.error(c.red("HEDGE_RULE=BASE_LOSS needs CORE_SIDE_OVERRIDE=LONG|SHORT (manual core side) — refusing to boot.")); process.exit(1); }
if (BL && !CARRY) { console.error(c.red("HEDGE_RULE=BASE_LOSS needs CORE_CARRY_OVERRIDE=true (NRML core + MIS hedge) — refusing to boot.")); process.exit(1); }

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
    async function buildLeg(underlying, legLabel, { lots, lotMultOverride, symbolOverride = null, carry = CARRY }) {
        // Contract/context resolution is shared with backtestHedgePair.js
        // via hedgePairContext.js — see that file's header for why. Throws
        // on a missing lotMult instead of returning an error code; caught
        // right below and turned into the same refuse-to-boot process.exit(1)
        // this file always used.
        let context, source;
        try {
            ({ context, source } = resolveHedgePairLeg({
                underlying, legLabel, exchange: EXCHANGE_OVERRIDE, csvRepo, pinStore, lots, lotMultOverride, carryOvernight: carry, symbolOverride, hedgeRule: HEDGE_RULE,
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
        symbolOverride: process.env.CORE_SYMBOL_OVERRIDE || null,
    });
    const hedge = await buildLeg(HEDGE_UNDERLYING, "HEDGE", {
        lots: Number(process.env.HEDGE_LOTS_OVERRIDE) || (BL ? (Number(process.env.CORE_LOTS_OVERRIDE) || 1) : 5),
        carry: BL ? false : CARRY,   // BASE_LOSS: the hedge is MIS (a separate broker row from the NRML core on the same contract)
        lotMultOverride: process.env.HEDGE_LOTMULT_OVERRIDE ? Number(process.env.HEDGE_LOTMULT_OVERRIDE) : null,
        symbolOverride: process.env.HEDGE_SYMBOL_OVERRIDE || null,
    });

    if (BL && core.context.token === hedge.context.token && CORE_UNDERLYING !== HEDGE_UNDERLYING) { console.error(c.red("core and hedge resolved to the same contract from different underlyings — refusing to boot.")); process.exit(1); }
    if (BL) {
        console.log(c.bold(`HEDGE PAIR (base-loss, manual side)  ${core.context.symbol}  core NRML ${CORE_SIDE} ${core.context.lots} lot, MIS hedge ${hedge.context.lots} lot when core P&L < ${PNL_BAND ? "-" + PNL_BAND + " pts" : "0"}, checked every ${CHECK_MIN} min  ·  both closed at EOD  ·  one account`));
        console.log();
    } else
    console.log(c.bold(`HEDGE PAIR  core:${core.context.symbol} (side from daily DSB, ${core.context.lots} lot, ${CARRY ? "NRML, carried overnight" : "MIS, closed at EOD"})  hedge:${hedge.context.symbol} (${hedge.context.lots} lots, unwind:${UNWIND_MODE})`));
    console.log();

    // Both signal readers key off the CORE instrument's own token — the
    // hedge leg has no signal of its own (see file header).
    const hourlyReader = BL ? null : createHaCandleReader({ token: core.context.token, timeframe: "1h", engineConfig, label: core.context.tgPrefix });
    // Confirmation filter for checkHedge() — see dynamicBandReader.js's own
    // header for why raw 1h HA color alone is too noisy on its own.
    // Daily DSB on daily Heikin-Ashi candles — decides the core's side (once, at entry).
    const dailyBandReader = BL ? null : createDynamicBandReader({ token: core.context.token, timeframe: "1d", bandStep: core.context.bandStep, engineConfig, label: core.context.tgPrefix, ha: true });
    const bandReader   = BL ? null : createDynamicBandReader({ token: core.context.token, timeframe: "1h", bandStep: core.context.bandStep, engineConfig, label: core.context.tgPrefix, ha: true });

    // Read-only client for LTP lookups at our own entry/exit bookkeeping
    // moments — see file header ("NO LIVE WEBSOCKET TICKER").
    const kcForLtp = new KiteConnect({ api_key: engineConfig.API_KEY });
    kcForLtp.setAccessToken(ACCESS_TOKEN);
    // BASE_LOSS: every price (entry fill, checks, status, EOD) comes from the WEBSOCKET ticker only — never REST. A price older than WS_STALE_MS
    // counts as "no price": the check is skipped / the core entry waits until fresh ticks arrive (orders themselves are still placed via REST).
    const WS_STALE_MS = 15000, wsTicks = new Map();   // instrument token -> { price, at }
    if (BL) {
        const tokens = [...new Set([core.context.token, hedge.context.token])];
        const ticker = new KiteTicker({ api_key: engineConfig.API_KEY, access_token: ACCESS_TOKEN });
        ticker.on("connect", () => { ticker.subscribe(tokens); ticker.setMode(ticker.modeLTP, tokens); console.log(c.dim("[WS] connected")); });
        ticker.on("ticks", ticks => { for (const t of ticks) if (t.last_price) wsTicks.set(t.instrument_token, { price: t.last_price, at: Date.now() }); });
        ticker.on("error", err => console.error(c.red(`[WS] error: ${err && err.message ? err.message : err}`)));
        ticker.on("close", () => console.log(c.dim(`[WS] closed — no price decisions until fresh ticks arrive (stale after ${WS_STALE_MS / 1000}s)`)));
        ticker.on("reconnect", n => console.log(c.dim(`[WS] reconnect #${n}`)));
        ticker.connect();
    }
    async function getLtp(ltpKey) {
        if (BL) {
            const leg = [core, hedge].find(l => l.ltpKey === ltpKey);
            const t = leg && wsTicks.get(leg.context.token);
            return t && Date.now() - t.at < WS_STALE_MS ? t.price : null;
        }
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
    const CORE_ENTRY_HOUR = BL ? 0 : 10, CORE_ENTRY_MINUTE = 0;   // BASE_LOSS: no entry-time gate — the core goes in as soon as the algo is turned on
    async function checkCoreEntry() {
        const { hours, minutes } = istParts();
        const pastOpen = hours > CORE_ENTRY_HOUR ||
            (hours === CORE_ENTRY_HOUR && minutes >= CORE_ENTRY_MINUTE);
        if (!pastOpen) return;

        const today = todayIST();
        if (coreDecidedForDate === today) return; // already decided — "no flipping" for the rest of today
        if (core.state.position) { coreDecidedForDate = today; return; } // resumed from a crash-restart — already decided, don't re-enter

        if (BL && !(await getLtp(core.ltpKey))) return;   // websocket not delivering yet — wait for the first fresh tick before taking the core
        const daily = BL ? { color: CORE_SIDE === "LONG" ? "green" : "red" } : await dailyBandReader.getLatest();
        if (!daily || !daily.color) return; // no read yet — retry next poll
        // Locks in for today the moment we act — a failed entry means no
        // core position today, not a retry loop.
        coreDecidedForDate = today;
        const side = daily.color === "green" ? "LONG" : "SHORT";
        await enterLeg(core, side, BL ? `manual ${CORE_SIDE}` : `daily DSB ${daily.color}`);
    }

    // ─── HEDGE: driven by the 1h HA Dynamic Step Band on the CORE instrument.
    // Opens when the band flips against the core; closes when it comes back
    // in the core's favour (per UNWIND_MODE).
    // BASE_LOSS rule: hedge the core against ITS OWN loss. Evaluated once per clock-aligned CHECK_MIN slot (a skipped poll still catches the next slot).
    let lastSlot = null;
    async function checkBaseLoss() {
        if (!core.state.position) return;
        const { hours, minutes } = istParts(), slot = `${todayIST()}:${Math.floor((hours * 60 + minutes) / CHECK_MIN)}`;
        if (slot === lastSlot) return;
        const px = await getLtp(core.ltpKey).catch(() => null);
        if (!(px > 0)) { console.error(c.red("[HEDGE_PAIR] no fresh websocket tick — base-loss check skipped, retrying next poll")); return; }
        const dir = core.state.position === "LONG" ? 1 : -1, pts = dir * (px - core.state.entryPrice);
        let ok = true;
        if (pts < -PNL_BAND && !hedge.state.position) {
            console.log(c.cyan(`[HEDGE_PAIR] core ${core.state.position} P&L=${pts.toFixed(2)}pts -> OPEN ${core.state.position === "LONG" ? "SHORT" : "LONG"} MIS hedge`));
            ok = await enterLeg(hedge, core.state.position === "LONG" ? "SHORT" : "LONG", `core P&L ${pts.toFixed(2)} pts below 0`);
        } else if (pts > PNL_BAND && hedge.state.position) {
            console.log(c.cyan(`[HEDGE_PAIR] core ${core.state.position} P&L=${pts.toFixed(2)}pts -> CLOSE hedge`));
            ok = await exitLeg(hedge, "core back in profit");
        }
        if (ok) { lastSlot = slot; await logStatus(px); }   // a failed order is retried on the next poll; a status block is printed once per check
    }
    async function logStatus(px) {
        const f = (v, d = 0) => (v >= 0 ? "+" : "") + v.toFixed(d), L = [];
        L.push(`[PAIR] ${new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" })}  ${core.context.symbol}  LTP ${px.toFixed(2)}   manual core ${CORE_SIDE}`);
        let u = 0;
        for (const leg of [core, hedge]) {
            const lu = leg.state.position ? positions.unrealised(leg.context, leg.state, px) : 0; u += lu;
            const pts = leg.state.position ? (leg.state.position === "LONG" ? 1 : -1) * (px - leg.state.entryPrice) : 0;
            L.push(`   ${leg.label.padEnd(6)} ${(leg.context.product || (leg === core ? "NRML" : "MIS")).padEnd(4)} ${leg.state.position ? `${leg.state.position} @${leg.state.entryPrice.toFixed(2)}`.padEnd(16) + `${f(pts, 2)} pts  ${f(lu)}` : "flat"}`);
        }
        const r = (core.state.pnl || 0) + (hedge.state.pnl || 0);
        L.push(`   NET    unreal ${f(u)} \u00b7 real ${f(r)} \u00b7 total ${f(u + r)}`);
        console.log(c.dim(L.join("\n")));
    }

    async function checkHedge() {
        if (BL) return checkBaseLoss();
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
        // MIS mode: close both legs (hedge first) — retried every tick until flat.
        if (!CARRY || BL) {   // BASE_LOSS: the NRML core is closed at EOD too
            if (hedge.state.position) await exitLeg(hedge, "EOD_FORCE");
            if (core.state.position)  await exitLeg(core,  "EOD_FORCE");
            if (core.state.position || hedge.state.position) { console.error(c.red("EOD did not fully flatten — will retry next tick")); return; }
        } else if (hedge.state.position && UNWIND_MODE === "EOD_ONLY") {
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
        if (CARRY && !BL && core.state.position) lines.push("Core carried overnight (NRML). Restart the engine before the next open.");
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
        if (BL) return;
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

    let ticking = false;   // a slow API/exit must not let a second poll start while the first is mid-order
    async function tick() {
        if (ticking) return;
        ticking = true;
        try {
            await checkEod();
            await checkCoreEntry();
            await checkHedge();
            await logHourlyPnl();
            await emitLivePnl();
        } catch (err) {
            console.error(c.red(`HEDGE PAIR loop error: ${err.message}`));
        } finally {
            ticking = false;
        }
    }

    if (!BL) { hourlyReader.prewarm(); dailyBandReader.prewarm(); bandReader.prewarm(); }
    await tick();
    setInterval(tick, POLL_MS);
}

main().catch(err => {
    console.error("BOOT FAILED", err);
    process.exit(1);
});

process.on("uncaughtException",  err => console.error("UNCAUGHT",  err));
process.on("unhandledRejection", err => console.error("UNHANDLED", err));
