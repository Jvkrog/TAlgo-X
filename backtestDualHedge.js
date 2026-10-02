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
// STRATEGY (strategy) — "DUAL" (default) or "BIAS". Everything above and below
// this block describes DUAL; BIAS is described under BIAS HEDGE further down.
//
// SIGNAL SOURCE (DUAL only; signalSource) — "RANGE" (default, = the live
// engine) or "HA".
//   RANGE  DSB colour on range bars, as above.
//   HA     Heikin-Ashi candle colour at haTimeframe (5m/15m/30m/1h/1d), the
//          same colour convention as haCandleReader.js (HA close > open =
//          green, < open = red, doji = no read -> the previous colour stands).
//          The HA bars are Kite's OWN historical bars at that timeframe
//          (historicalFetch.js — the same source haCandleReader.js uses live),
//          NOT rebuilt from the 1-minute candles; toHA() runs over them. The
//          live Dual Hedge engine has NO HA mode — this swaps ONLY the signal
//          feeding the identical entry / flip / exit logic, so the two sources
//          can be compared on the same data. A bar becomes visible once it
//          has fully closed (start + timeframe; the end of its IST day for
//          1d), like live dropping the forming bar. Warm-up mirrors
//          haCandleReader.js's lookback (15 days intraday, 90 for 1d) because
//          toHA() is path-dependent on its seed bar.
//
// BIAS HEDGE (strategy "BIAS") — the hedge-pair idea (hedgePairEngine.js)
// applied to the two same-instrument accounts. NOT a replay of anything the
// live Dual Hedge engine runs; a backtest-side strategy, built from the same
// parts the hedge pair uses (haCandleReader.js's HA convention,
// dynamicBandReader.js's band, hedgePairEngine.js's decide-once-per-day core).
//   BIAS    The latest COMPLETED daily HA candle strictly before today, read
//           once per day at/after entryHour:entryMinute IST (default 10:00,
//           the hedge pair's): green -> the LONG account takes the CORE
//           position, red -> the SHORT account does. Decided ONCE per day
//           ("it remains const"); a doji or missing daily read means no core
//           that day. The core has no target and no stop.
//   HEDGE   While the core is open and the other account is flat: when the
//           Dynamic Band on bandTimeframe (default 15m — raw closes of Kite's
//           own 15m bars, dynamicBandReader.js's exact state machine, "no
//           white") is AGAINST the core (core LONG -> band red; core SHORT ->
//           band green), the OTHER account enters the opposite side. State-
//           based like live hedge pair: a band that is already adverse when
//           the core opens hedges straight away.
//   UNWIND  unwindMode BAND_FLIP (default): the band back in the core's favour
//           closes the hedge; it re-opens if the band turns adverse again.
//           EOD_ONLY: the hedge stays until EOD.
//   EOD     Both accounts force-closed every day (hedge first), at the EOD
//           time for bandTimeframe (context.js defaultEodFor: 23:15 for 15m,
//           23:00 for 30m/1h) — no overnight carry, no gap capture, and
//           takeProfit/maxLoss do not apply (same as the hedge pair).
//   FILLS   1-minute candles are the clock: a bar's colour is visible from the
//           first minute that starts at/after its end; entries/exits fill at
//           that minute's open (EOD on the day's last candle if it comes
//           before the EOD time: that candle's close).
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
const { toHA } = require("./indicators");
const { fetchHistoricalCandles, fetchDailyCandles } = require("./historicalFetch");
const { createBandStepper } = require("./dynamicBandReader");
const { defaultEodFor } = require("./context");
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
// Native Kite timeframes the HA signal can use (historicalFetch.js: 5m/15m/30m/1h
// intraday, fetchDailyCandles for 1d) -> bar length in minutes (null = one IST day).
const HA_TIMEFRAMES   = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "1d": null };
const HA_WARMUP_DAYS  = tf => (tf === "1d" ? 90 : 15);   // haCandleReader.js's LOOKBACK_DAYS
// BIAS strategy: the band timeframes dynamicBandReader.js can read (+ 5m/30m that
// historicalFetch.js serves) and its lookback; daily bias warm-up is haCandleReader.js's 90.
const BAND_TIMEFRAMES = { "5m": 5, "15m": 15, "30m": 30, "1h": 60 };
const BAND_WARMUP_DAYS = tf => (tf === "1h" ? 15 : 7);   // dynamicBandReader.js's LOOKBACK_DAYS
const DAILY_WARMUP_DAYS = 90;

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

// ─── SIGNAL BUILDERS — each returns { colorAfter[], doneMs[], count }: the band
// colour after bar k and the epoch-ms moment bar k became visible to a live read.
function buildRangeSignal(candles, bandStep, rangeSize) {
    const { bars, forming } = makeRangeBars(candlesToPoints(candles), rangeSize);
    const dsb = createDsb(bandStep);
    const colorAfter = new Array(bars.length);
    const doneMs     = new Array(bars.length);
    for (let k = 0; k < bars.length; k++) {
        dsb.push(bars[k]);
        colorAfter[k] = dsb.state().color;
        // bar k completed in the minute the next bar opened (a new bar is created
        // at the very point that closes the previous one)
        doneMs[k] = new Date(k + 1 < bars.length ? bars[k + 1].time : forming.time).getTime();
    }
    return { colorAfter, doneMs, count: bars.length, kind: "range bars" };
}

// Kite's own bars at a native timeframe (5m/15m/30m/1h, or 1d) via
// historicalFetch.js — completed-or-forming; visibility is decided later by
// barEndMs(), exactly like live dropping the still-forming bar.
async function fetchNativeBars({ kc, token, timeframe, fromMs, toMs }) {
    const from = new Date(fromMs), to = new Date(Math.min(toMs, Date.now()));
    return timeframe === "1d"
        ? fetchDailyCandles({ kc, token, from, to })
        : fetchHistoricalCandles({ kc, token, timeframe, from, to });
}

// The moment a native bar is fully closed: start + length (intraday), the end
// of its IST calendar day (1d).
function barEndMs(bar, timeframe) {
    const t = bar.date.getTime();
    if (timeframe === "1d") return Math.floor((t + IST_MS) / 86400000) * 86400000 - IST_MS + 86400000;
    return t + (HA_TIMEFRAMES[timeframe] ?? BAND_TIMEFRAMES[timeframe]) * 60000;
}

function haColor(b) { return b.close > b.open ? "green" : b.close < b.open ? "red" : null; }

function buildHaSignal(bars, tf) {
    if (!(tf in HA_TIMEFRAMES)) throw new Error(`HA timeframe "${tf}" not supported (known: ${Object.keys(HA_TIMEFRAMES).join(", ")})`);
    const ha = toHA(bars);   // bars are Kite's own at this timeframe, sorted + de-duped by historicalFetch.js
    const colorAfter = new Array(ha.length);
    const doneMs     = new Array(ha.length);
    let last = null;   // doji = no read this bar, previous colour stands
    for (let k = 0; k < ha.length; k++) {
        const col = haColor(ha[k]);
        if (col) last = col;
        colorAfter[k] = last;   // null until the first non-doji bar
        doneMs[k] = barEndMs(bars[k], tf);
    }
    return { colorAfter, doneMs, count: ha.length, kind: `HA ${tf} candles (historical)` };
}

// Dynamic Band colour (dynamicBandReader.js's state machine, via its stepper)
// after each native bar, plus when that bar became visible. Raw closes, no HA.
function buildBandSignal(bars, tf, step) {
    const stepper = createBandStepper(step);
    const colorAfter = new Array(bars.length);
    const doneMs     = new Array(bars.length);
    for (let k = 0; k < bars.length; k++) {
        stepper.push(bars[k]);
        colorAfter[k] = stepper.state().color;
        doneMs[k] = barEndMs(bars[k], tf);
    }
    return { colorAfter, doneMs, count: bars.length, kind: `${tf} Dynamic Band (step ${step})` };
}

// createLegKit — the two accounts' bookkeeping shared by both strategies:
// per-leg state + ledger on a shared replay clock, slippage-aware entry/exit
// that routes through positions.close() (same PnL math + close flow as live),
// per-trade MAE/flipped/role extras, and the mark-to-market equity tracker.
function createLegKit({ longCtx, shortCtx, startDate, slip, log, stats }) {
    const clockBox = { date: startDate };
    const clock = { now: () => clockBox.date };
    const tg = () => {};
    function makeLeg(side, ctx) {
        const state = createState();
        state.flipped = false;
        return { side, ctx, state, ledger: createBacktestLedger({ clock }), wantEntry: false, mae: 0, flipTime: null, worstUPnL: 0, role: null };
    }
    const long = makeLeg("LONG", longCtx);
    const short = makeLeg("SHORT", shortCtx);
    const legs = [long, short];
    const label = leg => leg.ctx.tgPrefix;

    async function enterLeg(leg, rawPrice, reason, role = null) {
        const px = leg.side === "LONG" ? rawPrice + slip : rawPrice - slip;
        leg.state.position   = leg.side;
        leg.state.entryPrice = px;
        leg.state.flipped    = false;
        leg.state.openTradeId = await leg.ledger.insertOpenTrade(leg.ctx.tgPrefix, leg.ctx.symbol, leg.side, leg.ctx.lots, px);
        leg.ledger.savePosition(leg.ctx.tgPrefix, leg.ctx.token, leg.ctx.symbol, leg.side, px, `DUAL_HEDGE_${leg.side}`);
        leg.mae = 0; leg.flipTime = null; leg.role = role;
        stats.entries[leg.side]++;
        log(`**${role ? role + " " : ""}${leg.side} ENTRY**`);
        log(c.green(`[${label(leg)}] ${leg.side} @ price ${px.toFixed(2)}  |  ${reason}`));
    }

    async function exitLeg(leg, rawPrice, reason, { noSlip = false } = {}) {
        if (!leg.state.position) return false;
        const side = leg.state.position;
        const adj  = noSlip ? 0 : slip;
        const px   = side === "LONG" ? rawPrice - adj : rawPrice + adj;
        const tradeId = leg.state.openTradeId;
        const wasFlipped = leg.state.flipped, flipTime = leg.flipTime, mae = leg.mae, role = leg.role;
        log(`**${role ? role + " " : ""}${side} EXIT**`);
        await positions.close(leg.ctx, leg.state, leg.ledger, tg, px, reason);
        leg.ledger.savePosition(leg.ctx.tgPrefix, leg.ctx.token, leg.ctx.symbol, null, 0);
        // Per-trade extras the shared ledger doesn't know about (same objects
        // the ledger holds, so they flow into getAllTrades()).
        const t = leg.ledger.getAllTrades().find(x => x.id === tradeId);
        if (t) { t.mae = mae; t.flipped = wasFlipped; t.flip_time = flipTime; t.role = role; }
        leg.state.flipped = false; leg.mae = 0; leg.flipTime = null; leg.role = null;
        return true;
    }

    const unreal = (leg, px) => leg.state.position ? positions.unrealised(leg.ctx, leg.state, px) : 0;
    const realizedTotal = () => long.state.pnl + short.state.pnl;

    // MTM equity: realized + unrealized, sampled by the caller.
    let peak = 0, maxDD = 0, troughEq = 0, ddAt = null;
    function sampleEquity(price, date) {
        const eq = realizedTotal() + unreal(long, price) + unreal(short, price);
        if (eq > peak) peak = eq;
        if (peak - eq > maxDD) { maxDD = peak - eq; ddAt = date; }
        if (eq < troughEq) troughEq = eq;
        return eq;
    }
    const mtmResult = daily => ({
        finalEquity: realizedTotal(), peak, trough: troughEq, maxDrawdown: maxDD,
        maxDrawdownAt: ddAt ? ddAt.toISOString() : null,
        worstUnrealized: { LONG: long.worstUPnL, SHORT: short.worstUPnL },
        daily,
    });
    const tradesFrom = (tradeFromMs) => {
        const tag = leg => leg.ledger.getAllTrades().filter(t => new Date(t.entry_time).getTime() >= tradeFromMs).map(t => ({ ...t, leg: leg.side }));
        const longTrades = tag(long), shortTrades = tag(short);
        const trades = [...longTrades, ...shortTrades]
            .sort((a, b) => new Date(a.exit_time || a.entry_time) - new Date(b.exit_time || b.entry_time));
        return { longTrades, shortTrades, trades };
    };

    return { clockBox, long, short, legs, label, enterLeg, exitLeg, unreal, realizedTotal, sampleEquity, mtmResult, tradesFrom };
}

// replayDualHedge — pure replay, no I/O (everything it needs is passed in, so
// it is testable without Kite). See the file header for the semantics.
async function replayDualHedge({
    longCtx, shortCtx, candles, bandStep, rangeSize, tradeFromMs,
    signalSource = "RANGE", haTimeframe = "1h", haBars = null,   // haBars: Kite's own bars at haTimeframe (HA only)
    takeProfit = 3000, maxLoss = 3000,
    gapCapture = false, gc = { hour: 23, minute: 20, quitHour: 23, quitMinute: 25 },
    slippagePoints = 0, progress, verbose = true,
}) {
    if (!candles.length) throw new Error("replayDualHedge: no candles");
    if (signalSource === "HA" && !(haBars && haBars.length)) throw new Error("replayDualHedge: HA signal needs haBars (Kite's historical bars at haTimeframe)");
    const log  = verbose ? (...a) => console.log(...a) : () => {};
    const slip = Number(slippagePoints) || 0;
    const gcMin     = gc.hour * 60 + gc.minute;
    const gcQuitMin = gc.quitHour * 60 + gc.quitMinute;

    // ─── SIGNAL — built once over everything (path-dependent), then sliced by
    // visibility time. Bars are causal, so slicing one full build by completion
    // time == rebuilding from each prefix.
    const sig = signalSource === "HA" ? buildHaSignal(haBars, haTimeframe)
              : signalSource === "RANGE" ? buildRangeSignal(candles, bandStep, rangeSize)
              : (() => { throw new Error(`replayDualHedge: unknown signalSource "${signalSource}" (RANGE or HA)`); })();
    const { colorAfter, doneMs } = sig;
    let barPtr = 0;
    // Latest colour as a live read at an evaluation inside minute `slotMs` would
    // see it: only bars fully closed by the start of that minute. (Range bars:
    // completed in a minute strictly before it; HA bars: end boundary <= it —
    // the same thing, since a bar's last minute is its end minus one.)
    function bandAt(slotMs) {
        while (barPtr < colorAfter.length && (signalSource === "HA" ? doneMs[barPtr] <= slotMs : doneMs[barPtr] < slotMs)) barPtr++;
        if (barPtr === 0 || colorAfter[barPtr - 1] === null) return null;
        return { color: colorAfter[barPtr - 1], bars: barPtr };
    }

    // ─── LEGS (shared kit)
    const stats = {
        evaluations: 0, entries: { LONG: 0, SHORT: 0 }, flips: { LONG: 0, SHORT: 0 },
        exits: { takeProfit: 0, stopLoss: 0, gapRealize: 0, backtestEnd: 0 },
        gapCaptureDays: 0, gapCaptureSkippedDays: 0, missedSlotEvals: 0,
    };
    const kit = createLegKit({ longCtx, shortCtx, startDate: candles[0].date, slip, log, stats });
    const { clockBox, long, short, legs, label, enterLeg, exitLeg, unreal, realizedTotal, sampleEquity } = kit;

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

    const daily = [];

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

    const { longTrades, shortTrades, trades } = kit.tradesFrom(tradeFromMs);

    return {
        longTrades, shortTrades, trades, stats,
        mtm: kit.mtmResult(daily),
        signalBars: sig.count, signalKind: sig.kind,
    };
}

// replayBiasHedge — pure replay of the BIAS HEDGE strategy (see the file header),
// no I/O. dailyBars / bandBars are Kite's own historical bars (raw OHLC,
// sorted) at 1d and bandTimeframe; candles are the 1-minute clock.
async function replayBiasHedge({
    longCtx, shortCtx, candles, tradeFromMs,
    dailyBars, bandBars, bandStep, bandTimeframe = "15m",
    unwindMode = "BAND_FLIP",
    entryHour = 10, entryMinute = 0, eodHour = 23, eodMinute = 15,
    slippagePoints = 0, progress, verbose = true,
}) {
    if (!candles.length) throw new Error("replayBiasHedge: no candles");
    if (!(dailyBars && dailyBars.length)) throw new Error("replayBiasHedge: no daily bars for the bias");
    if (!(bandBars && bandBars.length)) throw new Error("replayBiasHedge: no band bars");
    if (unwindMode !== "BAND_FLIP" && unwindMode !== "EOD_ONLY") throw new Error(`replayBiasHedge: unwindMode must be BAND_FLIP or EOD_ONLY (got ${unwindMode})`);
    const entryMin = entryHour * 60 + entryMinute, eodMin = eodHour * 60 + eodMinute;
    if (!(eodMin > entryMin)) throw new Error(`replayBiasHedge: EOD (${hhmm(eodHour, eodMinute)}) must be after the core entry time (${hhmm(entryHour, entryMinute)})`);
    const log  = verbose ? (...a) => console.log(...a) : () => {};
    const slip = Number(slippagePoints) || 0;

    // ─── SIGNALS — both built once over everything, then sliced by visibility.
    // BIAS: daily HA colour per IST day (doji = null = no read).
    const dailyHA = toHA(dailyBars).map(b => ({ dayKey: dayKeyIST(b.date), color: haColor(b) }));
    let dailyPtr = -1;
    function priorDailyColor(dayKey) {   // the last daily HA candle STRICTLY BEFORE this day (today's isn't closed yet)
        while (dailyPtr + 1 < dailyHA.length && dailyHA[dailyPtr + 1].dayKey < dayKey) dailyPtr++;
        return dailyPtr >= 0 ? dailyHA[dailyPtr].color : null;
    }
    // BAND: Dynamic Band colour after each native bar; visible once the bar has closed.
    const band = buildBandSignal(bandBars, bandTimeframe, bandStep);
    let bandPtr = 0;
    function bandColorAt(ms) {   // latest colour a live read at the start of minute `ms` would see
        while (bandPtr < band.count && band.doneMs[bandPtr] <= ms) bandPtr++;
        return bandPtr === 0 ? null : band.colorAfter[bandPtr - 1];
    }

    const stats = {
        entries: { LONG: 0, SHORT: 0 }, coreDays: { LONG: 0, SHORT: 0 },
        hedgeEntries: 0, hedgeUnwinds: 0, noBiasDays: 0,
        exits: { eod: 0, bandUnwind: 0, backtestEnd: 0 },
    };
    const kit = createLegKit({ longCtx, shortCtx, startDate: candles[0].date, slip, log, stats });
    const { clockBox, long, short, legs, label, enterLeg, exitLeg, unreal, realizedTotal, sampleEquity } = kit;

    const daily = [];
    let coreAcct = null, coreDecidedDay = null, noBiasNoted = null, lastDay = null;
    let lastClose = candles[candles.length - 1].close;
    const total = candles.length;

    for (let i = 0; i < candles.length; i++) {
        const cn = candles[i];
        const ms = cn.date.getTime();
        if (ms < tradeFromMs) continue;
        clockBox.date = cn.date;
        const dayKey = dayKeyIST(cn.date);
        const minOfDay = istMinuteOfDay(ms);
        const next = candles[i + 1];
        const dayEnds = !!next && dayKeyIST(next.date) !== dayKey;   // last candle of this IST day (not merely the end of the data)
        if (lastDay !== dayKey) { lastDay = dayKey; log(); log(`**STARTING** ${dayKey}`); }

        const pastEod = minOfDay >= eodMin;
        if (pastEod || dayEnds) {
            // EOD — both accounts, hedge first, every day, unconditionally. At the
            // EOD minute's open; if the day's data ends before it, at that last candle's close.
            if (legs.some(l => l.state.position)) {
                log("**EOD**");
                const px = pastEod ? cn.open : cn.close;
                for (const leg of [...legs].sort((a, b) => (b.role === "HEDGE") - (a.role === "HEDGE"))) {
                    if (leg.state.position) { stats.exits.eod++; await exitLeg(leg, px, "EOD_FORCE"); }
                }
            }
        } else {
            // CORE — decided ONCE per day, from the daily HA candle before today.
            if (minOfDay >= entryMin && coreDecidedDay !== dayKey) {
                const prior = priorDailyColor(dayKey);
                if (prior) {
                    coreDecidedDay = dayKey;
                    const side = prior === "green" ? "LONG" : "SHORT";
                    coreAcct = side === "LONG" ? long : short;
                    stats.coreDays[side]++;
                    await enterLeg(coreAcct, cn.open, `daily HA ${prior}`, "CORE");
                } else if (noBiasNoted !== dayKey) {
                    noBiasNoted = dayKey; stats.noBiasDays++;
                    log(c.yellow(`${dayKey}  no usable daily HA read (doji / no prior candle) — no core today, retrying until EOD`));
                }
            }
            // HEDGE — the OTHER account, against the core, off the band colour.
            if (coreAcct && coreAcct.state.position) {
                const col = bandColorAt(ms);
                if (col) {
                    const coreSide = coreAcct.state.position;
                    const hedgeAcct = coreSide === "LONG" ? short : long;
                    const adverse = coreSide === "LONG" ? col === "red" : col === "green";
                    if (!hedgeAcct.state.position && adverse) {
                        stats.hedgeEntries++;
                        await enterLeg(hedgeAcct, cn.open, `${bandTimeframe} band ${col} against ${coreSide} core`, "HEDGE");
                    } else if (hedgeAcct.state.position && unwindMode === "BAND_FLIP" && !adverse) {
                        stats.hedgeUnwinds++; stats.exits.bandUnwind++;
                        await exitLeg(hedgeAcct, cn.open, "BAND_FLIP_UNWIND");
                    }
                }
            }
        }

        // MAE / worst unrealized along this candle's price path, for whatever is open
        const pts = candlesToPoints([cn]);
        for (const leg of legs) {
            if (!leg.state.position) continue;
            for (const pt of pts) {
                const u = unreal(leg, pt.price);
                if (u < leg.mae) leg.mae = u;
                if (u < leg.worstUPnL) leg.worstUPnL = u;
            }
        }

        sampleEquity(cn.close, cn.date);
        if (!next || dayEnds) {
            const eq = realizedTotal() + unreal(long, cn.close) + unreal(short, cn.close);
            const fmtLeg = leg => leg.state.position ? `${leg.role || ""} ${leg.state.position}@${leg.state.entryPrice.toFixed(2)} ${sgn(unreal(leg, cn.close))}`.trim() : "flat";
            log(c.dim(`[DAY ${dayKey}] close ${cn.close.toFixed(2)}  long: ${fmtLeg(long)}  |  short: ${fmtLeg(short)}  |  realized ${sgn(realizedTotal())}  equity ${sgn(eq)}`));
            daily.push({
                day: dayKey, equity: eq, realized: realizedTotal(), unrealized: eq - realizedTotal(),
                long: long.state.position, short: short.state.position,
            });
            coreAcct = null;   // a new day decides afresh
        }
        lastClose = cn.close;
        if (progress && i % 2000 === 0) progress(i, total);
    }
    if (progress) progress(total, total);

    // Mark-to-market anything still open when the data ran out (a day cut off mid-session).
    for (const leg of [...legs].sort((a, b) => (b.role === "HEDGE") - (a.role === "HEDGE"))) {
        if (leg.state.position) { stats.exits.backtestEnd++; await exitLeg(leg, lastClose, "BACKTEST_END", { noSlip: true }); }
    }

    return {
        ...kit.tradesFrom(tradeFromMs), stats, mtm: kit.mtmResult(daily),
        signalBars: band.count, signalKind: `daily HA bias + ${band.kind}`,
    };
}

// runDualHedgeBacktest({
//   underlying,                 // e.g. "NATGASMINI"
//   exchange = "MCX",
//   lots = 1, longLots, shortLots,
//   lotMultOverride,            // required unless context.js already has one
//   strategy = "DUAL",          // "DUAL" (each account trades its own side off ONE signal; carries; TP/SL after a flip)
//                               // | "BIAS" (daily-HA-bias core + Dynamic-Band hedge in the other account; flat at EOD)
//   ── DUAL only ──
//   signalSource = "RANGE",     // "RANGE" (live engine) | "HA" (Kite's own HA bars)
//   haTimeframe = "1h",         // HA only: 5m | 15m | 30m | 1h | 1d
//   bandStepOverride, rangeSizeOverride,   // RANGE only (bandStepOverride also feeds BIAS's band)
//   rangeStart,                 // IST "YYYY-MM-DD HH:mm:ss"; default: RANGE -> the live anchor (or a warm-up before `from`); HA / BIAS band -> the live reader's lookback
//   takeProfit = 3000, maxLoss = 3000,
//   gapCapture = false, gcHour = 23, gcMinute = 20, gcQuitHour = 23, gcQuitMinute = 25,
//   ── BIAS only ──
//   bandTimeframe = "15m",      // 5m | 15m | 30m | 1h
//   unwindMode = "BAND_FLIP",   // "BAND_FLIP" | "EOD_ONLY"
//   entryHour = 10, entryMinute = 0,       // when the core is decided each day (IST)
//   eodHour, eodMinute,         // default: context.js defaultEodFor(bandTimeframe, exchange)
//   ──
//   slippagePoints = 0,
//   from, to,                   // Date objects (inclusive IST calendar days)
//   kc,                         // authenticated KiteConnect (market data only)
//   progress,                   // optional (done, total | message) => void
// })
async function runDualHedgeBacktest({
    underlying, exchange = "MCX", lots = 1, longLots, shortLots, lotMultOverride,
    strategy = "DUAL",
    bandStepOverride, rangeSizeOverride, rangeStart,
    signalSource = "RANGE", haTimeframe = "1h",
    bandTimeframe = "15m", unwindMode = "BAND_FLIP", entryHour = 10, entryMinute = 0, eodHour, eodMinute,
    takeProfit = 3000, maxLoss = 3000,
    gapCapture = false, gcHour = 23, gcMinute = 20, gcQuitHour = 23, gcQuitMinute = 25,
    slippagePoints = 0, from, to, kc, progress,
}) {
    strategy = String(strategy).toUpperCase();
    if (strategy !== "DUAL" && strategy !== "BIAS") throw new Error(`runDualHedgeBacktest: strategy must be DUAL or BIAS (got ${strategy})`);
    const isBias = strategy === "BIAS";
    signalSource = String(signalSource).toUpperCase();
    if (!isBias && signalSource !== "RANGE" && signalSource !== "HA") throw new Error(`runDualHedgeBacktest: signalSource must be RANGE or HA (got ${signalSource})`);
    if (!isBias && signalSource === "HA" && !(haTimeframe in HA_TIMEFRAMES)) throw new Error(`runDualHedgeBacktest: haTimeframe must be one of ${Object.keys(HA_TIMEFRAMES).join(", ")} (got ${haTimeframe})`);
    const isHA = !isBias && signalSource === "HA";
    if (!(Number(slippagePoints) >= 0)) throw new Error(`runDualHedgeBacktest: slippagePoints must be >= 0 (got ${slippagePoints})`);
    if (isBias) {
        unwindMode = String(unwindMode).toUpperCase();
        if (unwindMode !== "BAND_FLIP" && unwindMode !== "EOD_ONLY") throw new Error(`runDualHedgeBacktest: unwindMode must be BAND_FLIP or EOD_ONLY (got ${unwindMode})`);
        if (!(bandTimeframe in BAND_TIMEFRAMES)) throw new Error(`runDualHedgeBacktest: bandTimeframe must be one of ${Object.keys(BAND_TIMEFRAMES).join(", ")} (got ${bandTimeframe})`);
        if (gapCapture) throw new Error("runDualHedgeBacktest: gap capture isn't part of the BIAS strategy (it is flat at EOD, like the hedge pair)");
        const eod = defaultEodFor(bandTimeframe, exchange);
        eodHour   = eodHour   ?? eod.eodHour;
        eodMinute = eodMinute ?? eod.eodMinute;
    } else {
        for (const [name, v] of [["takeProfit", takeProfit], ["maxLoss", maxLoss]]) {
            if (!(Number(v) > 0)) throw new Error(`runDualHedgeBacktest: ${name} must be a positive number (got ${v})`);
        }
        if (gapCapture && !(gcQuitHour * 60 + gcQuitMinute > gcHour * 60 + gcMinute)) {
            throw new Error(`runDualHedgeBacktest: gap capture quit time (${hhmm(gcQuitHour, gcQuitMinute)}) must be after the gap capture time (${hhmm(gcHour, gcMinute)})`);
        }
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
    const token = longLeg.context.token;

    const bandStep  = longLeg.context.bandStep ?? engineConfig.BAND_STEP_DEFAULT;
    const rangeSize = rangeSizeOverride ? Number(rangeSizeOverride) : bandStep;
    if ((isBias || !isHA) && !(bandStep > 0)) throw new Error(`runDualHedgeBacktest: invalid band step (${bandStep})`);
    if (!isBias && !isHA && !(rangeSize > 0)) throw new Error(`runDualHedgeBacktest: invalid range size (${rangeSize})`);

    const fromMs = Date.parse(`${dayKeyIST(from)}T00:00:00+05:30`);
    const toMs   = Date.parse(`${dayKeyIST(to)}T23:59:59+05:30`);
    if (!(fromMs < toMs)) throw new Error("runDualHedgeBacktest: `from` must be before `to`");

    // Warm-up anchor helper: 09:00 IST, `days` before `from`.
    const warmAnchor = days => parseIST(`${dayKeyIST(new Date(fromMs - days * 86400000))} 09:00:00`);
    const customAnchor = () => {
        const ms = parseIST(rangeStart);
        if (Number.isNaN(ms)) throw new Error(`runDualHedgeBacktest: invalid rangeStart "${rangeStart}"`);
        return ms;
    };
    const noCandles = "runDualHedgeBacktest: no 1-minute candles returned — check the date range, market holidays, and that Kite still lists this contract";

    let res, params, anchorMs, anchorNote, candles;
    setEmitSuppressed(true);   // in-process backtest must not flood a live webdash log (see eventBridge.js)
    try {
        if (isBias) {
            // ─── BIAS: daily HA bias + Dynamic Band, both from Kite's own bars.
            anchorMs = rangeStart ? customAnchor() : warmAnchor(BAND_WARMUP_DAYS(bandTimeframe));
            anchorNote = rangeStart ? "custom" : `${BAND_WARMUP_DAYS(bandTimeframe)}-day warm-up (mirrors dynamicBandReader.js's lookback)`;
            const dailyAnchorMs = warmAnchor(DAILY_WARMUP_DAYS);
            if (!(anchorMs < fromMs)) throw new Error(`runDualHedgeBacktest: band anchor (${fmtIST(anchorMs)}) must be before \`from\``);
            console.log(c.dim(`  bias: daily HA (warm-up from ${fmtIST(dailyAnchorMs)} IST, ${DAILY_WARMUP_DAYS}d)  |  hedge: ${bandTimeframe} Dynamic Band step ${bandStep} (from ${fmtIST(anchorMs)} IST, ${anchorNote})  |  unwind ${unwindMode}  |  EOD ${hhmm(eodHour, eodMinute)} IST`));

            if (progress) progress("fetching daily bars");
            const dailyBars = await fetchNativeBars({ kc, token, timeframe: "1d", fromMs: dailyAnchorMs, toMs });
            if (dailyBars.length === 0) throw new Error("runDualHedgeBacktest: no daily bars returned — check the date range and that Kite still lists this contract");
            await sleep(CHUNK_DELAY_MS);
            if (progress) progress(`fetching ${bandTimeframe} bars`);
            const bandBars = await fetchNativeBars({ kc, token, timeframe: bandTimeframe, fromMs: anchorMs, toMs });
            if (bandBars.length === 0) throw new Error(`runDualHedgeBacktest: no ${bandTimeframe} bars returned — check the date range and market holidays`);
            await sleep(CHUNK_DELAY_MS);
            candles = await fetchMinuteCandles({ kc, token, fromMs, toMs, progress });
            if (candles.length === 0) throw new Error(noCandles);

            res = await replayBiasHedge({
                longCtx: longLeg.context, shortCtx: shortLeg.context, candles, tradeFromMs: fromMs,
                dailyBars, bandBars, bandStep, bandTimeframe, unwindMode,
                entryHour, entryMinute, eodHour, eodMinute,
                slippagePoints: Number(slippagePoints), progress,
            });
            params = {
                strategy: "BIAS", signal: `daily HA bias + ${bandTimeframe} band`, bandStep, bandTimeframe, unwindMode,
                entry: hhmm(entryHour, entryMinute), eod: hhmm(eodHour, eodMinute),
                rangeStart: fmtIST(anchorMs), anchor: anchorNote, slippagePoints: Number(slippagePoints),
                takeProfit: null, maxLoss: null, gapCapture: null,
            };
        } else {
            // ─── DUAL
            // Anchor. RANGE: the live fixed anchor when the range starts on/after it
            // (exact live replay), else a warm-up window before `from`. HA: the live HA
            // reader's own lookback before `from` (the live engine has no HA mode, so
            // there is no "exact live" anchor to match).
            const warmDays = isHA ? HA_WARMUP_DAYS(haTimeframe) : WARMUP_DAYS;
            if (rangeStart) {
                anchorMs = customAnchor();
                anchorNote = "custom";
            } else if (!isHA && fromMs >= parseIST(LIVE_RANGE_START)) {
                anchorMs = parseIST(LIVE_RANGE_START);
                anchorNote = "live anchor";
            } else {
                anchorMs = warmAnchor(warmDays);
                anchorNote = isHA
                    ? `${warmDays}-day warm-up (mirrors the live HA reader's lookback)`
                    : `${warmDays}-day warm-up (range starts before the live anchor — not an exact live replay)`;
            }
            if (!(anchorMs < fromMs)) throw new Error(`runDualHedgeBacktest: signal anchor (${fmtIST(anchorMs)}) must be before \`from\``);
            console.log(c.dim(isHA
                ? `  signal: HA ${haTimeframe} candles (Kite historical bars), warm-up from ${fmtIST(anchorMs)} IST (${anchorNote})`
                : `  range bars anchored ${fmtIST(anchorMs)} IST (${anchorNote})  step ${bandStep}  range ${rangeSize}`));

            let haBars = null;
            if (isHA) {
                if (progress) progress(`fetching ${haTimeframe} bars`);
                haBars = await fetchNativeBars({ kc, token, timeframe: haTimeframe, fromMs: anchorMs, toMs });
                if (haBars.length === 0) throw new Error(`runDualHedgeBacktest: no ${haTimeframe} bars returned — check the date range and market holidays`);
                await sleep(CHUNK_DELAY_MS);
            }
            // Range bars are built from the minute candles, so those need the warm-up;
            // HA reads Kite's own bars, so the minute clock only needs the range itself.
            candles = await fetchMinuteCandles({ kc, token, fromMs: isHA ? fromMs : anchorMs, toMs, progress });
            if (candles.length === 0) throw new Error(noCandles);
            if (!candles.some(cn => cn.date.getTime() >= fromMs)) throw new Error("runDualHedgeBacktest: no 1-minute candles inside the requested range");

            res = await replayDualHedge({
                longCtx: longLeg.context, shortCtx: shortLeg.context, candles, bandStep, rangeSize, tradeFromMs: fromMs,
                signalSource, haTimeframe, haBars,
                takeProfit: Number(takeProfit), maxLoss: Number(maxLoss),
                gapCapture, gc: { hour: gcHour, minute: gcMinute, quitHour: gcQuitHour, quitMinute: gcQuitMinute },
                slippagePoints: Number(slippagePoints), progress,
            });
            params = {
                strategy: "DUAL",
                takeProfit: Number(takeProfit), maxLoss: Number(maxLoss),
                signal: isHA ? `HA ${haTimeframe}` : "RANGE", bandStep: isHA ? null : bandStep, rangeSize: isHA ? null : rangeSize,
                rangeStart: fmtIST(anchorMs), anchor: anchorNote, slippagePoints: Number(slippagePoints),
                gapCapture: gapCapture ? { time: hhmm(gcHour, gcMinute), quit: hhmm(gcQuitHour, gcQuitMinute) } : null,
            };
        }
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
        params,
        range: { from, to }, runAt: new Date(),
        metrics, mtm: res.mtm, stats: res.stats, trades: res.trades,
        meta: { candles: candles.length, signalBars: res.signalBars, signalKind: res.signalKind },
    });
    const paths = saveDualHedgeReport(report);
    return { report, paths };
}

module.exports = { runDualHedgeBacktest, replayDualHedge, replayBiasHedge, fetchMinuteCandles, fetchNativeBars, buildHaSignal, buildBandSignal, barEndMs };
