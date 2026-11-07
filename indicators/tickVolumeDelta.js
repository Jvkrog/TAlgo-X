"use strict";
// tickVolumeDelta.js — ESTIMATED tick-rule volume delta.
//
// Kite ticks in FULL mode carry `volume_traded` (cumulative for the day)
// and `last_price`, but NOT a genuine bid/ask aggressor flag — Kite doesn't
// expose true exchange aggressor-side buy/sell volume over the ticker.
// This is therefore an ESTIMATE using the standard tick rule: price up =
// buy-side, price down = sell-side, unchanged = carry the previous tick's
// direction forward. See createVolumeDeltaCvdStrategy in strategies.js for
// where this feeds in, and the strategy's own header for the same
// limitation stated again at the point it matters for trading decisions.
//
// createTickDeltaAccumulator() is the STATEFUL half — one instance per
// running instrument (same per-process-instance pattern candleBuilder.js's
// createCandleBuffer() already uses), fed one tick at a time via onTick(),
// snapshotted and reset via rollCandle() whenever candlePoll.js appends a
// newly-completed candle (see candleDeltaBuffer.js, which owns that
// snapshot/reset/history bookkeeping and calls the accumulator functions
// below directly rather than duplicating this logic).

// Pure function — given the current tick's price/volume and the
// accumulator's previous tick state, returns the estimated buy/sell
// increment for THIS tick only. No side effects; the caller decides what
// to do with the result (this is what candleDeltaBuffer.js's accumulator
// wraps with actual running totals).
//
// prevState: { lastPrice, lastDirection, lastVolumeTraded } — lastDirection
// is 1 (up/buy) or -1 (down/sell) or null (no prior tick yet).
function estimateTickIncrement(price, cumulativeVolume, prevState) {
    // First tick ever for this accumulator — no direction to infer, no
    // prior cumulative volume to diff against. Record state, contribute
    // nothing to buy/sell (there's no incremental volume to attribute yet).
    if (prevState.lastPrice === null) {
        return {
            buyVolume: 0,
            sellVolume: 0,
            direction: null,
            nextState: { lastPrice: price, lastDirection: null, lastVolumeTraded: cumulativeVolume ?? null },
        };
    }

    // Duplicate tick — identical price AND identical cumulative volume
    // (or no volume field at all, e.g. LTP-mode fallback) means nothing
    // actually traded since the last tick. Contribute zero, don't even
    // update lastDirection (nothing happened to have a direction).
    const noVolumeField = cumulativeVolume === undefined || cumulativeVolume === null;
    if (price === prevState.lastPrice && (noVolumeField || cumulativeVolume === prevState.lastVolumeTraded)) {
        return {
            buyVolume: 0,
            sellVolume: 0,
            direction: null,
            nextState: { ...prevState },
        };
    }

    // Direction: price move decides it; unchanged price carries the
    // previous tick's direction forward (never null once any direction has
    // ever been established, per the tick-rule convention in the spec).
    let direction;
    if (price > prevState.lastPrice) direction = 1;
    else if (price < prevState.lastPrice) direction = -1;
    else direction = prevState.lastDirection ?? 1; // first-ever unchanged tick with no history yet — default to buy-side, arbitrary but harmless (contributes almost nothing at n=1)

    // Incremental volume for this tick — cumulative diff when Kite gives
    // us volume_traded (FULL mode); missing entirely if running in a mode
    // without it. A volume RESET (broker's cumulative counter dropping,
    // e.g. a fresh trading session boundary or a reconnect that resubscribes
    // mid-session) or any negative diff is clamped to zero rather than
    // fed backward into buy/sell — negative incremental volume is never
    // valid and would silently corrupt the running totals otherwise.
    let deltaVolume = 0;
    if (!noVolumeField) {
        const diff = cumulativeVolume - (prevState.lastVolumeTraded ?? cumulativeVolume);
        deltaVolume = diff > 0 ? diff : 0; // covers both a genuine reset (diff very negative) and simple noise (diff slightly negative) the same way — clamp, never subtract
    }

    return {
        buyVolume:  direction === 1  ? deltaVolume : 0,
        sellVolume: direction === -1 ? deltaVolume : 0,
        direction,
        nextState: { lastPrice: price, lastDirection: direction, lastVolumeTraded: cumulativeVolume ?? prevState.lastVolumeTraded },
    };
}

// Stateful accumulator — one per running instrument. Out-of-order ticks
// (a rare WS reordering) aren't detectable from price/volume alone without
// tick sequence numbers Kite doesn't expose, so they're accepted as-received
// same as any other tick; a reconnect naturally self-heals into a fresh
// "first tick" state via resync() below, which is the practical mitigation
// available here.
function createTickDeltaAccumulator() {
    let tickState = { lastPrice: null, lastDirection: null, lastVolumeTraded: null };
    let buyVolume = 0;
    let sellVolume = 0;
    let tickCount = 0;

    function onTick(price, cumulativeVolume) {
        const { buyVolume: bv, sellVolume: sv, nextState } = estimateTickIncrement(price, cumulativeVolume, tickState);
        buyVolume += bv;
        sellVolume += sv;
        tickState = nextState;
        tickCount += 1;
    }

    // Called on reconnect — Kite's cumulative volume_traded counter is
    // per-connection-safe (it's a broker-side session total, not reset by
    // a WS reconnect), but the tick RULE'S own price-direction memory
    // shouldn't carry a stale "last price" across a gap where prices may
    // have moved without this accumulator seeing it. Resetting lastPrice
    // (not lastVolumeTraded) means the next tick after reconnect is treated
    // like a fresh "first tick" for DIRECTION purposes, while volume
    // diffing still continues correctly from wherever it left off.
    function resync() {
        tickState = { lastPrice: null, lastDirection: tickState.lastDirection, lastVolumeTraded: tickState.lastVolumeTraded };
    }

    // Snapshot current totals and reset for the next interval — called by
    // candleDeltaBuffer.js the moment a new candle completes.
    function snapshotAndReset() {
        const snapshot = { buyVolume, sellVolume, delta: buyVolume - sellVolume, tickCount };
        buyVolume = 0;
        sellVolume = 0;
        tickCount = 0;
        return snapshot;
    }

    function peek() {
        return { buyVolume, sellVolume, delta: buyVolume - sellVolume, tickCount };
    }

    return { onTick, resync, snapshotAndReset, peek };
}

module.exports = { estimateTickIncrement, createTickDeltaAccumulator };
