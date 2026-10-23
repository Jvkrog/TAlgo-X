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
// LOGIC — a direct port of long.js/short.js (uploaded reference scripts):
//   SIGNAL: the Dynamic Step Band on RANGE BARS built from 1-minute history
//   (rangeBandReader.js — read ONCE and shared by both legs, so the two
//   accounts can never disagree about a flip). Evaluated at :20 seconds past
//   every 15-minute mark from 09:15 IST on (09:15:20, 09:30:20, ... exactly
//   the reference's trade_timer schedule); nothing is evaluated before 09:15
//   and NOT at boot — a fresh start waits for the next slot, as the scripts do.
//   LONG leg (long.js): flat + band green at an evaluation -> enter LONG at
//     the next second. Never opens SHORT — this account only holds LONG/flat.
//   SHORT leg (short.js): flat + band red -> enter SHORT. Never LONG.
//   FLIP: holding + the band turns AGAINST the position at an evaluation ->
//     the leg is "flipped" (hedged_position=1 / sma_signal flip in the
//     scripts). Sticky for the rest of that position's life. Before any flip
//     there is NO exit at all ("closing makes it losing trade").
//   EXITS, checked EVERY SECOND on the live price (the scripts' trade_manager
//     runs on a 1s timer against the websocket tick), flipped legs only:
//       unrealised P&L  >  +TAKE_PROFIT  -> exit  ("Long Exit" / "Short Exit")
//       unrealised P&L  <  -MAX_LOSS     -> exit  ("... Exit SL")
//     otherwise hold. After an exit the leg is flat and waits for its own
//     favorable color at a later evaluation (sma_signal reset to 0).
//   Positions carry overnight (NRML). Optional gap capture below is the
//   reference's 23:20/23:21/23:22/23:25 sequence.
//   No chop/volume/long-candle/HTF/daily-HA gates on either leg (see
//   dualHedgeContext.js).
//
// LIVE PRICE: one KiteTicker websocket on the LONG user's credentials (market
// data is account-agnostic), subscribed to the shared contract token. REST
// LTP is only a throttled fallback while the ticker is stale/down.
//
// ARCHITECTURE — why this is its own process, not two engine.js runs: the
// SAME band signal drives both legs and must never be computed twice; it is
// read once per evaluation and applied to both legs' own independent state
// (same "shared reader, per-leg state" shape as hedgePairEngine.js).
//
// GAP CAPTURE (optional, DH_GAP_CAPTURE=true) — SIMPLIFIED again (Oct 2026):
// there is no special gap window, no realize step, no separate overnight entry
// and no quit. Enabling it only means: every order this engine places is a
// single NRML order (day and overnight use the SAME order — never MIS for the
// day plus a separate NRML one for overnight) and the algo may enter at any
// time. (dualHedgeContext.js already sets carryOvernight=true, i.e. NRML, and
// this engine has no EOD force-close, so nothing else changes.)
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
//   DH_BAND_STEP_OVERRIDE     optional, else engineConfig.BAND_STEP_DEFAULT (DSB step)
//   DH_RANGE_SIZE_OVERRIDE    range bar size in price units, default = the band step
//   DH_RANGE_START_OVERRIDE   fixed range-bar anchor, IST "YYYY-MM-DD HH:mm:ss",
//                             default "2026-06-01 09:00:00" (bars are path-
//                             dependent — never change it casually)
//   DH_MAX_LOSS_RUPEES_OVERRIDE     default 3000 (flipped legs exit below -this)
//   DH_TAKE_PROFIT_RUPEES_OVERRIDE  default 3000 (flipped legs exit above +this)
//   DH_SL_MODE                "RUPEES" (default — the stop above) | "ATR": a flipped
//                             leg exits once price moves DH_ATR_SL_MULT_OVERRIDE x ATR
//                             against its entry (ATR snapshotted at entry, fixed after;
//                             see dualHedgeAtr.js). DH_MAX_LOSS_RUPEES_OVERRIDE then
//                             stays only as the backstop used while ATR isn't available.
//   DH_ATR_SL_MULT_OVERRIDE   ATR mode: multiplier, default engineConfig.ATR_SL_MULT
//   DH_ATR_TIMEFRAME_OVERRIDE ATR mode: bar timeframe 5m|15m|30m|1h, default 1h
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
require("./plainLog").install();   // PM2 .log files plain; coloured copy goes to a -color.log sidecar for the dashboard / toolbox


// DH_STRATEGY selects the strategy this single PM2 entry point runs:
//   DUAL (default) — the band-following dual hedge below
//   BIAS           — daily-HA-bias core + Dynamic-Band hedge (dualBiasHedgeEngine.js)
const DH_STRATEGY = (process.env.DH_STRATEGY || "DUAL").toUpperCase();
if (DH_STRATEGY !== "DUAL" && DH_STRATEGY !== "BIAS" && DH_STRATEGY !== "REALIZE") { console.error(`DH_STRATEGY "${process.env.DH_STRATEGY}" invalid (known: DUAL, BIAS, REALIZE) — refusing to boot.`); process.exit(1); }
// REALIZE (profit-lock): no signal. LONG on the long account + SHORT on the short account at any time while
// flat; when a leg's unrealized P&L exceeds DH_REALIZE_RUPEES it is closed (realized) and the SAME side is
// opened again at once (NRML, carried overnight). The losing leg is never closed by the engine — you top up
// its funds; DH_LOSS_ALERT_RUPEES (0 = off) sends a Telegram "add funds" alert when it is that far down.
const REALIZE_MODE = DH_STRATEGY === "REALIZE";
const REALIZE_RUPEES = Number(process.env.DH_REALIZE_RUPEES) > 0 ? Number(process.env.DH_REALIZE_RUPEES) : 3000;
const LOSS_ALERT_RUPEES = Number(process.env.DH_LOSS_ALERT_RUPEES) > 0 ? Number(process.env.DH_LOSS_ALERT_RUPEES) : 0;
if (DH_STRATEGY === "BIAS") { require("./dualBiasHedgeEngine"); return; }

const { KiteConnect, KiteTicker } = require("kiteconnect");
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
const { createRangeBandReader } = require("./rangeBandReader");
const { SL_MODES, ATR_TIMEFRAMES, DEFAULT_ATR_TIMEFRAME, createAtrReader } = require("./dualHedgeAtr");

const MAX_LOSS_RUPEES    = Number(process.env.DH_MAX_LOSS_RUPEES_OVERRIDE) || 3000;
const TAKE_PROFIT_RUPEES = Number(process.env.DH_TAKE_PROFIT_RUPEES_OVERRIDE) || 3000;
const RANGE_START = process.env.DH_RANGE_START_OVERRIDE || "2026-06-01 09:00:00";
// Stop-loss mode — see header. RUPEES (default) keeps the original behaviour.
const SL_MODE = (process.env.DH_SL_MODE || "RUPEES").toUpperCase();
if (!SL_MODES.includes(SL_MODE)) { console.error(`DH_SL_MODE "${process.env.DH_SL_MODE}" invalid (known: ${SL_MODES.join(", ")}) — refusing to boot.`); process.exit(1); }
const ATR_SL_MULT   = Number(process.env.DH_ATR_SL_MULT_OVERRIDE) || engineConfig.ATR_SL_MULT;
const ATR_TIMEFRAME = process.env.DH_ATR_TIMEFRAME_OVERRIDE || DEFAULT_ATR_TIMEFRAME;
if (SL_MODE === "ATR" && !ATR_TIMEFRAMES.includes(ATR_TIMEFRAME)) { console.error(`DH_ATR_TIMEFRAME_OVERRIDE "${ATR_TIMEFRAME}" invalid (known: ${ATR_TIMEFRAMES.join(", ")}) — refusing to boot.`); process.exit(1); }
if (SL_MODE === "ATR" && !(ATR_SL_MULT > 0)) { console.error(`DH_ATR_SL_MULT_OVERRIDE must be a positive number — refusing to boot.`); process.exit(1); }
const EVAL_OFFSET_SEC = 20;      // evaluate at :20 past each 15-minute mark (reference trade_timer)
const EXIT_COOLDOWN_MS = 30 * 1000;   // after a FAILED exit, don't re-fire every second
const PRICE_STALE_MS = 15 * 1000;
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
        state.flipped = false; // extra field on top of createState()'s usual shape — see evaluateBand()/manageLeg() below
        const orders = createOrders(context, tg, kc); // kcOverride — THIS leg's own account, not the global one

        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            if (saved?.position === side) {
                state.position   = saved.position;
                state.entryPrice = saved.entry_price;
                const openTrade  = await db.getOpenTrade(context.tgPrefix);
                state.openTradeId = openTrade ? openTrade.id : null;
                // state.flipped is NOT persisted (the reference scripts don't
                // either — hedged_position restarts at 0) — a restart while
                // already past the flip point re-arms the exit rules only at
                // the next real flip.
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

        return { side, user, context, tg, db, state, orders, ltpKey: `${context.exchange}:${context.symbol}`, wantEntry: false, nextExitAt: 0, slDistance: null, slAtr: null, slSnapshotAt: 0 };
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

    console.log(c.bold(`DUAL HEDGE  ${long.context.symbol}  LONG:${long.user.name} (${long.context.lots} lot)  SHORT:${short.user.name} (${short.context.lots} lot)  ${SL_MODE === "ATR" ? `stop:${ATR_SL_MULT}x ATR(${engineConfig.ST_ATR_LEN}) on ${ATR_TIMEFRAME} (backstop ₹${MAX_LOSS_RUPEES} until ATR is available)` : `maxLoss:₹${MAX_LOSS_RUPEES}`} takeProfit:₹${TAKE_PROFIT_RUPEES} (exits armed only once flipped)`));
    // ─── TELEGRAM ALERTS (all sent via the long leg's tg, same chat as entries/exits):
    // start-up, flips, loop errors (throttled), and a daily summary. Entries, exits and
    // entry/exit failures already alert from enterLeg/exitLeg/positions.close.
    const alertAt = {};
    function alertThrottled(key, msg, ms = 10 * 60 * 1000) {
        if (Date.now() - (alertAt[key] || 0) < ms) return;
        alertAt[key] = Date.now();
        Promise.resolve(long.tg(msg)).catch(() => {});
    }
    long.tg(`\u25b6 Dual Hedge started \u2014 ${long.context.symbol}\nLONG:${long.user.name} (${long.context.lots} lot)  SHORT:${short.user.name} (${short.context.lots} lot)\n${REALIZE_MODE ? `REALIZE mode: close + re-open a leg when profit > \u20b9${REALIZE_RUPEES}; losing leg is never closed${LOSS_ALERT_RUPEES ? ` (alert at -\u20b9${LOSS_ALERT_RUPEES})` : ""}` : SL_MODE === "ATR" ? `Stop ${ATR_SL_MULT}x ATR on ${ATR_TIMEFRAME} (backstop \u20b9${MAX_LOSS_RUPEES})  Take profit \u20b9${TAKE_PROFIT_RUPEES}` : `Stop \u20b9${MAX_LOSS_RUPEES}  Take profit \u20b9${TAKE_PROFIT_RUPEES}`}\n${engineConfig.LIVE_ORDERS ? "LIVE orders" : "PAPER"}  \u00b7  NRML${GAP_CAPTURE ? " \u00b7 gap capture" : ""}`);

    // Daily summary once per day at DH_REPORT_HOUR:DH_REPORT_MINUTE IST (default 23:25).
    const REPORT_HOUR = Number(process.env.DH_REPORT_HOUR ?? 23), REPORT_MINUTE = Number(process.env.DH_REPORT_MINUTE ?? 25);
    let reportedForDate = null;
    async function dailySummary() {
        const today = todayIST();
        if (reportedForDate === today || !pastClock(REPORT_HOUR, REPORT_MINUTE)) return;
        reportedForDate = today;
        const px = (tickPrice !== null && Date.now() - tickAt <= PRICE_STALE_MS) ? tickPrice : await getLtp(long.ltpKey).catch(() => null);
        const lines = [];
        let total = 0;
        for (const leg of [long, short]) {
            const realized = await leg.db.getRealizedPnlToday(leg.context.tgPrefix);
            const open = leg.state.position && px !== null ? positions.unrealised(leg.context, leg.state, px) : null;
            total += realized + (open || 0);
            lines.push(`${leg.side} (${leg.user.name}): realized ${positions.pnlStr(realized)}` + (leg.state.position ? `  \u00b7 OPEN @${leg.state.entryPrice}${open !== null ? ` unrealized ${positions.pnlStr(open)}` : ""}` : "  \u00b7 flat"));
        }
        long.tg(`\ud83d\udcca Dual Hedge summary \u2014 ${today}\n${long.context.symbol}\n${lines.join("\n")}\nNet (realized + unrealized): ${positions.pnlStr(total)}`);
    }
    setInterval(() => { dailySummary().catch(err => console.error(c.red(`summary error: ${err.message}`))); }, 30000);
    console.log();

    // Shared band signal — read ONCE per evaluation, applied to both legs.
    // See file header for why this must not be computed independently twice.
    const bandStep  = long.context.bandStep ?? engineConfig.BAND_STEP_DEFAULT;
    const rangeSize = process.env.DH_RANGE_SIZE_OVERRIDE ? Number(process.env.DH_RANGE_SIZE_OVERRIDE) : bandStep;
    if (!(rangeSize > 0) || !(bandStep > 0)) {
        console.error(c.red(`invalid band step (${bandStep}) / range size (${rangeSize}) — refusing to boot.`));
        process.exit(1);
    }
    console.log(c.dim(`signal: Dynamic Step Band on range bars  step ${bandStep}  range ${rangeSize}  from ${RANGE_START} IST`));
    const bandReader = createRangeBandReader({
        getKc: () => longKc, token: long.context.token, step: bandStep, rangeSize, startDate: RANGE_START, label: "DUAL_HEDGE",
    });

    // ─── Live price — one websocket on the LONG user's credentials (market
    // data is account-agnostic). See file header.
    let tickPrice = null, tickAt = 0;
    const ticker = new KiteTicker({ api_key: longUser.apiKey, access_token: longUser.accessToken });
    ticker.connect();
    ticker.on("connect", () => {
        ticker.subscribe([long.context.token]);
        ticker.setMode(ticker.modeLTP, [long.context.token]);
    });
    ticker.on("ticks", ticks => {
        for (const t of ticks) {
            if (t.instrument_token === long.context.token && t.last_price) { tickPrice = t.last_price; tickAt = Date.now(); }
        }
    });
    ticker.on("error",       err => console.error(c.red(`WS  error: ${err && err.message ? err.message : err}`)));
    ticker.on("close",       ()  => console.log(c.dim("WS  closed")));
    ticker.on("reconnect",   n   => console.log(c.dim(`WS  reconnect #${n}`)));
    ticker.on("noreconnect", ()  => { console.error(c.red("WS  max reconnects — exiting so PM2 restarts")); process.exit(1); });

    // Read-only client for LTP lookups (uPnL checks + entry/exit
    // bookkeeping prices) — same reasoning as hedgePairEngine.js's own
    // getLtp(): orders.js's _place() fetches its own LTP internally for
    // order pricing, this is purely for THIS engine's own PnL math.
    async function getLtp(ltpKey) {
        const data = await longKc.getLTP([ltpKey]);
        return data[ltpKey]?.last_price ?? null;
    }

    // ATR stop-loss (DH_SL_MODE=ATR): read on the LONG user's client like all
    // market data here. See dualHedgeAtr.js.
    const atrReader = SL_MODE === "ATR"
        ? createAtrReader({ getKc: () => longKc, token: long.context.token, timeframe: ATR_TIMEFRAME, len: engineConfig.ST_ATR_LEN })
        : null;
    // Stop distance in price points for this leg's current position, from the
    // ATR at entry. null = not known yet (resumed position, or ATR unavailable).
    async function snapshotSlDistance(leg) {
        if (!atrReader) return;
        const a = await atrReader.get().catch(() => null);
        leg.slDistance = a !== null && a > 0 ? ATR_SL_MULT * a : null;
        leg.slAtr = a;
        leg.slSnapshotAt = Date.now();
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
        leg.slDistance = null; leg.slAtr = null; leg.slSnapshotAt = 0;
        await snapshotSlDistance(leg);
        leg.state.openTradeId = await leg.db.insertOpenTrade(leg.context.tgPrefix, leg.context.symbol, leg.side, leg.context.lots, price);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, leg.side, price, `DUAL_HEDGE_${leg.side}`);
        console.log(c.bold(`**${leg.side} ENTRY**`));
        console.log(c.green(`[${leg.context.tgPrefix}] ${leg.side} @ price ${price.toFixed(2)}  |  ${reason}`));
        const slNote = leg.slDistance !== null ? `\nstop (once flipped): ${ATR_SL_MULT}x ATR ${leg.slAtr.toFixed(2)} = ${leg.slDistance.toFixed(2)} pts` : "";
        if (leg.slDistance !== null) console.log(c.dim(`[${leg.context.tgPrefix}] ${leg.side} stop distance ${leg.slDistance.toFixed(2)} pts (${ATR_SL_MULT}x ATR(${engineConfig.ST_ATR_LEN}) ${leg.slAtr.toFixed(2)} on ${ATR_TIMEFRAME}), armed once flipped`));
        leg.tg(`${leg.side} ENTER (${reason}) @ \u20b9${price.toFixed(2)}${slNote}`);
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
        leg.slDistance = null; leg.slAtr = null; leg.slSnapshotAt = 0;
        return true;
    }

    // Latest price: the live tick when fresh; otherwise REST LTP, throttled
    // (the ticker is down or quiet — don't hammer the REST endpoint at 1/s).
    let lastRestAt = 0;
    async function livePrice() {
        if (tickPrice !== null && Date.now() - tickAt <= PRICE_STALE_MS) return tickPrice;
        if (Date.now() - lastRestAt < 5000) return null;
        lastRestAt = Date.now();
        return getLtp(long.ltpKey).catch(() => null);
    }

    // ─── BAND EVALUATION — runs at :20 past each 15-minute mark from 09:15
    // (reference candle_trade/screener). Only ever ARMS things: a favorable
    // color while flat sets the entry signal, an adverse color while holding
    // sets the sticky flip. The 1-second manager below acts on them.
    async function evaluateBand() {
        if (REALIZE_MODE) return;   // REALIZE has no band signal
        const { hours, minutes } = istParts();
        if (hours < 9 || (hours === 9 && minutes < 15)) return;   // reference never evaluates before 09:15
        if (gapWindowActive()) {
            // Band logic is off for the rest of the day (see GAP CAPTURE in the header).
            await emitLivePnl();
            return;
        }
        const band = await bandReader.getLatest();
        if (!band) { console.log(c.dim("DUAL HEDGE  no band read yet — will retry next slot")); return; }

        for (const leg of [long, short]) {
            const favorable = leg.side === "LONG" ? "green" : "red";
            const adverse   = leg.side === "LONG" ? "red"   : "green";
            if (!leg.state.position) {
                if (band.color === favorable) leg.wantEntry = true;   // white/adverse while flat: nothing
            } else if (!leg.state.flipped && band.color === adverse) {
                leg.state.flipped = true;
                alertThrottled(`flip-${leg.side}`, `\u26a0 ${leg.side} FLIPPED \u2014 band turned ${band.color} against the ${leg.side} leg (${leg.user.name}). Exits armed: take-profit > +\u20b9${TAKE_PROFIT_RUPEES}, ${SL_MODE === "ATR" ? `stop ${ATR_SL_MULT}x ATR` : `stop < -\u20b9${MAX_LOSS_RUPEES}`}.`, 60000);
                console.log(c.yellow(`[${leg.context.tgPrefix}] ${leg.side} FLIPPED (band ${band.color}) — exits now armed: take-profit > +₹${TAKE_PROFIT_RUPEES}, stop ${SL_MODE === "ATR" ? `${ATR_SL_MULT}x ATR` : `< -₹${MAX_LOSS_RUPEES}`}`));
            }
        }
        await emitLivePnl();
    }

    // ─── 1-SECOND MANAGER (reference trade_manager) — entries armed by the
    // evaluation, and the exit rules for flipped legs, against the live price.
    async function manageLeg(leg, price) {
        if (!leg.state.position) {
            if (leg.wantEntry) {
                leg.wantEntry = false;   // one attempt per signal — a failed entry waits for the next evaluation
                await enterLeg(leg, `band ${leg.side === "LONG" ? "green" : "red"}`);
            }
            return;
        }
        if (!leg.state.flipped) return;   // no exit of any kind before a flip, by design
        if (Date.now() < leg.nextExitAt) return;

        const uPnl = positions.unrealised(leg.context, leg.state, price);
        let reason = null;
        if (uPnl > TAKE_PROFIT_RUPEES) reason = `${leg.side} EXIT (take profit > ₹${TAKE_PROFIT_RUPEES})`;
        else {
            // ATR mode: price-distance stop from the entry-time ATR. A resumed
            // position (or one entered while ATR was unavailable) has no
            // snapshot — take one now, at most every 30s. While there is still
            // none, the rupee stop below stays as the backstop.
            if (SL_MODE === "ATR" && leg.slDistance === null && Date.now() - leg.slSnapshotAt > 30 * 1000) await snapshotSlDistance(leg);
            if (SL_MODE === "ATR" && leg.slDistance !== null) {
                const adverse = leg.state.position === "LONG" ? leg.state.entryPrice - price : price - leg.state.entryPrice;
                if (adverse > leg.slDistance) reason = `${leg.side} EXIT SL (${adverse.toFixed(2)} pts against entry > ${ATR_SL_MULT}x ATR = ${leg.slDistance.toFixed(2)})`;
            } else if (uPnl < -MAX_LOSS_RUPEES) {
                reason = `${leg.side} EXIT SL (loss > ₹${MAX_LOSS_RUPEES})`;
            }
        }
        if (!reason) return;

        const ok = await exitLeg(leg, reason);
        if (ok) leg.wantEntry = false;   // sma_signal=0 after an exit
        else    leg.nextExitAt = Date.now() + EXIT_COOLDOWN_MS;
    }

    // REALIZE mode, run every second per leg (see DH_STRATEGY note near the top).
    function marketOpenNow() {   // MCX session, entries/realizing only inside it (carry orders can't fill outside)
        const { hours, minutes } = istParts();
        return hours >= 9 && (hours < 23 || (hours === 23 && minutes < 25));
    }
    async function realizeLeg(leg, price) {
        if (!marketOpenNow() || Date.now() < leg.nextExitAt) return;
        if (!leg.state.position) {
            // Flat (first start, or a failed re-open): open the leg's own side, NRML.
            const ok = await enterLeg(leg, "initial / re-open (carry overnight)");
            if (!ok) leg.nextExitAt = Date.now() + EXIT_COOLDOWN_MS;
            return;
        }
        const uPnl = positions.unrealised(leg.context, leg.state, price);
        if (uPnl > REALIZE_RUPEES) {
            const side = leg.side;
            const closed = await exitLeg(leg, `${side} REALIZE (profit > \u20b9${REALIZE_RUPEES})`);
            if (!closed) { leg.nextExitAt = Date.now() + EXIT_COOLDOWN_MS; return; }
            const reopened = await enterLeg(leg, `re-open after realizing (overnight carry)`);
            leg.tg(reopened ? `\u267b ${side} profit realized and re-opened (NRML carry).` : `\u26a0 ${side} profit realized but RE-OPEN FAILED \u2014 will retry automatically.`);
            if (!reopened) leg.nextExitAt = Date.now() + EXIT_COOLDOWN_MS;
            return;
        }
        if (LOSS_ALERT_RUPEES > 0 && uPnl < -LOSS_ALERT_RUPEES) {
            alertThrottled(`loss-${leg.side}`, `\u26a0 ${leg.side} leg (${leg.user.name}) is down ${positions.pnlStr(uPnl)} (alert level \u20b9${LOSS_ALERT_RUPEES}). Add funds / manage margin on that account. Nothing is closed automatically.`, 60 * 60 * 1000);
        }
    }

    let managing = false;
    async function manage() {
        if (managing) return;
        managing = true;
        try {
            if (gapWindowActive()) return;
            const price = await livePrice();
            if (price === null) return;
            if (REALIZE_MODE) { await realizeLeg(long, price); await realizeLeg(short, price); }
            else { await manageLeg(long, price); await manageLeg(short, price); }
        } catch (err) {
            console.error(c.red(`DUAL HEDGE manager error: ${err.message}`));
            alertThrottled("mgr-err", `\u26a0 Dual Hedge manager error: ${err.message}`);
        } finally {
            managing = false;
        }
    }

    // ─── Web dashboard live pane + console heartbeat — one line per leg,
    // once per 15-minute evaluation.
    async function emitLivePnl() {
        const ts = new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
        for (const leg of [long, short]) {
            const price = (tickPrice !== null && Date.now() - tickAt <= PRICE_STALE_MS) ? tickPrice : await getLtp(leg.ltpKey).catch(() => null);
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
        console.log(c.dim(`gap capture ON  all orders NRML (single order day + overnight); algo enters at any time`));
    }

    function gapWindowActive() {
        return false;   // simplified: no special gap window — the band logic runs at any time
        // eslint-disable-next-line no-unreachable
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

        // SIMPLIFIED: no realize step and no separate overnight order. A leg that
        // is already holding keeps its position (already NRML); a flat leg gets
        // its NRML entry (LONG on the long account, SHORT on the short account).
        // 2. Enter — locked in before either order fires, so a failed entry
        // means no position tonight, not a retry loop.
        gcDoneForDate = today;
        console.log();
        console.log(c.bold("**GAP CAPTURE ENTRY**"));
        const reason = `gap capture ${hhmm(GC_HOUR, GC_MINUTE)} IST (carry overnight)`;
        if (!long.state.position)  await enterLeg(long,  reason);
        if (!short.state.position) await enterLeg(short, reason);
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
            await gapEnter();   // (gapQuit/shutdown removed — the engine keeps running; band logic resumes after midnight)
        } catch (err) {
            console.error(c.red(`GAP CAPTURE loop error: ${err.message}`));
        }
    }

    // ─── 15-minute slot scheduling, +20s like the reference's trade_timer
    // (seconds == 20 at minute % 15 == 0).
    function msUntilNextSlot() {
        const now   = new Date();
        const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
        const ist   = new Date(istMs);
        const secInSlot = (ist.getUTCMinutes() % SLOT_MINUTES) * 60 + ist.getUTCSeconds();
        // Time until :20 past the mark — this slot's if we haven't reached it
        // yet, else the next slot's. The 250ms floor stops a slightly-early
        // timer from scheduling a second evaluation for the same slot.
        let ms = (EVAL_OFFSET_SEC - secInSlot) * 1000 - ist.getUTCMilliseconds();
        if (ms <= 250) ms += SLOT_MINUTES * 60 * 1000;
        return ms;
    }

    async function evaluateSafe() {
        try { await evaluateBand(); }
        catch (err) { console.error(c.red(`DUAL HEDGE evaluation error: ${err.message}`)); alertThrottled("eval-err", `\u26a0 Dual Hedge evaluation error: ${err.message}`); }
    }

    function scheduleNextEval() {
        setTimeout(async () => { await evaluateSafe(); scheduleNextEval(); }, msUntilNextSlot());
    }

    // No evaluation at boot — the reference scripts only act at their :20
    // slots. Warm the minute-candle cache now so the first slot is instant.
    if (!REALIZE_MODE) bandReader.prewarm();
    scheduleNextEval();
    setInterval(manage, 1000);
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
