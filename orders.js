// orders.js — Kite order placement.
//
// CHANGED:
//   - Was a module reading config.FAST_TOKEN/FAST_SYMBOL/FAST_LOTS directly
//     and keying _inFlight off a hardcoded "FAST" string. Now createOrders(context)
//     returns an instance scoped to one InstrumentContext, with its own
//     in-flight guard closed over instead of a shared object keyed by name.
//   - Dropped "Fast" naming: fastEntry/fastExit/fastSLExit → enter/exit/slExit.
//     Order tags TALGO_F_EN/EX/SL → TALGO_EN/EX/SL (no fast/slow split anymore).
//   - reconcile() now takes state explicitly instead of a global FAST object.
//   - _place() no longer sends order_type:"MARKET". MCX rejects market orders
//     without "market protection" via the API — there's no direct param for
//     that in kiteconnect's placeOrder, so it's emulated with a LIMIT order
//     banded ± MARKET_PROTECTION_PCT around current LTP.
//   - enter/exit/slExit now RETURN _place()'s result (order id, or null on
//     failure/skip) instead of swallowing it. Callers in signals.js/candlePoll.js
//     gate state transitions on this — previously they always resolved to
//     undefined, so the "did the order actually work" checks upstream were
//     dead code and internal state could go LONG/flat even on a broker reject.
//
// Toggle LIVE_ORDERS in engineConfig.js to enable/disable.
// When disabled: all calls are no-ops, engine runs in shadow mode.
// When enabled: places MIS limit (protected) orders via Kite Connect.
//
// Pre-live checklist implemented here:
// A. Position reconciliation — called from initSignals via reconcile()
// B. Order acknowledgement logging — every order logs ts/signal/id/status/qty/price
// C. Duplicate order protection — in-flight flag blocks concurrent submissions
"use strict";

const { KiteConnect } = require("kiteconnect");
const fs           = require("fs");
const engineConfig = require("./engineConfig");
const c            = require("./c");
const { normalizePrice } = require("./price");

function createOrders(context, tg) {
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim());

    // ─── C. DUPLICATE ORDER PROTECTION ───────────────────────────────────────
    // true while an order HTTP call is in progress for this instrument.
    // Prevents signal → network retry → signal again → double order.
    let _inFlight = false;

    // ─── B. ORDER ACKNOWLEDGEMENT LOG ────────────────────────────────────────
    // CHANGED: split from one long line into two shorter ones — the single-line
    // version wrapped awkwardly on a mobile SSH terminal's narrow width.
    function _logOrder(signal, orderId, status, qty, price) {
        const ts     = new Date().toLocaleTimeString("en-IN", { hour12: false });
        const line1  = `ORDER  ${ts}  [${context.tgPrefix}]  ${signal}  ${status}`;
        const line2  = `  id:${orderId}  qty:${qty}  px:${price ?? "MKT"}`;
        const colorFn = (status === "FILLED" || status === "PLACED") ? c.dim : c.red;
        console.log(colorFn(line1));
        console.log(colorFn(line2));
    }

    // ─── INTERNAL PLACE ───────────────────────────────────────────────────────
    // Returns the broker order id on success, or null on failure/duplicate-skip.
    // CHANGED: added an `awaitFill` option. Previously the fill-status poll was
    // always a fire-and-forget setTimeout, so callers (including EOD shutdown
    // in lifecycle.js) resolved as soon as the order was PLACED, not FILLED —
    // the FILLED log could land after the "*** SHUTDOWN ***" line, or not print
    // at all before process.exit(). Normal live entries/exits still fire-and-forget
    // (no reason to block the strategy loop for 2s on every order); EOD passes
    // { awaitFill: true } to block until the FILLED/manual-check log has printed.
    async function _place(transaction_type, quantity, signal, { awaitFill = false } = {}) {
        if (!engineConfig.LIVE_ORDERS) return null;

        // C. Duplicate guard — block if an order for this instrument is in flight
        if (_inFlight) {
            console.log(c.yellow(`ORDER  [${context.tgPrefix}] ${signal} skipped — order already in flight`));
            return null;
        }

        _inFlight = true;
        try {
            // MCX rejects order_type:"MARKET" via API without market protection
            // ("Market orders without market protection are not allowed via API.
            // Please set market protection or use a Limit order."). Emulate a
            // protected market order with a LIMIT order banded around LTP.
            const ltpKey  = `${context.exchange}:${context.symbol}`;
            const ltpData = await kc.getLTP([ltpKey]);
            const ltp     = ltpData[ltpKey]?.last_price;
            if (!ltp) throw new Error(`LTP fetch failed for ${ltpKey}`);

            const protectionPct = engineConfig.MARKET_PROTECTION_PCT ?? 0.5; // %
            const band  = ltp * (protectionPct / 100);
            const rawPrice = transaction_type === "BUY" ? ltp + band : ltp - band;
            // BUG FIX (27 Jul incident): was `.toFixed(2)` — 2-decimal-place
            // rounding, not tick-size rounding. 380.64 has 2 decimals but is
            // not a multiple of ZINCMINI's 0.05 tick, so Kite rejected it
            // ("INVALID PRICE ... NOT AS PER TICKSIZE") and the position had
            // to be closed manually. normalizePrice() rounds to context.tickSize
            // instead. Throws loudly if tickSize is missing rather than
            // silently falling back to decimal-place rounding again.
            const price = normalizePrice(rawPrice, context.tickSize);

            // CHANGED: product depends on context.carryOvernight. MIS (Margin
            // Intraday Square-off) is auto-closed by the broker itself around
            // EOD regardless of what this app does — so a carry-overnight
            // position placed as MIS would get force-closed by Zerodha even if
            // lifecycle.js skips its own EOD exit. NRML (normal/overnight
            // margin) is what actually allows a position to persist past the
            // trading session. Both entry AND exit orders use the same product
            // as whatever the position was opened under (an MIS entry must be
            // closed with an MIS exit, same for NRML) — context.carryOvernight
            // is fixed per-process (set once at boot from the toolbox prompt),
            // so this is safe to read at every _place() call, not just entry.
            const product = context.carryOvernight ? "NRML" : "MIS";

            const order = await kc.placeOrder("regular", {
                tradingsymbol:    context.symbol,
                exchange:         context.exchange,
                transaction_type,
                order_type:       "LIMIT",
                price,
                product,
                quantity,
                validity:         "DAY",
                tag:              signal,           // visible in Kite UI, max 20 chars
            });

            const id = order.order_id;

            // B. Acknowledgement log — accepted by exchange
            _logOrder(signal, id, "PLACED", quantity, price);
            tg(`✅ Order placed [${context.tgPrefix}]\n${signal}  qty:${quantity}\nid:${id}`);

            // Risk #3 — verify fill status (protected LIMIT orders fill almost
            // instantly on MCX given the LTP band, same as a true market order).
            // Poll once after 2s — if not COMPLETE, alert for manual check.
            const confirmFill = async () => {
                try {
                    const history = await kc.getOrderHistory(id);
                    const last    = history[history.length - 1];
                    const status  = last?.status ?? "UNKNOWN";
                    if (status !== "COMPLETE") {
                        console.error(c.red(`ORDER  [${context.tgPrefix}] ${signal} id:${id}  status:${status} — manual check required`));
                        tg(`⚠ Order not filled [${context.tgPrefix}]\n${signal}  id:${id}\nStatus: ${status}\nManual check required.`);
                    } else {
                        const fillPx = last.average_price ?? "n/a";
                        _logOrder(signal, id, "FILLED", quantity, fillPx);
                    }
                } catch (e) {
                    console.error(c.red(`ORDER  status check failed for ${id}: ${e.message}`));
                }
            };

            if (awaitFill) {
                // EOD path: block until the FILLED (or manual-check) log has
                // actually printed, so it lands before the session summary.
                await new Promise(r => setTimeout(r, 2000));
                await confirmFill();
            } else {
                setTimeout(confirmFill, 2000);
            }

            return id;

        } catch (err) {
            const msg = err.message || String(err);
            // B. Log failure too
            _logOrder(signal, "FAILED", msg, quantity, null);
            console.error(c.red(`ORDER ERR  [${context.tgPrefix}] ${signal}: ${msg}`));
            tg(`⚠ Order FAILED [${context.tgPrefix}]\n${signal}  qty:${quantity}\n${msg}`);
            return null;

        } finally {
            _inFlight = false;
        }
    }

    // ─── A. POSITION RECONCILIATION ───────────────────────────────────────────
    // Call on startup after initSignals. Fetches broker positions and compares
    // against internal state. Logs and alerts on any mismatch.
    // Only runs when LIVE_ORDERS is true — no point reconciling in shadow mode.
    async function reconcile(state) {
        if (!engineConfig.LIVE_ORDERS) return;

        try {
            const { net } = await kc.getPositions();

            const brokerMap = {};
            for (const p of (net || [])) {
                brokerMap[p.tradingsymbol] = (brokerMap[p.tradingsymbol] || 0) + p.quantity;
            }

            const brokerQty   = brokerMap[context.symbol] || 0;
            const internalQty = state.position === "LONG"  ?  context.lots
                              : state.position === "SHORT" ? -context.lots
                              : 0;

            if (brokerQty !== internalQty) {
                console.log();
                console.log(c.red(`⚠ RECONCILE MISMATCH [${context.tgPrefix}]`));
                console.log(c.red(`  broker  : ${brokerQty >= 0 ? "+" : ""}${brokerQty} lots  (${context.symbol})`));
                console.log(c.red(`  internal: ${internalQty >= 0 ? "+" : ""}${internalQty} lots  (${state.position ?? "flat"})`));
                console.log();
                tg(`⚠ Position mismatch [${context.tgPrefix}]\nBroker: ${brokerQty} lots\nBot: ${internalQty} lots (${state.position ?? "flat"})\nManual check required.`);
            } else {
                console.log(c.green(`RECONCILE  [${context.tgPrefix}]  ok  (${brokerQty >= 0 ? "+" : ""}${brokerQty} lots)`));
                console.log();
            }

        } catch (err) {
            console.error(c.red(`RECONCILE  [${context.tgPrefix}] failed: ${err.message}`));
            tg(`⚠ Reconciliation failed [${context.tgPrefix}]: ${err.message}`);
        }
    }

    // ─── HELPERS ──────────────────────────────────────────────────────────────
    function _exitSide(side) { return side === "LONG" ? "SELL" : "BUY"; }

    // ─── PUBLIC API ───────────────────────────────────────────────────────────
    // Each returns the broker order id on success, or null on failure/skip —
    // callers MUST check this before mutating internal position state.
    async function enter(side, opts) {
        const transaction_type = side === "LONG" ? "BUY" : "SELL";
        return await _place(transaction_type, context.lots, "TALGO_EN", opts);
    }

    async function exit(side, opts) {
        return await _place(_exitSide(side), context.lots, "TALGO_EX", opts);
    }

    async function slExit(side, opts) {
        return await _place(_exitSide(side), context.lots, "TALGO_SL", opts);
    }

    async function targetExit(side, opts) {
        return await _place(_exitSide(side), context.lots, "TALGO_TP", opts);
    }

    return { enter, exit, slExit, targetExit, reconcile };
}

module.exports = { createOrders };
