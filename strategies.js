// strategies.js — Strategy registry + implementations.
//
// Each factory takes the exact same deps shape signals.js has always been
// handed (context, engineConfig, state, db, candles, slStore, orders,
// positionsClose, positionsUnrealised, lifecycle, tg) and returns
// { processCandle, initSignals }. signals.js is now a thin dispatcher that
// picks one of these by context.strategy and hands back its instance
// unchanged — engine.js, candlePoll.js, lifecycle.js need no changes.
"use strict";

const c = require("./c");
const {
    toHA, alma, atr, atrSeries, supertrend,
    adx, rsi, choppinessIndex, hmIndicator, dpi, getDPIState, sma, ema, adaptiveTrendEnvelope,
} = require("./indicators");
const { istParts } = require("./istTime");
const { evaluateMarketQuality } = require("./marketQuality");
const { emitEvent } = require("./eventBridge"); // web dashboard only, see eventBridge.js header

// ════════════════════════════════════════════════════════════════════════
// DPI_TREND_MEANREV (key name kept as-is for DB-filename/continuity reasons
// — db.js derives each instrument's SQLite filename from this key, so
// renaming it would silently orphan any live position's saved state) — as
// of this change, this is now PURE DPI TREND ONLY. The MEANREV regime that
// used to live in this function has been split out into its own strategy,
// DPI_MEANREV (see createDpiMeanrevStrategy below, registered as the last
// entry in STRATEGIES), which keeps the original combined TREND+MEANREV
// logic unchanged. This function no longer has any RSI-fade regime, no
// efficiency-based regime switch — everything below is the TREND half
// only. A resumed position is always positionSource "TREND", EXCEPT an
// orphaned pre-split MEANREV row (saved before this key stopped opening
// MEANREV trades) — initSignals() flattens that on boot instead of
// mislabeling it TREND, since this function no longer has any exit logic
// that was ever meant for a mean-reversion trade.
// ════════════════════════════════════════════════════════════════════════
//
// Direction: single SuperTrend (ST_FACTOR) on 15m HA candles. A flip sets
//            pendingSide — a candidate direction waiting for DPI to confirm.
//            ST1 no longer gates or exits anything by itself.
// Entry:     fires when pendingSide is set AND DPI confirms it (dpiState
//            resolves to STRONG_BULL/STRONG_BEAR matching pendingSide),
//            plus any optional ADX/CHOP/RSI filters and the trading window.
// Exit:      THREE independent triggers, any one closes the trade —
//            a fast SMA9 reversal exit (catches a turn before DPI reacts),
//            DPI giveback-from-peak (USE_DPI_GIVEBACK), and a forced exit
//            when efficiency drops below DPI_EFF_THRESH.
//
// SL trail: ATR-based, sized off ST1's direction — pure risk management,
//   not part of the entry/exit decision.
function createDpiTrendMeanrevStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    // ─── PER-INSTANCE STATE ────────────────────────────────────────────────────
    let prevSTDir   = 0;    // last ST1 direction: 1 | -1
    let pendingSide = null; // candidate direction waiting on DPI confirmation

    // ─── TRADING WINDOW ───────────────────────────────────────────────────────
    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    // ─── PERSIST ──────────────────────────────────────────────────────────────
    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    // ─── SL TRAIL — ATR-based, direction from ST1. Risk management only. ─────
    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    // ─── MAIN SIGNAL LOOP ─────────────────────────────────────────────────────
    async function runSignals(price, stResult, atrVal, adxVal, rsiVal, chopVal, hmPrev, hmNow, dpiResult, haCloseVal, sma9Val) {
        const livePrice = candles.getLivePrice() ?? price;

        const stLast     = stResult[stResult.length - 1];
        const stDir      = stLast ? stLast.dir : prevSTDir;
        const stFlipping = stDir !== 0 && stDir !== prevSTDir;

        const dpiState = dpiResult ? getDPIState(dpiResult.dpi, dpiResult.efficiency) : null;
        // efficiency is signed (direction) now — strength/regime check uses
        // magnitude. A strong bear move reads close to -1, still "trending."
        const effOk    = dpiResult ? Math.abs(dpiResult.efficiency) >= engineConfig.DPI_EFF_THRESH : false;

        // ── Gates (all optional, all off by default) ────────────────────────────
        const adxOk      = !engineConfig.USE_ADX_FILTER  || (adxVal  !== null && adxVal  >= engineConfig.ADX_MIN);
        const chopOk     = !engineConfig.USE_CHOP_FILTER || (chopVal !== null && chopVal <= engineConfig.CHOP_MAX);
        const rsiLongOk  = !engineConfig.USE_RSI_FILTER  || (rsiVal  !== null && rsiVal  >  engineConfig.RSI_LONG_MIN);
        const rsiShortOk = !engineConfig.USE_RSI_FILTER  || (rsiVal  !== null && rsiVal  <  engineConfig.RSI_SHORT_MAX);

        // ── Candle close tick ─────────────────────────────────────────────────
        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const clr  = stDir === 1 ? "▲" : stDir === -1 ? "▼" : "●";
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);

        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} ${clr} ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // ── ENGINE ─────────────────────────────────────────────────────────────

        // Exit #1: SMA9 reversal — fast, independent of DPI. TREND positions
        // only — checked first, deliberately, since its whole purpose is to
        // catch a reversal before DPI's smoothed math would react to it.
        if (engineConfig.ENGINE_ENABLED && engineConfig.USE_SMA_EXIT && state.position && state.positionSource === "TREND" && sma9Val !== null) {
            const reversed =
                (state.position === "SHORT" && haCloseVal > sma9Val) ||
                (state.position === "LONG"  && haCloseVal < sma9Val);
            if (reversed) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (SMA9_REVERSAL) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (SMA9_REVERSAL) @ ₹${livePrice.toFixed(2)}\nHA close ${haCloseVal.toFixed(2)} crossed SMA9 ${sma9Val.toFixed(2)}`);
                    await positionsClose(livePrice, "SMA9_REVERSAL");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                    pendingSide = stDir === 1 ? "LONG" : stDir === -1 ? "SHORT" : null;
                }
            }
        }

        // Exit #2: DPI giveback — favorable DPI pressure faded from its peak.
        // TREND positions only — mean-reversion trades don't track peakDPI,
        // they're not betting on directional persistence in the first place.
        // Only arms once the peak reached STRONG threshold.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "TREND" && dpiResult) {
            const favor = state.position === "LONG" ? dpiResult.dpi : -dpiResult.dpi;
            state.peakDPI = Math.max(state.peakDPI, favor);
            if (engineConfig.USE_DPI_GIVEBACK) {
                const armed = state.peakDPI >= engineConfig.DPI_BULL_THRESH;
                if (armed && favor < state.peakDPI * engineConfig.DPI_GIVEBACK_RATIO) {
                    const closed = await orders.exit(state.position);
                    if (engineConfig.LIVE_ORDERS && closed === null) {
                        console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (DPI_GIVEBACK) — will retry next candle`));
                    } else {
                        tg(`${state.position} EXIT (DPI_GIVEBACK) @ ₹${livePrice.toFixed(2)}\npeak:${state.peakDPI.toFixed(2)}  now:${favor.toFixed(2)}`);
                        await positionsClose(livePrice, "DPI_GIVEBACK");
                        slStore.clearTrail();
                        targetStore.clearTarget();
                        persist(null, 0);
                        pendingSide = stDir === 1 ? "LONG" : stDir === -1 ? "SHORT" : null;
                    }
                }
            }
        }

        // Exit #3: DPI efficiency floor — forced exit regardless of giveback/peak
        // state. TREND positions only — a MEANREV trade is already betting the
        // market is choppy, low efficiency is the expected condition, not a
        // reason to exit it.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "TREND" && dpiResult && !effOk) {
            const closed = await orders.exit(state.position);
            if (engineConfig.LIVE_ORDERS && closed === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (DPI_EFF_LOW) — will retry next candle`));
            } else {
                tg(`${state.position} EXIT (DPI_EFF_LOW) @ ₹${livePrice.toFixed(2)}\n|efficiency|: ${Math.abs(dpiResult.efficiency).toFixed(2)} < ${engineConfig.DPI_EFF_THRESH}`);
                await positionsClose(livePrice, "DPI_EFF_LOW");
                slStore.clearTrail();
                targetStore.clearTarget();
                persist(null, 0);
                pendingSide = stDir === 1 ? "LONG" : stDir === -1 ? "SHORT" : null;
            }
        }

        // Exit: HM momentum reversal — independent of ST/DPI, off by default.
        // TREND positions only.
        if (engineConfig.ENGINE_ENABLED && engineConfig.USE_HM_EXIT && state.position && state.positionSource === "TREND" && hmPrev && hmNow) {
            const hmCrossExit =
                (state.position === "LONG"  && hmPrev.ema3 >= hmPrev.wma21 && hmNow.ema3 < hmNow.wma21) ||
                (state.position === "SHORT" && hmPrev.ema3 <= hmPrev.wma21 && hmNow.ema3 > hmNow.wma21);
            if (hmCrossExit) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (HM_EXIT) — will retry next candle`));
                } else {
                    const e3 = hmNow.ema3.toFixed(1), w21 = hmNow.wma21.toFixed(1);
                    tg(`${state.position} EXIT (HM_EXIT) @ ₹${livePrice.toFixed(2)}\nEMA3:${e3}  WMA21:${w21}`);
                    await positionsClose(livePrice, "HM_EXIT");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                    pendingSide = stDir === 1 ? "LONG" : stDir === -1 ? "SHORT" : null;
                }
            }
        }

        // Set or cancel pending side on ST1 flip — direction only, no gating.
        if (engineConfig.ENGINE_ENABLED && !state.position) {
            if (stFlipping) {
                pendingSide = stDir === 1 ? "LONG" : "SHORT";
            } else if (pendingSide) {
                const pendingMatchesST =
                    (pendingSide === "LONG"  && stDir === 1) ||
                    (pendingSide === "SHORT" && stDir === -1);
                if (!pendingMatchesST) pendingSide = null;
            }
        }

        // Entry: direction from ST1 (pendingSide), confirmed by DPI.
        // Naturally can't fire below DPI_EFF_THRESH — STRONG_BULL/BEAR
        // already requires it.
        if (engineConfig.ENGINE_ENABLED && !state.position && pendingSide && canEnter() && adxOk && chopOk) {
            const side  = pendingSide;
            const rsiOk = side === "LONG" ? rsiLongOk : rsiShortOk;
            const dpiOk = side === "LONG" ? dpiState === "STRONG_BULL" : dpiState === "STRONG_BEAR";
            if (rsiOk && dpiOk) {
                const ordered = await orders.enter(side);
                if (engineConfig.LIVE_ORDERS && ordered === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
                } else {
                    const slTrail = computeTrail(livePrice, atrVal, side);

                    state.position    = side;
                    state.entryPrice  = livePrice;
                    state.positionSource = "TREND";
                    state.peakDPI     = dpiResult ? (side === "LONG" ? dpiResult.dpi : -dpiResult.dpi) : 0;
                    state.openTradeId = await db.insertOpenTrade(
                        context.tgPrefix, context.symbol, side, context.lots, livePrice
                    );

                    const trailValid =
                        slTrail !== null &&
                        ((side === "LONG"  && slTrail < livePrice) ||
                         (side === "SHORT" && slTrail > livePrice));
                    if (trailValid) slStore.setTrail(slTrail, stDir);

                    persist(side, livePrice, "TREND");
                    pendingSide = null;
                    console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}  DPI:${dpiState}`));
                    emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                    tg(`${side} ENTRY @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}  DPI:${dpiState}`);
                }
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, stDir);
        }

        prevSTDir = stDir;
    }

    // ─── PROCESS CANDLE — called by candlePoll on every completed 15m candle ──
    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        const warmupNeeded = Math.max(engineConfig.DPI_LEN, engineConfig.ST_ATR_LEN, engineConfig.SMA_LEN, engineConfig.RSI_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        const haCandles = toHA(rawCandles);
        const haCloses  = haCandles.map(cd => cd.close);

        const stResult = supertrend(haCandles, engineConfig.ST_ATR_LEN, engineConfig.ST_FACTOR);
        if (!stResult) return;

        const adxArr = adx(rawCandles, engineConfig.ADX_LEN);
        const adxVal = adxArr[adxArr.length - 1];

        const rsiArr = rsi(haCloses, engineConfig.RSI_LEN);
        const rsiVal = rsiArr[rsiArr.length - 1];

        const chopArr = choppinessIndex(rawCandles, engineConfig.CHOP_LEN);
        const chopVal = chopArr[chopArr.length - 1];

        const hmArr = hmIndicator(haCloses);
        let hmNow = null, hmPrev = null;
        for (let i = hmArr.length - 1; i >= 0 && (!hmNow || !hmPrev); i--) {
            if (hmArr[i] !== null) {
                if (!hmNow)       hmNow  = hmArr[i];
                else if (!hmPrev) hmPrev = hmArr[i];
            }
        }

        const atrVal = atr(haCandles, engineConfig.ST_ATR_LEN);

        const atrArr    = atrSeries(haCandles, engineConfig.ST_ATR_LEN);
        const dpiResult = dpi(haCandles, atrArr, engineConfig.DPI_LEN, engineConfig.DPI_STREAK_MULT, engineConfig.DPI_STREAK_CAP);

        const sma9Arr  = sma(haCloses, engineConfig.SMA_LEN);
        const sma9Val  = sma9Arr[sma9Arr.length - 1];
        const haCloseVal = haCloses[haCloses.length - 1];

        // Boot seed — first candle after restart, prevSTDir still 0. Seed from
        // computed ST so runSignals doesn't see current direction as a flip
        // from nothing, and arm pendingSide so a mid-session restart doesn't
        // wait for the next ST flip to re-engage.
        if (prevSTDir === 0) {
            const bootDir = stResult[stResult.length - 1]?.dir ?? 0;
            prevSTDir = bootDir;
            if (!state.position && bootDir !== 0) {
                pendingSide = bootDir === 1 ? "LONG" : "SHORT";
            }
        }

        await runSignals(rawCandle.close, stResult, atrVal, adxVal, rsiVal, chopVal, hmPrev, hmNow, dpiResult, haCloseVal, sma9Val);
    }

    // ─── INIT — restore from DB on startup ────────────────────────────────────
    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume && saved.position_source === "MEANREV") {
                    // Orphaned leftover from before the DPI split — this key
                    // can no longer open a MEANREV trade at all, and this
                    // strategy has no MEANREV exit logic anymore (removed,
                    // see DPI_MEANREV for where it lives now). Silently
                    // relabeling it "TREND" would apply SMA9/giveback/
                    // eff-floor exits to a trade that was never opened under
                    // that logic — wrong regardless of size, and this
                    // instrument is paper-only right now, so the safe fix is
                    // to flatten it on boot rather than mismanage it.
                    console.warn(c.yellow(`[${context.tgPrefix}] orphaned MEANREV position from before the DPI split (${saved.position}@${saved.entry_price}) — this strategy can no longer manage it, flattening on boot instead of misrouting its exits`));
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                } else if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = "TREND";
                    prevSTDir = saved.position === "LONG" ? 1 : -1;

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            // Session PnL is rebuilt from the ledger, not trusted from RAM —
            // a crash/restart must change nothing about the day's numbers.
            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// DPI_MEANREV — the original combined DPI_TREND_MEANREV logic, split out
// unchanged into its own strategy (see createDpiTrendMeanrevStrategy above,
// which now only keeps the TREND half). Registered as the last entry in
// STRATEGIES. Nothing about the entry/exit/regime logic differs from the
// original — this is the full TREND+MEANREV combo.
// ════════════════════════════════════════════════════════════════════════
//
// TWO REGIMES, split by |DPI efficiency| (signed ratio, roughly [-1,1] —
// sign is net direction, magnitude is trend quality/cleanliness):
//   efficiency >= DPI_EFF_THRESH -> TREND regime  (ST1 direction, DPI confirms)
//   efficiency <  DPI_EFF_THRESH -> MEANREV regime (fades RSI extremes)
// The split is exclusive by construction, not by an extra guard: TREND
// entries already require STRONG_BULL/BEAR, which already requires
// efficiency >= DPI_EFF_THRESH — so a MEANREV-regime candle can never also
// pass TREND's entry gate. state.positionSource ("TREND"|"MEANREV") records
// which regime opened the current position, so exits route to the right
// logic — a MEANREV trade doesn't get exited by TREND-only triggers like
// SMA9/giveback/efficiency-floor, and vice versa.
//
// TREND regime:
//   Direction: single SuperTrend (ST_FACTOR) on 15m HA candles. A flip sets
//              pendingSide — a candidate direction waiting for DPI to confirm.
//              ST1 no longer gates or exits anything by itself.
//   Entry:     fires when pendingSide is set AND DPI confirms it (dpiState
//              resolves to STRONG_BULL/STRONG_BEAR matching pendingSide),
//              plus any optional ADX/CHOP/RSI filters and the trading window.
//   Exit:      THREE independent triggers, any one closes the trade —
//              a fast SMA9 reversal exit (catches a turn before DPI reacts),
//              DPI giveback-from-peak (USE_DPI_GIVEBACK), and a forced exit
//              when efficiency drops below DPI_EFF_THRESH.
//
// MEANREV regime:
//   Entry:     RSI >= MEANREV_RSI_SELL -> SHORT (fade the overbought move)
//              RSI <= MEANREV_RSI_BUY  -> LONG  (fade the oversold move)
//              Deliberately NOT gated by ST1/ADX/CHOP — those are
//              trend-following filters and would work backwards here.
//   Exit:      opposite RSI extreme — a SHORT exits at RSI <= MEANREV_RSI_BUY,
//              a LONG exits at RSI >= MEANREV_RSI_SELL. Same trigger as the
//              opposite side's entry, so an exit and a fresh flip-entry can
//              land on the same candle — intentional, not a bug.
//
// SL trail (both regimes): ATR-based, sized off ST1's direction — pure risk
//   management, not part of either regime's entry/exit decision.
function createDpiMeanrevStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    // ─── PER-INSTANCE STATE ────────────────────────────────────────────────────
    let prevSTDir   = 0;    // last ST1 direction: 1 | -1
    let pendingSide = null; // candidate direction waiting on DPI confirmation

    // ─── TRADING WINDOW ───────────────────────────────────────────────────────
    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    // ─── PERSIST ──────────────────────────────────────────────────────────────
    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    // ─── SL TRAIL — ATR-based, direction from ST1. Risk management only. ─────
    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    // ─── MAIN SIGNAL LOOP ─────────────────────────────────────────────────────
    async function runSignals(price, stResult, atrVal, adxVal, rsiVal, chopVal, hmPrev, hmNow, dpiResult, haCloseVal, sma9Val) {
        const livePrice = candles.getLivePrice() ?? price;

        const stLast     = stResult[stResult.length - 1];
        const stDir      = stLast ? stLast.dir : prevSTDir;
        const stFlipping = stDir !== 0 && stDir !== prevSTDir;

        const dpiState = dpiResult ? getDPIState(dpiResult.dpi, dpiResult.efficiency) : null;
        // efficiency is signed (direction) now — strength/regime check uses
        // magnitude. A strong bear move reads close to -1, still "trending."
        const effOk    = dpiResult ? Math.abs(dpiResult.efficiency) >= engineConfig.DPI_EFF_THRESH : false;
        // Regime switch: |efficiency| >= DPI_EFF_THRESH -> TREND, below -> MEANREV.
        // Same value as effOk, named separately here because it's now doing
        // double duty as the full regime split, not just an entry/exit gate.
        const trending = effOk;

        // ── Gates (all optional, all off by default) ────────────────────────────
        const adxOk      = !engineConfig.USE_ADX_FILTER  || (adxVal  !== null && adxVal  >= engineConfig.ADX_MIN);
        const chopOk     = !engineConfig.USE_CHOP_FILTER || (chopVal !== null && chopVal <= engineConfig.CHOP_MAX);
        const rsiLongOk  = !engineConfig.USE_RSI_FILTER  || (rsiVal  !== null && rsiVal  >  engineConfig.RSI_LONG_MIN);
        const rsiShortOk = !engineConfig.USE_RSI_FILTER  || (rsiVal  !== null && rsiVal  <  engineConfig.RSI_SHORT_MAX);

        // ── Candle close tick ─────────────────────────────────────────────────
        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const clr  = stDir === 1 ? "▲" : stDir === -1 ? "▼" : "●";
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);

        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} ${clr} ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // ── ENGINE ─────────────────────────────────────────────────────────────

        // Exit #1: SMA9 reversal — fast, independent of DPI. TREND positions
        // only — checked first, deliberately, since its whole purpose is to
        // catch a reversal before DPI's smoothed math would react to it.
        if (engineConfig.ENGINE_ENABLED && engineConfig.USE_SMA_EXIT && state.position && state.positionSource === "TREND" && sma9Val !== null) {
            const reversed =
                (state.position === "SHORT" && haCloseVal > sma9Val) ||
                (state.position === "LONG"  && haCloseVal < sma9Val);
            if (reversed) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (SMA9_REVERSAL) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (SMA9_REVERSAL) @ ₹${livePrice.toFixed(2)}\nHA close ${haCloseVal.toFixed(2)} crossed SMA9 ${sma9Val.toFixed(2)}`);
                    await positionsClose(livePrice, "SMA9_REVERSAL");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                    pendingSide = stDir === 1 ? "LONG" : stDir === -1 ? "SHORT" : null;
                }
            }
        }

        // Exit #2: DPI giveback — favorable DPI pressure faded from its peak.
        // TREND positions only — mean-reversion trades don't track peakDPI,
        // they're not betting on directional persistence in the first place.
        // Only arms once the peak reached STRONG threshold.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "TREND" && dpiResult) {
            const favor = state.position === "LONG" ? dpiResult.dpi : -dpiResult.dpi;
            state.peakDPI = Math.max(state.peakDPI, favor);
            if (engineConfig.USE_DPI_GIVEBACK) {
                const armed = state.peakDPI >= engineConfig.DPI_BULL_THRESH;
                if (armed && favor < state.peakDPI * engineConfig.DPI_GIVEBACK_RATIO) {
                    const closed = await orders.exit(state.position);
                    if (engineConfig.LIVE_ORDERS && closed === null) {
                        console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (DPI_GIVEBACK) — will retry next candle`));
                    } else {
                        tg(`${state.position} EXIT (DPI_GIVEBACK) @ ₹${livePrice.toFixed(2)}\npeak:${state.peakDPI.toFixed(2)}  now:${favor.toFixed(2)}`);
                        await positionsClose(livePrice, "DPI_GIVEBACK");
                        slStore.clearTrail();
                        targetStore.clearTarget();
                        persist(null, 0);
                        pendingSide = stDir === 1 ? "LONG" : stDir === -1 ? "SHORT" : null;
                    }
                }
            }
        }

        // Exit #3: DPI efficiency floor — forced exit regardless of giveback/peak
        // state. TREND positions only — a MEANREV trade is already betting the
        // market is choppy, low efficiency is the expected condition, not a
        // reason to exit it.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "TREND" && dpiResult && !effOk) {
            const closed = await orders.exit(state.position);
            if (engineConfig.LIVE_ORDERS && closed === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (DPI_EFF_LOW) — will retry next candle`));
            } else {
                tg(`${state.position} EXIT (DPI_EFF_LOW) @ ₹${livePrice.toFixed(2)}\n|efficiency|: ${Math.abs(dpiResult.efficiency).toFixed(2)} < ${engineConfig.DPI_EFF_THRESH}`);
                await positionsClose(livePrice, "DPI_EFF_LOW");
                slStore.clearTrail();
                targetStore.clearTarget();
                persist(null, 0);
                pendingSide = stDir === 1 ? "LONG" : stDir === -1 ? "SHORT" : null;
            }
        }

        // Exit: HM momentum reversal — independent of ST/DPI, off by default.
        // TREND positions only.
        if (engineConfig.ENGINE_ENABLED && engineConfig.USE_HM_EXIT && state.position && state.positionSource === "TREND" && hmPrev && hmNow) {
            const hmCrossExit =
                (state.position === "LONG"  && hmPrev.ema3 >= hmPrev.wma21 && hmNow.ema3 < hmNow.wma21) ||
                (state.position === "SHORT" && hmPrev.ema3 <= hmPrev.wma21 && hmNow.ema3 > hmNow.wma21);
            if (hmCrossExit) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (HM_EXIT) — will retry next candle`));
                } else {
                    const e3 = hmNow.ema3.toFixed(1), w21 = hmNow.wma21.toFixed(1);
                    tg(`${state.position} EXIT (HM_EXIT) @ ₹${livePrice.toFixed(2)}\nEMA3:${e3}  WMA21:${w21}`);
                    await positionsClose(livePrice, "HM_EXIT");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                    pendingSide = stDir === 1 ? "LONG" : stDir === -1 ? "SHORT" : null;
                }
            }
        }

        // Exit #5: MEANREV RSI flip — a mean-reversion trade exits at the
        // OPPOSITE extreme from where it entered (short entered at RSI>=SELL,
        // exits at RSI<=BUY; long entered at RSI<=BUY, exits at RSI>=SELL).
        // Same trigger as the opposite side's entry — deliberately — so a
        // close and a fresh entry the other way can land the same candle.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "MEANREV" && rsiVal !== null) {
            const meanrevReversed =
                (state.position === "SHORT" && rsiVal <= engineConfig.MEANREV_RSI_BUY) ||
                (state.position === "LONG"  && rsiVal >= engineConfig.MEANREV_RSI_SELL);
            if (meanrevReversed) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (MEANREV_RSI_FLIP) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (MEANREV_RSI_FLIP) @ ₹${livePrice.toFixed(2)}\nRSI ${rsiVal.toFixed(1)}`);
                    await positionsClose(livePrice, "MEANREV_RSI_FLIP");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                }
            }
        }

        // Set or cancel pending side on ST1 flip — direction only, no gating.
        if (engineConfig.ENGINE_ENABLED && !state.position) {
            if (stFlipping) {
                pendingSide = stDir === 1 ? "LONG" : "SHORT";
            } else if (pendingSide) {
                const pendingMatchesST =
                    (pendingSide === "LONG"  && stDir === 1) ||
                    (pendingSide === "SHORT" && stDir === -1);
                if (!pendingMatchesST) pendingSide = null;
            }
        }

        // Entry (TREND): direction from ST1 (pendingSide), confirmed by DPI.
        // Naturally can't fire below DPI_EFF_THRESH — STRONG_BULL/BEAR
        // already requires it — so this never overlaps with MEANREV entries.
        if (engineConfig.ENGINE_ENABLED && !state.position && pendingSide && canEnter() && adxOk && chopOk) {
            const side  = pendingSide;
            const rsiOk = side === "LONG" ? rsiLongOk : rsiShortOk;
            const dpiOk = side === "LONG" ? dpiState === "STRONG_BULL" : dpiState === "STRONG_BEAR";
            if (rsiOk && dpiOk) {
                const ordered = await orders.enter(side);
                if (engineConfig.LIVE_ORDERS && ordered === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
                } else {
                    const slTrail = computeTrail(livePrice, atrVal, side);

                    state.position    = side;
                    state.entryPrice  = livePrice;
                    state.positionSource = "TREND";
                    state.peakDPI     = dpiResult ? (side === "LONG" ? dpiResult.dpi : -dpiResult.dpi) : 0;
                    state.openTradeId = await db.insertOpenTrade(
                        context.tgPrefix, context.symbol, side, context.lots, livePrice
                    );

                    const trailValid =
                        slTrail !== null &&
                        ((side === "LONG"  && slTrail < livePrice) ||
                         (side === "SHORT" && slTrail > livePrice));
                    if (trailValid) slStore.setTrail(slTrail, stDir);

                    persist(side, livePrice, "TREND");
                    pendingSide = null;
                    console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}  DPI:${dpiState}`));
                    emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                    tg(`${side} ENTRY @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}  DPI:${dpiState}`);
                }
            }
        }

        // Entry (MEANREV): fades RSI extremes, only when efficiency says the
        // market is choppy (!trending), not gated by ST1/ADX/CHOP — those
        // filters are trend-following concepts and would work backwards
        // here (low ADX / high chop is exactly the condition this wants).
        // Runs after the TREND entry block so a same-candle exit-then-flip
        // (see MEANREV exit above) can re-enter immediately.
        if (engineConfig.ENGINE_ENABLED && !state.position && !trending && canEnter() && rsiVal !== null) {
            let side = null;
            if (rsiVal >= engineConfig.MEANREV_RSI_SELL) side = "SHORT";
            else if (rsiVal <= engineConfig.MEANREV_RSI_BUY) side = "LONG";

            if (side) {
                const ordered = await orders.enter(side);
                if (engineConfig.LIVE_ORDERS && ordered === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
                } else {
                    const slTrail = computeTrail(livePrice, atrVal, side);

                    state.position    = side;
                    state.entryPrice  = livePrice;
                    state.positionSource = "MEANREV";
                    state.openTradeId = await db.insertOpenTrade(
                        context.tgPrefix, context.symbol, side, context.lots, livePrice
                    );

                    const trailValid =
                        slTrail !== null &&
                        ((side === "LONG"  && slTrail < livePrice) ||
                         (side === "SHORT" && slTrail > livePrice));
                    if (trailValid) slStore.setTrail(slTrail, stDir);

                    persist(side, livePrice, "MEANREV");
                    console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (MEANREV) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}  RSI:${rsiVal.toFixed(1)}`));
                    emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                    tg(`${side} ENTRY (MEANREV) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}  RSI:${rsiVal.toFixed(1)}`);
                }
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, stDir);
        }

        prevSTDir = stDir;
    }

    // ─── PROCESS CANDLE — called by candlePoll on every completed 15m candle ──
    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        const warmupNeeded = Math.max(engineConfig.DPI_LEN, engineConfig.ST_ATR_LEN, engineConfig.SMA_LEN, engineConfig.RSI_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        const haCandles = toHA(rawCandles);
        const haCloses  = haCandles.map(cd => cd.close);

        const stResult = supertrend(haCandles, engineConfig.ST_ATR_LEN, engineConfig.ST_FACTOR);
        if (!stResult) return;

        const adxArr = adx(rawCandles, engineConfig.ADX_LEN);
        const adxVal = adxArr[adxArr.length - 1];

        const rsiArr = rsi(haCloses, engineConfig.RSI_LEN);
        const rsiVal = rsiArr[rsiArr.length - 1];

        const chopArr = choppinessIndex(rawCandles, engineConfig.CHOP_LEN);
        const chopVal = chopArr[chopArr.length - 1];

        const hmArr = hmIndicator(haCloses);
        let hmNow = null, hmPrev = null;
        for (let i = hmArr.length - 1; i >= 0 && (!hmNow || !hmPrev); i--) {
            if (hmArr[i] !== null) {
                if (!hmNow)       hmNow  = hmArr[i];
                else if (!hmPrev) hmPrev = hmArr[i];
            }
        }

        const atrVal = atr(haCandles, engineConfig.ST_ATR_LEN);

        const atrArr    = atrSeries(haCandles, engineConfig.ST_ATR_LEN);
        const dpiResult = dpi(haCandles, atrArr, engineConfig.DPI_LEN, engineConfig.DPI_STREAK_MULT, engineConfig.DPI_STREAK_CAP);

        const sma9Arr  = sma(haCloses, engineConfig.SMA_LEN);
        const sma9Val  = sma9Arr[sma9Arr.length - 1];
        const haCloseVal = haCloses[haCloses.length - 1];

        // Boot seed — first candle after restart, prevSTDir still 0. Seed from
        // computed ST so runSignals doesn't see current direction as a flip
        // from nothing, and arm pendingSide so a mid-session restart doesn't
        // wait for the next ST flip to re-engage.
        if (prevSTDir === 0) {
            const bootDir = stResult[stResult.length - 1]?.dir ?? 0;
            prevSTDir = bootDir;
            if (!state.position && bootDir !== 0) {
                pendingSide = bootDir === 1 ? "LONG" : "SHORT";
            }
        }

        await runSignals(rawCandle.close, stResult, atrVal, adxVal, rsiVal, chopVal, hmPrev, hmNow, dpiResult, haCloseVal, sma9Val);
    }

    // ─── INIT — restore from DB on startup ────────────────────────────────────
    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    // Legacy rows predate this column — default to TREND rather
                    // than leave it null (null wouldn't route to ANY exit logic).
                    state.positionSource = saved.position_source || "TREND";

                    if (state.positionSource === "TREND") {
                        prevSTDir = saved.position === "LONG" ? 1 : -1;
                    }
                    // else: leave prevSTDir at 0 — a MEANREV position's side has
                    // no relationship to ST1 direction, so guessing it from the
                    // position would be wrong. processCandle's own boot-seed
                    // logic computes it fresh from the real indicator instead.

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            // Session PnL is rebuilt from the ledger, not trusted from RAM —
            // a crash/restart must change nothing about the day's numbers.
            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// DPI_SMA5_EXIT — from the user-provided Pine script ("TAlgo - ALMA + DPI +
// SMA5 Exits"). Two things worth flagging up front about this port:
//
// 1. ALMA IS NOT IMPLEMENTED HERE — in the Pine script itself, almaShort/
//    almaLong are only ever used for the plot color and the status table;
//    they never appear in any strategy.entry()/strategy.close() condition.
//    Porting cosmetic-only indicators into a live engine would be pure
//    overhead with zero effect on trading behavior, so this factory
//    computes DPI and SMA5 only — the two things that actually decide
//    anything in the source script.
//
// 2. THIS RUNS ON RAW CANDLES, NOT HEIKIN ASHI — unlike DPI_TREND_MEANREV,
//    the source Pine script never calls ta.heikinashi anywhere; every
//    calculation (dir, body, close, sma5) reads plain OHLC. Reusing this
//    codebase's HA convention here would silently change the strategy's
//    behavior from what was actually specified in the script. DPI's ATR
//    normalization also uses atrSeries(rawCandles, DPI_LEN) specifically —
//    the Pine script's own `atrSeries = ta.atr(dpiPeriod)` is ATR length =
//    dpiPeriod, not a separate ST_ATR_LEN the way DPI_TREND_MEANREV does it.
//
// DPI itself is otherwise IDENTICAL math to indicators.js's existing dpi()/
// getDPIState() — this codebase's DPI implementation was evidently already
// built from this exact script (engineConfig's DPI_LEN/DPI_STREAK_MULT/
// DPI_BULL_THRESH/DPI_BEAR_THRESH/DPI_EFF_THRESH defaults already match
// the Pine script's dpiPeriod/dpiStreakMult/(hardcoded 3.0/-3.0)/
// dpiEffThresh inputs exactly) — so no new DPI logic needed, just applied
// to raw candles here instead of HA ones.
//
// Entry:  dpiState resolves to STRONG_BULL/STRONG_BEAR (via
//         getDPIState()'s existing thresholds) while flat — direct port of
//         `if dpiState == "STRONG_BULL" and strategy.position_size == 0`.
//         canEnter()'s TRADE_START window is this port's own addition —
//         the Pine backtester has no such concept, but every live strategy
//         in this codebase gates entries on it (same as ALMA_BAND/
//         ALMA_FAST/DUAL_ST_CHOP).
// Exit:   raw close crosses SMA(close, DPI_SMA5_EXIT_LEN) — direct port of
//         the script's `close < sma5` / `close > sma5` checks.
// SL:     the Pine script has NO stop-loss logic at all — it's a pure
//         signal-in/signal-out backtest. Running that unprotected between
//         candle closes on real capital would mean no intrabar downside
//         protection whatsoever, so this port adds the same ATR_SL_MULT x
//         ATR(ST_ATR_LEN) trail every other strategy here uses, on raw
//         candles (same choice ALMA_BAND made) — risk management only,
//         not part of the entry/exit decision, and not something the
//         source script specified either way.
// state.positionSource = "DPI_SMA5_EXIT" — keeps this strategy's exits
//         from ever acting on a position a different strategy opened.
// ════════════════════════════════════════════════════════════════════════
function createDpiSma5ExitStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    async function runSignals(price, dpiState, sma5Val, atrVal, closeVal) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} DPI5 ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit: raw close crosses SMA5 — direct port of the script's exit.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "DPI_SMA5_EXIT" && sma5Val !== null) {
            const crossed =
                (state.position === "LONG"  && closeVal < sma5Val) ||
                (state.position === "SHORT" && closeVal > sma5Val);
            if (crossed) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (SMA5_EXIT) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (SMA5_EXIT) @ ₹${livePrice.toFixed(2)}\nclose ${closeVal.toFixed(2)} crossed SMA5 ${sma5Val.toFixed(2)}`);
                    await positionsClose(livePrice, "SMA5_EXIT");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                }
            }
        }

        // Entry: DPI STRONG_BULL/STRONG_BEAR while flat — direct port of
        // the script's entry, plus this codebase's trading-window gate.
        if (engineConfig.ENGINE_ENABLED && !state.position && canEnter()) {
            let side = null;
            if (dpiState === "STRONG_BULL")      side = "LONG";
            else if (dpiState === "STRONG_BEAR") side = "SHORT";

            if (side) {
                const ordered = await orders.enter(side);
                if (engineConfig.LIVE_ORDERS && ordered === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
                } else {
                    const slTrail = computeTrail(livePrice, atrVal, side);

                    state.position    = side;
                    state.entryPrice  = livePrice;
                    state.positionSource = "DPI_SMA5_EXIT";
                    state.openTradeId = await db.insertOpenTrade(
                        context.tgPrefix, context.symbol, side, context.lots, livePrice
                    );

                    const trailValid =
                        slTrail !== null &&
                        ((side === "LONG"  && slTrail < livePrice) ||
                         (side === "SHORT" && slTrail > livePrice));
                    if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                    persist(side, livePrice, "DPI_SMA5_EXIT");
                    console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (DPI_SMA5_EXIT) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}  DPI:${dpiState}`));
                    emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                    tg(`${side} ENTRY (DPI_SMA5_EXIT) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}  DPI:${dpiState}`);
                }
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour.
        // Same risk-management-only addition noted in the header comment.
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        const warmupNeeded = Math.max(engineConfig.DPI_LEN, engineConfig.DPI_SMA5_EXIT_LEN, engineConfig.ST_ATR_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        // Raw candles throughout — see header comment. atrSeries length is
        // DPI_LEN (matches the Pine script's `ta.atr(dpiPeriod)` exactly),
        // NOT ST_ATR_LEN — that's reserved for the SL trail below only.
        const atrForDpi = atrSeries(rawCandles, engineConfig.DPI_LEN);
        const dpiResult = dpi(rawCandles, atrForDpi, engineConfig.DPI_LEN, engineConfig.DPI_STREAK_MULT, engineConfig.DPI_STREAK_CAP);
        if (!dpiResult) return;
        const dpiState = getDPIState(dpiResult.dpi, dpiResult.efficiency);

        const rawCloses = rawCandles.map(cd => cd.close);
        const sma5Arr   = sma(rawCloses, engineConfig.DPI_SMA5_EXIT_LEN);
        const sma5Val   = sma5Arr[sma5Arr.length - 1];

        // SL trail only — this port's own addition, no Pine equivalent.
        const atrVal = atr(rawCandles, engineConfig.ST_ATR_LEN);

        await runSignals(rawCandle.close, dpiState, sma5Val, atrVal, rawCandle.close);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "DPI_SMA5_EXIT";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// ALMA_DUAL_BAND_SMA5 — user-specified composite, built from the same
// close-vs-ALMA color logic as the original DPI+ALMA+SMA5 script, but with
// ALMA (not DPI) as the actual entry driver this time, plus a fallback to
// the existing ALMA_BAND breakout logic when the two ALMA lines disagree.
// DPI plays NO role here per instruction — this is the "forget about DPI"
// version, not an extension of DPI_SMA5_EXIT.
//
// Two ALMA lines on RAW close (ALMA_DUAL_SHORT_LEN=9, ALMA_DUAL_LONG_LEN=50)
// — no HA, matching this whole script family's convention (see
// DPI_SMA5_EXIT's header for why).
//
// SHORT line color — reuses the ORIGINAL script's almaColor logic
// verbatim (this piece was never asked to change):
//   close > almaShort AND (close-almaLong)/almaLong >  ALMA_DUAL_DIFF_PCT -> GREEN
//   close < almaShort AND (close-almaLong)/almaLong < -ALMA_DUAL_DIFF_PCT -> RED
//   otherwise -> GREY
//
// LONG line color — per instruction, deliberately simpler than the short
// line, no grey state at all:
//   close >= almaLong -> GREEN,  close < almaLong -> RED
//
// Entry:
//   - Both lines GREEN  -> LONG  (direct trend entry)
//   - Both lines RED    -> SHORT (direct trend entry)
//   - Anything else (short GREY, or the two lines disagreeing) -> fall
//     back to the SAME high/low ALMA-band breakout ALMA_BAND already uses
//     (same HA-candle convention, same ALMA_LEN/ALMA_OFFSET/ALMA_SIGMA
//     config — this IS that strategy's band logic, reused, not a copy with
//     its own tunables). Only a genuine breakout outside the band enters —
//     price sitting inside the band opens nothing, same as ALMA_BAND.
//   ASSUMPTION (not explicitly stated, flagging it): "the two lines
//   disagree" (short GREEN + long RED, or vice versa) is treated the same
//   as "short is GREY" — both fall back to the band. Only literal
//   agreement (both GREEN or both RED) fires a direct trend entry. If you
//   actually want disagreement to block entries entirely rather than
//   falling back to the band, that's a one-line change.
// Exit: SAME SMA5 cross as DPI_SMA5_EXIT, on raw close, applies uniformly
//   no matter which mechanism (direct trend vs band breakout) opened the
//   position — matches the chart's "SMA5 Exit" label appearing on every
//   trade regardless of entry type.
// SL: same ATR_SL_MULT x ATR(ST_ATR_LEN) trail as every other strategy —
//   this port's own addition, no Pine equivalent specified.
// state.positionSource = "ALMA_DUAL_BAND_SMA5".
// ════════════════════════════════════════════════════════════════════════
function createAlmaDualBandStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    async function runSignals(price, entrySide, entryReason, sma5Val, atrVal, closeVal) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} ADB  ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit: raw close crosses SMA5 — identical to DPI_SMA5_EXIT's exit,
        // applies to every open position regardless of what opened it.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "ALMA_DUAL_BAND_SMA5" && sma5Val !== null) {
            const crossed =
                (state.position === "LONG"  && closeVal < sma5Val) ||
                (state.position === "SHORT" && closeVal > sma5Val);
            if (crossed) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (SMA5_EXIT) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (SMA5_EXIT) @ ₹${livePrice.toFixed(2)}\nclose ${closeVal.toFixed(2)} crossed SMA5 ${sma5Val.toFixed(2)}`);
                    await positionsClose(livePrice, "SMA5_EXIT");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                }
            }
        }

        // Entry — side/reason already resolved by processCandle (dual-ALMA
        // agreement or band breakout); this block just executes it.
        if (engineConfig.ENGINE_ENABLED && !state.position && canEnter() && entrySide) {
            const side = entrySide;
            const ordered = await orders.enter(side);
            if (engineConfig.LIVE_ORDERS && ordered === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
            } else {
                const slTrail = computeTrail(livePrice, atrVal, side);

                state.position    = side;
                state.entryPrice  = livePrice;
                state.positionSource = "ALMA_DUAL_BAND_SMA5";
                state.openTradeId = await db.insertOpenTrade(
                    context.tgPrefix, context.symbol, side, context.lots, livePrice
                );

                const trailValid =
                    slTrail !== null &&
                    ((side === "LONG"  && slTrail < livePrice) ||
                     (side === "SHORT" && slTrail > livePrice));
                if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                persist(side, livePrice, "ALMA_DUAL_BAND_SMA5");
                console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (${entryReason}) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}`));
                emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                tg(`${side} ENTRY (${entryReason}) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}`);
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour.
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        const warmupNeeded = Math.max(engineConfig.ALMA_DUAL_LONG_LEN, engineConfig.ALMA_LEN, engineConfig.ST_ATR_LEN, engineConfig.DPI_SMA5_EXIT_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        // ── Dual ALMA trend lines — RAW close, see header comment ─────────
        const rawCloses = rawCandles.map(cd => cd.close);
        const closeVal  = rawCandle.close;

        const almaShortVal = alma(rawCloses, engineConfig.ALMA_DUAL_SHORT_LEN, engineConfig.ALMA_DUAL_OFFSET, engineConfig.ALMA_DUAL_SIGMA);
        const almaLongVal  = alma(rawCloses, engineConfig.ALMA_DUAL_LONG_LEN,  engineConfig.ALMA_DUAL_OFFSET, engineConfig.ALMA_DUAL_SIGMA);
        if (almaShortVal === null || almaLongVal === null) return;

        // Short line: 3-state, verbatim from the original script's almaColor.
        const diffPct = almaLongVal !== 0 ? (closeVal - almaLongVal) / almaLongVal : 0;
        const shortColor =
            (closeVal > almaShortVal && diffPct >  engineConfig.ALMA_DUAL_DIFF_PCT) ? "GREEN" :
            (closeVal < almaShortVal && diffPct < -engineConfig.ALMA_DUAL_DIFF_PCT) ? "RED"   : "GREY";

        // Long line: 2-state, simple above/below, no threshold.
        const longColor = closeVal >= almaLongVal ? "GREEN" : "RED";

        // ── Resolve entry side + reason ────────────────────────────────────
        let entrySide   = null;
        let entryReason = null;

        if (longColor === "GREEN" && shortColor === "GREEN") {
            entrySide = "LONG";  entryReason = "ALMA_TREND_AGREE";
        } else if (longColor === "RED" && shortColor === "RED") {
            entrySide = "SHORT"; entryReason = "ALMA_TREND_AGREE";
        } else {
            // Fallback: the existing ALMA_BAND breakout, same HA-candle
            // convention and config (ALMA_LEN/OFFSET/SIGMA) that strategy
            // already uses — genuinely reused, not duplicated.
            const haCandles = toHA(rawCandles);
            const highs = haCandles.map(cd => cd.high);
            const lows  = haCandles.map(cd => cd.low);
            const almaHigh = alma(highs, engineConfig.ALMA_LEN, engineConfig.ALMA_OFFSET, engineConfig.ALMA_SIGMA);
            const almaLow  = alma(lows,  engineConfig.ALMA_LEN, engineConfig.ALMA_OFFSET, engineConfig.ALMA_SIGMA);
            if (almaHigh !== null && almaLow !== null) {
                const haCloseVal = haCandles[haCandles.length - 1].close;
                if (haCloseVal > almaHigh)      { entrySide = "LONG";  entryReason = "ALMA_BAND_BREAKOUT"; }
                else if (haCloseVal < almaLow)  { entrySide = "SHORT"; entryReason = "ALMA_BAND_BREAKOUT"; }
                // else: inside the band — no entry, matches "in band there
                // wont be any entries".
            }
        }

        const sma5Arr = sma(rawCloses, engineConfig.DPI_SMA5_EXIT_LEN);
        const sma5Val = sma5Arr[sma5Arr.length - 1];

        // SL trail only — this port's own addition, no Pine equivalent.
        const atrVal = atr(rawCandles, engineConfig.ST_ATR_LEN);

        await runSignals(rawCandle.close, entrySide, entryReason, sma5Val, atrVal, closeVal);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "ALMA_DUAL_BAND_SMA5";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// ALMA_BAND — from the user-provided Pine script ("ALMA High-Low Band
// (Algo View)"). The Pine script itself is only a plotting indicator (bands
// + buy/sell shapes) — it defines no exit or SL logic, so those two pieces
// below are this port's own additions, not from the script:
//
// Bands:  almaHigh = ta.alma(high, ALMA_LEN, ALMA_OFFSET, ALMA_SIGMA)
//         almaLow  = ta.alma(low,  ALMA_LEN, ALMA_OFFSET, ALMA_SIGMA)
//         Computed on HA candles — changed from an earlier raw-candle
//         version (which matched the Pine script exactly) at the user's
//         request, to smooth the bands the same way HA already smooths
//         everything else in this codebase (ST1/RSI/SMA9 in the other
//         strategy, and this strategy's own signal comparison below).
// Signal: buy/sell comparison against the bands uses the HA close.
//         rawCandle.close (actual LTP) still drives order price / PnL math
//         throughout — only the band calculation and the signal comparison
//         use HA.
// Entry:  HA close > almaHigh -> LONG  (breakout above upper band)
//         HA close < almaLow  -> SHORT (breakout below lower band)
// Exit:   HA close re-enters the band —
//         LONG  exits when HA close < almaHigh
//         SHORT exits when HA close > almaLow
// SL:     same ATR trail as DPI_TREND_MEANREV (ATR_SL_MULT x ATR(ST_ATR_LEN)),
//         also on raw candles — risk management only, not part of the
//         entry/exit decision.
// Filters: none — the Pine script has no ADX/CHOP/RSI gates. Only the
//         shared TRADE_START_HOUR/MINUTE window applies, same as the other
//         strategy's two regimes.
// state.positionSource = "ALMA_BAND" — kept distinct so a strategy switch
//         mid-position can never let the wrong strategy's exit logic act on
//         a position it didn't open.
// ════════════════════════════════════════════════════════════════════════
function createAlmaBandStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    async function runSignals(price, almaHigh, almaLow, atrVal, closeVal) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} ALMA ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit: price re-enters the band.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "ALMA_BAND") {
            const reentered =
                (state.position === "LONG"  && closeVal < almaHigh) ||
                (state.position === "SHORT" && closeVal > almaLow);
            if (reentered) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (ALMA_REENTRY) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (ALMA_REENTRY) @ ₹${livePrice.toFixed(2)}\nHA close ${closeVal.toFixed(2)} re-entered band [${almaLow.toFixed(2)}, ${almaHigh.toFixed(2)}]`);
                    await positionsClose(livePrice, "ALMA_REENTRY");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                }
            }
        }

        // Entry: close breaks outside a band.
        if (engineConfig.ENGINE_ENABLED && !state.position && canEnter()) {
            let side = null;
            if (closeVal > almaHigh)      side = "LONG";
            else if (closeVal < almaLow)  side = "SHORT";

            if (side) {
                const ordered = await orders.enter(side);
                if (engineConfig.LIVE_ORDERS && ordered === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
                } else {
                    const slTrail = computeTrail(livePrice, atrVal, side);

                    state.position    = side;
                    state.entryPrice  = livePrice;
                    state.positionSource = "ALMA_BAND";
                    state.openTradeId = await db.insertOpenTrade(
                        context.tgPrefix, context.symbol, side, context.lots, livePrice
                    );

                    const trailValid =
                        slTrail !== null &&
                        ((side === "LONG"  && slTrail < livePrice) ||
                         (side === "SHORT" && slTrail > livePrice));
                    if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                    persist(side, livePrice, "ALMA_BAND");
                    console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (ALMA_BAND) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}  High:${almaHigh.toFixed(2)}  Low:${almaLow.toFixed(2)}`));
                    emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                    tg(`${side} ENTRY (ALMA_BAND) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}\nBand: [${almaLow.toFixed(2)}, ${almaHigh.toFixed(2)}]`);
                }
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        const warmupNeeded = Math.max(engineConfig.ALMA_LEN, engineConfig.ST_ATR_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        const haCandles = toHA(rawCandles);
        const highs = haCandles.map(cd => cd.high);
        const lows  = haCandles.map(cd => cd.low);

        const almaHigh = alma(highs, engineConfig.ALMA_LEN, engineConfig.ALMA_OFFSET, engineConfig.ALMA_SIGMA);
        const almaLow  = alma(lows,  engineConfig.ALMA_LEN, engineConfig.ALMA_OFFSET, engineConfig.ALMA_SIGMA);
        if (almaHigh === null || almaLow === null) return;

        // ATR for the SL trail — atr() only needs high/low/close, works the
        // same on raw candles as on HA ones. Same ST_ATR_LEN window as the
        // other strategy so ATR_SL_MULT means the same thing in both.
        const atrVal = atr(rawCandles, engineConfig.ST_ATR_LEN);

        // Bands AND the buy/sell comparison now both run on HA — smooths
        // out the whole signal the same way HA smooths ST1/RSI/SMA9 in the
        // other strategy. rawCandle.close (actual LTP) is still what's
        // used for order price / PnL math throughout — only the band
        // calculation and the signal comparison use HA.
        const haCloseVal = haCandles[haCandles.length - 1].close;

        await runSignals(rawCandle.close, almaHigh, almaLow, atrVal, haCloseVal);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "ALMA_BAND";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// ALMA_FAST — from the user-provided Pine script ("TAlgo — Dual ALMA for
// Natgas"). Per instruction, only the FAST engine is implemented — the
// SLOW ALMA crossover engine from that script is deliberately excluded.
//
// This is NOT a band strategy like ALMA_BAND — there's only one ALMA line
// here, computed on HA close (fast_len=20, offset=0.85, sigma=6, all on
// engineConfig.ALMA_FAST_*). The signal is the line's SLOPE flipping
// direction, not price crossing anything.
//
// WHIPSAW CONTROL (this port's own addition — the Pine script has none):
// the raw script flips color/signal on literally any slope change, which
// flip-flops constantly in a sideways market. Two independent brakes:
//   1. DEADBAND — classifies each candle's slope into three states, not
//      two: BULL (rising past ALMA_FAST_DEADBAND_ATR_MULT x ATR), BEAR
//      (falling past the same threshold), or NEUTRAL/"grey" (anything
//      smaller). NEUTRAL neither opens nor closes a position — it holds
//      whatever's already there and waits for a real move. A flip only
//      fires on a transition INTO a decisive state (BULL/BEAR) FROM a
//      different one — grey wobbles in between don't count as a direction
//      change, so a BULL -> grey -> BULL sequence isn't a flip at all.
//   2. CHOP FILTER — blocks NEW entries (not exits) when the Choppiness
//      Index says the market is sideways (USE_ALMA_FAST_CHOP_FILTER /
//      ALMA_FAST_CHOP_MAX), independent of and in addition to the deadband.
//
// Detecting a slope needs two consecutive ALMA values (now, one candle
// back) — alma() always operates on the last N elements of whatever array
// it's handed, so passing a progressively shorter slice of the HA-close
// array gives each historical value directly, no separate "ALMA series"
// function needed.
//
// Entry:   a decisive flip (see above) while flat.
// Exit:    the OPPOSITE decisive flip closes an open position, same
//          trigger that opens the new one — same pattern as
//          DPI_TREND_MEANREV's MEANREV regime (an exit and a fresh
//          flip-entry can land on the same candle, intentional, not a
//          bug). A NEUTRAL/grey candle does neither.
// SL:      same ATR trail as the other two strategies (ATR_SL_MULT x
//          ATR(ST_ATR_LEN)) — risk management only, not part of the
//          entry/exit decision.
// state.positionSource = "ALMA_FAST" — keeps this strategy's exits from
//          ever acting on a position a different strategy opened.
function createAlmaFastStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    // Persists across candles — grey periods don't reset "what direction
    // were we last decisively in", that's the whole point of the deadband.
    let lastDecisiveState = null; // "BULL" | "BEAR" | null (never decided yet)

    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    async function runSignals(price, flipSide, atrVal, currentState, chopOk) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const clr  = currentState === "BULL" ? "▲" : currentState === "BEAR" ? "▼" : "●"; // grey = neutral dot
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} FAST ${clr} ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit: opposite flip closes the open position, before the entry
        // block below (possibly) re-opens on the same trigger. Not gated
        // by chopOk — chop only blocks NEW entries, exiting an existing
        // position on a genuine reversal is risk management, not a bet.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "ALMA_FAST" && flipSide && flipSide !== state.position) {
            const closed = await orders.exit(state.position);
            if (engineConfig.LIVE_ORDERS && closed === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (ALMA_FAST_FLIP) — will retry next candle`));
            } else {
                tg(`${state.position} EXIT (ALMA_FAST_FLIP) @ ₹${livePrice.toFixed(2)}`);
                await positionsClose(livePrice, "ALMA_FAST_FLIP");
                slStore.clearTrail();
                targetStore.clearTarget();
                persist(null, 0);
            }
        }

        // Entry: a decisive flip while flat, AND the market isn't flagged
        // too choppy to bother (chopOk) — the deadband already filtered
        // out small wiggles by the time flipSide is non-null here; chopOk
        // is the second, independent brake.
        if (engineConfig.ENGINE_ENABLED && !state.position && flipSide && canEnter() && chopOk) {
            const side = flipSide;
            const ordered = await orders.enter(side);
            if (engineConfig.LIVE_ORDERS && ordered === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
            } else {
                const slTrail = computeTrail(livePrice, atrVal, side);

                state.position    = side;
                state.entryPrice  = livePrice;
                state.positionSource = "ALMA_FAST";
                state.openTradeId = await db.insertOpenTrade(
                    context.tgPrefix, context.symbol, side, context.lots, livePrice
                );

                const trailValid =
                    slTrail !== null &&
                    ((side === "LONG"  && slTrail < livePrice) ||
                     (side === "SHORT" && slTrail > livePrice));
                if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                persist(side, livePrice, "ALMA_FAST");
                console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (ALMA_FAST) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}`));
                emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                tg(`${side} ENTRY (ALMA_FAST) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}`);
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        // Needs 2 consecutive ALMA values (current, -1) for slope, plus
        // whatever CHOP_LEN needs — warmup is the largest of those plus a
        // margin, same +5 buffer pattern as the other two strategies.
        const warmupNeeded = Math.max(engineConfig.ALMA_FAST_LEN, engineConfig.ST_ATR_LEN, engineConfig.CHOP_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        const haCandles = toHA(rawCandles);
        const haCloses  = haCandles.map(cd => cd.close);

        const a0 = alma(haCloses,             engineConfig.ALMA_FAST_LEN, engineConfig.ALMA_FAST_OFFSET, engineConfig.ALMA_FAST_SIGMA);
        const a1 = alma(haCloses.slice(0, -1), engineConfig.ALMA_FAST_LEN, engineConfig.ALMA_FAST_OFFSET, engineConfig.ALMA_FAST_SIGMA);
        if (a0 === null || a1 === null) return;

        const atrVal = atr(rawCandles, engineConfig.ST_ATR_LEN);

        // Deadband classification — slope must clear ALMA_FAST_DEADBAND_ATR_MULT
        // x ATR to count as a real direction. atrVal === null (shouldn't
        // happen past warmup, but defensively) falls back to a 0 deadband,
        // i.e. plain binary classification rather than silently treating
        // everything as neutral.
        const slope    = a0 - a1;
        const deadband = atrVal !== null ? engineConfig.ALMA_FAST_DEADBAND_ATR_MULT * atrVal : 0;
        const currentState = slope > deadband ? "BULL" : slope < -deadband ? "BEAR" : "NEUTRAL";

        // A flip only fires transitioning INTO a decisive state FROM a
        // different one — NEUTRAL candles neither trigger a flip nor
        // overwrite lastDecisiveState, so a BULL -> grey -> BULL sequence
        // isn't seen as a direction change at all.
        let flipSide = null;
        if (currentState !== "NEUTRAL" && currentState !== lastDecisiveState) {
            flipSide = currentState === "BULL" ? "LONG" : "SHORT";
        }
        if (currentState !== "NEUTRAL") lastDecisiveState = currentState;

        const chopArr = choppinessIndex(rawCandles, engineConfig.CHOP_LEN);
        const chopVal = chopArr[chopArr.length - 1];
        const chopOk  = !engineConfig.USE_ALMA_FAST_CHOP_FILTER || (chopVal !== null && chopVal <= engineConfig.ALMA_FAST_CHOP_MAX);

        await runSignals(rawCandle.close, flipSide, atrVal, currentState, chopOk);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "ALMA_FAST";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// MA_SLOPE — from the user-provided Pine script ("Moving Average Slope
// [aamonkey]"). Single line, three colors, same overall shape as ALMA_FAST
// (one indicator, GREEN/RED/GREY, entry+exit on a color flip) — but the
// indicator itself and its grey zone are both completely different:
//
// - Source is RAW ohlc4 ((open+high+low+close)/4), NOT Heikin-Ashi close —
//   the script never converts to HA, same reasoning as DPI_SMA5_EXIT and
//   ALMA_DUAL_BAND_SMA5 for staying on raw candles throughout.
// - The line itself is ema(ohlc4, MA_SLOPE_LEN) — needed indicators.js to
//   grow a plain ema() function, since nothing in this codebase used one
//   before (ALMA_FAST uses alma(), DPI uses Wilder-style ATR smoothing —
//   neither is a plain EMA).
// - The "slope" isn't a raw difference the way ALMA_FAST's is — it's an
//   ANGLE in degrees: atan((ma_now - ma_prev) / atr(MA_SLOPE_ATR_LEN)) x
//   (180/π), ported exactly as the script computes it, including using the
//   RAW candles' own ATR (not the ema line's own volatility) as the
//   normalizer — same as the script's `atr(14)` call, which reads the
//   chart's ATR, not a series derived from `_src`.
// - UPDATED: grey no longer means "no entries, full stop." Per instruction,
//   GREY now falls back to the existing ALMA_BAND breakout logic — the
//   SAME high/low ALMA-band check ALMA_BAND itself uses (same HA-candle
//   convention, same ALMA_LEN/ALMA_OFFSET/ALMA_SIGMA config — genuinely
//   reused, not duplicated; identical fallback shape to what
//   ALMA_DUAL_BAND_SMA5 already does when its two lines disagree). HA
//   close above almaHigh -> LONG, below almaLow -> SHORT, inside the band
//   -> no entry. This only matters while flat and only in GREY — a
//   decisive BULL/BEAR flip still takes priority and fires its own entry
//   as before.
//
// Entry:  a decisive flip (angle crosses out of the grey zone into a
//         DIFFERENT decisive state than the last one) while flat — same
//         edge-triggered pattern as ALMA_FAST, so a color that's been
//         steady for many candles doesn't re-enter on every single one of
//         them. This IS an interpretive choice beyond your literal
//         instruction ("when color flips exit" only states the exit side
//         explicitly) — flagging it in case you actually wanted a
//         level-based entry (enter whenever the color IS aqua/yellow,
//         re-firing every candle) instead of edge-triggered; easy to
//         change if so.
//         GREY, while flat, instead checks the ALMA_BAND breakout (above
//         high band = buy, below low band = sell) every candle — this
//         piece IS level-based/re-firing, matching how ALMA_BAND itself
//         behaves, not edge-triggered like the BULL/BEAR flip above.
// Exit:   the opposite decisive flip closes an open position — direct port
//         of "when color flips exit." This is UNCHANGED and applies no
//         matter which mechanism opened the position (decisive flip or
//         GREY-band fallback) — positionSource stays "MA_SLOPE" either
//         way, same single-exit-mechanism approach ALMA_DUAL_BAND_SMA5
//         uses (one exit rule, regardless of entry mechanism).
//         UPDATED (per instruction: "exits should happen when candles
//         enter inside alma band even when it is in trend cause ma is
//         lagging"): the band's own re-entry ALSO closes the position now,
//         regardless of which path opened it — ema(56) is slow, so this
//         gives a faster, price-driven exit instead of waiting for the
//         lagging angle to decisively reverse. A position now exits on
//         EITHER the opposite flip OR price re-entering the ALMA band,
//         whichever comes first.
//         A grey candle with an existing position still does not trigger
//         the FLIP exit path (grey holds through that path) — but the
//         band-reentry check above runs on every candle regardless of
//         currentState, so it can still fire while GREY too.
// SL:     the Pine script has no stop-loss logic at all (it's a plotting-
//         only indicator, not even a strategy() with entries) — this port
//         adds the same ATR_SL_MULT x ATR(ST_ATR_LEN) trail every other
//         strategy here uses, computed on raw candles, independent of the
//         MA_SLOPE_ATR_LEN(14) used inside the angle formula itself.
// state.positionSource = "MA_SLOPE".
// ════════════════════════════════════════════════════════════════════════
function createMaSlopeStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    // Persists across candles — grey periods don't reset "what direction
    // were we last decisively in", same reasoning as ALMA_FAST.
    let lastDecisiveState = null; // "BULL" | "BEAR" | null (never decided yet)

    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    // Fixed favorable-exit target — now armed generically by candlePoll.js's
    // checkTarget() off context.targetPoints (toolbox prompt), same as every
    // other strategy, not by this function anymore. MA_SLOPE_TARGET_POINTS
    // (engineConfig.js) is superseded — left in place for reference only.

    async function runSignals(price, flipSide, entrySide, entryReason, atrVal, currentState, almaHigh, almaLow, haCloseVal) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const clr  = currentState === "BULL" ? "▲" : currentState === "BEAR" ? "▼" : "●"; // grey = neutral dot
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} SLOPE ${clr} ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit 1: opposite flip closes the open position — direct port of
        // "when color flips exit." Checked first, same as ALMA_FAST, so a
        // flip on the same candle can both close the old position and open
        // the new one. Applies no matter which mechanism opened the
        // position (decisive flip or GREY-band fallback).
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "MA_SLOPE" && flipSide && flipSide !== state.position) {
            const closed = await orders.exit(state.position);
            if (engineConfig.LIVE_ORDERS && closed === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (MA_SLOPE_FLIP) — will retry next candle`));
            } else {
                tg(`${state.position} EXIT (MA_SLOPE_FLIP) @ ₹${livePrice.toFixed(2)}`);
                await positionsClose(livePrice, "MA_SLOPE_FLIP");
                slStore.clearTrail();
                targetStore?.clearTarget();
                persist(null, 0);
                state.maSlopeEntryReason = null;
            }
        }

        // Exit 2: price re-enters the band — CHANGED per instruction ("exits
        // should happen when candles enter inside alma band even when it is
        // in trend cause ma is lagging", applied to strategies 7 and 8
        // both): now fires for a position opened via EITHER entry path, not
        // only the GREY-state ALMA_BAND fallback. Rationale: ema(56) is
        // slow, so Exit 1's opposite-flip signal lags — by the time the
        // ema angle itself decisively reverses, price has often already
        // round-tripped back into the band. Same reentry condition
        // ALMA_BAND's own strategy uses.
        // CAVEAT: state.maSlopeEntryReason lives in memory only — it is not
        // persisted. That no longer matters for GATING this exit (it now
        // fires regardless of entry reason), but the CAVEAT below about tg
        // messaging after a restart still stands.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "MA_SLOPE" &&
            almaHigh !== null && almaLow !== null) {
            const reentered =
                (state.position === "LONG"  && haCloseVal < almaHigh) ||
                (state.position === "SHORT" && haCloseVal > almaLow);
            if (reentered) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (ALMA_REENTRY) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (ALMA_REENTRY) @ ₹${livePrice.toFixed(2)}\nHA close ${haCloseVal.toFixed(2)} re-entered band [${almaLow.toFixed(2)}, ${almaHigh.toFixed(2)}]`);
                    await positionsClose(livePrice, "ALMA_REENTRY");
                    slStore.clearTrail();
                    targetStore?.clearTarget();
                    persist(null, 0);
                    state.maSlopeEntryReason = null;
                }
            }
        }

        // Entry — side/reason already resolved by processCandle: either a
        // decisive BULL/BEAR flip (entryReason "MA_SLOPE_FLIP"), or, when
        // GREY, the ALMA_BAND breakout fallback (entryReason
        // "ALMA_BAND_BREAKOUT"). This block just executes whichever one
        // fired — same pattern as ALMA_DUAL_BAND_SMA5's entry block.
        if (engineConfig.ENGINE_ENABLED && !state.position && entrySide && canEnter()) {
            const side = entrySide;
            const ordered = await orders.enter(side);
            if (engineConfig.LIVE_ORDERS && ordered === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
            } else {
                const slTrail = computeTrail(livePrice, atrVal, side);

                state.position    = side;
                state.entryPrice  = livePrice;
                state.positionSource = "MA_SLOPE";
                state.maSlopeEntryReason = entryReason;
                state.openTradeId = await db.insertOpenTrade(
                    context.tgPrefix, context.symbol, side, context.lots, livePrice
                );

                const trailValid =
                    slTrail !== null &&
                    ((side === "LONG"  && slTrail < livePrice) ||
                     (side === "SHORT" && slTrail > livePrice));
                if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                // Target no longer armed here — candlePoll.js's checkTarget()
                // arms it generically off context.targetPoints on the next
                // tick, same mechanism every other strategy now uses.

                persist(side, livePrice, "MA_SLOPE");
                console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (${entryReason}) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}`));
                emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                tg(`${side} ENTRY (${entryReason}) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}`);
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour.
        // The target is NOT refreshed — fixed from entry, same as
        // MA_SLOPE_SCALP's original design.
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        // Needs MA_SLOPE_LEN to seed the EMA, plus one more candle back for
        // the slope's "previous" value, plus MA_SLOPE_ATR_LEN/ST_ATR_LEN for
        // the two separate ATR uses — same +5 warmup margin every other
        // strategy in this file uses.
        // ALMA_LEN added to warmup — needed for the GREY-state ALMA_BAND
        // fallback below, on top of the pre-existing MA_SLOPE lengths.
        const warmupNeeded = Math.max(engineConfig.MA_SLOPE_LEN + 1, engineConfig.MA_SLOPE_ATR_LEN, engineConfig.ST_ATR_LEN, engineConfig.ALMA_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        // ohlc4 — direct port of the script's `src=input(ohlc4)` default.
        const ohlc4Series = rawCandles.map(cd => (cd.open + cd.high + cd.low + cd.close) / 4);
        const emaArr = ema(ohlc4Series, engineConfig.MA_SLOPE_LEN);

        const maNow  = emaArr[emaArr.length - 1];
        const maPrev = emaArr[emaArr.length - 2];
        if (maNow === null || maPrev === null) return;

        // atr(MA_SLOPE_ATR_LEN) on the RAW chart — same as the script's
        // `atr(14)` call inside angle(), which reads chart ATR, not
        // anything derived from the ema line itself.
        // BUG FIX (diagnosed this session, same root cause found on
        // MA_SLOPE_PURE #9 and applied here too): `atr()` is a plain simple
        // average of TR over the trailing window, not Wilder's RMA that the
        // source Pine script's `atr(14)` actually is — the two can land on
        // opposite sides of the +-2 degree GREY threshold on the same
        // candle. Switched to atrSeries() (true Wilder RMA, already used
        // elsewhere in this file) and dropped the old silent `=== 0` bail.
        const atrAngleSeries = atrSeries(rawCandles, engineConfig.MA_SLOPE_ATR_LEN);
        const atrForAngle    = atrAngleSeries[atrAngleSeries.length - 1];
        if (atrForAngle === null || atrForAngle === 0) return;

        const RAD_TO_DEG = 180 / Math.PI;
        const angle = RAD_TO_DEG * Math.atan((maNow - maPrev) / atrForAngle);

        const currentState =
            angle > engineConfig.MA_SLOPE_FILTER_TOP    ? "BULL" :
            angle < engineConfig.MA_SLOPE_FILTER_BOTTOM ? "BEAR" : "GREY";

        // A flip only fires transitioning INTO a decisive state FROM a
        // different one — GREY candles neither trigger a flip nor
        // overwrite lastDecisiveState, same pattern as ALMA_FAST.
        let flipSide = null;
        if (currentState !== "GREY" && currentState !== lastDecisiveState) {
            flipSide = currentState === "BULL" ? "LONG" : "SHORT";
        }
        if (currentState !== "GREY") lastDecisiveState = currentState;

        // ALMA band — computed every candle now (not just in GREY), same
        // HA-candle bands ALMA_BAND itself uses. Needed for the GREY entry
        // fallback below AND for the reentry exit check in runSignals (a
        // band-fallback position exits when price re-enters the band, same
        // as ALMA_BAND's own exit — added per instruction since that's
        // "where more uncertainty exists").
        const haCandles  = toHA(rawCandles);
        const highs      = haCandles.map(cd => cd.high);
        const lows       = haCandles.map(cd => cd.low);
        const almaHigh   = alma(highs, engineConfig.ALMA_LEN, engineConfig.ALMA_OFFSET, engineConfig.ALMA_SIGMA);
        const almaLow    = alma(lows,  engineConfig.ALMA_LEN, engineConfig.ALMA_OFFSET, engineConfig.ALMA_SIGMA);
        const haCloseVal = haCandles[haCandles.length - 1].close;

        // ── Resolve entry side + reason ────────────────────────────────────
        // CHANGED per instruction: entry is now LEVEL-based on currentState,
        // not edge-triggered on flipSide. Previously, if the strategy went
        // flat while already mid-trend (a restart, or exited via SL/band-
        // reentry with the trend still intact), NOTHING would re-enter it —
        // flipSide only fires the single candle the state actually changes,
        // and by the time you're flat again lastDecisiveState usually
        // already equals the current state, so it silently never re-fires.
        // Renamed the tag from "MA_SLOPE_FLIP" to "MA_SLOPE_TREND" since
        // it's no longer specifically about the flip edge.
        // flipSide (edge-triggered, unchanged) is still used below for the
        // EXIT check only — that one SHOULD stay edge-triggered (you only
        // want to close once, right when the state actually reverses, not
        // repeatedly every candle the opposite state persists).
        // CAVEAT (flagging, not asked): this can re-enter immediately after
        // an SL/band-reentry exit if the angle is still decisively BULL/BEAR
        // on the very next candle (a pullback within a trend, not a real
        // reversal) — more re-entries, more slippage/commission exposure
        // during a choppy trend. Say the word if you'd rather add a short
        // cooldown after an SL-triggered exit specifically.
        // CHANGED again per instruction ("if the candle is in band dont
        // place order, cause maslope is giving sell signal but candle is in
        // alma band so it is in sideways"): a decisive BULL/BEAR reading is
        // no longer enough on its own — HA close must be outside the band
        // on the SAME SIDE the trend direction requires, not just outside
        // the band somewhere.
        // BUG FIX (this same session): the first version of this check used
        // `!insideBand`, which only asks "is price outside the band at
        // all" — so BEAR (sell) + price above almaHigh (a BULLISH breakout,
        // agreeing with LONG, not SHORT) still passed and fired a SHORT.
        // Caught live: "ma said sell and alma band says long and it
        // entered short". Now requires haCloseVal on the matching side:
        // BULL needs haCloseVal > almaHigh, BEAR needs haCloseVal < almaLow
        // — the same two conditions the GREY/ALMA_BAND_BREAKOUT branch
        // below already uses, just gated by currentState instead of GREY.
        // Separate ATR for the SL trail — this port's own addition, uses
        // ST_ATR_LEN (this file's standard risk-management length), NOT
        // MA_SLOPE_ATR_LEN (that one's reserved for the angle formula only).
        // MOVED earlier (was after entry resolution) so the market-quality
        // gate below can reuse this same value — no second ATR calculation.
        const atrForTrail = atr(rawCandles, engineConfig.ST_ATR_LEN);

        const bandKnown = almaHigh !== null && almaLow !== null;

        let entrySide   = null;
        let entryReason = null;

        if (currentState === "BULL" && bandKnown && haCloseVal > almaHigh)      { entrySide = "LONG";  entryReason = "MA_SLOPE_TREND"; }
        else if (currentState === "BEAR" && bandKnown && haCloseVal < almaLow) { entrySide = "SHORT"; entryReason = "MA_SLOPE_TREND"; }
        else if (currentState === "GREY" && almaHigh !== null && almaLow !== null) {
            if (haCloseVal > almaHigh)      { entrySide = "LONG";  entryReason = "ALMA_BAND_BREAKOUT"; }
            else if (haCloseVal < almaLow)  { entrySide = "SHORT"; entryReason = "ALMA_BAND_BREAKOUT"; }
            // else: inside the band — no entry, same as ALMA_BAND.
        }

        // ── Market-quality gate — ENTRY ONLY, exits are never touched ──────
        // Added per instruction: skip a flip-flop-prone entry (large ATR
        // relative to a compressed ALMA band) even though the signal itself
        // resolved cleanly above. See marketQuality.js for the reasoning.
        // Only runs at all if a signal actually fired (entrySide non-null)
        // — no point logging PASS/SKIP on every flat, signal-less candle.
        if (entrySide) {
            const bandWidth = bandKnown ? (almaHigh - almaLow) : null;
            const quality   = evaluateMarketQuality(atrForTrail, bandWidth, engineConfig);
            if (!quality.pass) {
                console.log(c.yellow(`[${context.tgPrefix}] SKIP [ATR/BAND]\n  ATR: ${quality.atr?.toFixed(2) ?? "-"}\n  Band Width: ${quality.bandWidth?.toFixed(2) ?? "-"}\n  Reason: ${quality.reason}`));
                entrySide   = null;
                entryReason = null;
            } else {
                console.log(c.dim(`[${context.tgPrefix}] QUALITY PASS\n  ATR: ${quality.atr?.toFixed(2) ?? "-"}\n  Band Width: ${quality.bandWidth?.toFixed(2) ?? "-"}\n  Proceeding with breakout.`));
            }
        }

        await runSignals(rawCandle.close, flipSide, entrySide, entryReason, atrForTrail, currentState, almaHigh, almaLow, haCloseVal);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "MA_SLOPE";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// MA_SLOPE_SCALP — clone of createMaSlopeStrategy (per instruction: "new
// strategy 8, same 7th strategy but...", not a parameterized variant, so
// the two stay fully independent and neither can be broken by editing the
// other). TWO entry modes, per instruction ("capture trend when blue or
// yellow [BULL/BEAR] and scalp in grey"):
//
// 1. TREND CAPTURE — decisive BULL/BEAR flip (entryReason "MA_SLOPE_FLIP"),
//    same as MA_SLOPE's own entry. Rides the ATR SL trail like MA_SLOPE
//    does — no fixed take-profit, since capturing a real trend shouldn't
//    cut itself short at +1 point.
//
// 2. SCALP — GREY-state ALMA_BAND breakout (entryReason
//    "ALMA_BAND_BREAKOUT"), same fallback MA_SLOPE has. ONLY this mode also
//    arms a fixed favorable-exit target at engineConfig.SCALP_TARGET_POINTS
//    away from entry (currently 1 point) — checked on every WebSocket TICK
//    (candlePoll.js's checkTarget), not candle close, same tick-driven
//    mechanism the SL trail already uses (checkSL), just for the opposite
//    (favorable) direction.
//
// Both modes share the same SL trail (kept active for both, per
// instruction — "keep SL trail too, both exits active"), the same
// opposite-flip exit, AND the band-reentry exit (added to trend-capture
// too, per instruction — "ma is lagging", so the reentry gives a faster,
// price-driven exit than waiting for the slow ema angle to reverse). ONLY
// the take-profit target stays scalp-mode-exclusive — a trend-capture
// position still has no fixed target, just three ways out now (opposite
// flip, band reentry, or the ATR SL trail) instead of two. Which mode
// opened the position is tracked in state.maSlopeScalpEntryReason and
// gates the target only.
//
// ASSUMPTION (flagging, not explicitly stated): the scalp target is a
// FIXED level set once at entry — it does not trail/tighten like the SL
// does. If you want it to ratchet (e.g. re-arm +1 point further every time
// it's approached), that's a different design; easy to change if that's
// what you actually meant by "monitor favorable position."
// state.positionSource = "MA_SLOPE_SCALP".
// ════════════════════════════════════════════════════════════════════════
function createMaSlopeScalpStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    let lastDecisiveState = null; // "BULL" | "BEAR" | null (never decided yet)
    let prevState = null;         // "BULL" | "BEAR" | "GREY" | null — tracks the RAW state each
                                   // candle (unlike lastDecisiveState, which skips GREY), purely so
                                   // the GREY-entry log below can fire once on the transition INTO
                                   // GREY, not every single GREY candle.

    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    // CHANGED (this session): was SCALP_TARGET_POINTS, armed ONLY for
    // GREY/ALMA_BAND_BREAKOUT (scalp-mode) entries. Per instruction, the new
    // fixed-target feature applies to "all three" MA_SLOPE variants and both
    // entry modes here, so this now uses the shared MA_SLOPE_TARGET_POINTS
    // config and arms on every entry, same as #7/#9 — SCALP_TARGET_POINTS is
    // no longer read anywhere, left in engineConfig.js for reference only.
    // Fixed favorable-exit level, set once at entry, not refreshed/trailed
    // candle to candle (see header ASSUMPTION).
    function computeTarget(entryPrice, side) {
        return side === "LONG" ? entryPrice + engineConfig.MA_SLOPE_TARGET_POINTS
                                : entryPrice - engineConfig.MA_SLOPE_TARGET_POINTS;
    }

    async function runSignals(price, flipSide, entrySide, entryReason, atrVal, currentState, almaHigh, almaLow, haCloseVal) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const clr  = currentState === "BULL" ? "▲" : currentState === "BEAR" ? "▼" : "●"; // grey = neutral dot
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} SCALP ${clr} ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit 1: opposite flip closes the open position — same as MA_SLOPE.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "MA_SLOPE_SCALP" && flipSide && flipSide !== state.position) {
            const closed = await orders.exit(state.position);
            if (engineConfig.LIVE_ORDERS && closed === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (MA_SLOPE_FLIP) — will retry next candle`));
            } else {
                tg(`${state.position} EXIT (MA_SLOPE_FLIP) @ ₹${livePrice.toFixed(2)}`);
                await positionsClose(livePrice, "MA_SLOPE_FLIP");
                slStore.clearTrail();
                targetStore.clearTarget();
                persist(null, 0);
                state.maSlopeScalpEntryReason = null;
            }
        }

        // Exit 2: price re-enters the band — CHANGED per instruction ("exits
        // should happen when candles enter inside alma band even when it is
        // in trend cause ma is lagging"): this now applies to BOTH entry
        // modes, not just scalp entries. Rationale: ema(56) is slow, so
        // Exit 1's opposite-flip signal lags — by the time the ema angle
        // itself decisively reverses, price has often already round-tripped
        // back into the band. The band reentry is a faster, price-driven
        // signal that doesn't wait for the lagging MA to catch up, so it's
        // now a legitimate exit for a trend-capture position too, not only
        // a scalp one. (This change is scoped to MA_SLOPE_SCALP only —
        // MA_SLOPE itself, strategy #7, is untouched.)
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "MA_SLOPE_SCALP" &&
            almaHigh !== null && almaLow !== null) {
            const reentered =
                (state.position === "LONG"  && haCloseVal < almaHigh) ||
                (state.position === "SHORT" && haCloseVal > almaLow);
            if (reentered) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (ALMA_REENTRY) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (ALMA_REENTRY) @ ₹${livePrice.toFixed(2)}\nHA close ${haCloseVal.toFixed(2)} re-entered band [${almaLow.toFixed(2)}, ${almaHigh.toFixed(2)}]`);
                    await positionsClose(livePrice, "ALMA_REENTRY");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                    state.maSlopeScalpEntryReason = null;
                }
            }
        }

        // Note: the take-profit exit itself does NOT happen here — it
        // fires from candlePoll.js's checkTarget() on a WebSocket tick, not
        // from candle-close processing. This block only ARMS the target
        // (below, at entry) and refreshes SL; checkTarget owns firing it.

        // Entry — two modes: decisive BULL/BEAR flip = "trend capture"
        // (entryReason "MA_SLOPE_FLIP"), GREY-state ALMA_BAND breakout =
        // "scalp" (entryReason "ALMA_BAND_BREAKOUT"). CHANGED (this
        // session): both modes now arm the tick-level target — previously
        // only scalp entries did (see computeTarget's header comment).
        if (engineConfig.ENGINE_ENABLED && !state.position && entrySide && canEnter()) {
            const side = entrySide;
            const ordered = await orders.enter(side);
            if (engineConfig.LIVE_ORDERS && ordered === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
            } else {
                const slTrail = computeTrail(livePrice, atrVal, side);
                const target  = computeTarget(livePrice, side);

                state.position    = side;
                state.entryPrice  = livePrice;
                state.positionSource = "MA_SLOPE_SCALP";
                state.maSlopeScalpEntryReason = entryReason;
                state.openTradeId = await db.insertOpenTrade(
                    context.tgPrefix, context.symbol, side, context.lots, livePrice
                );

                const trailValid =
                    slTrail !== null &&
                    ((side === "LONG"  && slTrail < livePrice) ||
                     (side === "SHORT" && slTrail > livePrice));
                if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                // Arm the tick-level take-profit — checked by checkTarget(),
                // not here. dir 1 = exit when price >= target (LONG), -1 =
                // exit when price <= target (SHORT).
                targetStore.setTarget(target, side === "LONG" ? 1 : -1);

                persist(side, livePrice, "MA_SLOPE_SCALP");
                console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (${entryReason}) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}  Tgt:${target.toFixed(2)}`));
                emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                tg(`${side} ENTRY (${entryReason}) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}\nTarget: ₹${target.toFixed(2)}`);
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour.
        // The target is deliberately NOT refreshed here — it stays fixed
        // from entry (see header ASSUMPTION).
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        const warmupNeeded = Math.max(engineConfig.MA_SLOPE_LEN + 1, engineConfig.MA_SLOPE_ATR_LEN, engineConfig.ST_ATR_LEN, engineConfig.ALMA_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        const ohlc4Series = rawCandles.map(cd => (cd.open + cd.high + cd.low + cd.close) / 4);
        const emaArr = ema(ohlc4Series, engineConfig.MA_SLOPE_LEN);

        const maNow  = emaArr[emaArr.length - 1];
        const maPrev = emaArr[emaArr.length - 2];
        if (maNow === null || maPrev === null) return;

        // BUG FIX (same as #7/#9): plain-average atr() swapped for
        // atrSeries()'s true Wilder RMA to match the source Pine script's
        // atr(14).
        const atrAngleSeries = atrSeries(rawCandles, engineConfig.MA_SLOPE_ATR_LEN);
        const atrForAngle    = atrAngleSeries[atrAngleSeries.length - 1];
        if (atrForAngle === null || atrForAngle === 0) return;

        const RAD_TO_DEG = 180 / Math.PI;
        const angle = RAD_TO_DEG * Math.atan((maNow - maPrev) / atrForAngle);

        const currentState =
            angle > engineConfig.MA_SLOPE_FILTER_TOP    ? "BULL" :
            angle < engineConfig.MA_SLOPE_FILTER_BOTTOM ? "BEAR" : "GREY";

        let flipSide = null;
        if (currentState !== "GREY" && currentState !== lastDecisiveState) {
            flipSide = currentState === "BULL" ? "LONG" : "SHORT";
        }
        if (currentState !== "GREY") lastDecisiveState = currentState;

        // Log once on each transition — trend capture (into BULL/BEAR) and
        // scalp (into GREY) are now two distinct modes within this one
        // strategy (per instruction: "capture trend when blue or yellow
        // [BULL/BEAR] and scalp in grey"), so both get their own one-shot
        // activation log. prevState (not lastDecisiveState) drives this
        // since lastDecisiveState skips GREY entirely and would never show
        // the transition into it.
        if (currentState === "GREY" && prevState !== "GREY") {
            console.log(c.cyan(`[${context.tgPrefix}] SCALP ACTIVATED — MA_SLOPE in GREY, switched to ALMA_BAND monitoring`));
            tg(`🔎 SCALP ACTIVATED [${context.tgPrefix}]\nMA_SLOPE in GREY — now monitoring ALMA_BAND breakout`);
            emitEvent(context.tgPrefix, "MODE", { label: "SCALP ACTIVATED", detail: "MA_SLOPE in GREY — monitoring ALMA_BAND" });
        } else if (currentState !== "GREY" && currentState !== prevState) {
            console.log(c.cyan(`[${context.tgPrefix}] TREND CAPTURE — MA_SLOPE ${currentState}`));
            tg(`📈 TREND CAPTURE [${context.tgPrefix}]\nMA_SLOPE ${currentState} — trend-following entry armed`);
            emitEvent(context.tgPrefix, "MODE", { label: "TREND CAPTURE", detail: `MA_SLOPE ${currentState}` });
        }
        prevState = currentState;

        const haCandles  = toHA(rawCandles);
        const highs      = haCandles.map(cd => cd.high);
        const lows       = haCandles.map(cd => cd.low);
        const almaHigh   = alma(highs, engineConfig.ALMA_LEN, engineConfig.ALMA_OFFSET, engineConfig.ALMA_SIGMA);
        const almaLow    = alma(lows,  engineConfig.ALMA_LEN, engineConfig.ALMA_OFFSET, engineConfig.ALMA_SIGMA);
        const haCloseVal = haCandles[haCandles.length - 1].close;

        let entrySide   = null;
        let entryReason = null;

        // CHANGED again per instruction: trend-capture entry is now LEVEL-
        // based on currentState, not edge-triggered on flipSide — same fix
        // as MA_SLOPE (#7) got, same reason: if this strategy goes flat
        // while already mid-trend (a restart, or exited via SL/band-reentry
        // with the trend still intact), flipSide alone would silently never
        // re-fire since lastDecisiveState already matches currentState.
        // Renamed the tag from "MA_SLOPE_FLIP" to "MA_SLOPE_TREND" to match
        // — the isScalp check in runSignals below still keys off
        // entryReason === "ALMA_BAND_BREAKOUT", so this rename doesn't
        // change which mode gets the take-profit target.
        // flipSide (edge-triggered, unchanged) is still used for the EXIT
        // check only, which should stay edge-triggered.
        // CAVEAT (same as MA_SLOPE, flagging not asked): can re-enter
        // immediately after an SL/band-reentry exit if still decisively
        // trending on the next candle — more re-entries during a choppy
        // trend. Say the word if you want a cooldown after an SL exit.
        // ALSO CHANGED (same as MA_SLOPE #7, "if the candle is in band dont
        // place order"): a decisive BULL/BEAR reading alone is no longer
        // enough — HA close must be outside the band on the SAME SIDE the
        // trend direction requires.
        // BUG FIX (this same session, same as #7): the first version used
        // `!insideBand`, which only checks "outside the band at all" — so
        // BEAR + price above almaHigh (a bullish breakout) still passed and
        // fired a SHORT. Caught live: "ma said sell and alma band says
        // long and it entered short". Now requires the matching side:
        // BULL needs haCloseVal > almaHigh, BEAR needs haCloseVal < almaLow.
        const bandKnown = almaHigh !== null && almaLow !== null;

        if (currentState === "BULL" && bandKnown && haCloseVal > almaHigh)      { entrySide = "LONG";  entryReason = "MA_SLOPE_TREND"; }
        else if (currentState === "BEAR" && bandKnown && haCloseVal < almaLow) { entrySide = "SHORT"; entryReason = "MA_SLOPE_TREND"; }
        else if (currentState === "GREY" && almaHigh !== null && almaLow !== null) {
            if (haCloseVal > almaHigh)      { entrySide = "LONG";  entryReason = "ALMA_BAND_BREAKOUT"; }
            else if (haCloseVal < almaLow)  { entrySide = "SHORT"; entryReason = "ALMA_BAND_BREAKOUT"; }
        }

        // Separate ATR for the SL trail — MOVED earlier (was after entry
        // resolution) so the market-quality gate below can reuse this same
        // value instead of computing ATR twice.
        const atrForTrail = atr(rawCandles, engineConfig.ST_ATR_LEN);

        // ── Market-quality gate — ENTRY ONLY, exits are never touched ──────
        // Same gate as MA_SLOPE (#7) — see marketQuality.js. Only runs if a
        // signal actually fired (entrySide non-null).
        if (entrySide) {
            const bandWidth = bandKnown ? (almaHigh - almaLow) : null;
            const quality   = evaluateMarketQuality(atrForTrail, bandWidth, engineConfig);
            if (!quality.pass) {
                console.log(c.yellow(`[${context.tgPrefix}] SKIP [ATR/BAND]\n  ATR: ${quality.atr?.toFixed(2) ?? "-"}\n  Band Width: ${quality.bandWidth?.toFixed(2) ?? "-"}\n  Reason: ${quality.reason}`));
                entrySide   = null;
                entryReason = null;
            } else {
                console.log(c.dim(`[${context.tgPrefix}] QUALITY PASS\n  ATR: ${quality.atr?.toFixed(2) ?? "-"}\n  Band Width: ${quality.bandWidth?.toFixed(2) ?? "-"}\n  Proceeding with breakout.`));
            }
        }

        await runSignals(rawCandle.close, flipSide, entrySide, entryReason, atrForTrail, currentState, almaHigh, almaLow, haCloseVal);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "MA_SLOPE_SCALP";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                    // NOTE: the scalp target is NOT restored here (same
                    // in-memory-only caveat as maSlopeScalpEntryReason) — a
                    // position resumed after a restart keeps its SL trail
                    // (also re-armed on the next refresh below) but has no
                    // active take-profit target until a fresh entry.
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// MA_SLOPE_PURE — the ema(56) angle color, and NOTHING else. No ALMA band
// anywhere in this one (unlike MA_SLOPE/MA_SLOPE_SCALP, which both now
// depend on the band for entry confirmation AND for the reentry exit) —
// per instruction, this is meant to be the plain baseline: "pure ma slope
// entries based on color and exit if color changes and no trade in grey
// state." A separate strategy, not a mode switch on #7/#8, so all the
// ALMA-related changes made to those two stay fully isolated from this one.
//
// Entry:  LEVEL-based on currentState while flat — BULL -> LONG, BEAR ->
//         SHORT, fires every candle the color reads decisively either way
//         (not just on the flip edge — same level-based choice made for
//         MA_SLOPE/MA_SLOPE_SCALP's trend entries, for the same reason: if
//         flat while the color is already decisive, still enter).
// Exit:   EDGE-triggered — only when the color actually CHANGES to the
//         opposite decisive state ("exit if color changes"), same
//         flipSide mechanism MA_SLOPE originally had before the band
//         reentry exit was added to it. No band-reentry exit here — there
//         is no band at all in this strategy.
// GREY:   no entries, full stop ("no trade in grey state") — a grey candle
//         also does NOT close an existing position; it just holds,
//         waiting for a decisive color either way.
// SL:     same ATR_SL_MULT x ATR(ST_ATR_LEN) trail every other strategy in
//         this file uses — the underlying Pine script has no stop-loss of
//         its own, same reasoning as MA_SLOPE's own SL addition.
// SMA9:   a second, independent exit — HA close crosses SMA(9) against the
//         position, but ONLY once the slope angle already confirms a
//         clearly one-sided move (> MA_SLOPE_PURE_SMA9_EXIT_ANGLE degrees
//         for a LONG, < -that for a SHORT — a stronger bar than the plain
//         +-2 degree BULL/BEAR split used for entries). Either this or the
//         flip/GREY exit above can close the position, whichever fires
//         first on a given candle.
// state.positionSource = "MA_SLOPE_PURE".
// ════════════════════════════════════════════════════════════════════════
function createMaSlopePureStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    let lastDecisiveState = null; // "BULL" | "BEAR" | null (never decided yet)

    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    async function runSignals(price, flipSide, entrySide, atrVal, currentState, angle, haCloseVal, sma9Val) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const clr  = currentState === "BULL" ? "▲" : currentState === "BEAR" ? "▼" : "●";
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} PURE ${clr} ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit: SMA9 reversal — a second, faster exit alongside the opposite-
        // color-flip/GREY exit below, gated by MA_SLOPE_PURE_SMA9_EXIT_ANGLE
        // so it only checks once the slope has already confirmed a clearly
        // one-sided move (not on a marginal decisive-but-barely candle).
        // Independent trigger — either this or the flip/GREY exit below can
        // close the position, whichever fires first.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "MA_SLOPE_PURE" && sma9Val !== null) {
            const angleConfirms =
                (state.position === "LONG"  && angle >  engineConfig.MA_SLOPE_PURE_SMA9_EXIT_ANGLE) ||
                (state.position === "SHORT" && angle < -engineConfig.MA_SLOPE_PURE_SMA9_EXIT_ANGLE);
            const smaReversed =
                (state.position === "SHORT" && haCloseVal > sma9Val) ||
                (state.position === "LONG"  && haCloseVal < sma9Val);
            if (angleConfirms && smaReversed) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (MA_SLOPE_PURE_SMA9) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (MA_SLOPE_PURE_SMA9) @ ₹${livePrice.toFixed(2)}\nangle:${angle.toFixed(1)}°  HA close ${haCloseVal.toFixed(2)} crossed SMA9 ${sma9Val.toFixed(2)}`);
                    await positionsClose(livePrice, "MA_SLOPE_PURE_SMA9");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                }
            }
        }

        // Exit: color change to the opposite decisive state, OR a flip into
        // GREY — both close the position now. CHANGED (this session, live
        // incident): GREY used to only hold; user wants it treated as an
        // exit signal too, no more sitting through GREY on an open position.
        // Still level-based for GREY (fires every candle currentState is
        // GREY while a position is open — harmless since positionsClose
        // clears state.position on the first one, so it can only fire
        // once), edge-triggered for the opposite-color case (flipSide),
        // same as before.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "MA_SLOPE_PURE") {
            const flipExit = flipSide && flipSide !== state.position;
            const greyExit = currentState === "GREY";
            if (flipExit || greyExit) {
                const exitTag = greyExit ? "MA_SLOPE_PURE_GREY" : "MA_SLOPE_PURE_FLIP";
                const closed  = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (${exitTag}) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (${exitTag}) @ ₹${livePrice.toFixed(2)}`);
                    await positionsClose(livePrice, exitTag);
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                }
            }
        }

        // Entry: level-based on currentState while flat — no trade in grey
        // (entrySide is only ever non-null when currentState is decisively
        // BULL/BEAR — see processCandle below; grey never sets it).
        if (engineConfig.ENGINE_ENABLED && !state.position && entrySide && canEnter()) {
            const side = entrySide;
            const ordered = await orders.enter(side);
            if (engineConfig.LIVE_ORDERS && ordered === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
            } else {
                const slTrail = computeTrail(livePrice, atrVal, side);

                state.position    = side;
                state.entryPrice  = livePrice;
                state.positionSource = "MA_SLOPE_PURE";
                state.openTradeId = await db.insertOpenTrade(
                    context.tgPrefix, context.symbol, side, context.lots, livePrice
                );

                const trailValid =
                    slTrail !== null &&
                    ((side === "LONG"  && slTrail < livePrice) ||
                     (side === "SHORT" && slTrail > livePrice));
                if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                persist(side, livePrice, "MA_SLOPE_PURE");
                console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (MA_SLOPE_PURE) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}`));
                emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                tg(`${side} ENTRY (MA_SLOPE_PURE) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}`);
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour.
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        // No ALMA_LEN in this warmup — this strategy never touches the band.
        // SMA_LEN added for the new SMA9 reversal exit's warmup requirement.
        const warmupNeeded = Math.max(engineConfig.MA_SLOPE_LEN + 1, engineConfig.MA_SLOPE_ATR_LEN, engineConfig.ST_ATR_LEN, engineConfig.SMA_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        const ohlc4Series = rawCandles.map(cd => (cd.open + cd.high + cd.low + cd.close) / 4);
        const emaArr = ema(ohlc4Series, engineConfig.MA_SLOPE_LEN);

        const maNow  = emaArr[emaArr.length - 1];
        const maPrev = emaArr[emaArr.length - 2];
        if (maNow === null || maPrev === null) return;

        // BUG FIX (diagnosed this session): was `atr(rawCandles,
        // MA_SLOPE_ATR_LEN)` — that function (see indicators.js) is a
        // plain SIMPLE AVERAGE of True Range over the trailing window,
        // re-derived fresh each call with no memory outside that window.
        // The Pine script's `atr(14)` this angle formula was ported from
        // is `ta.atr()`, which is Wilder's RMA — a recursive smoothing
        // that carries decaying influence from the entire prior history,
        // not just the last 14 bars. The two diverge, sometimes enough to
        // land on opposite sides of the +-2 degree GREY threshold on the
        // exact same candle — the bot reads GREY (holds, doesn't exit)
        // while the chart's real indicator already shows a decisive color.
        // This is the most likely root cause of the ZINCMINI report ("MA
        // slope visibly changed color but the position didn't exit").
        // atrSeries() (used elsewhere in this file, e.g. DPI) already
        // implements true Wilder RMA — switched to that, take the last
        // value. Also drops the old silent `=== 0` bail: a properly
        // Wilder-smoothed ATR essentially never lands on exactly zero once
        // warmed up, so this is now just the standard null/not-yet-warm
        // check, not a live risk of quietly skipping a candle's exit
        // evaluation.
        const atrAngleSeries = atrSeries(rawCandles, engineConfig.MA_SLOPE_ATR_LEN);
        const atrForAngle    = atrAngleSeries[atrAngleSeries.length - 1];
        if (atrForAngle === null || atrForAngle === 0) return;

        const RAD_TO_DEG = 180 / Math.PI;
        const angle = RAD_TO_DEG * Math.atan((maNow - maPrev) / atrForAngle);

        const currentState =
            angle > engineConfig.MA_SLOPE_FILTER_TOP    ? "BULL" :
            angle < engineConfig.MA_SLOPE_FILTER_BOTTOM ? "BEAR" : "GREY";

        // Edge-triggered flip, used for the EXIT only ("exit if color
        // changes") — grey neither fires this nor overwrites lastDecisiveState.
        let flipSide = null;
        if (currentState !== "GREY" && currentState !== lastDecisiveState) {
            flipSide = currentState === "BULL" ? "LONG" : "SHORT";
        }
        if (currentState !== "GREY") lastDecisiveState = currentState;

        // Level-based ENTRY — no ALMA band check of any kind, no trade in
        // grey. This is the one deliberate difference from MA_SLOPE/
        // MA_SLOPE_SCALP's trend entries, which now also require price to
        // have cleared the band — "pure" means color alone decides here.
        let entrySide = null;
        if (currentState === "BULL")      entrySide = "LONG";
        else if (currentState === "BEAR") entrySide = "SHORT";

        const atrForTrail = atr(rawCandles, engineConfig.ST_ATR_LEN);

        // SMA9 reversal exit inputs — HA close vs SMA(9) on HA closes, same
        // basis DPI_TREND_MEANREV's own SMA9 exit uses. Only computed here
        // for the exit gate above; entries/currentState above are unaffected
        // (still plain-close ema/atan, "pure" color logic untouched).
        const haCandles = toHA(rawCandles);
        const haCloses  = haCandles.map(cd => cd.close);
        const sma9Arr   = sma(haCloses, engineConfig.SMA_LEN);
        const sma9Val   = sma9Arr[sma9Arr.length - 1];
        const haCloseVal = haCloses[haCloses.length - 1];

        await runSignals(rawCandle.close, flipSide, entrySide, atrForTrail, currentState, angle, haCloseVal, sma9Val);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "MA_SLOPE_PURE";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// MA_SLOPE_HM — strategy #10. Same entry as MA_SLOPE_PURE (level-based on
// ema(ohlc4,56) slope-angle color, no ALMA band anywhere, no trade in GREY).
// The ONLY thing that's different is the exit: instead of PURE's
// opposite-color-flip exit, this uses the Hilega-Milega (HM) momentum
// crossover already built for DPI_TREND_MEANREV's optional HM exit —
// RSI(9) -> WMA(21) [slow/"strength"] + EMA(3) [fast/"price"], both on HA
// closes. Exit fires the candle EMA3 crosses WMA21 AGAINST the position's
// direction (LONG: was ema3>=wma21, now ema3<wma21; SHORT: mirror). Same
// ATR SL trail every MA_SLOPE variant has, no target, no quality gate —
// same "otherwise plain" shape as PURE, just a different exit signal.
// Unlike DPI_TREND_MEANREV's HM exit (engineConfig.USE_HM_EXIT, off by
// default, optional bolt-on for TREND positions only), HM is this
// strategy's ONLY exit — not gated behind that toggle, since here it's the
// whole point rather than an optional extra.
// ════════════════════════════════════════════════════════════════════════
function createMaSlopeHmStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    async function runSignals(price, entrySide, atrVal, currentState, hmPrev, hmNow) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const clr  = currentState === "BULL" ? "▲" : currentState === "BEAR" ? "▼" : "●";
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} HM ${clr} ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit: HM crossover against position direction — see header comment.
        // Edge-triggered on the actual cross (needs both hmPrev and hmNow),
        // not level-based, so it fires once, the candle it happens.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "MA_SLOPE_HM" && hmPrev && hmNow) {
            const hmCrossExit =
                (state.position === "LONG"  && hmPrev.ema3 >= hmPrev.wma21 && hmNow.ema3 < hmNow.wma21) ||
                (state.position === "SHORT" && hmPrev.ema3 <= hmPrev.wma21 && hmNow.ema3 > hmNow.wma21);
            if (hmCrossExit) {
                const closed = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (HM_EXIT) — will retry next candle`));
                } else {
                    const e3 = hmNow.ema3.toFixed(1), w21 = hmNow.wma21.toFixed(1);
                    tg(`${state.position} EXIT (HM_EXIT) @ ₹${livePrice.toFixed(2)}\nEMA3:${e3}  WMA21:${w21}`);
                    await positionsClose(livePrice, "HM_EXIT");
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                }
            }
        }

        // Entry: identical to MA_SLOPE_PURE — level-based on currentState
        // while flat, no trade in grey.
        if (engineConfig.ENGINE_ENABLED && !state.position && entrySide && canEnter()) {
            const side = entrySide;
            const ordered = await orders.enter(side);
            if (engineConfig.LIVE_ORDERS && ordered === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
            } else {
                const slTrail = computeTrail(livePrice, atrVal, side);

                state.position    = side;
                state.entryPrice  = livePrice;
                state.positionSource = "MA_SLOPE_HM";
                state.openTradeId = await db.insertOpenTrade(
                    context.tgPrefix, context.symbol, side, context.lots, livePrice
                );

                const trailValid =
                    slTrail !== null &&
                    ((side === "LONG"  && slTrail < livePrice) ||
                     (side === "SHORT" && slTrail > livePrice));
                if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                persist(side, livePrice, "MA_SLOPE_HM");
                console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (MA_SLOPE_HM) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}`));
                emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                tg(`${side} ENTRY (MA_SLOPE_HM) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}`);
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour.
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        // HM needs RSI_LEN+1+WMA_LEN = 9+1+21 = 31 HA candles warmed
        // (see hmIndicator's own minLen) on top of the MA_SLOPE lengths.
        const warmupNeeded = Math.max(engineConfig.MA_SLOPE_LEN + 1, engineConfig.MA_SLOPE_ATR_LEN, engineConfig.ST_ATR_LEN, 31) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        const ohlc4Series = rawCandles.map(cd => (cd.open + cd.high + cd.low + cd.close) / 4);
        const emaArr = ema(ohlc4Series, engineConfig.MA_SLOPE_LEN);

        const maNow  = emaArr[emaArr.length - 1];
        const maPrev = emaArr[emaArr.length - 2];
        if (maNow === null || maPrev === null) return;

        // Same Wilder-RMA ATR fix as MA_SLOPE/MA_SLOPE_SCALP/MA_SLOPE_PURE.
        const atrAngleSeries = atrSeries(rawCandles, engineConfig.MA_SLOPE_ATR_LEN);
        const atrForAngle    = atrAngleSeries[atrAngleSeries.length - 1];
        if (atrForAngle === null || atrForAngle === 0) return;

        const RAD_TO_DEG = 180 / Math.PI;
        const angle = RAD_TO_DEG * Math.atan((maNow - maPrev) / atrForAngle);

        const currentState =
            angle > engineConfig.MA_SLOPE_FILTER_TOP    ? "BULL" :
            angle < engineConfig.MA_SLOPE_FILTER_BOTTOM ? "BEAR" : "GREY";

        // Level-based ENTRY — same as PURE, no ALMA band involvement.
        let entrySide = null;
        if (currentState === "BULL")      entrySide = "LONG";
        else if (currentState === "BEAR") entrySide = "SHORT";

        const atrForTrail = atr(rawCandles, engineConfig.ST_ATR_LEN);

        // HM series — same pattern as DPI_TREND_MEANREV's processCandle:
        // compute on HA closes, then scan backward for the two most recent
        // non-null entries (hmNow, hmPrev) to detect the cross on this candle.
        const haCandles = toHA(rawCandles);
        const haCloses  = haCandles.map(cd => cd.close);
        const hmArr = hmIndicator(haCloses);
        let hmNow = null, hmPrev = null;
        for (let i = hmArr.length - 1; i >= 0 && (!hmNow || !hmPrev); i--) {
            if (hmArr[i] !== null) {
                if (!hmNow)       hmNow  = hmArr[i];
                else if (!hmPrev) hmPrev = hmArr[i];
            }
        }

        await runSignals(rawCandle.close, entrySide, atrForTrail, currentState, hmPrev, hmNow);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "MA_SLOPE_HM";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// DUAL_ST_CHOP — two independent SuperTrends (a faster/tighter one and a
// slower/wider one) must AGREE on direction, gated by the Choppiness Index
// so it only enters when the market isn't ranging. This is the classic
// dual-SuperTrend + Choppiness Index combination from this project's early
// history (see project history notes) — reintroduced here as its own
// selectable strategy rather than folded back into DPI_TREND_MEANREV,
// which deliberately dropped ST2 entirely. Nothing here touches that
// strategy's ST1/DPI logic.
//
// Direction: ST1 (DST_ST1_ATR_LEN/FACTOR) and ST2 (DST_ST2_ATR_LEN/FACTOR),
//         both on HA candles, same as ST1 works in DPI_TREND_MEANREV.
// Entry:  fires only when ST1.dir === ST2.dir (both bullish or both
//         bearish) AND Choppiness Index <= DST_CHOP_MAX (market judged
//         trending, not ranging) AND the trading window is open. LONG when
//         they agree bullish, SHORT when they agree bearish.
// Exit:   the two SuperTrends stop agreeing — i.e. either one flips against
//         the position. This is the direct mirror of the entry condition:
//         entry requires agreement, exit fires the moment agreement breaks.
//         Choppiness Index is deliberately an ENTRY-only gate here, same
//         convention as CHOP_MAX/ALMA_FAST_CHOP_MAX elsewhere in this file —
//         it never triggers an exit on its own.
// SL:     same ATR trail pattern as the other strategies (ATR_SL_MULT x
//         ATR(DST_ST1_ATR_LEN)) — risk management only, not part of the
//         entry/exit decision.
// Filters: none beyond the two above — no ADX/RSI gates, matching
//         ALMA_BAND's minimalism rather than DPI_TREND_MEANREV's fuller set.
// state.positionSource = "DUAL_ST_CHOP" — kept distinct so a strategy
//         switch mid-position can't let a different strategy's exit logic
//         act on a position it didn't open.
// Timeframe: defaults to 15m in STRATEGY_TIMEFRAME below — this strategy's
//         source material (dual-ST + CHOP) didn't pin one either, so 15m
//         was picked to match this codebase's other 15m strategies rather
//         than assumed from anything strategy-specific. Easy one-line
//         change there if a different cadence was actually intended.
// ════════════════════════════════════════════════════════════════════════
function createDualStChopStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    async function runSignals(price, st1Dir, st2Dir, atrVal, chopVal) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const agree = st1Dir !== 0 && st1Dir === st2Dir;
        const clr   = !agree ? "✕" : st1Dir === 1 ? "▲" : "▼";
        const fmt   = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} ${clr} ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit: the two SuperTrends stop agreeing — direct mirror of the
        // entry condition. CHOP is not part of the exit decision.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "DUAL_ST_CHOP" && !agree) {
            const closed = await orders.exit(state.position);
            if (engineConfig.LIVE_ORDERS && closed === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (ST_DISAGREE) — will retry next candle`));
            } else {
                tg(`${state.position} EXIT (ST_DISAGREE) @ ₹${livePrice.toFixed(2)}\nST1 dir ${st1Dir}, ST2 dir ${st2Dir} — no longer agree`);
                await positionsClose(livePrice, "ST_DISAGREE");
                slStore.clearTrail();
                targetStore.clearTarget();
                persist(null, 0);
            }
        }

        // Entry: both SuperTrends agree AND the market isn't choppy.
        if (engineConfig.ENGINE_ENABLED && !state.position && canEnter() && agree) {
            const chopOk = chopVal !== null && chopVal <= engineConfig.DST_CHOP_MAX;
            if (chopOk) {
                const side = st1Dir === 1 ? "LONG" : "SHORT";
                const ordered = await orders.enter(side);
                if (engineConfig.LIVE_ORDERS && ordered === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
                } else {
                    const slTrail = computeTrail(livePrice, atrVal, side);

                    state.position    = side;
                    state.entryPrice  = livePrice;
                    state.positionSource = "DUAL_ST_CHOP";
                    state.openTradeId = await db.insertOpenTrade(
                        context.tgPrefix, context.symbol, side, context.lots, livePrice
                    );

                    const trailValid =
                        slTrail !== null &&
                        ((side === "LONG"  && slTrail < livePrice) ||
                         (side === "SHORT" && slTrail > livePrice));
                    if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                    persist(side, livePrice, "DUAL_ST_CHOP");
                    console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (DUAL_ST_CHOP) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}  CHOP:${chopVal.toFixed(1)}`));
                    emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                    tg(`${side} ENTRY (DUAL_ST_CHOP) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}\nST1/ST2 agree ${side}, CHOP ${chopVal.toFixed(1)} (<= ${engineConfig.DST_CHOP_MAX})`);
                }
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        const warmupNeeded = Math.max(engineConfig.DST_ST1_ATR_LEN, engineConfig.DST_ST2_ATR_LEN, engineConfig.DST_CHOP_LEN) + 5;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        const haCandles = toHA(rawCandles);

        const st1Arr = supertrend(haCandles, engineConfig.DST_ST1_ATR_LEN, engineConfig.DST_ST1_FACTOR);
        const st2Arr = supertrend(haCandles, engineConfig.DST_ST2_ATR_LEN, engineConfig.DST_ST2_FACTOR);
        if (st1Arr === null || st2Arr === null) return;
        const st1Last = st1Arr[st1Arr.length - 1];
        const st2Last = st2Arr[st2Arr.length - 1];
        if (!st1Last || !st2Last) return;

        // SL sizing uses ST1's own ATR window — same reasoning as the other
        // strategies (ATR_SL_MULT x a fixed lookback), just DST_ST1_ATR_LEN
        // instead of the shared ST_ATR_LEN, since this strategy has its own
        // separate namespace.
        const atrVal = atr(rawCandles, engineConfig.DST_ST1_ATR_LEN);

        const chopArr = choppinessIndex(rawCandles, engineConfig.DST_CHOP_LEN);
        const chopVal = chopArr[chopArr.length - 1];

        await runSignals(rawCandle.close, st1Last.dir, st2Last.dir, atrVal, chopVal);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                // CHANGED: carry-overnight support — a position opened with
                // context.carryOvernight=true is allowed to resume on a LATER
                // calendar day too, not just same-day. Without this, the
                // RESUME_INTRADAY_ONLY safety gate below would silently wipe
                // an intentionally-carried position the next time this process
                // boots, since entry_date would no longer match today.
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "DUAL_ST_CHOP";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

// ════════════════════════════════════════════════════════════════════════
// ADAPTIVE_TREND — strategy #11. Direct port of the user-supplied Pine v6
// script "Adaptive Trend Envelope [BackQuant]" (see indicators.js's
// adaptiveTrendEnvelope() for the full pipeline + the dead-hysteresis-code
// note). The Pine script's own regime state machine already gives a clean
// three-way BULL(1)/BEAR(-1)/FLAT(0) signal per bar, so entry/exit are a
// direct mapping onto it:
//   ENTRY (level-based, only while flat): regime 1 -> LONG, regime -1 -> SHORT.
//   EXIT: close whenever the open position's regime no longer matches its
//   side — covers BOTH the script's own "back to flat" case (crossed the
//   spine) AND a direct flip straight to the opposite regime in one step.
// ASSUMPTION, flagging clearly: the Pine script's own buy/sell PLOT signals
// (bullStart/bearStart) are edge-triggered off a `lastSignal` var that only
// updates on BULL/BEAR transitions, not on FLAT ones — so if price goes
// bull -> flat -> bull again without ever touching bear in between, the
// script's own plotted "Buy" signal would NOT re-fire (lastSignal is
// already 1), which would leave a level-based reader stuck flat with no
// entry signal. This port uses the level-based reading (regime itself)
// instead of replicating that edge-triggered plot quirk, same call already
// made for MA_SLOPE_TREND earlier in this project after real chart evidence
// showed missed re-entries from the edge-triggered version — same reasoning
// applies here, not re-litigated per instrument this time.
// Same ATR SL trail every strategy in this file has (the Pine script itself
// has no stop-loss at all — this port's own addition, same as every other
// ported script here). No target, no quality gate — "otherwise plain",
// matching this project's default shape unless told to add more.
// ════════════════════════════════════════════════════════════════════════
function createAdaptiveTrendStrategy({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() } }) {
    function canEnter() {
        const { hours, minutes } = istParts(clock.now());
        return hours > engineConfig.TRADE_START_HOUR ||
            (hours === engineConfig.TRADE_START_HOUR &&
             minutes >= engineConfig.TRADE_START_MINUTE);
    }

    function persist(position, entryPrice, positionSource) {
        db.savePosition(context.tgPrefix, context.token, context.symbol, position, entryPrice || 0, positionSource);
    }

    function computeTrail(livePrice, atrVal, side) {
        if (atrVal === null) return null;
        const offset = engineConfig.ATR_SL_MULT * atrVal;
        return side === "LONG" ? livePrice - offset : livePrice + offset;
    }

    async function runSignals(price, entrySide, atrVal, regime) {
        const livePrice = candles.getLivePrice() ?? price;

        const uPnL = positionsUnrealised(livePrice);
        const ts   = clock.now().toLocaleTimeString("en-IN", { hour12: false });
        const fmt  = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);
        const clr  = regime === 1 ? "▲" : regime === -1 ? "▼" : "●";
        const session   = (state.pnl || 0) + uPnL;
        const lineColor = !state.position
            ? c.white
            : uPnL > 0 ? c.green : uPnL < 0 ? c.red : c.white;
        console.log(lineColor(`[${context.tgPrefix}] ${ts} ATE ${clr} ${livePrice.toFixed(2).padStart(7)}  ${fmt(uPnL).padStart(7)}  ${fmt(session).padStart(8)}`));
        emitEvent(context.tgPrefix, "TICK", { price: livePrice, uPnl: uPnL, session, position: state.position, entryPrice: state.entryPrice || null });

        // Exit: regime no longer matches the open position's side — see
        // header comment for why this covers both "went flat" and "flipped
        // straight to the opposite side" in one condition.
        if (engineConfig.ENGINE_ENABLED && state.position && state.positionSource === "ADAPTIVE_TREND") {
            const mismatched =
                (state.position === "LONG"  && regime !== 1) ||
                (state.position === "SHORT" && regime !== -1);
            if (mismatched) {
                const exitTag = regime === 0 ? "ATE_FLAT" : "ATE_FLIP";
                const closed  = await orders.exit(state.position);
                if (engineConfig.LIVE_ORDERS && closed === null) {
                    console.log(c.yellow(`[${context.tgPrefix}] ${state.position} exit failed (${exitTag}) — will retry next candle`));
                } else {
                    tg(`${state.position} EXIT (${exitTag}) @ ₹${livePrice.toFixed(2)}`);
                    await positionsClose(livePrice, exitTag);
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    persist(null, 0);
                }
            }
        }

        // Entry: level-based on regime while flat — see header ASSUMPTION.
        if (engineConfig.ENGINE_ENABLED && !state.position && entrySide && canEnter()) {
            const side = entrySide;
            const ordered = await orders.enter(side);
            if (engineConfig.LIVE_ORDERS && ordered === null) {
                console.log(c.yellow(`[${context.tgPrefix}] ${side} order failed — will retry next candle`));
            } else {
                const slTrail = computeTrail(livePrice, atrVal, side);

                state.position    = side;
                state.entryPrice  = livePrice;
                state.positionSource = "ADAPTIVE_TREND";
                state.openTradeId = await db.insertOpenTrade(
                    context.tgPrefix, context.symbol, side, context.lots, livePrice
                );

                const trailValid =
                    slTrail !== null &&
                    ((side === "LONG"  && slTrail < livePrice) ||
                     (side === "SHORT" && slTrail > livePrice));
                if (trailValid) slStore.setTrail(slTrail, side === "LONG" ? 1 : -1);

                persist(side, livePrice, "ADAPTIVE_TREND");
                console.log(c.green(`[${context.tgPrefix}] ${side} ENTRY (ADAPTIVE_TREND) @ ${livePrice.toFixed(2)}  Tr:${slTrail?.toFixed(2) ?? "-"}`));
                emitEvent(context.tgPrefix, "ENTRY", { side, price: livePrice, trail: slTrail ?? null });
                tg(`${side} ENTRY (ADAPTIVE_TREND) @ ₹${livePrice.toFixed(2)}\nTrail: ₹${slTrail?.toFixed(2) ?? "-"}`);
            }
        }

        // Refresh SL every candle — trail tightens as price moves in favour.
        if (engineConfig.ENGINE_ENABLED && state.position && atrVal !== null) {
            const slTrail      = computeTrail(livePrice, atrVal, state.position);
            const refreshValid =
                (state.position === "LONG"  && slTrail < livePrice) ||
                (state.position === "SHORT" && slTrail > livePrice);
            if (refreshValid) slStore.setTrail(slTrail, state.position === "LONG" ? 1 : -1);
        }
    }

    async function processCandle(rawCandle) {
        if (lifecycle.isShutdown()) return;
        const rawCandles = candles.getRawCandles();

        // Longest chain in the pipeline: retLenL (default 80) needs that
        // many candles of log-returns, THEN blendLen (default 30) worth of
        // ema-of-ema smoothing on top before spine/regime are non-null —
        // see adaptiveTrendEnvelope()'s own warmup behavior.
        const warmupNeeded = engineConfig.ATE_RET_LEN_LONG + engineConfig.ATE_BLEND_LEN + engineConfig.ST_ATR_LEN + 10;
        if (rawCandles.length < warmupNeeded) {
            console.log(c.dim(`[${context.tgPrefix}] WARMUP  ${rawCandles.length}/${warmupNeeded}`));
            return;
        }

        const ateSeries = adaptiveTrendEnvelope(rawCandles, {
            fastLen:     engineConfig.ATE_FAST_LEN,
            slowLen:     engineConfig.ATE_SLOW_LEN,
            blendLen:    engineConfig.ATE_BLEND_LEN,
            retLenS:     engineConfig.ATE_RET_LEN_SHORT,
            retLenL:     engineConfig.ATE_RET_LEN_LONG,
            bandMult:    engineConfig.ATE_BAND_MULT,
            ewmaAlpha:   engineConfig.ATE_EWMA_ALPHA,
            confirmBars: engineConfig.ATE_CONFIRM_BARS,
        });
        const ateNow = ateSeries[ateSeries.length - 1];
        if (ateNow === null) return;

        const regime = ateNow.regime;
        let entrySide = null;
        if (regime === 1)       entrySide = "LONG";
        else if (regime === -1) entrySide = "SHORT";

        const atrForTrail = atr(rawCandles, engineConfig.ST_ATR_LEN);

        await runSignals(rawCandle.close, entrySide, atrForTrail, regime);
    }

    async function initSignals() {
        try {
            const saved = await db.loadPosition(context.tgPrefix, context.token);
            const today = clock.now().toISOString().split("T")[0];

            if (engineConfig.RESUME_INTRADAY_ONLY && saved?.position) {
                const sameDay     = (saved.entry_date ?? null) === today;
                const shouldResume = sameDay || context.carryOvernight;
                if (shouldResume) {
                    state.position   = saved.position;
                    state.entryPrice = saved.entry_price;
                    state.positionSource = saved.position_source || "ADAPTIVE_TREND";

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }
            }

            state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

            const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
            console.log();
            console.log(c.green(`[${context.tgPrefix}] ${info}`));
            console.log();

            await orders.reconcile(state);

        } catch (err) {
            console.warn(`INIT  [${context.tgPrefix}] restore failed:`, err.message);
        }
    }

    return { processCandle, initSignals };
}

const STRATEGIES = {
    DPI_TREND_MEANREV: createDpiTrendMeanrevStrategy,
    ALMA_BAND:          createAlmaBandStrategy,
    ALMA_FAST:          createAlmaFastStrategy,
    DUAL_ST_CHOP:       createDualStChopStrategy,
    DPI_SMA5_EXIT:      createDpiSma5ExitStrategy,
    ALMA_DUAL_BAND_SMA5: createAlmaDualBandStrategy,
    MA_SLOPE:            createMaSlopeStrategy,
    MA_SLOPE_SCALP:      createMaSlopeScalpStrategy,
    MA_SLOPE_PURE:       createMaSlopePureStrategy,
    MA_SLOPE_HM:          createMaSlopeHmStrategy,
    ADAPTIVE_TREND:       createAdaptiveTrendStrategy,
    DPI_MEANREV:          createDpiMeanrevStrategy,
};

// Toolbox-facing labels only — not a full param schema yet (that's a later
// backtester piece). Keyed the same as STRATEGIES so a picker can iterate
// Object.keys(STRATEGIES) and look up a label here, with a plain fallback
// to the raw key for anything added without an entry here.
const STRATEGY_INFO = {
    DPI_TREND_MEANREV: { label: "DPI Trend (pure)", description: "ST1-confirmed DPI trend only — the MEANREV regime that used to live here has moved to DPI_MEANREV; key name kept for DB-filename continuity", short: "DPI" },
    ALMA_BAND:          { label: "ALMA Band",                  description: "ta.alma(high/low) breakout bands, HA-close signal, HA-candle bands", short: "ALMAB" },
    ALMA_FAST:          { label: "ALMA Fast (Color Flip)",     description: "single fast ALMA on HA close, entry on slope-direction flip",       short: "ALMAF" },
    DUAL_ST_CHOP:       { label: "Dual SuperTrend + Chop",     description: "ST1+ST2 agree on direction, Choppiness Index gates entry",          short: "DST" },
    DPI_SMA5_EXIT:      { label: "DPI + SMA5 Exit",             description: "raw-candle DPI entry, SMA5 close-cross exit (ALMA in source script is cosmetic-only, not implemented)", short: "DPI5" },
    ALMA_DUAL_BAND_SMA5: { label: "ALMA Dual + Band + SMA5",    description: "dual-ALMA (9/50) trend agreement, falls back to ALMA_BAND breakout when they disagree, SMA5 exit", short: "ADB" },
    MA_SLOPE:            { label: "MA Slope",                    description: "ema(ohlc4,56) angle vs ATR(14) — grey zone falls back to ALMA_BAND breakout; exits on opposite flip OR band reentry (either entry path)", short: "SLOPE" },
    MA_SLOPE_SCALP:      { label: "MA Slope Scalp",              description: "trend-capture on BULL/BEAR flip + scalp on GREY ALMA_BAND breakout — both exit on opposite flip OR band reentry; only scalp also has a tick-level +SCALP_TARGET_POINTS take-profit", short: "SCALP" },
    MA_SLOPE_PURE:       { label: "MA Slope Pure",               description: "color-only ema(56) slope, no ALMA band at all — enter on BULL/BEAR, no trade in GREY, exit on either a flip to the opposite decisive color, a flip into GREY, or an SMA9 reversal once the slope angle is beyond ±MA_SLOPE_PURE_SMA9_EXIT_ANGLE", short: "PURE" },
    MA_SLOPE_HM:          { label: "MA Slope + Hilega-Milega",    description: "same entry as MA Slope Pure (color-only, no ALMA band) — exit is a Hilega-Milega RSI9/WMA21/EMA3 crossover against position direction, not a color flip", short: "HM" },
    ADAPTIVE_TREND:       { label: "Adaptive Trend Envelope",     description: "port of BackQuant's Pine script — volatility-adaptive EMA blend spine wrapped in an EWMA-vol envelope; enter on regime flip to bull/bear, exit when regime no longer matches (flat or opposite)", short: "ATE" },
    DPI_MEANREV:          { label: "DPI Trend + Mean Reversion",  description: "the original DPI_TREND_MEANREV combo — ST1-confirmed DPI trend, RSI mean-reversion in the chop between", short: "DPIMR" },
};

// Each strategy's live/paper candle interval — this is a property of the
// strategy's own design (ALMA_LEN=20 means something completely different
// on 1h bars than on 15m ones), not a per-instrument choice, so it isn't an
// overrides.js field the way `strategy` itself is. context.js reads this to
// set context.timeframe, and candlePoll.js polls at whichever cadence that
// resolves to — so switching an instrument to ALMA_BAND automatically polls
// hourly instead of every 15 minutes, no separate toggle needed.
const STRATEGY_TIMEFRAME = {
    DPI_TREND_MEANREV: "15m",
    ALMA_BAND:          "1h",
    // Pine script doesn't pin a timeframe (uses timeframe.period — whatever
    // chart it's applied to), so this defaults to 15m rather than assuming
    // it should match ALMA_BAND's 1h. Flagging this — easy one-line change
    // here if 1h (or something else) was actually intended.
    ALMA_FAST:          "15m",
    // See this strategy's own header comment above — 15m picked to match
    // the other 15m strategies, not derived from anything strategy-specific.
    DUAL_ST_CHOP:       "15m",
    // Pine script has no fixed timeframe (works on whatever chart it's
    // applied to) — 15m picked to match the other default-cadence
    // strategies, same reasoning as ALMA_FAST/DUAL_ST_CHOP above. Easy
    // one-line change here if a different cadence was actually intended.
    DPI_SMA5_EXIT:      "15m",
    ALMA_DUAL_BAND_SMA5: "15m",
    // Pine script has no fixed timeframe either (applies to whatever chart
    // it's on) — 15m again picked to match the platform's default cadence.
    MA_SLOPE:            "15m",
    // Same reasoning as MA_SLOPE above (Pine script has no fixed timeframe) —
    // scalping benefits from a fast entry cadence anyway, so 15m stays the
    // pick here too rather than going faster; easy to change if you want
    // this on 5m instead.
    MA_SLOPE_SCALP:      "15m",
    MA_SLOPE_PURE:       "15m",
    // Same entry cadence as MA_SLOPE_PURE (identical entry logic) — no
    // strategy-specific reason to pick a different one.
    MA_SLOPE_HM:          "15m",
    // No timeframe guidance from the Pine script itself (author didn't
    // specify one) — 15m for consistency with everything else in this file.
    ADAPTIVE_TREND:       "15m",
    // Same 15m as DPI_TREND_MEANREV always ran at — unchanged, this is the
    // same combo logic, just under its own key now.
    DPI_MEANREV:          "15m",
};

const DEFAULT_STRATEGY = "DPI_TREND_MEANREV";

module.exports = { STRATEGIES, STRATEGY_INFO, STRATEGY_TIMEFRAME, DEFAULT_STRATEGY, createDpiTrendMeanrevStrategy, createDpiMeanrevStrategy, createAlmaBandStrategy, createAlmaFastStrategy, createDualStChopStrategy, createDpiSma5ExitStrategy, createAlmaDualBandStrategy, createMaSlopeStrategy };
