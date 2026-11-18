// backtestPriceMaHedge.js — replay of the Price-MA dual-account hedge (priceMaHedgeEngine.js) over 1-minute candles.
// It runs the SAME pure module the live engine runs (hedge/priceMaHedgeController.js), so the
// decisions are identical; only the broker (simulated fills) and the clock differ.
//
// WHAT IS APPROXIMATED — read this before trusting a result:
//   * Live checks each base's P&L once per IST minute at the latest tick. History has no ticks, so the check uses the
//     OPEN of each minute candle (the first price of the minute). Intra-minute excursions are not seen.
//   * Fills are instant and complete: no rejections / partial fills / margin, at that open +/- slippagePoints.
//     Brokerage, taxes and exchange charges are NOT deducted (every hedge open/close is an order; a base that hovers
//     around its entry price re-hedges often — set slippagePoints to see the cost direction).
// Everything else follows the live rules: bases once per day at the base time, a losing base is hedged by an opposite
// position (carry: NRML bases held, MIS hedge closed at EOD; day mode: MIS bases + NRML hedge, all flat at EOD), a day
// whose data ends before the EOD minute is closed at its last candle.
"use strict";

const { createPriceMaHedgeController } = require("../hedge/priceMaHedgeController");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("../core/state");
const positions = require("../core/positions");
const c = require("../utils/c");

const IST_MS = 5.5 * 60 * 60 * 1000;
const dayKeyIST = d => new Date(d.getTime() + IST_MS).toISOString().split("T")[0];
const minuteOfDay = ms => { const x = new Date(ms + IST_MS); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const sgn = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);

async function replayPriceMaHedge({
    longCtx, shortCtx, candles, tradeFromMs, hedgeLongCtx = null, hedgeShortCtx = null, hedgeCandles = null,   // hedge*Ctx/hedgeCandles: hedges on another contract (calendar spread)
    baseHour = 9, baseMinute = 15, eodHour = 23, eodMinute = 15,
    pnlBand = 0, pnlSmooth = 1, checkMinutes = 1, getDailyBias = null, carry = false,
    slippagePoints = 0, progress, verbose = true,
}) {
    if (!candles.length) throw new Error("replayPriceMaHedge: no candles");
    const log = verbose ? (...a) => console.log(...a) : () => {};
    const slip = Number(slippagePoints) || 0;

    const clockBox = { date: candles[0].date };
    const clock = { now: () => clockBox.date };
    const tg = () => {};
    const mk = (key, account, kind, side, ctx) => ({
        key, account, kind, side, ctx, context: ctx, blocked: false,
        state: createState(), ledger: createBacktestLedger({ clock }), mae: 0, worstUPnL: 0,
    });
    const legs = {
        LONG_BASE:   mk("LONG_BASE",   "LONG",  "BASE",  "LONG",  longCtx),
        LONG_HEDGE:  mk("LONG_HEDGE",  "LONG",  "HEDGE", "SHORT", hedgeLongCtx || longCtx),
        SHORT_BASE:  mk("SHORT_BASE",  "SHORT", "BASE",  "SHORT", shortCtx),
        SHORT_HEDGE: mk("SHORT_HEDGE", "SHORT", "HEDGE", "LONG",  hedgeShortCtx || shortCtx),
    };
    const L = Object.values(legs);
    const stats = {
        entries: { LONG: 0, SHORT: 0 }, baseEntries: 0, hedgeEntries: 0, hedgeExits: 0,
        signalMinutes: 0,
        exits: { eod: 0, backtestEnd: 0 },
    };

    const keepBases = carry && !getDailyBias;   // the daily-HA rule closes its NRML base at EOD too
    const SPLIT = !!(hedgeCandles && hedgeLongCtx);
    const hMap = new Map(SPLIT ? hedgeCandles.map(h => [h.date.getTime(), h]) : []);
    let hCur = null;                            // latest hedge-contract candle at or before the current minute
    let execPx = candles[0].open;               // fill reference for the minute being processed
    let hExec = null;                           // same, for the hedge contract
    const refPx = leg => (SPLIT && leg.kind === "HEDGE") ? hExec : execPx;
    async function enter(leg, why) {
        const rp = refPx(leg);
        if (!(rp > 0)) { log(c.dim(`[${leg.ctx.tgPrefix}] no ${leg.ctx.symbol} price yet — hedge entry waits`)); return false; }
        const px = leg.side === "LONG" ? rp + slip : rp - slip;
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
        const rp = refPx(leg), px = side === "LONG" ? rp - adj : rp + adj;
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

    let nowMs = candles[0].date.getTime();
    const controller = createPriceMaHedgeController({
        legs, broker, clock: () => ({ today: dayKeyIST(new Date(nowMs)), hours: Math.floor(minuteOfDay(nowMs) / 60), minutes: minuteOfDay(nowMs) % 60, nowMs }),
        baseHour, baseMinute, eodHour, eodMinute, maxPriceAgeMs: 150 * 1000, log: m => log(c.dim(m)),
        carry, pnlBand, pnlSmooth, checkMinutes, getDailyBias, getPrice: () => ({ price: execPx, atMs: nowMs }),   // the decision is taken at the minute's open
    });

    let lastClose = candles[candles.length - 1].close, hLastClose = null;
    const unreal = leg => leg.state.position ? positions.unrealised(leg.ctx, leg.state, (SPLIT && leg.kind === "HEDGE") ? (hLastClose ?? leg.state.entryPrice) : lastClose) : 0;
    const realized = () => L.reduce((a, l) => a + l.state.pnl, 0);
    let peak = 0, maxDD = 0, trough = 0, ddAt = null;
    const daily = [], series = [];   // series: per-account MTM equity (realized + unrealized) sampled every 15 minutes
    const acctEq = a => L.filter(l => l.account === a).reduce((s, l) => s + l.state.pnl + unreal(l), 0);
    let lastDay = null;
    const total = candles.length;

    for (let i = 0; i < candles.length; i++) {
        const cn = candles[i], ms = cn.date.getTime();
        if (ms < tradeFromMs) continue;
        clockBox.date = cn.date; nowMs = ms; execPx = cn.open; lastClose = cn.close;
        if (SPLIT) { hCur = hMap.get(ms) || hCur; hExec = hCur ? hCur.open : null; hLastClose = hCur ? hCur.close : hLastClose; }
        const dayKey = dayKeyIST(cn.date);
        if (lastDay !== dayKey) { lastDay = dayKey; log(); log(`**STARTING** ${dayKey}`); }

        stats.signalMinutes++;
        await controller.tick();

        const next = candles[i + 1];
        const dayEnds = !!next && dayKeyIST(next.date) !== dayKey;
        if (dayEnds || !next) {   // data for the day ends before the EOD minute: close at this candle's close (hedge first)
            execPx = cn.close; if (SPLIT && hCur) hExec = hCur.close;
            const open = L.filter(l => l.state.position && !(keepBases && l.kind === "BASE" && next)).sort((a, b) => (b.kind === "HEDGE") - (a.kind === "HEDGE"));
            if (open.length && next) { log("**EOD**"); for (const l of open) await exit(l, "EOD_FORCE"); }
        }
        for (const leg of L) {   // MAE / worst unrealized along the candle's path
            if (!leg.state.position) continue;
            const bar = (SPLIT && leg.kind === "HEDGE") ? hCur : cn;
            if (!bar) continue;
            for (const px of [bar.open, bar.low, bar.high, bar.close]) {
                const u = positions.unrealised(leg.ctx, leg.state, px);
                if (u < leg.mae) leg.mae = u; if (u < leg.worstUPnL) leg.worstUPnL = u;
            }
        }
        const eq = realized() + L.reduce((a, l) => a + unreal(l), 0);
        if (i % 15 === 0 || !next || dayEnds) series.push({ t: cn.date.toISOString(), long: acctEq("LONG"), short: acctEq("SHORT"), equity: eq });
        if (eq > peak) peak = eq; if (peak - eq > maxDD) { maxDD = peak - eq; ddAt = cn.date; } if (eq < trough) trough = eq;
        if (!next || dayEnds) {
            const fmt = l => l.state.position ? `${l.key} ${l.state.position}@${l.state.entryPrice.toFixed(2)}` : null;
            log(c.dim(`[DAY ${dayKey}] close ${cn.close.toFixed(2)}  open: ${L.map(fmt).filter(Boolean).join(", ") || "flat"}  |  realized ${sgn(realized())}  equity ${sgn(eq)}`));
            daily.push({ day: dayKey, equity: eq, realized: realized(), unrealized: eq - realized(), long: legs.LONG_BASE.state.position || legs.LONG_HEDGE.state.position, short: legs.SHORT_BASE.state.position || legs.SHORT_HEDGE.state.position });
            if (dayEnds) { controller.restore({ baseEnteredOn: {} }); continue; }   // a new day starts clean, like a fresh live process
        }
        if (progress && i % 2000 === 0) progress(i, total);
    }
    if (progress) progress(total, total);

    execPx = lastClose; if (SPLIT && hLastClose) hExec = hLastClose;
    for (const leg of L.sort((a, b) => (b.kind === "HEDGE") - (a.kind === "HEDGE"))) if (leg.state.position) { stats.exits.backtestEnd++; await exit(leg, "BACKTEST_END", { noSlip: true }); }

    const tag = leg => leg.ledger.getAllTrades().filter(t => new Date(t.entry_time).getTime() >= tradeFromMs).map(t => ({ ...t, leg: leg.account, role: leg.kind }));
    const longTrades = [legs.LONG_BASE, legs.LONG_HEDGE].flatMap(tag), shortTrades = [legs.SHORT_BASE, legs.SHORT_HEDGE].flatMap(tag);
    const trades = [...longTrades, ...shortTrades].sort((a, b) => new Date(a.exit_time || a.entry_time) - new Date(b.exit_time || b.entry_time));
    const worst = acct => L.filter(l => l.account === acct).reduce((a, l) => a + l.worstUPnL, 0);
    return {
        longTrades, shortTrades, trades, stats,
        mtm: { finalEquity: realized(), peak, trough, maxDrawdown: maxDD, maxDrawdownAt: ddAt ? ddAt.toISOString() : null, worstUnrealized: { LONG: worst("LONG"), SHORT: worst("SHORT") }, daily, series },
        signalBars: stats.signalMinutes, signalKind: (SPLIT ? `hedges on ${hedgeLongCtx.symbol} (calendar spread) \u00b7 ` : "") + (getDailyBias ? "daily HA colour: one NRML base + MIS hedge, all flat at EOD \u00b7 " : carry ? "NRML bases held, MIS hedge closed at EOD \u00b7 " : "") + `Base-loss hedge (band ${pnlBand} pts, smooth ${pnlSmooth}; decided every ${checkMinutes} min at the minute open)`,
    };
}

module.exports = { replayPriceMaHedge };
