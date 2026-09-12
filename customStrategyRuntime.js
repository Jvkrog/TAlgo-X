"use strict";
// customStrategyRuntime.js — createCustomStrategy(spec) returns a factory
// with the exact same ({context, engineConfig, state, db, ...}) => {processCandle,
// initSignals} shape every hardcoded factory in strategies.js returns.
// signals.js's createSignals() calls this when a strategy key isn't found
// in STRATEGIES, resolving instead via customStrategyDb.getStrategyByName().
//
// Known gaps, deliberately left visible rather than papered over:
// - stopLoss.atrRef must point at an ATR-type indicator block in the same
//   spec; if it doesn't resolve, the stop is silently skipped for that
//   entry (logged) rather than crashing the engine mid-trade.
// - target.type "points" is tick-monitored the same way the existing
//   fixed-target flow works (see candlePoll.js's checkTarget) — this
//   module only arms it via targetStore, it doesn't re-implement the
//   tick check.

const { computeIndicators } = require("./indicatorEngine");
const { evaluateTree } = require("./conditionEvaluator");
const { isChopBlocked } = require("./chopGate");
const { isDoubleOrderBlocked } = require("./doubleOrderGate");
const { isVolumeBlocked } = require("./volumeGate");
const { evaluateLongCandle } = require("./longCandleGate");

function createCustomStrategy(spec) {
    return function ({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, positionsUnrealised, lifecycle, tg, clock = { now: () => new Date() }, htf }) {
        let edgeMemory = {};

        function buildContext(rawCandles) {
            const { current, previous, warmup, activeCandles } = computeIndicators(spec.indicators, rawCandles, spec.candleType);
            const price = {
                close: activeCandles[activeCandles.length - 1].close,
                high:  activeCandles[activeCandles.length - 1].high,
                low:   activeCandles[activeCandles.length - 1].low,
            };
            const prevPrice = activeCandles.length > 1
                ? { close: activeCandles[activeCandles.length - 2].close, high: activeCandles[activeCandles.length - 2].high, low: activeCandles[activeCandles.length - 2].low }
                : { close: price.close, high: price.high, low: price.low };

            return { current, previous, warmup, ctx: { indicatorValues: { current, previous }, price, prevPrice } };
        }

        function resolveAtrStop(current, side, livePrice) {
            const sl = spec.exitConfig?.stopLoss;
            if (!sl || sl.type !== "atr") return null;
            const [refId, refField] = sl.atrRef.split(".");
            const atrVal = current[refId]?.[refField];
            if (atrVal === null || atrVal === undefined) {
                console.warn(`[${context.tgPrefix}] custom strategy "${spec.name}": stopLoss.atrRef "${sl.atrRef}" did not resolve — entering without a stop`);
                return null;
            }
            return side === "LONG" ? livePrice - sl.mult * atrVal : livePrice + sl.mult * atrVal;
        }

        async function processCandle(rawCandle) {
            if (lifecycle.isShutdown()) return;
            if (!engineConfig.ENGINE_ENABLED) return;

            const rawCandles = candles.getRawCandles();
            const { current, warmup, ctx } = buildContext(rawCandles);
            if (rawCandles.length < warmup) return;

            const livePrice = candles.getLivePrice() ?? rawCandle.close;

            // Exit first — only acts on positions this strategy itself opened
            // (positionSource check mirrors every hardcoded strategy's own
            // guard against acting on another strategy's open position).
            if (state.position && state.positionSource === spec.name) {
                const oppositeTree = state.position === "LONG" ? spec.entryShort : spec.entryLong;
                const reversalHit  = spec.exitConfig?.reversalExit && evaluateTree(oppositeTree, ctx);
                const conditionHit = spec.exitConfig?.conditionExit && evaluateTree(spec.exitConfig.conditionExit, ctx);

                if (reversalHit || conditionHit) {
                    const closedSide = state.position;
                    await orders.exit(closedSide);
                    tg(`${closedSide} EXIT (${spec.name}) @ \u20b9${livePrice.toFixed(2)}`);
                    await positionsClose(livePrice, spec.name);
                    slStore.clearTrail();
                    targetStore.clearTarget();
                    edgeMemory = {};
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0, null, null, null, null);
                    return; // don't re-enter on the same candle it exited
                }
            }

            // Entry
            if (!state.position) {
                const longHit  = spec.entryLong  && evaluateTree(spec.entryLong, ctx);
                const shortHit = spec.entryShort && evaluateTree(spec.entryShort, ctx);
                const side = longHit ? "LONG" : shortHit ? "SHORT" : null;
                if (!side) return;

                // Universal entry gates — same 5 checks every hardcoded
                // strategy in strategies.js runs before orders.enter()
                // (chopGate/doubleOrderGate/volumeGate/longCandleGate/
                // htfGate), previously NOT wired here (pre-existing gap —
                // see talgo-x.md). isReversal is always false: this
                // function returns right after an exit (above), so a
                // custom strategy can never exit-then-reenter within the
                // same processCandle call the way strategies.js's
                // same-candle reversal strategies do — doubleOrderGate is
                // wired for parity/future-proofing but has no current
                // effect here.
                const isReversal = false;
                const doubleBlocked = isDoubleOrderBlocked(context, state, isReversal);
                const chopBlocked = isChopBlocked(context, engineConfig, candles, { force: engineConfig.CHOP_GATE_ALWAYS_FORCE !== false });
                const volumeBlocked = isVolumeBlocked(context, engineConfig, candles);
                const longCandleBlocked = evaluateLongCandle(context, engineConfig, candles, state);
                const htfBlocked = htf ? await htf.isBlocked() : false;
                if (doubleBlocked) console.log(`[${context.tgPrefix}] custom:${spec.name} entry blocked — double orders disabled`);
                else if (chopBlocked) console.log(`[${context.tgPrefix}] custom:${spec.name} entry blocked by Choppiness Index filter`);
                else if (volumeBlocked) console.log(`[${context.tgPrefix}] custom:${spec.name} entry blocked — volume not above its SMA`);
                else if (longCandleBlocked) console.log(`[ENTRY_BLOCKED_LONG_CANDLE] instrument=${context.symbol} strategy=custom:${spec.name} direction=${side} remainingCooldown=${state.longCandleCooldown || 0}`);
                else if (htfBlocked) console.log(`[${context.tgPrefix}] custom:${spec.name} entry blocked — higher timeframe trending but still inside its own ALMA band`);
                if (doubleBlocked || chopBlocked || volumeBlocked || longCandleBlocked || htfBlocked) return;

                await orders.enter(side);
                state.position       = side;
                state.entryPrice     = livePrice;
                state.positionSource = spec.name;
                state.openTradeId    = await db.insertOpenTrade(context.tgPrefix, context.symbol, side, context.lots, livePrice);

                const stopLevel = resolveAtrStop(current, side, livePrice);
                if (stopLevel !== null) slStore.setTrail(stopLevel, side === "LONG" ? 1 : -1);
                else if (spec.exitConfig?.stopLoss?.type === "points") {
                    const pts = spec.exitConfig.stopLoss.value;
                    slStore.setTrail(side === "LONG" ? livePrice - pts : livePrice + pts, side === "LONG" ? 1 : -1);
                }
                if (spec.exitConfig?.target?.type === "points") {
                    const pts = spec.exitConfig.target.value;
                    // setTarget takes an absolute price level + direction
                    // (1 = LONG exits at/above, -1 = SHORT exits at/below),
                    // same contract as slStore.setTrail above — target.js's
                    // own dir convention, not a points-relative call.
                    targetStore.setTarget(
                        side === "LONG" ? livePrice + pts : livePrice - pts,
                        side === "LONG" ? 1 : -1
                    );
                }

                db.savePosition(
                    context.tgPrefix, context.token, context.symbol,
                    side, livePrice, spec.name, null, null,
                    JSON.stringify(edgeMemory)
                );
                tg(`${side} ENTRY (${spec.name}) @ \u20b9${livePrice.toFixed(2)}`);
            }
        }

        async function initSignals() {
            try {
                const saved = await db.loadPosition(context.tgPrefix, context.token);
                if (saved?.position) {
                    state.position       = saved.position;
                    state.entryPrice     = saved.entry_price;
                    state.positionSource = saved.position_source || spec.name;
                    edgeMemory = saved.strategy_state ? JSON.parse(saved.strategy_state) : {};

                    const openTrade = await db.getOpenTrade(context.tgPrefix);
                    state.openTradeId = openTrade ? openTrade.id : null;
                }
                state.pnl = await db.getRealizedPnlToday(context.tgPrefix);

                const info = state.position ? `${state.position}@${state.entryPrice}` : "flat";
                console.log(`[${context.tgPrefix}] custom:${spec.name} ${info}`);

                await orders.reconcile(state);
            } catch (err) {
                console.warn(`INIT  [${context.tgPrefix}] custom strategy "${spec.name}" restore failed:`, err.message);
            }
        }

        return { processCandle, initSignals };
    };
}

module.exports = { createCustomStrategy };
