// dualBiasHedgeEngine.js — LIVE dual-account BIAS hedge (DH_STRATEGY=BIAS).
// Started by dualHedgeEngine.js, which stays the single PM2 entry point.
//
// TWO SEPARATE Kite logins (dualHedgeUsers.js), ONE instrument:
//   CORE   once per IST day at/after the entry time (default 10:00) the previous
//          completed DAILY Heikin-Ashi candle decides it: green -> the LONG
//          account goes long, red -> the SHORT account goes short.
//   HEDGE  when the Dynamic Band (default 15m, raw closes of Kite's own bars)
//          turns AGAINST the core, the OTHER account enters the opposite side.
//   UNWIND BAND_FLIP (band back in the core's favour closes the hedge) or
//          EOD_ONLY (hold to EOD).
//   EOD    both accounts are force-closed (hedge first, awaited). No overnight
//          carry, no gap capture, no TP/SL. The process exits 0 after the
//          report and needs a PM2 start on the next trading day.
// All decisions live in dualBiasHedgeController.js (pure, parity-tested against
// backtestDualHedge.js's replayBiasHedge). This file is plumbing only: users,
// contexts, readers, orders, DB resume, Telegram, webdash events.
//
// ENV VARS:
//   DH_UNDERLYING, DH_LONG_USER, DH_SHORT_USER   (required)
//   DH_EXCHANGE_OVERRIDE          default "MCX"
//   DH_LOTS_OVERRIDE              default 1; DH_LONG_LOTS_OVERRIDE / DH_SHORT_LOTS_OVERRIDE per leg
//   DH_LOTMULT_OVERRIDE           unless context.js already has one
//   DH_BAND_STEP_OVERRIDE         optional band step
//   DH_BAND_TIMEFRAME             5m | 15m | 30m | 1h   (default 15m)
//   DH_UNWIND_MODE                BAND_FLIP (default) | EOD_ONLY
//   DH_ENTRY_HOUR_OVERRIDE / DH_ENTRY_MINUTE_OVERRIDE   core entry time IST (10:00)
//   DH_EOD_HOUR_OVERRIDE / DH_EOD_MINUTE_OVERRIDE       default context.js defaultEodFor(timeframe)
//   DH_POLL_MS                    decision poll, default 60000
//   LIVE_ORDERS_OVERRIDE          "true" | "false"
//
// Fills can lag the backtest by up to one poll; a late start takes the core on
// the first poll after the entry time.
"use strict";

const { KiteConnect } = require("kiteconnect");
const engineConfig = require("./engineConfig");
const c = require("./c");
const { createCsvRepository } = require("./csvRepository");
const { createInstrumentSource } = require("./instrumentSource");
const { createContractPinStore } = require("./contractPins");
const { resolveDualHedgeLeg } = require("./dualHedgeContext");
const { listUsers } = require("./dualHedgeUsers");
const { defaultEodFor } = require("./context");
const { createTelegram } = require("./telegram");
const { createState } = require("./state");
const { createDb } = require("./db");
const { createOrders } = require("./orders");
const positions = require("./positions");
const { emitEvent } = require("./eventBridge");
const { istParts, todayIST } = require("./istTime");
const { createHaCandleReader } = require("./haCandleReader");
const { createDynamicBandReader } = require("./dynamicBandReader");
const { createBiasHedgeController } = require("./dualBiasHedgeController");

const BAND_TIMEFRAMES = ["5m", "15m", "30m", "1h"];
const hhmm = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const envInt = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v))) ? Number(v) : d;
const fail = msg => { console.error(c.red(`${msg} — refusing to boot.`)); process.exit(1); };

async function main() {
    const UNDERLYING = process.env.DH_UNDERLYING;
    const LONG_USER  = process.env.DH_LONG_USER;
    const SHORT_USER = process.env.DH_SHORT_USER;
    if (!UNDERLYING || !LONG_USER || !SHORT_USER) fail("DH_UNDERLYING, DH_LONG_USER and DH_SHORT_USER are all required");
    if (LONG_USER.toUpperCase() === SHORT_USER.toUpperCase()) fail("DH_LONG_USER and DH_SHORT_USER must be two different accounts");
    const EXCHANGE = process.env.DH_EXCHANGE_OVERRIDE || "MCX";
    const UNWIND = (process.env.DH_UNWIND_MODE || "BAND_FLIP").toUpperCase();
    if (UNWIND !== "BAND_FLIP" && UNWIND !== "EOD_ONLY") fail(`DH_UNWIND_MODE "${process.env.DH_UNWIND_MODE}" invalid (BAND_FLIP / EOD_ONLY)`);
    const BAND_TF = (process.env.DH_BAND_TIMEFRAME || "15m").toLowerCase();
    if (!BAND_TIMEFRAMES.includes(BAND_TF)) fail(`DH_BAND_TIMEFRAME "${process.env.DH_BAND_TIMEFRAME}" invalid (${BAND_TIMEFRAMES.join("/")})`);
    const POLL_MS = Math.max(5000, envInt(process.env.DH_POLL_MS, 60 * 1000));

    const entryHour = envInt(process.env.DH_ENTRY_HOUR_OVERRIDE, 10);
    const entryMinute = envInt(process.env.DH_ENTRY_MINUTE_OVERRIDE, 0);
    const eodDef = defaultEodFor(BAND_TF, EXCHANGE);
    const eodHour = envInt(process.env.DH_EOD_HOUR_OVERRIDE, eodDef.eodHour);
    const eodMinute = envInt(process.env.DH_EOD_MINUTE_OVERRIDE, eodDef.eodMinute);
    if (!(eodHour * 60 + eodMinute > entryHour * 60 + entryMinute)) {
        fail(`EOD ${hhmm(eodHour, eodMinute)} must be after the core entry time ${hhmm(entryHour, entryMinute)}`);
    }

    const userMap = {};
    for (const u of listUsers()) userMap[u.name] = u;
    const longUser = userMap[LONG_USER.toUpperCase()];
    const shortUser = userMap[SHORT_USER.toUpperCase()];
    for (const [label, u, raw] of [["DH_LONG_USER", longUser, LONG_USER], ["DH_SHORT_USER", shortUser, SHORT_USER]]) {
        if (!u || !u.apiKey || !u.accessToken) {
            console.error(c.red(`  Fix via toolbox.js's Dual Hedge > Manage Users menu.`));
            fail(`${label} "${raw}" is not a fully configured dual-hedge user (missing API key or access token)`);
        }
    }

    if (process.env.LIVE_ORDERS_OVERRIDE !== undefined) engineConfig.LIVE_ORDERS = process.env.LIVE_ORDERS_OVERRIDE === "true";
    console.log(c.bold(engineConfig.LIVE_ORDERS ? c.red("LIVE — real orders will be placed (both accounts)")
                                                  : c.cyan("PAPER — shadow mode, no real orders")));

    const kcFor = user => { const kc = new KiteConnect({ api_key: user.apiKey }); kc.setAccessToken(user.accessToken); return kc; };
    const longKc = kcFor(longUser), shortKc = kcFor(shortUser);

    console.log(c.dim(`loading instrument dump (${EXCHANGE})...`));
    const csvFilePath = EXCHANGE === "NSE" ? engineConfig.NSE_INSTRUMENT_CSV_PATH : engineConfig.INSTRUMENT_CSV_PATH;
    const csvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({ filePath: csvFilePath, kc: longKc, exchange: EXCHANGE }).fetchRows,
    });
    await csvRepo.load();
    const pinStore = createContractPinStore();

    const today0 = todayIST();
    const resumed = [];

    async function buildLeg(side, user, kc, { lots, lotMultOverride, bandStepOverride }) {
        let context, source;
        try {
            ({ context, source } = resolveDualHedgeLeg({
                underlying: UNDERLYING, side, userName: user.name, exchange: EXCHANGE,
                csvRepo, pinStore, lots, lotMultOverride, bandStepOverride,
            }));
        } catch (err) {
            console.error(c.red(`[${side}] leg resolve failed: ${err.stack || err.message}`));
            process.exit(1);
        }
        context.name = context.name.replace("(Dual Hedge", "(Dual Bias Hedge");
        context.tgLabel = `Dual Bias Hedge ${side} (${user.name})`;
        context.eodHour = eodHour; context.eodMinute = eodMinute;
        console.log(c.dim(`[${context.tgPrefix}] resolved contract (${source}): ${context.symbol} (token ${context.token}, lotMult ${context.lotMult}, lots ${context.lots}, account:${user.name})`));

        const { tg } = createTelegram(context, engineConfig);
        const db = createDb(context);
        db.initDB();
        const state = createState();
        const orders = createOrders(context, tg, kc);
        const leg = { side, user, context, tg, db, state, orders, role: null, ltpKey: `${context.exchange}:${context.symbol}` };

        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const src = saved?.position_source;
            if (saved?.position === side && (src === "DUAL_BIAS_CORE" || src === "DUAL_BIAS_HEDGE")) {
                state.position = saved.position;
                state.entryPrice = saved.entry_price;
                const openTrade = await db.getOpenTrade(context.tgPrefix);
                state.openTradeId = openTrade ? openTrade.id : null;
                leg.role = src === "DUAL_BIAS_CORE" ? "CORE" : "HEDGE";
                resumed.push(leg);
                console.log(c.yellow(`[${context.tgPrefix}] resumed ${leg.role} ${state.position}@${state.entryPrice}`));
                const savedDate = saved.entry_date || saved.date || null;
                if (savedDate && String(savedDate).slice(0, 10) < today0) {
                    console.warn(c.yellow(`[${context.tgPrefix}] resumed position is from ${savedDate} (not today) — it will be flattened at EOD`));
                    tg(`⚠ [${context.tgPrefix}] Resumed ${leg.role} ${side} is from ${savedDate}, not today. Verify at the broker.`);
                }
            } else if (saved?.position) {
                console.error(c.red(`[${context.tgPrefix}] saved position (${saved.position}@${saved.entry_price}, source ${src || "?"}) is not a bias-hedge position for this leg — NOT adopted, verify at the broker`));
                tg(`⚠ [${context.tgPrefix}] Found a saved ${saved.position}@${saved.entry_price} not owned by the bias hedge — NOT adopted. Verify at the broker.`);
            }
            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);
        } catch (err) {
            console.warn(`[${context.tgPrefix}] boot resume failed: ${err.message}`);
        }
        await orders.reconcile(state);
        return leg;
    }

    const bandStepOverride = process.env.DH_BAND_STEP_OVERRIDE ? Number(process.env.DH_BAND_STEP_OVERRIDE) : null;
    const lotMultOverride = process.env.DH_LOTMULT_OVERRIDE ? Number(process.env.DH_LOTMULT_OVERRIDE) : null;
    const defaultLots = Number(process.env.DH_LOTS_OVERRIDE) || 1;
    const long = await buildLeg("LONG", longUser, longKc, { lots: Number(process.env.DH_LONG_LOTS_OVERRIDE) || defaultLots, lotMultOverride, bandStepOverride });
    const short = await buildLeg("SHORT", shortUser, shortKc, { lots: Number(process.env.DH_SHORT_LOTS_OVERRIDE) || defaultLots, lotMultOverride, bandStepOverride });

    // Two recovered COREs can't both be core — keep LONG, demote SHORT.
    if (long.role === "CORE" && short.role === "CORE") {
        short.role = "HEDGE";
        console.warn(c.yellow("both accounts resumed as CORE — SHORT demoted to HEDGE"));
        long.tg("⚠ Both accounts resumed as CORE; SHORT treated as HEDGE.");
    }

    console.log(c.bold(`DUAL BIAS HEDGE  ${long.context.symbol}  LONG:${long.user.name} (${long.context.lots} lot)  SHORT:${short.user.name} (${short.context.lots} lot)  band ${BAND_TF}  unwind ${UNWIND}  core ${hhmm(entryHour, entryMinute)}  flat ${hhmm(eodHour, eodMinute)} IST`));
    console.log();

    // Readers use the LONG user's credentials (market data is account-agnostic);
    // the token is re-read from the user registry on every refresh.
    const readerConfig = Object.assign(Object.create(engineConfig), {
        API_KEY: longUser.apiKey,
        getAccessToken: () => { const u = listUsers().find(x => x.name === longUser.name); return (u && u.accessToken) || longUser.accessToken; },
    });
    const bandStep = long.context.bandStep ?? engineConfig.BAND_STEP_DEFAULT;
    const token = long.context.token;
    const dailyReader = createHaCandleReader({ token, timeframe: "1d", engineConfig: readerConfig, label: "DUAL_BIAS_DAILY" });
    const bandReader = createDynamicBandReader({
        token, timeframe: BAND_TF, bandStep, engineConfig: readerConfig, label: "DUAL_BIAS_BAND",
        refreshMs: Math.max(10 * 1000, POLL_MS - 5 * 1000),
    });

    async function getLtp(key) {
        const data = await longKc.getLTP([key]);
        return data[key]?.last_price ?? null;
    }

    async function enterLeg(leg, role, reason) {
        const orderId = await leg.orders.enter(leg.side);
        if (engineConfig.LIVE_ORDERS && orderId === null) {
            console.error(c.red(`[${leg.context.tgPrefix}] ${role} ${leg.side} entry FAILED (${reason})`));
            leg.tg(`⚠ [${leg.context.tgPrefix}] ${role} ${leg.side} entry FAILED (${reason})`);
            return false;
        }
        const price = (await getLtp(leg.ltpKey).catch(() => null)) || 0;
        leg.state.position = leg.side;
        leg.state.entryPrice = price;
        leg.state.openTradeId = await leg.db.insertOpenTrade(leg.context.tgPrefix, leg.context.symbol, leg.side, leg.context.lots, price);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, leg.side, price, `DUAL_BIAS_${role}`);
        console.log(c.bold(`**${role} ${leg.side} ENTRY**`));
        console.log(c.green(`[${leg.context.tgPrefix}] ${leg.side} @ price ${price.toFixed(2)}  |  ${reason}`));
        leg.tg(`${role} ${leg.side} ENTER (${reason}) @ ₹${price.toFixed(2)}`);
        emitEvent(leg.context.tgPrefix, "ENTRY", { side: leg.side, price, trail: null });
        return true;
    }

    async function exitLeg(leg, reason, { awaitFill = false } = {}) {
        if (!leg.state.position) return true;
        const side = leg.state.position;
        const orderId = await leg.orders.exit(side, awaitFill ? { awaitFill: true } : undefined);
        if (engineConfig.LIVE_ORDERS && orderId === null) {
            console.error(c.red(`[${leg.context.tgPrefix}] ${side} exit FAILED (${reason}) — position left open, NOT marked closed`));
            leg.tg(`⚠ [${leg.context.tgPrefix}] ${side} exit FAILED (${reason}) — position left open, verify manually.`);
            return false;
        }
        const price = (await getLtp(leg.ltpKey).catch(() => null)) ?? leg.state.entryPrice;
        console.log(c.bold(`**${leg.role ? leg.role + " " : ""}${leg.side} EXIT**`));
        await positions.close(leg.context, leg.state, leg.db, leg.tg, price, reason);
        leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, null, 0);
        return true;
    }

    const clock = () => { const p = istParts(); return { today: todayIST(), hours: p.hours, minutes: p.minutes }; };
    const controller = createBiasHedgeController({
        long, short, dailyReader, bandReader, enterLeg, exitLeg, clock,
        entryHour, entryMinute, eodHour, eodMinute, unwindMode: UNWIND,
        log: m => console.log(c.dim(`DUAL BIAS  ${m}`)),
    });
    for (const leg of resumed) controller.markResumed(leg, leg.role, today0);

    // Late-start notices.
    {
        const t = clock();
        const nowMin = t.hours * 60 + t.minutes;
        if (nowMin >= eodHour * 60 + eodMinute) {
            const m = `started after EOD (${hhmm(eodHour, eodMinute)}) — will only flatten what is open, then exit`;
            console.log(c.yellow(`DUAL BIAS  ${m}`)); long.tg(`⚠ Dual Bias Hedge ${m}`);
        } else if (nowMin >= entryHour * 60 + entryMinute && !controller.coreLeg()) {
            const m = `started after the core entry time (${hhmm(entryHour, entryMinute)}) — the core is taken on the first poll from the latest completed daily HA candle`;
            console.log(c.yellow(`DUAL BIAS  ${m}`)); long.tg(`ℹ Dual Bias Hedge ${m}`);
        }
    }

    let lastBeat = 0;
    async function emitLivePnl() {
        const ts = new Date().toLocaleTimeString("en-IN", { hour12: false });
        const beat = Date.now() - lastBeat >= 15 * 60 * 1000;
        if (beat) lastBeat = Date.now();
        for (const leg of [long, short]) {
            const price = await getLtp(leg.ltpKey).catch(() => null);
            if (price === null) continue;
            const uPnl = leg.state.position ? positions.unrealised(leg.context, leg.state, price) : 0;
            const session = (leg.state.pnl || 0) + uPnl;
            emitEvent(leg.context.tgPrefix, "TICK", { price, uPnl, session, position: leg.state.position, entryPrice: leg.state.entryPrice || null });
            if (beat) {
                const posStr = leg.state.position ? `${leg.role || ""} ${leg.state.position}@${leg.state.entryPrice.toFixed(2)}`.trim() : "flat";
                const fmt = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
                console.log((leg.state.position ? (uPnl >= 0 ? c.green : c.red) : c.dim)(`[${leg.context.tgPrefix}] ${ts}  price ${price.toFixed(2).padStart(9)}  ${posStr.padEnd(24)}  uPnL:${fmt(uPnl).padStart(7)}  session:${fmt(session).padStart(8)}`));
            }
        }
    }

    async function eodReportAndExit() {
        const today = todayIST();
        const lr = await long.db.getRealizedPnlToday(long.context.tgPrefix);
        const sr = await short.db.getRealizedPnlToday(short.context.tgPrefix);
        const mode = engineConfig.LIVE_ORDERS ? "LIVE" : "PAPER";
        const report = `Dual Bias Hedge EOD (${mode}) — ${today}\nlong   ${long.context.symbol} (${long.user.name}): realized ${positions.pnlStr(lr)}\nshort  ${short.context.symbol} (${short.user.name}): realized ${positions.pnlStr(sr)}\ntotal realized: ${positions.pnlStr(lr + sr)}`;
        console.log(c.bold(report.replace(/\n/g, "   ")));
        await long.tg(report);
        console.log(c.bold("*** NORMAL SHUTDOWN ***"));
        emitEvent(long.context.tgPrefix, "SHUTDOWN", { pnl: lr + sr, trades: (long.state.trades || 0) + (short.state.trades || 0), positionLeftOpen: false });
        setTimeout(() => process.exit(0), 2000);
    }

    let ticking = false, finished = false;
    async function tick() {
        if (ticking || finished) return;
        ticking = true;
        try {
            const r = await controller.tick();
            if (r === "EOD_DONE") { finished = true; await eodReportAndExit(); return; }
            if (r === "EOD_PENDING") console.error(c.red("DUAL BIAS  EOD flatten incomplete — retrying next poll"));
            else await emitLivePnl();
        } catch (err) {
            console.error(c.red(`DUAL BIAS tick error: ${err.message}`));
        } finally {
            ticking = false;
        }
    }

    await tick();
    setInterval(tick, POLL_MS);
}

main().catch(err => {
    console.error("BOOT FAILED", err);
    process.exit(1);
});

process.on("uncaughtException", err => console.error("UNCAUGHT", err));
process.on("unhandledRejection", err => console.error("UNHANDLED", err));
