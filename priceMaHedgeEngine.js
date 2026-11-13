// priceMaHedgeEngine.js — Dual-account Price-MA hedge: TWO Kite logins (dualHedgeUsers.js), ONE instrument.
//
//   BASE   at the configured IST time (once per day): LONG account -> LONG MIS, SHORT account -> SHORT MIS.
//   SIGNAL every websocket LTP of each IST minute is averaged (hedge/priceMaSignal.js); this minute's MA minus the
//          previous minute's MA: > 0 GREEN, < 0 RED, == 0 NEUTRAL.
//   HEDGE  GREEN -> the SHORT account (SHORT MIS is losing) opens a LONG NRML hedge; RED -> the LONG account opens a
//          SHORT NRML hedge. A colour change closes the old hedge first (confirmed), then opens the new one. NEUTRAL
//          keeps whatever is open.
//   EOD    from the EOD time both NRML hedge and MIS bases are explicitly closed (hedge first, retried until flat),
//          then the process reports and exits 0 (PM2 start needed next trading day).
// Decisions: hedge/priceMaHedgeController.js (pure, unit-tested). Signal maths: hedge/priceMaSignal.js (pure). This
// file is plumbing: users, contexts, ticker, order placement + FILL CONFIRMATION, DB/broker recovery, Telegram.
// No order is ever placed from the raw tick callback — ticks only feed the signal; a 5 s decision loop acts.
// PAPER mode (LIVE_ORDERS_OVERRIDE != "true"): same flow, fills are simulated at the last price, no broker orders.
//
// ENV VARS:
//   PMA_UNDERLYING, PMA_LONG_USER, PMA_SHORT_USER      (required)
//   PMA_EXCHANGE_OVERRIDE         default "MCX"
//   PMA_LOTS_OVERRIDE             default 1; PMA_LONG_LOTS_OVERRIDE / PMA_SHORT_LOTS_OVERRIDE per account
//   PMA_LOTMULT_OVERRIDE          unless context.js already has one
//   PMA_CONTRACT_OVERRIDE         optional exact tradingsymbol (else the current contract)
//   PMA_BASE_HOUR / PMA_BASE_MINUTE   base entry time IST, default 09:15
//   PMA_EOD_HOUR / PMA_EOD_MINUTE     default context.js defaultEodFor("1m", exchange)
//   PMA_MIN_SLOPE                 default 0   (|slope| <= this counts as NEUTRAL; 0 = exact zero as specified)
//   PMA_CONFIRM_MINUTES           default 1   (same colour for N consecutive minutes before the hedge flips)
//   PMA_STALE_SECONDS             default 150 (a signal older than this never opens/flips a hedge)
//   PMA_POLL_MS                   default 5000 (decision loop)
//   LIVE_ORDERS_OVERRIDE          "true" | "false"
// Start (PM2):  PMA_UNDERLYING=NATGASMINI PMA_LONG_USER=a PMA_SHORT_USER=b PMA_LOTMULT_OVERRIDE=250 \
//               pm2 start priceMaHedgeEngine.js --name pma-natgasmini
"use strict";
require("./utils/plainLog").install();

const fs = require("fs");
const path = require("path");
const { KiteConnect, KiteTicker } = require("kiteconnect");
const engineConfig = require("./core/engineConfig");
const c = require("./utils/c");
const { createCsvRepository } = require("./data/csvRepository");
const { createInstrumentSource } = require("./data/instrumentSource");
const { createContractPinStore } = require("./data/contractPins");
const { resolveDualHedgeLeg } = require("./hedge/dualHedgeContext");
const { listUsers } = require("./hedge/dualHedgeUsers");
const { defaultEodFor } = require("./core/context");
const { createTelegram } = require("./utils/telegram");
const { createState } = require("./core/state");
const { createDb } = require("./data/db");
const { createOrders } = require("./core/orders");
const positions = require("./core/positions");
const { emitEvent } = require("./core/eventBridge");
const { istParts, todayIST } = require("./utils/istTime");
const { createPriceMaSignal } = require("./hedge/priceMaSignal");
const { createPriceMaHedgeController } = require("./hedge/priceMaHedgeController");

const envInt = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v))) ? Number(v) : d;
const envNum = envInt;
const hhmm = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const fail = msg => { console.error(c.red(`${msg} — refusing to boot.`)); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tag = (k, m) => console.log(`[${k}] ${m}`);

async function main() {
    const UNDERLYING = process.env.PMA_UNDERLYING, LONG_USER = process.env.PMA_LONG_USER, SHORT_USER = process.env.PMA_SHORT_USER;
    if (!UNDERLYING || !LONG_USER || !SHORT_USER) fail("PMA_UNDERLYING, PMA_LONG_USER and PMA_SHORT_USER are all required");
    if (LONG_USER.toUpperCase() === SHORT_USER.toUpperCase()) fail("PMA_LONG_USER and PMA_SHORT_USER must be two different accounts");
    const EXCHANGE = process.env.PMA_EXCHANGE_OVERRIDE || "MCX";
    const MIN_SLOPE = envNum(process.env.PMA_MIN_SLOPE, 0);
    const CONFIRM = envInt(process.env.PMA_CONFIRM_MINUTES, 1);
    const STALE_MS = envInt(process.env.PMA_STALE_SECONDS, 150) * 1000;
    const POLL_MS = Math.max(1000, envInt(process.env.PMA_POLL_MS, 5000));
    if (!(MIN_SLOPE >= 0)) fail("PMA_MIN_SLOPE must be >= 0");
    if (!(Number.isInteger(CONFIRM) && CONFIRM >= 1)) fail("PMA_CONFIRM_MINUTES must be a whole number >= 1");
    const baseHour = envInt(process.env.PMA_BASE_HOUR, 9), baseMinute = envInt(process.env.PMA_BASE_MINUTE, 15);
    const eodDef = defaultEodFor("1m", EXCHANGE);
    const eodHour = envInt(process.env.PMA_EOD_HOUR, eodDef.eodHour), eodMinute = envInt(process.env.PMA_EOD_MINUTE, eodDef.eodMinute);
    if (!(eodHour * 60 + eodMinute > baseHour * 60 + baseMinute)) fail(`EOD ${hhmm(eodHour, eodMinute)} must be after the base entry time ${hhmm(baseHour, baseMinute)}`);

    const userMap = {}; for (const u of listUsers()) userMap[u.name] = u;
    const longUser = userMap[LONG_USER.toUpperCase()], shortUser = userMap[SHORT_USER.toUpperCase()];
    for (const [label, u, raw] of [["PMA_LONG_USER", longUser, LONG_USER], ["PMA_SHORT_USER", shortUser, SHORT_USER]]) {
        if (!u || !u.apiKey || !u.accessToken) fail(`${label} "${raw}" is not a fully configured dual-hedge user (toolbox: Dual Hedge > Manage Users)`);
    }
    if (process.env.LIVE_ORDERS_OVERRIDE !== undefined) engineConfig.LIVE_ORDERS = process.env.LIVE_ORDERS_OVERRIDE === "true";
    const LIVE = !!engineConfig.LIVE_ORDERS;
    console.log(c.bold(LIVE ? c.red("LIVE — real orders will be placed (both accounts)") : c.cyan("PAPER — shadow mode, fills simulated, no broker orders")));

    const kcFor = u => { const kc = new KiteConnect({ api_key: u.apiKey }); kc.setAccessToken(u.accessToken); return kc; };
    const longKc = kcFor(longUser), shortKc = kcFor(shortUser);

    const csvFilePath = EXCHANGE === "NSE" ? engineConfig.NSE_INSTRUMENT_CSV_PATH : engineConfig.INSTRUMENT_CSV_PATH;
    const csvRepo = createCsvRepository({ fetchRows: createInstrumentSource({ filePath: csvFilePath, kc: longKc, exchange: EXCHANGE }).fetchRows });
    await csvRepo.load();
    const pinStore = createContractPinStore();
    const lotMultOverride = process.env.PMA_LOTMULT_OVERRIDE ? Number(process.env.PMA_LOTMULT_OVERRIDE) : null;
    const defaultLots = Number(process.env.PMA_LOTS_OVERRIDE) || 1;
    const today0 = todayIST();

    // ── broker-side helpers ───────────────────────────────────────────────────────────────────────
    const brokerNet = {};   // account -> net rows (one fetch per account at boot)
    async function fetchNet(kc) { const r = await kc.getPositions(); return (r && r.net) || []; }
    const qtyOf = (rows, leg) => rows.filter(p => p.tradingsymbol === leg.context.symbol && p.exchange === leg.context.exchange && p.product === leg.product).reduce((a, p) => a + p.quantity, 0);

    // ── sub-legs ──────────────────────────────────────────────────────────────────────────────────
    async function buildLeg(key, account, kind, side, user, kc) {
        const { context } = resolveDualHedgeLeg({ underlying: UNDERLYING, side: key, userName: user.name, exchange: EXCHANGE, csvRepo, pinStore,
            lots: Number(process.env[`PMA_${account}_LOTS_OVERRIDE`]) || defaultLots, lotMultOverride, bandStepOverride: null, symbolOverride: process.env.PMA_CONTRACT_OVERRIDE || null });
        context.tgPrefix = context.tgPrefix.replace("_DH_", "_PMA_");
        context.name = context.name.replace("Dual Hedge", "Price MA Hedge");
        context.tgLabel = `Price MA Hedge ${key} (${user.name})`;
        context.carryOvernight = false;                          // the engine flattens everything at EOD itself
        context.product = kind === "HEDGE" ? "NRML" : "MIS";     // orders.js productFor(): one product per orders instance
        context.eodHour = eodHour; context.eodMinute = eodMinute;
        const { tg } = createTelegram(context, engineConfig);
        const db = createDb(context); db.initDB();
        const state = createState();
        const orders = createOrders(context, tg, kc);
        const leg = { key, account, kind, side, user, kc, context, tg, db, state, orders, blocked: false, blockedReason: null,
            product: context.product, configuredLots: context.lots, ltpKey: `${context.exchange}:${context.symbol}` };
        await recover(leg);
        return leg;
    }

    // Boot recovery: a saved position is adopted ONLY when the broker agrees; a broker position we did not open is never adopted.
    async function recover(leg) {
        const { context, db, state } = leg;
        let saved = null;
        try { saved = await db.loadPosition(context.tgPrefix, context.token); } catch (e) { console.warn(`[${context.tgPrefix}] boot resume failed: ${e.message}`); }
        const ours = saved && saved.position && (saved.position_source === "PMA_BASE" || saved.position_source === "PMA_HEDGE");
        const brokerQty = LIVE ? qtyOf(brokerNet[leg.account], leg) : null;
        const expectSign = leg.side === "LONG" ? 1 : -1;
        if (ours && saved.position === leg.side) {
            if (LIVE && Math.sign(brokerQty) !== expectSign) {
                tag("RECOVERY", `${leg.key}: DB says ${saved.position} but the broker shows ${brokerQty} ${leg.product} lots — NOT adopted, saved row cleared`);
                leg.tg(`⚠ [${context.tgPrefix}] Saved ${saved.position} not found at the broker (qty ${brokerQty}). Cleared; verify manually.`);
                db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                if (brokerQty !== 0) { leg.blocked = true; leg.blockedReason = `broker ${leg.product} qty ${brokerQty} contradicts this leg`; }
            } else {
                if (LIVE && Math.abs(brokerQty) !== context.lots) { tag("RECOVERY", `${leg.key}: broker lots ${Math.abs(brokerQty)} != configured ${context.lots} — managing the broker quantity`); context.lots = Math.abs(brokerQty); }
                state.position = saved.position; state.entryPrice = saved.entry_price;
                const ot = await db.getOpenTrade(context.tgPrefix); state.openTradeId = ot ? ot.id : null;
                tag("RECOVERY", `${leg.key}: resumed ${state.position}@${state.entryPrice} (${leg.product}${LIVE ? ", broker confirmed" : ", paper"})`);
            }
        } else if (LIVE && brokerQty !== 0) {
            leg.blocked = true; leg.blockedReason = `broker already shows ${brokerQty} ${leg.product} lots on ${context.symbol} that this engine did not open`;
            tag("RECOVERY", `${leg.key}: ${leg.blockedReason} — leg BLOCKED, nothing adopted, nothing duplicated`);
            leg.tg(`⚠ [${context.tgPrefix}] ${leg.blockedReason}. Leg blocked. Verify manually.`);
        }
        state.pnl = await db.getRealizedPnlToday(context.tgPrefix).catch(() => 0);
    }

    if (LIVE) { brokerNet.LONG = await fetchNet(longKc); brokerNet.SHORT = await fetchNet(shortKc); }
    const legs = {
        LONG_BASE:   await buildLeg("LONG_BASE",   "LONG",  "BASE",  "LONG",  longUser,  longKc),
        LONG_HEDGE:  await buildLeg("LONG_HEDGE",  "LONG",  "HEDGE", "SHORT", longUser,  longKc),
        SHORT_BASE:  await buildLeg("SHORT_BASE",  "SHORT", "BASE",  "SHORT", shortUser, shortKc),
        SHORT_HEDGE: await buildLeg("SHORT_HEDGE", "SHORT", "HEDGE", "LONG",  shortUser, shortKc),
    };
    const L = Object.values(legs);
    const token = legs.LONG_BASE.context.token;
    for (const l of L) if (l.context.token !== token) fail(`legs resolved to different contracts (${l.context.symbol} vs ${legs.LONG_BASE.context.symbol}) — pin one contract`);
    console.log(c.bold(`PRICE MA HEDGE  ${legs.LONG_BASE.context.symbol}  LONG:${longUser.name} (${legs.LONG_BASE.context.lots} lot)  SHORT:${shortUser.name} (${legs.SHORT_BASE.context.lots} lot)  base ${hhmm(baseHour, baseMinute)}  EOD ${hhmm(eodHour, eodMinute)}  minSlope ${MIN_SLOPE}  confirm ${CONFIRM}m`));

    // ── prices ────────────────────────────────────────────────────────────────────────────────────
    let lastTick = null;   // { price, at }
    async function getLtp() {
        if (lastTick && Date.now() - lastTick.at < 15000) return lastTick.price;
        const d = await longKc.getLTP([legs.LONG_BASE.ltpKey]);
        return d[legs.LONG_BASE.ltpKey]?.last_price ?? null;
    }

    // ── order placement with FILL CONFIRMATION ────────────────────────────────────────────────────
    // A submitted order is not a fill. Poll the order history until COMPLETE / REJECTED / CANCELLED; on timeout cancel the
    // unfilled remainder (never an already-filled position) and report what actually filled.
    const lastOf = h => (h && h.length ? h[h.length - 1] : null);
    async function confirmFill(leg, orderId, wantLots) {
        let last = null;
        for (let i = 0; i < 20; i++) {
            await sleep(1000);
            try { last = lastOf(await leg.kc.getOrderHistory(orderId)); } catch (e) { console.warn(`[${leg.key}] order status check failed: ${e.message}`); continue; }
            if (!last) continue;
            if (last.status === "COMPLETE") return { status: "FILLED", filled: Number(last.filled_quantity) || wantLots, price: Number(last.average_price) || null };
            if (last.status === "REJECTED" || last.status === "CANCELLED") return { status: "REJECTED", filled: Number(last.filled_quantity) || 0, price: Number(last.average_price) || null, why: last.status_message || last.status };
        }
        try { await leg.kc.cancelOrder("regular", orderId); } catch { /* it may have completed meanwhile — re-read below */ }
        await sleep(1000);
        try { last = lastOf(await leg.kc.getOrderHistory(orderId)) || last; } catch { /* keep last */ }
        const filled = Number(last && last.filled_quantity) || 0;
        const price = Number(last && last.average_price) || null;
        if (last && last.status === "COMPLETE") return { status: "FILLED", filled: filled || wantLots, price };
        if (filled > 0 && filled < wantLots) return { status: "PARTIAL", filled, price };
        if (filled >= wantLots) return { status: "FILLED", filled, price };
        return { status: "NOT_FILLED", filled: 0, price: null, why: last ? last.status : "UNKNOWN" };
    }

    function notify(leg, msg, warn) {
        console.log((warn ? c.red : c.bold)(`[${leg.context.tgPrefix}] ${msg}`));
        leg.tg(`${warn ? "⚠ " : ""}[${leg.context.tgPrefix}] ${msg}`);
    }

    const broker = {
        async enter(leg, why) {
            const lots = leg.context.lots;
            let price = null, filled = lots;
            if (LIVE) {
                const id = await leg.orders.enter(leg.side);
                if (id === null) { notify(leg, `${leg.kind} ${leg.side} entry order NOT placed (${why}) — will retry`, true); return false; }
                tag("HEDGE_CONTROLLER", `${leg.key} ${leg.side} ${leg.product} OrderID=${id} placed (${why})`);
                const r = await confirmFill(leg, id, lots);
                if (r.status === "REJECTED" || r.status === "NOT_FILLED") { notify(leg, `entry ${r.status} OrderID=${id} (${r.why || ""}) — no position, will retry`, true); return false; }
                if (r.status === "PARTIAL") { notify(leg, `entry PARTIAL ${r.filled}/${lots} lots OrderID=${id} — remainder cancelled, managing ${r.filled} lot(s)`, true); leg.context.lots = r.filled; }
                filled = r.filled; price = r.price;
                tag("HEDGE_CONTROLLER", `${leg.key} FILLED ${filled} lot(s) @ ${price ?? "n/a"} OrderID=${id}`);
            }
            if (price === null) price = (await getLtp().catch(() => null)) || 0;
            leg.state.position = leg.side; leg.state.entryPrice = price;
            leg.state.openTradeId = await leg.db.insertOpenTrade(leg.context.tgPrefix, leg.context.symbol, leg.side, leg.context.lots, price);
            leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, leg.side, price, `PMA_${leg.kind}`);
            tag("HEDGE_CONTROLLER", `${leg.key} HedgeStatus=ACTIVE ${leg.side} ${leg.product} @ ${price.toFixed(2)} (${why})`);
            leg.tg(`${leg.kind} ${leg.side} ${leg.product} ENTER (${why}) @ ₹${price.toFixed(2)}`);
            emitEvent(leg.context.tgPrefix, "ENTRY", { side: leg.side, price, trail: null });
            persistState();
            return true;
        },
        async exit(leg, why) {
            if (!leg.state.position) return true;
            const side = leg.state.position;
            let price = null;
            if (LIVE) {
                const id = await leg.orders.exit(side, { awaitFill: false });
                if (id === null) { notify(leg, `${side} exit order NOT placed (${why}) — position left open, will retry`, true); return false; }
                tag("HEDGE_CONTROLLER", `${leg.key} exit OrderID=${id} placed (${why})`);
                const r = await confirmFill(leg, id, leg.context.lots);
                if (r.status === "PARTIAL") { const left = leg.context.lots - r.filled; notify(leg, `exit PARTIAL ${r.filled}/${leg.context.lots} OrderID=${id} — ${left} lot(s) still open, will retry (P&L of the partial part is not booked)`, true); leg.context.lots = left; return false; }
                if (r.status !== "FILLED") {   // confirm against the broker before giving up: the exit may have completed unnoticed
                    const q = qtyOf(await fetchNet(leg.kc).catch(() => [{ tradingsymbol: leg.context.symbol, exchange: leg.context.exchange, product: leg.product, quantity: NaN }]), leg);
                    if (q !== 0) { notify(leg, `exit ${r.status} OrderID=${id} (${r.why || ""}) — broker still shows ${q} lots, will retry`, true); return false; }
                    tag("RECOVERY", `${leg.key}: exit unconfirmed by the order book but broker position is flat — booking as closed`);
                }
                price = r.price;
            }
            if (price === null) price = (await getLtp().catch(() => null)) ?? leg.state.entryPrice;
            await positions.close(leg.context, leg.state, leg.db, leg.tg, price, why);
            leg.db.savePosition(leg.context.tgPrefix, leg.context.token, leg.context.symbol, null, 0);
            leg.context.lots = leg.configuredLots;
            tag("HEDGE_CONTROLLER", `${leg.key} HedgeStatus=CLOSED ${side} (${why}) @ ${price.toFixed(2)}`);
            persistState();
            return true;
        },
    };

    // ── signal + controller ───────────────────────────────────────────────────────────────────────
    const clock = () => { const p = istParts(); return { today: todayIST(), hours: p.hours, minutes: p.minutes, nowMs: Date.now() }; };
    const signal = createPriceMaSignal({ minSlope: MIN_SLOPE, confirmMinutes: CONFIRM, maxGapMinutes: 2, log: m => console.log(c.yellow(m)) });
    const controller = createPriceMaHedgeController({ legs, broker, clock, baseHour, baseMinute, eodHour, eodMinute, maxSignalAgeMs: STALE_MS, log: m => console.log(c.cyan(m)) });

    const stateFile = path.join(require("./data/dbDir").DB_DIR, `pma_${legs.LONG_BASE.context.underlying || UNDERLYING}_${longUser.name}_${shortUser.name}.json`.replace(/[^A-Za-z0-9_.-]/g, "_"));
    function persistState() {
        try {
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            const hedge = controller.activeHedge();
            const body = { date: todayIST(), instrument: legs.LONG_BASE.context.symbol, longUser: longUser.name, shortUser: shortUser.name,
                signal: signal.getState(), controller: controller.getState(),
                hedge: hedge ? { account: hedge.account, direction: hedge.side, product: "NRML", lots: hedge.context.lots, status: "ACTIVE" } : null, savedAt: new Date().toISOString() };
            fs.writeFileSync(stateFile + ".tmp", JSON.stringify(body)); fs.renameSync(stateFile + ".tmp", stateFile);
        } catch (e) { console.warn(`state file write failed: ${e.message}`); }
    }
    try {   // restore (the DB rows + broker already decided which positions exist)
        const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (s.date === today0 && s.instrument === legs.LONG_BASE.context.symbol) {
            signal.restore(s.signal); controller.restore(s.controller);
            tag("RECOVERY", `controller state restored (signal ${s.signal && s.signal.signal || "none"}, hedge ${s.hedge ? s.hedge.account + " " + s.hedge.direction : "none"})`);
        }
    } catch { /* no / unreadable state file: start clean */ }
    // A base that exists after recovery was already entered today.
    for (const l of [legs.LONG_BASE, legs.SHORT_BASE]) if (l.state.position) controller.markBaseEntered(l, today0);

    function onMinute(ev) {
        const f = x => (x === null || x === undefined ? "-" : x.toFixed(2));
        const sl = ev.slope === null ? "-" : (ev.slope >= 0 ? "+" : "") + ev.slope.toFixed(2);
        console.log(c.bold(`[PRICE_MA] Instrument=${UNDERLYING} Ticks=${ev.n} CurrentMA=${f(ev.ma)} PreviousMA=${f(ev.prevMa)} Slope=${sl} Raw=${ev.raw || "BASELINE"} Signal=${ev.signal || "NONE"}`));
        if (ev.transition) console.log(c.bold(`[PRICE_MA] SIGNAL TRANSITION ${ev.from || "NONE"} -> ${ev.signal}`));
        if (ev.signal) controller.setSignal(ev.signal, Date.now());
        persistState();
    }
    const handle = evs => { for (const ev of evs) onMinute(ev); };

    const ticker = new KiteTicker({ api_key: longUser.apiKey, access_token: longUser.accessToken });
    ticker.connect();
    ticker.on("connect", () => { ticker.subscribe([token]); ticker.setMode(ticker.modeLTP, [token]); tag("WS", "connected"); });
    ticker.on("ticks", ticks => {                       // ticks ONLY feed the signal — no order is placed here
        for (const t of ticks) if (t.instrument_token === token && t.last_price) { lastTick = { price: t.last_price, at: Date.now() }; handle(signal.addTick(t.last_price, Date.now())); }
    });
    ticker.on("error", err => console.error(c.red(`WS  error: ${err && err.message ? err.message : err}`)));
    ticker.on("close", () => console.log(c.dim("WS  closed — signal goes stale after " + STALE_MS / 1000 + "s; no new hedge until fresh minutes arrive")));
    ticker.on("reconnect", n => console.log(c.dim(`WS  reconnect #${n}`)));
    ticker.on("noreconnect", async () => {
        console.error(c.red("WS  max reconnects — exiting so PM2 restarts (positions are recovered from the broker/DB on boot)"));
        try { await legs.LONG_BASE.tg("⚠ Price MA Hedge: market-data socket cannot reconnect — restarting. Open positions untouched."); } catch { /* best effort */ }
        process.exit(1);
    });
    setInterval(() => handle(signal.flush(Date.now())), 2000);   // close a minute even if no later tick arrives

    async function eodReportAndExit() {
        let total = 0; const lines = [];
        for (const l of L) { const r = await l.db.getRealizedPnlToday(l.context.tgPrefix).catch(() => 0); total += r; lines.push(`${l.key.padEnd(11)} (${l.user.name}) realized ${positions.pnlStr(r)} | ${l.state.position ? l.state.position + " still OPEN" : "flat"}`); }
        const report = `Price MA Hedge EOD (${LIVE ? "LIVE" : "PAPER"}) — ${todayIST()}\n${lines.join("\n")}\ntotal ${positions.pnlStr(total)}`;
        console.log(c.bold(report.replace(/\n/g, "   ")));
        await legs.LONG_BASE.tg(report);
        console.log(c.bold("*** NORMAL SHUTDOWN ***"));
        emitEvent(legs.LONG_BASE.context.tgPrefix, "SHUTDOWN", { pnl: total, trades: L.reduce((a, l) => a + (l.state.trades || 0), 0), positionLeftOpen: L.some(l => l.state.position) });
        setTimeout(() => process.exit(0), 2000);
    }

    let finished = false, lastBeat = 0;
    async function loop() {
        if (finished) return;
        try {
            const r = await controller.tick();
            if (r === "EOD_DONE") { finished = true; await eodReportAndExit(); return; }
            if (r === "EOD_PENDING") console.error(c.red("EOD flatten incomplete — retrying next poll"));
            if (Date.now() - lastBeat >= 15 * 60 * 1000) {
                lastBeat = Date.now();
                const px = await getLtp().catch(() => null);
                const pos = L.filter(l => l.state.position).map(l => `${l.key}:${l.state.position}@${l.state.entryPrice.toFixed(2)}`).join("  ") || "flat";
                console.log(c.dim(`[PMA] ${new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" })}  price ${px === null ? "-" : px.toFixed(2)}  ${pos}  signal ${signal.getSignal() || "none"}`));
                if (px !== null) for (const l of L) emitEvent(l.context.tgPrefix, "LTP", { price: px, uPnl: l.state.position ? positions.unrealised(l.context, l.state, px) : 0, session: l.state.pnl || 0, position: l.state.position || null });
            }
        } catch (err) { console.error(c.red(`PMA loop error: ${err.message}`)); }
    }
    await loop();
    setInterval(loop, POLL_MS);
}

main().catch(err => { console.error("BOOT FAILED", err); process.exit(1); });
process.on("uncaughtException", err => console.error("UNCAUGHT", err));
process.on("unhandledRejection", err => console.error("UNHANDLED", err));
