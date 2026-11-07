// shortNames.js — short display codes for PM2 process names.
//
// "Zn" for ZINCMINI, "Ng" for NATGASMINI — these match how traders actually
// abbreviate these instruments, not something derivable from the string
// itself, so this is hand-maintained. Extend as you add new underlyings.
"use strict";

// CHANGED: mini/micro variants used to share the SAME code as their full-lot
// counterpart (ZINCMINI/ZINC both "Zn", GOLD/GOLDMINI/GOLDM all "Au", etc).
// toProcessName() is the only consumer of this map, and it builds the PM2
// process name purely from this code + strategy — so ZINC and ZINCMINI
// running the same strategy collided on name ("already running... stop/
// remove it first"), even though they're genuinely different MCX contracts
// (confirmed against MCX.csv — different tokens/lot sizes, not aliases of
// each other). Now every real underlying gets its own code: full-lot keeps
// the bare 2-letter code, mini/micro variants get an "m"/"c" suffix.
const shortNames = {
    ZINCMINI:   "Znm",
    ZINC:       "Zn",
    NATGASMINI: "Ngm",
    NATURALGAS: "Ng",
    GOLD:       "Au",
    GOLDMINI:   "Aux",
    GOLDM:      "Aum",
    SILVER:     "Ag",
    SILVERMINI: "Agx",
    SILVERM:    "Agm",
    SILVERMIC:  "Agc",
    CRUDEOIL:   "Cl",
    CRUDEOILM:  "Clm",
    COPPER:     "Cu",
    ALUMINIUM:  "Al",
    ALUMINI:    "Alm",
    NICKEL:     "Ni",
    LEAD:       "Pb",
    LEADMINI:   "Pbm",
    COTTON:     "Ct",
};

// Fallback for anything not in the table yet — first two letters, flagged
// so it's obvious this is a guess and not a real abbreviation. Add a proper
// entry above if you don't like what it picks.
function getShortName(underlying) {
    if (shortNames[underlying]) return shortNames[underlying];
    const guess = underlying.charAt(0).toUpperCase() + underlying.charAt(1).toLowerCase();
    console.warn(`shortNames: no entry for "${underlying}" — guessing "${guess}". Add a real entry in shortNames.js if this is wrong.`);
    return guess;
}

module.exports = { shortNames, getShortName };
