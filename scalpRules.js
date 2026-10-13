// scalpRules.js — effective scalp rules for the DSB-family scalp target.
// After the first scalp-target (SCALP_TP) hit of the IST day, further trades that day may use EITHER a different
// target (scalpNextMode "TARGET", rupees) OR a fixed rupee stop (scalpNextMode "SL"). state.scalpHitsToday is kept
// by losingSwitchGate (restored from the journal after a restart, reset on the IST day roll).
"use strict";
function scalpRules(context, state) {
    const base = Number(context.scalpTargetRupees) > 0 && !context.targetPoints ? Number(context.scalpTargetRupees) : null;
    const hits = (state && state.scalpHitsToday) || 0;
    const v = Number(context.scalpNextValue);
    const next = base && hits >= 1 && v > 0 ? context.scalpNextMode : null;
    return {
        targetRupees: base ? (next === "TARGET" ? v : base) : null,
        slRupees: next === "SL" ? v : null,
        hits,
    };
}
const rupeesToPoints = (context, r) => r / ((context.lotMult || 1) * (context.lots || 1));
module.exports = { scalpRules, rupeesToPoints };
