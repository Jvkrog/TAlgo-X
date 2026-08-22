// candlePoll.js — API candle poll + WebSocket SL monitor
//
// Poll: fires 10s after each candle-slot close -> fetchLastCandle() -> processCandle()
//       Slot size (15m/1h/etc.) comes from context.timeframe, which context.js
//       sets from the running strategy's fixed live cadence (see strategies.js's
//       STRATEGY_TIMEFRAME) — so switching an instrument's strategy changes its
//       poll cadence automatically, no separate config needed.
// SL:   every WebSocket tick -> checkSL(price)
//       exits when price crosses the active SuperTrend trail
//
// CHANGED:
//   - Was a module reading `./config` and `./state` directly (FAST, closeFast,
//     fastSLExit, getFastSL, clearFastSL, config.FAST_TOKEN/FAST_SYMBOL/FAST_ENABLED).
//     Now createCandlePoll({...}) takes context, engineConfig, state, candles,
//     slStore, orders, processCandle, db as explicit dependencies — nothing
//     is pulled off a shared singleton.
//   - Dropped "Fast" naming throughout: closeFast -> close, fastSLExit -> slExit,
//     getFastSL/clearFastSL -> getTrail/clearTrail, FAST_ENABLED -> ENGINE_ENABLED.
//   - DB engine tag "FAST" -> context.tgPrefix, so trades/positions rows are
//     labeled by instrument instead of a now-meaningless "FAST" string.
"use strict";

const { KiteConnect } = require("kiteconnect");
const fs = require("fs");
const c  = require("./c");
const { TIMEFRAME_TO_INTERVAL, TIMEFRAME_MINUTES } = require("./historicalFetch");
const { toHA, atrSeries, dpi, choppinessIndex } = require("./indicators");
const { selectAdaptiveTarget } = require("./adaptiveTarget");

function createCandlePoll({ context, engineConfig, state, candles, slStore, targetStore, orders, positionsClose, processCandle, db, tg }) {
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim());

    // Resolved from context.timeframe (set by context.js from the running
    // strategy's STRATEGY_TIMEFRAME — see strategies.js) so ALMA_BAND polls
    // hourly and DPI_TREND_MEANREV keeps polling every 15m, automatically,
    // with no separate toolbox toggle. The fallback to the old global
    // constant/15m only matters if context.timeframe is ever missing —
    // in practice createSignals() already throws on an unresolvable
    // strategy before this module is even constructed (see engine.js's
    // boot order), so this is a safety net, not a real code path.
    const interval    = TIMEFRAME_TO_INTERVAL[context.timeframe] || engineConfig.HIST_INTERVAL;
    const slotMinutes = TIMEFRAME_MINUTES[context.timeframe]     || 15;

    // ─── SL MONITOR — every WebSocket tick ───────────────────────────────────
    async function checkSL(price) {
        if (!price) return;

        const { trail } = slStore.getTrail();
        if (engineConfig.ENGINE_ENABLED && state.position && trail !== null) {
            const breached =
                (state.position === "LONG"  && price < trail) ||
                (state.position === "SHORT" && price > trail);
            if (breached) {
                tg(`🛑 ${state.position} STOP @ ₹${price.toFixed(2)}`);
                const ordered = await orders.slExit(state.position);
                if (engineConfig.LIVE_ORDERS && ordered === null) {
                    console.error(c.red(`SL order failed — position NOT cleared, manual exit required`));
                    tg(`⚠ SL order FAILED\nPosition still open — manual exit required immediately`);
                } else {
                    // positionsClose is positions.js's close(context, state, price, reason),
                    // pre-bound by engine.js to (context, state) so it's called here as (price, reason).
                    await positionsClose(price, "SL_ST");
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                    slStore.clearTrail();
                }
            }
        }
    }

    // ─── TARGET MONITOR — every WebSocket tick ───────────────────────────────
    // Arm step (once per position, whichever mode):
    //   FIXED    — target = entryPrice ± context.targetPoints, unchanged.
    //   ADAPTIVE — sized ONCE from CHOP + |DPI efficiency| at the moment of
    //   arming (see adaptiveTarget.js), then frozen: stored on this
    //   position's DB row and never recomputed for the life of the trade,
    //   including across a process restart (checked below BEFORE computing
    //   fresh — a restart resumes the SAME frozen value, it never re-decides).
    //   Everything after arming — the tick-by-tick LTP >= / <= target check —
    //   is identical for both modes; this function only ever monitors an
    //   already-decided level, exactly as before. Works for every strategy
    //   uniformly, same as it always has — only reads state.position/entryPrice
    //   and the candle buffer, nothing strategy-specific.
    // No-op entirely whenever context.targetPoints is unset AND targetMode
    // isn't "adaptive" — pre-existing behavior (no fixed take-profit) is
    // unchanged unless the instrument was explicitly configured with one.
    async function checkTarget(price) {
        if (!price || !targetStore) return;

        if (engineConfig.ENGINE_ENABLED && state.position && state.entryPrice && (context.targetPoints || context.targetMode === "adaptive")) {
            const { target: armedTarget } = targetStore.getTarget();
            if (armedTarget === null) {
                let points = context.targetPoints; // FIXED wins outright if set, regardless of targetMode

                if (!points && context.targetMode === "adaptive") {
                    // Restart-resume check FIRST — if this exact open position
                    // already has a frozen target on its DB row (from before a
                    // crash/restart), reuse it verbatim. Only a position with
                    // nothing stored yet (a genuinely brand-new entry) computes
                    // a fresh decision below.
                    const saved = await db.loadPosition(context.tgPrefix, context.token);
                    if (saved && saved.position === state.position && saved.target_points) {
                        points = saved.target_points;
                        console.log(c.dim(`[${context.tgPrefix}] [TARGET] MODE: ADAPTIVE (resumed)  REGIME: ${saved.target_regime}  TARGET: ${points} points`));
                    } else {
                        const rawCandles = candles.getRawCandles();
                        // Same three indicators this decision uses need their
                        // own lookback windows satisfied — if the buffer is
                        // still short (e.g. a restart right after boot,
                        // before preload's own guard would normally have
                        // caught it), just wait for the next tick rather
                        // than sizing off a too-short window. Position stays
                        // unarmed (safe) until this passes.
                        const warmupNeeded = Math.max(engineConfig.DPI_LEN, engineConfig.ST_ATR_LEN, engineConfig.CHOP_LEN) + 5;
                        if (rawCandles.length < warmupNeeded) return;

                        const haCandles = toHA(rawCandles);
                        const atrArr    = atrSeries(haCandles, engineConfig.ST_ATR_LEN);
                        const dpiResult = dpi(haCandles, atrArr, engineConfig.DPI_LEN, engineConfig.DPI_STREAK_MULT, engineConfig.DPI_STREAK_CAP);
                        const chopArr   = choppinessIndex(rawCandles, engineConfig.CHOP_LEN);
                        const chopVal   = chopArr[chopArr.length - 1];

                        const decision = selectAdaptiveTarget(
                            { chop: chopVal, efficiency: dpiResult ? dpiResult.efficiency : null },
                            engineConfig
                        );
                        points = decision.points;

                        console.log(c.dim(`[${context.tgPrefix}] [ADAPTIVE TARGET]`));
                        console.log(c.dim(`  MODE: ADAPTIVE`));
                        console.log(c.dim(`  REGIME: ${decision.regime}`));
                        console.log(c.dim(`  TARGET: ${decision.points} points`));
                        console.log(c.dim(`  CHOP: ${chopVal !== null && chopVal !== undefined ? chopVal.toFixed(1) : "n/a"}`));
                        console.log(c.dim(`  DPI: ${dpiResult ? dpiResult.dpi.toFixed(2) : "n/a"}`));
                        console.log(c.dim(`  EFFICIENCY: ${dpiResult ? dpiResult.efficiency.toFixed(2) : "n/a"}`));
                        console.log(c.dim(`  REASON: ${decision.reason}`));

                        // Freeze it — persisted onto this position's row
                        // BEFORE arming targetStore, so a crash between here
                        // and the next tick still resumes with this exact
                        // value on restart (the branch above), never a
                        // re-decided one. Passes through the position's
                        // CURRENT entry/source unchanged — this is the same
                        // upsert every strategy's own _persistState already
                        // does, just adding the two new columns.
                        db.savePosition(context.tgPrefix, context.token, context.symbol, state.position, state.entryPrice, state.positionSource, decision.points, decision.regime);
                    }
                } else if (context.targetPoints) {
                    console.log(c.dim(`[${context.tgPrefix}] [TARGET] MODE: FIXED  TARGET: ${context.targetPoints} points`));
                }

                if (points) {
                    const dir   = state.position === "LONG" ? 1 : -1;
                    const level = state.position === "LONG"
                        ? state.entryPrice + points
                        : state.entryPrice - points;
                    targetStore.setTarget(level, dir);
                    console.log(c.dim(`[${context.tgPrefix}] [TARGET ARMED]  POSITION: ${state.position}  ENTRY: ${state.entryPrice.toFixed(2)}  TARGET_POINTS: ${points}  TARGET_PRICE: ${level.toFixed(2)}`));
                }
            }
        }

        const { target, dir } = targetStore.getTarget();
        if (engineConfig.ENGINE_ENABLED && state.position && target !== null) {
            const reached =
                (dir === 1  && price >= target) ||
                (dir === -1 && price <= target);
            if (reached) {
                tg(`🎯 ${state.position} TARGET @ ₹${price.toFixed(2)}`);
                const ordered = await orders.targetExit(state.position);
                if (engineConfig.LIVE_ORDERS && ordered === null) {
                    console.error(c.red(`Target order failed — position NOT cleared, manual exit required`));
                    tg(`⚠ Target order FAILED\nPosition still open — manual exit required immediately`);
                } else {
                    await positionsClose(price, "SCALP_TP");
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                    slStore.clearTrail();
                    targetStore.clearTarget();

                    // Target hit — day's done, quit for the rest of the
                    // session (cooldown) instead of continuing to run flat
                    // and re-arming on the next entry. exit(0) is a clean
                    // exit code, which PM2_BASE_OPTS (toolbox.js) is
                    // configured to NOT autorestart — same mechanism the
                    // EOD shutdown in lifecycle.js relies on. Send the
                    // Telegram confirmation first and give it a moment to
                    // actually flush before killing the process.
                    await tg(`✅ Target reached — cooling down for the day [${context.tgPrefix}]`);
                    console.log(c.bold("*** TARGET HIT — COOLDOWN, DONE FOR THE DAY ***"));
                    setTimeout(() => process.exit(0), 2000);
                }
            }
        }
    }

    // ─── FETCH LAST COMPLETED CANDLE from API ────────────────────────────────
    async function fetchLastCandle() {
        try {
            const now  = new Date();
            // At least 4 candle-widths back, or 2 hours — whichever is
            // larger. 2 hours was fine when everything was 15m (that's
            // already 8 candle-widths of headroom); for 1h candles a fixed
            // 2-hour window would only ever return 1-2 completed bars,
            // risking the `bars.length < 2` guard below right after a
            // fresh boot or near session open. Scaling with slotMinutes
            // keeps the same headroom ratio for every timeframe.
            const lookbackMs = Math.max(2 * 60 * 60 * 1000, slotMinutes * 60 * 1000 * 4);
            const from = new Date(now.getTime() - lookbackMs);

            const bars = await kc.getHistoricalData(
                context.token,
                interval,
                from.toISOString().split("T")[0],
                now.toISOString().split("T")[0]
            );

            if (!bars || bars.length < 2) return null;

            // Last bar is still-forming — take second to last (last completed candle)
            const b = bars[bars.length - 2];
            return {
                open:  parseFloat(b.open),
                high:  parseFloat(b.high),
                low:   parseFloat(b.low),
                close: parseFloat(b.close),
                date:  String(b.date),
            };
        } catch (err) {
            console.error(c.red(`CANDLE  fetch failed: ${err.message}`));
            tg(`⚠ Candle fetch failed: ${err.message}`);
            return null;
        }
    }

    // ─── CANDLE CLOSE WATCHER ─────────────────────────────────────────────────
    let lastProcessedDate = null;
    let retryCount        = 0;
    const RETRY_DELAY_MS  = 10 * 1000;  // recheck 10s later if candle not published yet
    const MAX_RETRIES     = 12;          // give up retrying after 2 minutes, fall back to normal cadence

    function msUntilNextSlotPlus10() {
        const now   = new Date();
        const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
        const ist   = new Date(istMs);
        const secInSlot = (ist.getUTCMinutes() % slotMinutes) * 60 + ist.getUTCSeconds();
        const msToNextClose = (slotMinutes * 60 - secInSlot) * 1000 - ist.getUTCMilliseconds();
        return msToNextClose + 10 * 1000;
    }

    async function onCandleClose() {
        const candle = await fetchLastCandle();
        if (!candle) return retryOrScheduleNext();

        const candleTime = new Date(candle.date).getTime();
        const lastTime   = lastProcessedDate ? new Date(lastProcessedDate).getTime() : 0;

        if (candleTime > lastTime) {
            lastProcessedDate = candle.date;
            retryCount        = 0;   // found it — reset for next cycle
            const buf = candles.getRawCandles();
            buf.push(candle);
            if (buf.length > engineConfig.MAX_CANDLES) buf.shift();
            candles.setRawCandles(buf);
            await processCandle(candle);
            scheduleNext();
        } else {
            // Broker API hasn't published the just-closed candle yet. Retry
            // shortly instead of waiting a full 15m for the next slot boundary —
            // otherwise a few seconds of publish lag costs an entire candle
            // (this is what was pushing 9:15 entries out to 9:30).
            retryOrScheduleNext();
        }
    }

    function retryOrScheduleNext() {
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            setTimeout(onCandleClose, RETRY_DELAY_MS);
        } else {
            // Genuinely nothing new after 2 minutes of retrying — fall back to
            // normal cadence rather than hammering the API indefinitely.
            retryCount = 0;
            scheduleNext();
        }
    }

    function scheduleNext() {
        setTimeout(onCandleClose, msUntilNextSlotPlus10());
    }

    // ─── START — schedule first fire + immediate boot catchup ────────────────
    function startPoll() {
        fetchLastCandle().then(async candle => {
            if (!candle) return;
            const buf = candles.getRawCandles();
            const lastBufTime = buf.length > 0 ? new Date(buf[buf.length - 1].date).getTime() : 0;
            const candleTime  = new Date(candle.date).getTime();
            if (candleTime > lastBufTime) {
                lastProcessedDate = candle.date;
                buf.push(candle);
                if (buf.length > engineConfig.MAX_CANDLES) buf.shift();
                candles.setRawCandles(buf);
                await processCandle(candle);
            } else {
                lastProcessedDate = buf.length > 0 ? buf[buf.length - 1].date : null;
            }
        });

        scheduleNext();
    }

    return { startPoll, checkSL, checkTarget };
}

module.exports = { createCandlePoll };
