// sl.js — SL level store
// Standalone module with no dependencies — breaks the circular chain:
// signals.js → candlePoll.js → signals.js
"use strict";

let slowAlmaLevel = null;
let fastSTTrail   = null;
let fastSTDir     = 0;

function setSlowSL(almaVal)    { slowAlmaLevel = almaVal; }
function setFastSL(trail, dir) { fastSTTrail = trail; fastSTDir = dir; }
function clearSlowSL()         { slowAlmaLevel = null; }
function clearFastSL()         { fastSTTrail = null; fastSTDir = 0; }
function getSlowSL()           { return slowAlmaLevel; }
function getFastSL()           { return { trail: fastSTTrail, dir: fastSTDir }; }

module.exports = { setSlowSL, setFastSL, clearSlowSL, clearFastSL, getSlowSL, getFastSL };
