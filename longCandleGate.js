"use strict";
// longCandleGate.js — "Long-Candle / Volatility-Shock Entry Filter".
//
// ORIGIN: the Sep 2 2026 NATGASMINI incident on DYNAMIC_BAND — market was
// compressed, an abnormally large candle appeared, Dynamic Band's
// breakout/reversal logic reacted to it, and the resulting rapid
// direction-flip sequence produced a ~₹4,550 gross loss on one contract.
// The failure was NOT ordinary pullback noise — it was a single abnormal
// candle temporarily destabilizing signal/reversal behavior. This gate
// targets exactly that: detect abnormal candle expansion, temporarily
// block NEW exposure, let the market normalize, resume as normal.
//
// This is an ENTRY GATE, not a risk-management override. It NEVER touches
// stop-loss, target, emergency exit, position tracking, or broker
// reconciliation — those all keep running exactly as before on an
// already-open position. It only ever prevents creating NEW exposure
// (a fresh entry from flat, or a signal-driven reversal). See
// strategies.js's call sites for exactly where each strategy applies
// this — the "flat entry" case is gated the same way every other entry
// gate in this codebase already is (isChopBlocked/isVolumeBlocked/
// isDoubleOrderBlocked: called from inside doEnter(), before
// orders.enter()); the "reversal" case for the band/color-flip family of
// strategies (DYNAMIC_BAND, DYNAMIC_MID_COLOR, DYNAMIC_MID_COLOR_HL,
// PURE_HA) additionally gates BEFORE the exit half of the reversal, so an
// existing position is held rather than closed "solely to reverse" while
// blocked — see each of those strategies' own comments at their reversal
// call sites for why.
//
// DETECTION — completed candles only, no lookahead. candles.getRawCandles()
// already only ever contains COMPLETED candles (see candleBuilder.js/
// candlePoll.js — the still-forming candle is never appended until it
// closes), so evaluating "the latest entry in that array" here carries
// the exact same no-lookahead guarantee every other indicator call in
// this codebase already relies on (ATR, chop, volume SMA, etc.) — this
// file adds no new risk on that front, it just reuses the existing
// completed-candle convention.
//
//     candleRange = high - low
//     longCandle  = candleRange >= ATR(period) * LONG_CANDLE_ATR_MULT
//
// ATR comes from indicators.js's existing atr() — the SAME function
// every strategy's own stop-loss trail already uses (computeTrail()) —
// no duplicate ATR implementation. Raw candles, not Heikin-Ashi:
// DYNAMIC_BAND (the strategy this was built for) computes its own
// band/regime off raw closes, never HA, so the abnormal-expansion check
// stays on the same candle representation as the strategy's own signal —
// see strategies.js's createDynamicBandStrategy, which never calls toHA()
// at all. Every other strategy that uses this gate does so on raw
// candles too, for the same reason (ATR itself is inherently a raw-OHLC
// indicator throughout this codebase already — chopGate.js/volumeGate.js
// both do the same).
//
// OPTIONAL BODY CONFIRMATION — off by default. When
// context.longCandleUseBodyFilter is on, a long candle ALSO requires
// abs(close-open) >= ATR * LONG_CANDLE_BODY_ATR_MULT — i.e. the range
// condition is necessary but, with the body filter on, no longer
// sufficient. This stays optional and simple, per the spec's explicit
// "do not make the implementation unnecessarily complicated" — no
// separate body-only detection path, just an extra AND on the same
// evaluation.
//
// COOLDOWN — state.longCandleCooldown counts candles remaining BLOCKED
// after the current one. With LONG_CANDLE_COOLDOWN_CANDLES = 2:
//   candle N   (abnormal)      -> cooldown set to 2, blocked
//   candle N+1 (normal)        -> still blocked (cooldown was > 0), decrements to 1
//   candle N+2 (normal)        -> still blocked (cooldown was > 0), decrements to 0
//   candle N+3 (normal)        -> unblocked (cooldown is 0 and this candle isn't long)
// i.e. 1 (trigger) + cooldownCandles = 3 total blocked candles for a
// single abnormal candle followed by normal ones — matches the spec's
// worked example exactly. A CONSECUTIVE abnormal candle refreshes the
// cooldown back to the full value instead of decrementing (so a run of
// N abnormal candles doesn't let the block expire mid-run — spec
// section 7), and does NOT stack/accumulate beyond the configured
// value (refresh, not extend indefinitely).
//
// This function mutates state ONCE per completed candle — a
// `state.longCandleLastSeenDate` dedup guard makes repeat calls against
// the SAME latest candle (e.g. this gate being queried from more than
// one call site while processing one candle) safe: only the FIRST call
// for a given candle mutates the cooldown counter or logs a transition;
// every subsequent call that candle just re-reads the already-decided
// blocked state. This is what lets every entry site simply call
// evaluateLongCandle() directly, the same way they already call
// isChopBlocked()/isVolumeBlocked(), without needing a separate
// once-per-candle bookkeeping call threaded through runSignals().
const { atr } = require("./indicators");

function evaluateLongCandle(context, engineConfig, candles, state) {
    if (!context.longCandleFilterEnabled) return false;

    const rawCandles = candles.getRawCandles();
    const period = context.longCandleAtrPeriod ?? engineConfig.LONG_CANDLE_ATR_PERIOD_DEFAULT;
    if (!rawCandles || rawCandles.length < period + 1) {
        // Not enough warmup data for ATR yet — don't block on insufficient
        // data (same convention chopGate.js/volumeGate.js follow), but
        // still honor whatever cooldown is already ticking from before.
        return (state.longCandleCooldown || 0) > 0;
    }

    const latest = rawCandles[rawCandles.length - 1];
    const candleKey = latest.date ?? rawCandles.length;
    const isNewCandle = state.longCandleLastSeenDate !== candleKey;

    if (!isNewCandle) return (state.longCandleCooldown || 0) > 0;
    state.longCandleLastSeenDate = candleKey;

    const atrVal = atr(rawCandles, period);
    const mult = context.longCandleAtrMult ?? engineConfig.LONG_CANDLE_ATR_MULT_DEFAULT;
    const range = latest.high - latest.low;
    let isLong = atrVal !== null && atrVal > 0 && range >= atrVal * mult;

    if (isLong && context.longCandleUseBodyFilter) {
        const bodyMult = context.longCandleBodyAtrMult ?? engineConfig.LONG_CANDLE_BODY_ATR_MULT_DEFAULT;
        const body = Math.abs(latest.close - latest.open);
        isLong = body >= atrVal * bodyMult;
    }

    const cooldownLen = context.longCandleCooldownCandles ?? engineConfig.LONG_CANDLE_COOLDOWN_CANDLES_DEFAULT;
    let blocked;

    if (isLong) {
        state.longCandleCooldown = cooldownLen;
        state.longCandleLastRange = range;
        state.longCandleLastAtr = atrVal;
        state.longCandleLastRatio = range / atrVal;
        state.longCandleLastTime = candleKey;
        blocked = true;
        console.log(`[LONG_CANDLE_BLOCK] instrument=${context.symbol} timeframe=${context.timeframe} candleTime=${candleKey} open=${latest.open} high=${latest.high} low=${latest.low} close=${latest.close} range=${range.toFixed(2)} atr=${atrVal.toFixed(2)} rangeAtrRatio=${(range / atrVal).toFixed(2)} threshold=${mult} cooldown=${cooldownLen}`);
    } else {
        // Check the PRE-decrement value to decide whether THIS candle is
        // still blocked — cooldownLen=2 must mean 3 total blocked candles
        // (the trigger + 2 more), so the candle where the counter reaches
        // 0 is still one of the blocked ones; only the candle AFTER that
        // is free. Decrementing before this check would block one candle
        // too few.
        blocked = (state.longCandleCooldown || 0) > 0;
        if (blocked) {
            state.longCandleCooldown -= 1;
        } else if (state.longCandleCooldown === undefined) {
            state.longCandleCooldown = 0;
        }
    }

    // Log the release exactly on the transition candle (the first
    // non-long candle after cooldown has fully elapsed) — not merely
    // when the counter happens to hit 0, which (per the comment above)
    // is still one candle before the actual release.
    if (!blocked && state.longCandleWasBlocked) {
        console.log(`[LONG_CANDLE_FILTER_RELEASED] instrument=${context.symbol} timeframe=${context.timeframe}`);
    }
    state.longCandleWasBlocked = blocked;

    return blocked;
}

module.exports = { evaluateLongCandle };
