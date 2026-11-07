// price.js — order price normalization.
//
// Root cause of the 27 Jul ZINCMINI order rejection: orders.js's market-
// protection band price was rounded with `.toFixed(2)` — decimal-place
// rounding, not tick-size rounding. MCX ZINCMINI's tick size is 0.05, so a
// 2-decimal-place price like 380.64 is NOT a multiple of 0.05 and gets
// rejected by the exchange ("INVALID PRICE ... NOT AS PER TICKSIZE").
//
// Kept as a standalone, dependency-free module (same reasoning as
// sl.js/target.js) so any file that needs to round a price to a tick size
// can use the same one function instead of re-deriving `.toFixed(2)` in a
// new place and reintroducing this exact bug.
"use strict";

// Math.round(price / tick) * tick can land on values like 376.40000000000003
// due to floating point — the .toFixed(2)+Number() wrap below cleans that up
// AFTER tick-rounding (as opposed to the original bug, which used
// .toFixed(2) INSTEAD OF tick-rounding).
function normalizePrice(price, tickSize) {
    if (!tickSize) throw new Error(`normalizePrice: tickSize is missing/zero (got ${tickSize}) — refusing to guess`);
    return Number((Math.round(price / tickSize) * tickSize).toFixed(2));
}

module.exports = { normalizePrice };
