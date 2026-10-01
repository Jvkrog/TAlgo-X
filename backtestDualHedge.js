// backtestDualHedge.js — backtests dualHedgeEngine.js (dual-account hedging:
// ONE instrument, a LONG-only account + a SHORT-only account, both off the
// SAME Dynamic Step Band on range bars). See dualHedgeEngine.js's header for
// the live spec — this file is a bar-for-bar replay of that logic, not a
// strategies.js factory, for the same reason backtestHedgePair.js isn't one:
// two independent accounts' state machines can't be expressed as the
// single-position strategy factories backtestRun.js replays.
//
// WHAT IS SHARED WITH LIVE (so a backtest can't silently drift from it):
//   - contract/lotMult/band-step resolution: dualHedgeContext.js (the SAME
//     resolver dualHedgeEngine.js calls)
//   - signal: rangeBars.js makeRangeBars + rangeBandReader.js's DSB state
//     machine (createDsb — dsbFromBars is built on it, parity-tested), fed by
//     candlesToPoints() exactly like the live reader
//   - PnL math / close flow: positions.js; trade bookkeeping: backtestLedger.js
//
// REPLAY SHAPE — 1-minute candles are the clock (the live reader also builds
// its range bars from 1-minute history, and the live exit manager runs on a
// 1-second price feed, which 1-minute OHLC is the closest available stand-in
// for):
//   SIGNAL   Range bars are built once over ALL candles from a fixed anchor
//            (path-dependent — see rangeBandReader.js). The band colour "as
//            the live reader would have read it" at an evaluation is the DSB
//            state after the last range bar that COMPLETED in a minute
//            strictly before the evaluation's minute (live excludes the
//            still-forming minute). Bars are causal, so slicing one full
//            build by completion time == rebuilding from each prefix.
//   EVAL     :20 past every 15-minute IST mark from 09:15 (live trade_timer).
//            Minute granularity: the evaluation is treated as happening at
//            that minute's OPEN — fills/entries use the open (or, if that
//            minute has no candle (thin contracts), the previous candle's
//            close = the last traded price a live LTP would show). Nothing
//            is evaluated overnight / before 09:15, and not at start.
//   ENTRY    LONG leg: flat + band green -> LONG. SHORT leg: flat + band red
//            -> SHORT. Never the other side. White band = nothing.
//   FLIP     holding + band turns AGAINST the position at an evaluation ->
//            leg "flipped" (sticky until that position closes). NO exit of
//            any kind before a flip ("closing makes it losing trade").
//   EXITS    flipped legs only, checked along each candle's price path (the
//            same open -> low/high -> close unrolling the range bars use):
//              uPnL > +TAKE_PROFIT -> exit      uPnL < -MAX_LOSS -> exit
//            Fill = the exact threshold price when the path crosses it inside
//            a minute; the path point itself when it is already beyond the
//            threshold on arrival (an opening gap, or a leg that flips while
//            already deep underwater -> immediate exit at the open).
//   CARRY    NRML, NO EOD close (live has none). Whatever is open when the
//            data ends is marked-to-market closed (BACKTEST_END).
//   GAP CAPTURE (optional, DH_GAP_CAPTURE): at the first candle at/after the
//            gap time (default 23:20 IST) both legs realize any open
//            position and immediately enter LONG (long acct) / SHORT (short
//            acct) at that candle's open, carried overnight; band logic is
//            off for the rest of that day (live quits at 23:25 and is
//            restarted next morning — modeled as "running again by 09:15").
//
// MTM EQUITY — computeMetrics() only sees CLOSED trades, but this strategy
// can carry a leg for days with no exit rule at all (until it flips), so
// realized-only drawdown badly understates the risk. The replay therefore
// also tracks realized + unrealized equity per candle: the mtm block in the
// result (max drawdown on it, worst per-leg unrealized, a daily series for
// the chart) is the number that actually answers "could I have sat through
// this".
//
// KNOWN LIMITATIONS (same family as historicalFetch.js's):
//   - One instrument_token for the whole range — no stitching across contract
//     rolls; Kite also only serves minute data for contracts it still lists.
//   - Range bars + the DSB are path-dependent on the anchor. Live uses a fixed
//     anchor (2026-06-01 09:00 IST by default); a range starting before that
//     gets its own anchor (warm-up before `from`) and so can differ from what
//     live would have shown. Dates on/after the live anchor replay it exactly.
//   - Intra-minute ordering of ticks is assumed (open -> low/high -> close);
//     the :20-second offset inside a slot minute is collapsed to the minute.
//   - Margin, brokerage/taxes and order-fill latency are not modeled
//     (slippagePoints is an optional flat adverse fill penalty per order).
"use strict";

const { candlesToPoints, createDsb } = require("./rangeBandReader");
const { makeRangeBars } = require("./rangeBars");
const { createCsvRepository } = require("./csvRepository");
const { createInstrumentSource } = require("./instrumentSource");
const { createContractPinStore } = require("./contractPins");
const { resolveDualHedgeLeg } = require("./dualHedgeContext");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("./state");
const positions = require("./positions");
const { computeMetrics } = require("./backtestMetrics");
const { setEmitSuppressed } = require("./eventBridge");
const { buildDualHedgeReport, saveDualHedgeReport } = require("./backtestDualHedgeReport");
const engineConfig = require("./engineConfig");
const c = require("./c");

const LIVE_RANGE_START = "2026-06-01 09:00:00";   // dualHedgeEngine.js's default fixed anchor
const WARMUP_DAYS      = 14;                      // band/range-bar warm-up before `from` when the live anchor can't be used
const CHUNK_DAYS       = 55;                      // Kite caps 1-minute history at 60 days per request
const CHUNK_DELAY_MS   = 400;                     // stay under Kite's ~3 req/s historical-data limit
const SLOT_MINUTES     = 15;
const IST_MS           = 5.5 * 60 * 60 * 1000;
const EVAL_START_MIN   = 9 * 60 + 15;             // nothing is evaluated before 09:15 IST

const sleep    = ms => new Promise(r => setTimeout(r, ms));
const fmtIST   = ms => new Date(ms + IST_MS).toISOString().replace("T", " ").slice(0, 19);
const parseIST = str => Date.parse(String(str).trim().replace(" ", "T") + "+05:30");
const dayKeyIST = d => new Date(d.getTime() + IST_MS).toISOString().split("T")[0];
function istMinuteOfDay(ms) {
    const x = new Date(ms + IST_MS);
    return x.getUTCHours() * 60 + x.getUTCMinutes();
}
const hhmm = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const sgn  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);

// fetchMinuteCandles({ kc, token, fromMs, toMs }) — completed minutes only,
// chunked (see CHUNK_DAYS), sorted + de-duplicated. from/to are epoch ms;
// Kite gets IST wall-clock strings, same as rangeBandReader.js.
async function fetchMinuteCandles({ kc, token, fromMs, toMs, progress }) {
    const curMin = Math.floor(Date.now() / 60000) * 60000;   // the still-forming minute is never used
    const endMs  = Math.min(toMs, Date.now());
    const byTime = new Map();
    let cursor = fromMs, first = true, chunkNo = 0;
    const chunks = Math.max(1, Math.ceil((endMs - fromMs) / (CHUNK_DAYS * 86400000)));
    while (cursor < endMs) {
        if (!first) await sleep(CHUNK_DELAY_MS);
        first = false;
        const chunkEnd = Math.min(cursor + CHUNK_DAYS * 86400000, endMs);
        const part = await kc.getHistoricalData(token, "minute", fmtIST(cursor), fmtIST(chunkEnd));
        for (const b of part || []) {
            const date = new Date(b.date);
            const t = date.getTime();
            if (!(t < curMin) || Number.isNaN(t)) continue;
            byTime.set(t, {
                open: parseFloat(b.open), high: parseFloat(b.high),
                low:  parseFloat(b.low),  close: parseFloat(b.close),
                volume: b.volume, date,
            });
        }
        chunkNo++;
        if (progress) progress(`fetching 1m history ${chunkNo}/${chunks}`);
        if (chunkEnd >= endMs) break;
        cursor = chunkEnd;
    }
    return [...byTime.keys()].sort((a, b) => a - b).map(k => byTime.get(k));
}

// replayDualHedge — pure replay, no I/O (everything it needs is passed in, so
// it is testable without Kite). See the file header for the semantics.
async function replayDualHedge({
    longCtx, shortCtx, candles, bandStep, rangeSize, tradeFromMs,
    takeProfit = 3000, maxLoss = 3000,
    gapCapture = false, gc = { hour: 23, minute: 20, quitHour: 23, quitMinute: 25 },
    slippagePoints = 0, progress, verbose = true,
}) {
    if (!candles.length) throw new Error("replayDualHedge: no candles");
    const log  = verbose ? (...a) => console.log(...a) : () => {};
    const slip = Number(slippagePoints) || 0;
    const gcMin     = gc.hour * 60 + gc.minute;
    const gcQuitMin = gc.quitHour * 60 + gc.quitMinute;

    // ─── SIGNAL — range bars over everything, DSB colour after each bar, and
    // the minute each bar completed in (= the next bar's open time, because a
    // new bar is created at the very point that closes the previous one).
    const { bars, forming } = makeRangeBars(candlesToPoints(candles), rangeSize);
    const dsb = createDsb(bandStep);
    const colorAfter = new Array(bars.length);
    const doneMs     = new Array(bars.length);
    for (let k = 0; k < bars.length; k++) {
        dsb.push(bars[k]);
        colorAfter[k] = dsb.state().color;
        doneMs[k] = new Date(k + 1 < bars.length ? bars[k + 1].time : forming.time).getTime();
    }
    let barPtr = 0;
    // Latest band as a live read at an evaluation inside minute `slotMs` would
    // see it: only bars completed in minutes strictly before that minute.
    function bandAt(slotMs) {
        while (barPtr < bars.length && doneMs[barPtr] < slotMs) barPtr++;
        return barPtr === 0 ? null : { color: colorAfter[barPtr - 1], bars: barPtr };
    }

    // ─── LEGS
    const clockBox = { date: candles[0].date };
    const clock = { now: () => clockBox.date };
    const tg = () => {};
    function makeLeg(side, ctx) {
        const state = createState();
        state.flipped = false;
        return { side, ctx, state, ledger: createBacktestLedger({ clock }), wantEntry: false, mae: 0, flipTime: null, worstUPnL: 0 };
    }
    const long = makeLeg("LONG", longCtx);
    const short = makeLeg("SHORT", shortCtx);
    const legs = [long, short];
    const label = leg => leg.ctx.tgPrefix;

    const stats = {
        evaluations: 0, entries: { LONG: 0, SHORT: 0 }, flips: { LONG: 0, SHORT: 0 },
        exits: { takeProfit: 0, stopLoss: 0, gapRealize: 0, backtestEnd: 0 },
        gapCaptureDays: 0, gapCaptureSkippedDays: 0, missedSlotEvals: 0,
    };

    async function enterLeg(leg, rawPrice, reason) {
        const px = leg.side === "LONG" ? rawPrice + slip : rawPrice - slip;
        leg.state.position   = leg.side;
        leg.state.entryPrice = px;
        leg.state.flipped    = false;
        leg.state.openTradeId = await leg.ledger.insertOpenTrade(leg.ctx.tgPrefix, leg.ctx.symbol, leg.side, leg.ctx.lots, px);
        leg.ledger.savePosition(leg.ctx.tgPrefix, leg.ctx.token, leg.ctx.symbol, leg.side, px, `DUAL_HEDGE_${leg.side}`);
        leg.mae = 0; leg.flipTime = null;
        stats.entries[leg.side]++;
        log(`**${leg.side} ENTRY**`);
        log(c.green(`[${label(leg)}] ${leg.side} @ price ${px.toFixed(2)}  |  ${reason}`));
    }

    async function exitLeg(leg, rawPrice, reason, { noSlip = false } = {}) {
        if (!leg.state.position) return false;
        const side = leg.state.position;
        const adj  = noSlip ? 0 : slip;
        const px   = side === "LONG" ? rawPrice - adj : rawPrice + adj;
        const tradeId = leg.state.openTradeId;
        const wasFlipped = leg.state.flipped, flipTime = leg.flipTime, mae = leg.mae;
        log(`**${side} EXIT**`);
        await positions.close(leg.ctx, leg.state, leg.ledger, tg, px, reason);
        leg.ledger.savePosition(leg.ctx.tgPrefix, leg.ctx.token, leg.ctx.symbol, null, 0);
        // Per-trade extras the shared ledger doesn't know about (same objects
        // the ledger holds, so they flow into getAllTrades()).
        const t = leg.ledger.getAllTrades().find(x => x.id === tradeId);
        if (t) { t.mae = mae; t.flipped = wasFlipped; t.flip_time = flipTime; }
        leg.state.flipped = false; leg.mae = 0; leg.flipTime = null;
        return true;
    }

    const unreal = (leg, px) => leg.state.position ? positions.unrealised(leg.ctx, leg.state, px) : 0;
    const realizedTotal = () => long.state.pnl + short.state.pnl;

    // Exit manager for ONE leg across ONE candle's price path (live: every
    // second against the tick). Flipped legs only.
    async function manageLegPath(leg, pts) {
        for (let p = 0; p < pts.length; p++) {
            if (!leg.state.position) return;
            const px = pts[p].price;
            const u = unreal(leg, px);
            if (u < leg.mae) leg.mae = u;
            if (u < leg.worstUPnL) leg.worstUPnL = u;
            if (!leg.state.flipped) continue;   // no exit of any kind before a flip, by design

            const mult = leg.ctx.lotMult * leg.ctx.lots;
            const dir  = leg.state.position === "LONG" ? 1 : -1;
            let reason = null, thrPx = null;
            if (u > takeProfit)      { reason = `${leg.side} EXIT (take profit > ₹${takeProfit})`; thrPx = leg.state.entryPrice + dir * (takeProfit / mult); stats.exits.takeProfit++; }
            else if (u < -maxLoss)   { reason = `${leg.side} EXIT SL (loss > ₹${maxLoss})`;        thrPx = leg.state.entryPrice - dir * (maxLoss / mult);   stats.exits.stopLoss++; }
            if (!reason) continue;

            // Crossed inside the minute -> filled AT the threshold; already
            // beyond it on arrival (p === 0: opening gap / just-flipped
            // underwater leg) -> filled at the open.
            const fill = p === 0 ? px : thrPx;
            await exitLeg(leg, fill, reason);
            leg.wantEntry = false;   // sma_signal = 0 after an exit: needs a fresh favorable colour at a later evaluation
            return;
        }
    }

    // ─── MTM equity
    let peak = 0, maxDD = 0, troughEq = 0, peakAt = null, ddAt = null;
    const daily = [];
    function sampleEquity(price, date) {
        const eq = realizedTotal() + unreal(long, price) + unreal(short, price);
        if (eq > peak) { peak = eq; peakAt = date; }
        if (peak - eq > maxDD) { maxDD = peak - eq; ddAt = date; }
        if (eq < troughEq) troughEq = eq;
        return eq;
    }

    // ─── MAIN LOOP
    let prevCn = null, prevMs = -Infinity;
    let gcDoneDay = null, gcSkippedDay = null, lastDay = null;
    let lastClose = candles[candles.length - 1].close;
    const total = candles.length;

    for (let i = 0; i < candles.length; i++) {
        const cn = candles[i];
        const ms = cn.date.getTime();
        if (ms < tradeFromMs) { prevCn = cn; prevMs = ms; continue; }   // warm-up: signal history only
        clockBox.date = cn.date;
        const dayKey = dayKeyIST(cn.date);
        const minOfDay = istMinuteOfDay(ms);
        const sameDayPrev = prevCn && dayKeyIST(prevCn.date) === dayKey;
        if (lastDay !== dayKey) { lastDay = dayKey; log(); log(`**STARTING** ${dayKey}`); }

        // GAP CAPTURE — realize, then enter, at this candle's open.
        let gapActive = false;
        if (gapCapture && minOfDay >= gcMin && gcSkippedDay !== dayKey) {
            if (gcDoneDay !== dayKey) {
                if (minOfDay >= gcQuitMin) {
                    gcSkippedDay = dayKey; stats.gapCaptureSkippedDays++;   // window missed — band logic continues, as live
                    log(c.red(`GAP CAPTURE  no candle inside ${hhmm(gc.hour, gc.minute)}–${hhmm(gc.quitHour, gc.quitMinute)} IST on ${dayKey} — skipped, band logic continues`));
                } else {
                    log(); log("**GAP CAPTURE — REALIZING TODAY'S TRADES**");
                    for (const leg of legs) if (leg.state.position) { stats.exits.gapRealize++; await exitLeg(leg, cn.open, "GAP CAPTURE — REALIZE"); }
                    log("**GAP CAPTURE ENTRY**");
                    const reason = `gap capture ${hhmm(gc.hour, gc.minute)} IST (carry overnight)`;
                    await enterLeg(long, cn.open, reason);
                    await enterLeg(short, cn.open, reason);
                    for (const leg of legs) leg.wantEntry = false;
                    gcDoneDay = dayKey; stats.gapCaptureDays++;
                }
            }
            if (gcSkippedDay !== dayKey) gapActive = true;   // band logic + exit manager off for the rest of the day (live: gapWindowActive())
        }

        if (!gapActive) {
            // EVALUATION — the latest 15-minute mark in (prevMs, ms] on this IST day.
            const slotMs = Math.floor((ms + IST_MS) / (SLOT_MINUTES * 60000)) * (SLOT_MINUTES * 60000) - IST_MS;
            const slotMin = istMinuteOfDay(slotMs);
            const slotOk = slotMs > prevMs && dayKeyIST(new Date(slotMs)) === dayKey && slotMin >= EVAL_START_MIN
                        && (sameDayPrev || slotMs === ms);
            if (slotOk) {
                const slotPrice = slotMs === ms ? cn.open : prevCn.close;   // last traded price at the slot
                if (slotMs !== ms) stats.missedSlotEvals++;
                stats.evaluations++;
                const band = bandAt(slotMs);
                if (band) {
                    for (const leg of legs) {
                        const favorable = leg.side === "LONG" ? "green" : "red";
                        const adverse   = leg.side === "LONG" ? "red"   : "green";
                        if (!leg.state.position) {
                            if (band.color === favorable) leg.wantEntry = true;   // white/adverse while flat: nothing
                        } else if (!leg.state.flipped && band.color === adverse) {
                            leg.state.flipped = true;
                            leg.flipTime = cn.date.toISOString();
                            stats.flips[leg.side]++;
                            log(c.yellow(`[${label(leg)}] ${leg.side} FLIPPED (band ${band.color}) — exits now armed: take-profit > +₹${takeProfit}, stop < -₹${maxLoss}`));
                        }
                    }
                    // manager: entries armed by the evaluation fire right away
                    for (const leg of legs) {
                        if (!leg.state.position && leg.wantEntry) {
                            leg.wantEntry = false;
                            await enterLeg(leg, slotPrice, `band ${leg.side === "LONG" ? "green" : "red"}`);
                        }
                    }
                }
            }
            // EXIT MANAGER along this candle's price path
            const pts = candlesToPoints([cn]);
            for (const leg of legs) await manageLegPath(leg, pts);
        }

        // MTM sample at the candle close
        sampleEquity(cn.close, cn.date);
        const next = candles[i + 1];
        if (!next || dayKeyIST(next.date) !== dayKey) {
            const eq = realizedTotal() + unreal(long, cn.close) + unreal(short, cn.close);
            const fmtLeg = leg => leg.state.position ? `${leg.state.position}@${leg.state.entryPrice.toFixed(2)}${leg.state.flipped ? "*" : ""} ${sgn(unreal(leg, cn.close))}` : "flat";
            log(c.dim(`[DAY ${dayKey}] close ${cn.close.toFixed(2)}  long: ${fmtLeg(long)}  |  short: ${fmtLeg(short)}  |  realized ${sgn(realizedTotal())}  equity ${sgn(eq)}`));
            daily.push({
                day: dayKey, equity: eq, realized: realizedTotal(), unrealized: eq - realizedTotal(),
                long: long.state.position, short: short.state.position,
            });
        }
        lastClose = cn.close;
        prevCn = cn; prevMs = ms;
        if (progress && i % 2000 === 0) progress(i, total);
    }
    if (progress) progress(total, total);

    // Mark-to-market anything still open when the data ran out.
    for (const leg of legs) {
        if (leg.state.position) { stats.exits.backtestEnd++; await exitLeg(leg, lastClose, "BACKTEST_END", { noSlip: true }); }
    }

    const tag = (leg) => leg.ledger.getAllTrades().filter(t => new Date(t.entry_time).getTime() >= tradeFromMs).map(t => ({ ...t, leg: leg.side }));
    const longTrades = tag(long), shortTrades = tag(short);
    const trades = [...longTrades, ...shortTrades]
        .sort((a, b) => new Date(a.exit_time || a.entry_time) - new Date(b.exit_time || b.entry_time));

    return {
        longTrades, shortTrades, trades, stats,
        mtm: {
            finalEquity: realizedTotal(), peak, trough: troughEq, maxDrawdown: maxDD,
            maxDrawdownAt: ddAt ? ddAt.toISOString() : null,
            worstUnrealized: { LONG: long.worstUPnL, SHORT: short.worstUPnL },
            daily,
        },
        rangeBars: bars.length,
    };
}

// runDualHedgeBacktest({
//   underlying,                 // e.g. "NATGASMINI"
//   exchange = "MCX",
//   lots = 1, longLots, shortLots,
//   lotMultOverride,            // required unless context.js already has one
//   bandStepOverride, rangeSizeOverride,
//   rangeStart,                 // IST "YYYY-MM-DD HH:mm:ss"; default: the live anchor (or a warm-up before `from`)
//   takeProfit = 3000, maxLoss = 3000,
//   gapCapture = false, gcHour = 23, gcMinute = 20, gcQuitHour = 23, gcQuitMinute = 25,
//   slippagePoints = 0,
//   from, to,                   // Date objects (inclusive IST calendar days)
//   kc,                         // authenticated KiteConnect (market data only)
//   progress,                   // optional (done, total | message) => void
// })
async function runDualHedgeBacktest({
    underlying, exchange = "MCX", lots = 1, longLots, shortLots, lotMultOverride,
    bandStepOverride, rangeSizeOverride, rangeStart,
    takeProfit = 3000, maxLoss = 3000,
    gapCapture = false, gcHour = 23, gcMinute = 20, gcQuitHour = 23, gcQuitMinute = 25,
    slippagePoints = 0, from, to, kc, progress,
}) {
    for (const [name, v] of [["takeProfit", takeProfit], ["maxLoss", maxLoss]]) {
        if (!(Number(v) > 0)) throw new Error(`runDualHedgeBacktest: ${name} must be a positive number (got ${v})`);
    }
    if (!(Number(slippagePoints) >= 0)) throw new Error(`runDualHedgeBacktest: slippagePoints must be >= 0 (got ${slippagePoints})`);
    if (gapCapture && !(gcQuitHour * 60 + gcQuitMinute > gcHour * 60 + gcMinute)) {
        throw new Error(`runDualHedgeBacktest: gap capture quit time (${hhmm(gcQuitHour, gcQuitMinute)}) must be after the gap capture time (${hhmm(gcHour, gcMinute)})`);
    }

    const csvFilePath = exchange === "NSE" ? engineConfig.NSE_INSTRUMENT_CSV_PATH : engineConfig.INSTRUMENT_CSV_PATH;
    const csvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({ filePath: csvFilePath, kc, exchange }).fetchRows,
    });
    await csvRepo.load();
    const pinStore = createContractPinStore();

    const mkLeg = (side, n) => resolveDualHedgeLeg({
        underlying, side, userName: "BACKTEST", exchange, csvRepo, pinStore,
        lots: n, lotMultOverride, bandStepOverride,
    });
    const longLeg  = mkLeg("LONG",  Number(longLots)  || Number(lots) || 1);
    const shortLeg = mkLeg("SHORT", Number(shortLots) || Number(lots) || 1);

    const bandStep  = longLeg.context.bandStep ?? engineConfig.BAND_STEP_DEFAULT;
    const rangeSize = rangeSizeOverride ? Number(rangeSizeOverride) : bandStep;
    if (!(bandStep > 0) || !(rangeSize > 0)) throw new Error(`runDualHedgeBacktest: invalid band step (${bandStep}) / range size (${rangeSize})`);

    const fromMs = Date.parse(`${dayKeyIST(from)}T00:00:00+05:30`);
    const toMs   = Date.parse(`${dayKeyIST(to)}T23:59:59+05:30`);
    if (!(fromMs < toMs)) throw new Error("runDualHedgeBacktest: `from` must be before `to`");

    // Anchor: the live fixed anchor when the range starts on/after it (exact
    // live replay), else a warm-up window before `from`.
    let anchorMs, anchorNote;
    if (rangeStart) {
        anchorMs = parseIST(rangeStart);
        if (Number.isNaN(anchorMs)) throw new Error(`runDualHedgeBacktest: invalid rangeStart "${rangeStart}"`);
        anchorNote = "custom";
    } else if (fromMs >= parseIST(LIVE_RANGE_START)) {
        anchorMs = parseIST(LIVE_RANGE_START);
        anchorNote = "live anchor";
    } else {
        anchorMs = parseIST(`${dayKeyIST(new Date(fromMs - WARMUP_DAYS * 86400000))} 09:00:00`);
        anchorNote = `${WARMUP_DAYS}-day warm-up (range starts before the live anchor — not an exact live replay)`;
    }
    if (!(anchorMs < fromMs)) throw new Error(`runDualHedgeBacktest: range anchor (${fmtIST(anchorMs)}) must be before \`from\``);
    console.log(c.dim(`  range bars anchored ${fmtIST(anchorMs)} IST (${anchorNote})  step ${bandStep}  range ${rangeSize}`));

    const candles = await fetchMinuteCandles({ kc, token: longLeg.context.token, fromMs: anchorMs, toMs, progress });
    if (candles.length === 0) throw new Error("runDualHedgeBacktest: no 1-minute candles returned — check the date range, market holidays, and that Kite still lists this contract");
    if (!candles.some(cn => cn.date.getTime() >= fromMs)) throw new Error("runDualHedgeBacktest: no 1-minute candles inside the requested range");

    setEmitSuppressed(true);   // in-process backtest must not flood a live webdash log (see eventBridge.js)
    let res;
    try {
        res = await replayDualHedge({
            longCtx: longLeg.context, shortCtx: shortLeg.context, candles, bandStep, rangeSize, tradeFromMs: fromMs,
            takeProfit: Number(takeProfit), maxLoss: Number(maxLoss),
            gapCapture, gc: { hour: gcHour, minute: gcMinute, quitHour: gcQuitHour, quitMinute: gcQuitMinute },
            slippagePoints: Number(slippagePoints), progress,
        });
    } finally {
        setEmitSuppressed(false);
    }

    const metrics = {
        long:     computeMetrics(res.longTrades),
        short:    computeMetrics(res.shortTrades),
        combined: computeMetrics(res.trades),
    };
    const report = buildDualHedgeReport({
        underlying, symbol: longLeg.context.symbol, lotMult: longLeg.context.lotMult,
        longLots: longLeg.context.lots, shortLots: shortLeg.context.lots,
        params: {
            takeProfit: Number(takeProfit), maxLoss: Number(maxLoss), bandStep, rangeSize,
            rangeStart: fmtIST(anchorMs), anchor: anchorNote, slippagePoints: Number(slippagePoints),
            gapCapture: gapCapture ? { time: hhmm(gcHour, gcMinute), quit: hhmm(gcQuitHour, gcQuitMinute) } : null,
        },
        range: { from, to }, runAt: new Date(),
        metrics, mtm: res.mtm, stats: res.stats, trades: res.trades,
        meta: { candles: candles.length, rangeBars: res.rangeBars },
    });
    const paths = saveDualHedgeReport(report);
    return { report, paths };
}

module.exports = { runDualHedgeBacktest, replayDualHedge, fetchMinuteCandles };
