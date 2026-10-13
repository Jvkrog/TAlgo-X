// scalpRules.js — effective scalp rules for the DSB-family scalp target.
// After the first scalp-target (SCALP_TP) hit of the IST day, further trades that day may use EITHER a different
// target (scalpNextMode "TARGET", rupees; blank/0 = no target) OR a fixed rupee stop (scalpNextMode "SL"). state.scalpHitsToday is kept
// by losingSwitchGate (restored from the journal after a restart, reset on the IST day roll).
"use strict";
function scalpRules(context, state) {
    const base = Number(context.scalpTargetRupees) > 0 && !context.targetPoints ? Number(context.scalpTargetRupees) : null;
    const hits = (state && state.scalpHitsToday) || 0;
    const v = Number(context.scalpNextValue) || 0;
    // TARGET with no/0 value = no target for the rest of the day (exit only by the strategy's stop / flip).
    const next = base && hits >= 1 && (context.scalpNextMode === "TARGET" || (context.scalpNextMode === "SL" && v > 0)) ? context.scalpNextMode : null;
    return {
        targetRupees: base ? (next === "TARGET" ? (v > 0 ? v : null) : base) : null,
        slRupees: next === "SL" ? v : null,
        hits,
    };
}
const rupeesToPoints = (context, r) => r / ((context.lotMult || 1) * (context.lots || 1));
module.exports = { scalpRules, rupeesToPoints };
