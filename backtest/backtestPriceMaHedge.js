// backtestPriceMaHedge.js — replay of the Price-MA dual-account hedge (priceMaHedgeEngine.js) over 1-minute candles.
// It runs the SAME pure modules the live engine runs (hedge/priceMaSignal.js + hedge/priceMaHedgeController.js), so the
// decisions are identical; only the broker (simulated fills) and the clock differ.
//
// WHAT IS APPROXIMATED — read this before trusting a result:
//   * Live averages EVERY websocket LTP of the minute. History has no ticks, only the minute's OHLC, so each minute's
//     "tick average" is proxied by one value from the candle: ohlc4 (default) | hl2 | close. The true average is
//     unknowable; ohlc4 is an equal-weight average of four sample points of the minute. Slope SIGNS (and therefore GREEN /
//     RED flips) can differ from live — most of all on noisy minutes where consecutive proxies are within a tick of
//     each other. Run PAPER live to see the real flip rate.
//   * Decisions take effect at the OPEN of the minute after the one that produced the signal (live acts within one
//     decision-loop poll, 5 s, of the minute close, at LTP). Fills are at that open +/- slippagePoints.
//   * Fills are instant and complete: no rejections / partial fills / margin. Brokerage, taxes and the exchange charges
//     are NOT deducted (every colour flip is two orders per hedge — with a fresh flip every few minutes that cost is
//     large; set slippagePoints to see its direction).
//   * A signal minute needs a candle: minutes with no candle produce no MA (same as a minute with no ticks live).
// Everything else follows the live rules: bases once per day at the base time (MIS), the hedge only from GREEN/RED,
// NEUTRAL keeps the hedge, old hedge closed before the new one opens, EOD closes hedge then bases, a day whose data
// ends before the EOD minute is closed at its last candle.
"use strict";

const { createPriceMaSignal } = require("../hedge/priceMaSignal");
const { createPriceMaHedgeController } = require("../hedge/priceMaHedgeController");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("../core/state");
const positions = require("../core/positions");
const c = require("../utils/c");

const IST_MS = 5.5 * 60 * 60 * 1000;
const dayKeyIST = d => new Date(d.getTime() + IST_MS).toISOString().split("T")[0];
const minuteOfDay = ms => { const x = new Date(ms + IST_MS); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const sgn = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
const PROXIES = {
    ohlc4: b => (b.open + b.high + b.low + b.close) / 4,
    hl2:   b => (b.high + b.low) / 2,
    close: b => b.close,
};

async function replayPriceMaHedge({
    longCtx, shortCtx, candles, tradeFromMs,
    baseHour = 9, baseMinute = 15, eodHour = 23, eodMinute = 15,
    minSlope = 0, confirmMinutes = 1, maProxy = "ohlc4", hedgeMode = "SLOPE", pnlBand = 0, pnlSmooth = 1, carry = false,
    slippagePoints = 0, progress, verbose = true,
}) {
    if (!candles.length) throw new Error("replayPriceMaHedge: no candles");
    if (!PROXIES[maProxy]) throw new Error(`replayPriceMaHedge: maProxy must be one of ${Object.keys(PROXIES).join(", ")} (got ${maProxy})`);
    const proxy = PROXIES[maProxy];
    const log = verbose ? (...a) => console.log(...a) : () => {};
    const slip = Number(slippagePoints) || 0;
    const isPnl = String(hedgeMode).toUpperCase() === "PNL";

    const clockBox = { date: candles[0].date };
    const clock = { now: () => clockBox.date };
    const tg = () => {};
    const mk = (key, account, kind, side, ctx) => ({
        key, account, kind, side, ctx, context: ctx, blocked: false,
        state: createState(), ledger: createBacktestLedger({ clock }), mae: 0, worstUPnL: 0,
    });
    const legs = {
        LONG_BASE:   mk("LONG_BASE",   "LONG",  "BASE",  "LONG",  longCtx),
        LONG_HEDGE:  mk("LONG_HEDGE",  "LONG",  "HEDGE", "SHORT", longCtx),
        SHORT_BASE:  mk("SHORT_BASE",  "SHORT", "BASE",  "SHORT", shortCtx),
        SHORT_HEDGE: mk("SHORT_HEDGE", "SHORT", "HEDGE", "LONG",  shortCtx),
    };
    const L = Object.values(legs);
    const stats = {
        entries: { LONG: 0, SHORT: 0 }, baseEntries: 0, hedgeEntries: 0, hedgeExits: 0, colourFlips: 0,
        signalMinutes: 0, greenMinutes: 0, redMinutes: 0, neutralMinutes: 0, gapResets: 0,
        exits: { eod: 0, backtestEnd: 0 },
    };

    let execPx = candles[0].open;               // fill reference for the minute being processed
    async function enter(leg, why) {
        const px = leg.side === "LONG" ? execPx + slip : execPx - slip;
        leg.state.position = leg.side; leg.state.entryPrice = px;
        leg.state.openTradeId = await leg.ledger.insertOpenTrade(leg.ctx.tgPrefix, leg.ctx.symbol, leg.side, leg.ctx.lots, px);
        leg.ledger.savePosition(leg.ctx.tgPrefix, leg.ctx.token, leg.ctx.symbol, leg.side, px, `PMA_${leg.kind}`);
        leg.mae = 0;
        stats.entries[leg.side]++; if (leg.kind === "BASE") stats.baseEntries++; else stats.hedgeEntries++;
        log(`**${leg.kind} ${leg.side} ENTRY**`);
        log(c.green(`[${leg.ctx.tgPrefix}] ${leg.key} ${leg.side} ${leg.kind === "BASE" ? "MIS" : "NRML"} @ ${px.toFixed(2)}  |  ${why}`));
        return true;
    }
    async function exit(leg, why, { noSlip = false } = {}) {
        if (!leg.state.position) return true;
        const side = leg.state.position, adj = noSlip ? 0 : slip;
        const px = side === "LONG" ? execPx - adj : execPx + adj;
        const tradeId = leg.state.openTradeId, mae = leg.mae;
        log(`**${leg.kind} ${side} EXIT**`);
        await positions.close(leg.ctx, leg.state, leg.ledger, tg, px, why);
        leg.ledger.savePosition(leg.ctx.tgPrefix, leg.ctx.token, leg.ctx.symbol, null, 0);
        const t = leg.ledger.getAllTrades().find(x => x.id === tradeId);
        if (t) { t.mae = mae; t.flipped = false; t.flip_time = null; t.role = leg.kind; }
        leg.mae = 0;
        if (leg.kind === "HEDGE") stats.hedgeExits++;
        if (/^EOD/.test(why)) stats.exits.eod++;
        return true;
    }
    const broker = { enter: (leg, why) => enter(leg, why), exit: (leg, why) => exit(leg, why) };

    const newSignal = () => createPriceMaSignal({ minSlope, confirmMinutes, maxGapMinutes: 2, log: () => { stats.gapResets++; } });
    let sig = newSignal();
    let nowMs = candles[0].date.getTime();
    const controller = createPriceMaHedgeController({
        legs, broker, clock: () => ({ today: dayKeyIST(new Date(nowMs)), hours: Math.floor(minuteOfDay(nowMs) / 60), minutes: minuteOfDay(nowMs) % 60, nowMs }),
        baseHour, baseMinute, eodHour, eodMinute, maxSignalAgeMs: 150 * 1000, log: m => log(c.dim(m)),
        carry, hedgeMode, pnlBand, pnlSmooth, getPrice: () => ({ price: execPx, atMs: nowMs }),   // PNL mode: the decision is taken at the minute's open
    });

    const unreal = leg => leg.state.position ? positions.unrealised(leg.ctx, leg.state, lastClose) : 0;
    let lastClose = candles[candles.length - 1].close;
    const realized = () => L.reduce((a, l) => a + l.state.pnl, 0);
    let peak = 0, maxDD = 0, trough = 0, ddAt = null;
    const daily = [];
    let lastDay = null, prevCn = null, prevSignal = null;
    const total = candles.length;

    for (let i = 0; i < candles.length; i++) {
        const cn = candles[i], ms = cn.date.getTime();
        if (ms < tradeFromMs) { prevCn = cn; continue; }
        clockBox.date = cn.date; nowMs = ms; execPx = cn.open; lastClose = cn.close;
        const dayKey = dayKeyIST(cn.date);
        if (lastDay !== dayKey) { lastDay = dayKey; log(); log(`**STARTING** ${dayKey}`); }

        // The previous minute is complete: feed its tick-average proxy, close it, publish the signal, then decide.
        if (prevCn && !isPnl) {
            const pms = prevCn.date.getTime();
            for (const ev of [...sig.addTick(proxy(prevCn), pms), ...sig.flush(ms)]) {
                stats.signalMinutes++;
                if (ev.raw === "GREEN") stats.greenMinutes++; else if (ev.raw === "RED") stats.redMinutes++; else if (ev.raw === "NEUTRAL") stats.neutralMinutes++;
                if (ev.transition && ev.from) stats.colourFlips++;
                if (ev.transition) log(c.dim(`[PRICE_MA] ${dayKey} ${new Date(ms + IST_MS).toISOString().slice(11, 16)}  MA ${ev.ma.toFixed(2)} prev ${ev.prevMa === null ? "-" : ev.prevMa.toFixed(2)} slope ${ev.slope === null ? "-" : ev.slope.toFixed(2)} (n=1 proxy)  ${ev.from || "NONE"} -> ${ev.signal}`));
                if (ev.signal) controller.setSignal(ev.signal, ms);
                prevSignal = ev.signal;
            }
        }
        await controller.tick();

        const next = candles[i + 1];
        const dayEnds = !!next && dayKeyIST(next.date) !== dayKey;
        if (!carry && (dayEnds || !next)) {   // data for the day ends before the EOD minute: close at this candle's close (hedge first)
            execPx = cn.close;
            const open = L.filter(l => l.state.position).sort((a, b) => (b.kind === "HEDGE") - (a.kind === "HEDGE"));
            if (open.length && next) { log("**EOD**"); for (const l of open) await exit(l, "EOD_FORCE"); }
        }
        for (const leg of L) {   // MAE / worst unrealized along the candle's path
            if (!leg.state.position) continue;
            for (const px of [cn.open, cn.low, cn.high, cn.close]) {
                const u = positions.unrealised(leg.ctx, leg.state, px);
                if (u < leg.mae) leg.mae = u; if (u < leg.worstUPnL) leg.worstUPnL = u;
            }
        }
        const eq = realized() + L.reduce((a, l) => a + unreal(l), 0);
        if (eq > peak) peak = eq; if (peak - eq > maxDD) { maxDD = peak - eq; ddAt = cn.date; } if (eq < trough) trough = eq;
        if (!next || dayEnds) {
            const fmt = l => l.state.position ? `${l.key} ${l.state.position}@${l.state.entryPrice.toFixed(2)}` : null;
            log(c.dim(`[DAY ${dayKey}] close ${cn.close.toFixed(2)}  open: ${L.map(fmt).filter(Boolean).join(", ") || "flat"}  |  realized ${sgn(realized())}  equity ${sgn(eq)}`));
            daily.push({ day: dayKey, equity: eq, realized: realized(), unrealized: eq - realized(), long: legs.LONG_BASE.state.position || legs.LONG_HEDGE.state.position, short: legs.SHORT_BASE.state.position || legs.SHORT_HEDGE.state.position });
            if (dayEnds) { sig = newSignal(); controller.restore({ baseEnteredOn: {} }); prevCn = null; continue; }   // a new day starts clean, like a fresh live process
        }
        prevCn = cn;
        if (progress && i % 2000 === 0) progress(i, total);
    }
    if (progress) progress(total, total);

    execPx = lastClose;
    for (const leg of L.sort((a, b) => (b.kind === "HEDGE") - (a.kind === "HEDGE"))) if (leg.state.position) { stats.exits.backtestEnd++; await exit(leg, "BACKTEST_END", { noSlip: true }); }

    const tag = leg => leg.ledger.getAllTrades().filter(t => new Date(t.entry_time).getTime() >= tradeFromMs).map(t => ({ ...t, leg: leg.account, role: leg.kind }));
    const longTrades = [legs.LONG_BASE, legs.LONG_HEDGE].flatMap(tag), shortTrades = [legs.SHORT_BASE, legs.SHORT_HEDGE].flatMap(tag);
    const trades = [...longTrades, ...shortTrades].sort((a, b) => new Date(a.exit_time || a.entry_time) - new Date(b.exit_time || b.entry_time));
    const worst = acct => L.filter(l => l.account === acct).reduce((a, l) => a + l.worstUPnL, 0);
    return {
        longTrades, shortTrades, trades, stats,
        mtm: { finalEquity: realized(), peak, trough, maxDrawdown: maxDD, maxDrawdownAt: ddAt ? ddAt.toISOString() : null, worstUnrealized: { LONG: worst("LONG"), SHORT: worst("SHORT") }, daily },
        signalBars: stats.signalMinutes, signalKind: (carry ? "NRML carry-overnight \u00b7 " : "") + (isPnl ? `Base-loss hedge (band ${pnlBand} pts, smooth ${pnlSmooth}; decided once a minute at the minute open)` : `Price MA (1m ${maProxy} proxy of the tick average)`),
    };
}

module.exports = { replayPriceMaHedge, PROXIES };
