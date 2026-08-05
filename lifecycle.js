// lifecycle.js — EOD shutdown.
//
// CHANGED:
//   - Was a module reading `./state` (FAST), `./config` (FAST_TOKEN/FAST_SYMBOL),
//     `./db`, `./sl`, `./orders`, `./candleBuilder` all as singletons at
//     module scope. Now createLifecycle({...}) takes context, engineConfig,
//     state, db, candles, slStore, orders as explicit dependencies —
//     same pattern as candlePoll.js.
//   - Dropped "Fast" naming: closeFast -> positions.close (via injected
//     positionsClose), clearFastSL -> slStore.clearTrail, fastExit -> orders.exit,
//     FAST -> state. DB engine tag "FAST" -> context.tgPrefix.
//   - Report header ("TAlgo-X NatGas Mini") now built from context.name
//     instead of a hardcoded string, so this file doesn't need editing
//     when it's reused for another instrument.
//
// CHANGED (this pass): EOD force-close used to call orders.exit() and then
//   unconditionally treat the position as closed — same state-integrity bug
//   as the exit triggers in signals.js. Unlike those, EOD can't just "retry
//   next candle" (there is no next candle), so on a failed exit order this
//   now: alerts loudly, skips positionsClose/slStore.clearTrail and the DB
//   flatten, and leaves state.position as-is so reconcile() on next boot (or
//   a manual check tonight) can catch the real broker position. Shutdown and
//   the report still proceed either way — MIS carries its own EOD square-off
//   as a backstop, this just stops the bot from lying to itself about it.
"use strict";

const c           = require("./c");
const { pnlStr }  = require("./positions");
const { istParts } = require("./istTime");
const { emitEvent } = require("./eventBridge"); // web dashboard only, see eventBridge.js header

function createLifecycle({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, tg }) {
    let shutdownDone   = false;
    let _shutdown      = false;
    const sessionStart = Date.now();

    function isShutdown() { return _shutdown; }

    function startLifecycle() {
        const interval = setInterval(async () => {
            const now   = new Date();
            const price = candles.getLivePrice();

            // EOD — force close, write final exit to ledger, report from DB, shut down
            const { hours: istHour, minutes: istMinute } = istParts(now);
            if (istHour === context.eodHour && istMinute >= context.eodMinute && !shutdownDone) {
                shutdownDone = true;
                const mins  = Math.round((Date.now() - sessionStart) / 60000);
                const today = now.toISOString().split("T")[0];

                console.log();
                console.log(c.dim(`EOD  [${context.tgPrefix}]  ${now.toLocaleString("en-IN", { hour12: false })}`));

                if (state.position && !price) {
                    console.error(c.red("EOD  no live price — force close skipped"));
                    tg(`⚠ [${context.tgPrefix}] EOD: no live price — force close skipped, position left open`);
                } else if (state.position && context.carryOvernight) {
                    // CHANGED: carry-overnight — do NOT exit. Position, SL
                    // trail, and target are deliberately left as-is; the
                    // position row in DB already reflects this position (kept
                    // current on every entry via db.savePosition, unaffected
                    // by EOD). strategies.js's initSignals() now resumes it
                    // on the next boot even across a day boundary (see
                    // `shouldResume` there). NOTE: slStore/targetStore and any
                    // in-memory entry-reason tag (e.g. MA_SLOPE's
                    // maSlopeEntryReason) are NOT persisted to DB — same known
                    // gap as an intraday restart — so the SL trail and
                    // scalp target (if any) restart fresh from the position's
                    // entry price on next boot, not from wherever they'd
                    // trailed to tonight. Flagging, not fixing here.
                    console.log(c.yellow(`EOD  [${context.tgPrefix}] carrying ${state.position}@${state.entryPrice} overnight — no exit placed`));
                    tg(`🌙 [${context.tgPrefix}] Carrying overnight\n${state.position}@${state.entryPrice}\nNo EOD exit placed (carry-overnight mode).`);
                } else if (state.position) {
                    // awaitFill: true — block until FILLED (or manual-check) has
                    // logged, so it never lands after "*** SHUTDOWN ***"
                    const closed = await orders.exit(state.position, { awaitFill: true });
                    if (engineConfig.LIVE_ORDERS && closed === null) {
                        console.error(c.red(`EOD  [${context.tgPrefix}] exit order FAILED — position left open, NOT marked closed`));
                        tg(`⚠ [${context.tgPrefix}] EOD exit FAILED\nPosition still open in engine state — verify broker position manually. MIS auto square-off is the backstop.`);
                    } else {
                        await positionsClose(price, "EOD_FORCE");   // awaited — ledger write must land before we read it back
                        slStore.clearTrail();
                        targetStore?.clearTarget();
                        db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                    }
                } else {
                    db.savePosition(context.tgPrefix, context.token, context.symbol, null, 0);
                }

                // Pull every trade for today straight from the DB — not RAM
                const realizedPnl  = await db.getRealizedPnlToday(context.tgPrefix);
                const dayTrades    = await db.getTradesForDate(context.tgPrefix, today);
                const closedTrades = dayTrades.filter(t => t.status === "CLOSED");
                const wins         = closedTrades.filter(t => t.pnl > 0).length;
                const winRate      = closedTrades.length ? Math.round((wins / closedTrades.length) * 100) : 0;

                console.log(c.dim(`session  ${mins}m`));
                console.log(c.dim(`  pnl : ${pnlStr(realizedPnl)}  trades: ${closedTrades.length}  winrate: ${winRate}%`));
                console.log();
                console.log(c.bold("*** SHUTDOWN ***"));

                // Web dashboard only: the underlying EXIT event (if a
                // position was actually closed above) already reached the
                // dashboard via positions.js's own emitEvent — this is a
                // separate signal that the whole SESSION is ending, not
                // just a position. Without it, a viewer watching live sees
                // the EXIT line and then nothing until the next ~30s PM2
                // status poll happens to notice the process has exited —
                // this fires immediately, right as shutdown starts, and
                // flips the card straight to offline instead of waiting.
                // positionLeftOpen flags the rare failed-exit-order branch
                // above, so the dashboard can tell "clean EOD" apart from
                // "shut down with a position still open, go check manually".
                emitEvent(context.tgPrefix, "SHUTDOWN", {
                    pnl: realizedPnl, trades: closedTrades.length, winRate,
                    positionLeftOpen: !!state.position,
                });

                let report = `TAlgo-X ${context.name}\n${today}\n\n`;
                closedTrades.forEach((t, i) => {
                    report += `Trade #${i + 1}\n${t.side}\n${t.entry_price} → ${t.exit_price}\n${pnlStr(t.pnl)}\nReason: ${t.exit_reason}\n\n`;
                });
                report += `Trades: ${closedTrades.length}  Wins: ${wins}  WinRate: ${winRate}%\nGross PnL: ${pnlStr(realizedPnl)}`;

                await tg(report);   // ensure the message is sent before the process exits
                _shutdown = true;
                clearInterval(interval);
                setTimeout(() => process.exit(0), 2000);
            }
        }, 30000);
    }

    return { startLifecycle, isShutdown };
}

module.exports = { createLifecycle };
