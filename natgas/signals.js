// signals.js
const config = require("./config");
const { tg } = require("./telegram");
const { SLOW, FAST } = require("./state");
const { closeSlow, closeFast, unrealisedSlow, unrealisedFast } = require("./positions");
const { alma, almaHL, atr, toHA } = require("./indicators");
const { getRawCandles } = require("./candleBuilder");
const db = require("./db");

let slowPeakPnL = 0;
let prevState = 0;
let fastProbation = false;

async function persistPosition(engine, position, entryPrice, slPrice) {
    const token = engine === "SLOW" ? config.SLOW_TOKEN : config.FAST_TOKEN;
    const symbol = engine === "SLOW" ? config.SLOW_SYMBOL : config.FAST_SYMBOL;
    db.savePosition(engine, token, symbol, position, entryPrice, slPrice);
}

function getFastState(fast, fastPrev, rawCandles, currentATR) {
    const slope = fast - fastPrev;
    const band = almaHL(rawCandles);
    const bandWidth = (band.high !== null && band.low !== null) 
        ? band.high - band.low 
        : null;

    const is_sideways = bandWidth !== null && bandWidth < currentATR * config.COMPRESS_MULT;
    if (is_sideways) return 0;

    const strong_up   = slope > currentATR * config.SLOPE_MULT;
    const strong_down = slope < -currentATR * config.SLOPE_MULT;

    const buffer = currentATR * 0.25;
    const above_band = rawCandles.at(-1).close > band.high + buffer;
    const below_band = rawCandles.at(-1).close < band.low  - buffer;

    if (strong_up && above_band) return 1;
    if (strong_down && below_band) return -1;
    return 0;
}

async function runSignals(price, fast, fastPrev, slow, currentATR, isBootCheck = false) {
    const newState = getFastState(fast, fastPrev, getRawCandles(), currentATR);
    const stateChanged = newState !== prevState && newState !== 0;
    const protectTrigger = currentATR * config.SLOW_LOT_MULT * config.SLOW_LOTS * config.ATR_MULT;

    const slowUPnL = unrealisedSlow(price);
    if (SLOW.position && slowUPnL > slowPeakPnL) slowPeakPnL = slowUPnL;

    // 1H Candle Summary
    if (!isBootCheck) {
        const ts = new Date().toLocaleTimeString("en-IN", { hour12: false });
        const fPnL = FAST.position ? unrealisedFast(price) : 0;
        const sPnL = SLOW.position ? slowUPnL : 0;
        const tot = (fPnL + sPnL).toFixed(0);

        console.log(`${ts}  ${price.toFixed(2)}   SLOW: ${sPnL.toFixed(0)}   FAST: ${fPnL.toFixed(0)}   Total: ${tot}`);
        tg(`${ts}\nSLOW: ${sPnL.toFixed(0)}    FAST: ${fPnL.toFixed(0)}    Total: ${tot}`);
    }

    // FAST SL
    if (FAST.position) {
        const fastSLHit = (FAST.position === "LONG" && price < slow) || 
                         (FAST.position === "SHORT" && price > slow);
        if (fastSLHit) {
            await closeFast(price, "SL_SLOW_ALMA");
            await persistPosition("FAST", null, 0, 0);
            fastProbation = false;
        }
    }

    // SMART FAST Entry with Probation
    if (stateChanged) {
        const side = newState === 1 ? "LONG" : "SHORT";
        const slope = fast - fastPrev;
        const slopeStrength = Math.abs(slope) / currentATR;

        // If move is VERY strong (big candle), enter immediately without probation
        if (slopeStrength > 2.5) {   // Very strong move → no probation
            if (FAST.position && FAST.position !== side) {
                await closeFast(price, "STATE_CHANGE");
                await persistPosition("FAST", null, 0, 0);
            }
            FAST.position = side;
            FAST.entryPrice = price;
            FAST.slPrice = price + (side === "LONG" ? -1 : 1) * currentATR * config.SL_ATR_MULT;

            console.log(`→ FAST ${side} ENTRY (STRONG MOVE) @ ${price.toFixed(2)}`);
            tg(`→ FAST ${side} ENTRY (STRONG MOVE) @ ₹${price.toFixed(2)}`);

            await persistPosition("FAST", side, price, FAST.slPrice);
            fastProbation = false;
        } 
        else {
            // Normal move → use probation to avoid whipsaw
            if (!fastProbation) {
                fastProbation = true;
                console.log(`→ FAST ${side} PROBATION STARTED @ ${price.toFixed(2)}`);
                return;   // Wait for next candle
            }

            // Confirmation passed
            if (FAST.position && FAST.position !== side) {
                await closeFast(price, "STATE_CHANGE");
                await persistPosition("FAST", null, 0, 0);
            }

            FAST.position = side;
            FAST.entryPrice = price;
            FAST.slPrice = price + (side === "LONG" ? -1 : 1) * currentATR * config.SL_ATR_MULT;

            console.log(`→ FAST ${side} ENTRY CONFIRMED @ ${price.toFixed(2)}`);
            tg(`→ FAST ${side} ENTRY CONFIRMED @ ₹${price.toFixed(2)}`);

            await persistPosition("FAST", side, price, FAST.slPrice);
            fastProbation = false;
        }
    } else {
        fastProbation = false;   // Reset if state changes back
    }

    // FAST protects SLOW
    if (SLOW.position) {
        const fastReversal = (SLOW.position === "LONG" && newState <= 0) ||
                             (SLOW.position === "SHORT" && newState >= 0);

        if (slowPeakPnL > 0) {
            const giveBack = slowPeakPnL - slowUPnL;
            if (fastReversal && giveBack > protectTrigger) {
                await closeSlow(price, "FAST_PROTECT");
                await persistPosition("SLOW", null, 0, 0);
                slowPeakPnL = 0;
            }
        }

        if (slowUPnL < -config.MAX_LOSS_SLOW) {
            await closeSlow(price, "MAX_LOSS");
            await persistPosition("SLOW", null, 0, 0);
            slowPeakPnL = 0;
        }
    }

    // SLOW SL
    if (SLOW.position) {
        const slowSLHit = (SLOW.position === "LONG" && price < fast) || 
                         (SLOW.position === "SHORT" && price > fast);
        if (slowSLHit) {
            await closeSlow(price, "SL_FAST_ALMA");
            await persistPosition("SLOW", null, 0, 0);
            slowPeakPnL = 0;
        }
    }

    // SLOW Entry
    if (!SLOW.position) {
        const prevPrice = getRawCandles().at(-2)?.close;
        if (isBootCheck) {
            const side = price > slow ? "LONG" : "SHORT";
            SLOW.position = side;
            SLOW.entryPrice = price;
            slowPeakPnL = 0;
            SLOW.slPrice = price + (side === "LONG" ? -1 : 1) * currentATR * config.SL_ATR_MULT;
            console.log(`→ SLOW ${side} ENTRY (BOOT) @ ${price.toFixed(2)}`);
            tg(`→ SLOW ${side} ENTRY (BOOT) @ ₹${price.toFixed(2)}`);
            await persistPosition("SLOW", side, price, SLOW.slPrice);
        } else if (prevPrice != null) {
            const crossAbove = prevPrice <= slow && price > slow;
            const crossBelow = prevPrice >= slow && price < slow;
            if (crossAbove || crossBelow) {
                const side = crossAbove ? "LONG" : "SHORT";
                SLOW.position = side;
                SLOW.entryPrice = price;
                slowPeakPnL = 0;
                SLOW.slPrice = price + (side === "LONG" ? -1 : 1) * currentATR * config.SL_ATR_MULT;
                console.log(`→ SLOW ${side} ENTRY (CROSS) @ ${price.toFixed(2)}`);
                tg(`→ SLOW ${side} ENTRY (CROSS) @ ₹${price.toFixed(2)}`);
                await persistPosition("SLOW", side, price, SLOW.slPrice);
            }
        }
    }

    prevState = newState;
    FAST.color = newState === 1 ? "GREEN" : newState === -1 ? "RED" : "GREY";
}

function processCandle(rawCandle) {
    const rawCandles = getRawCandles();
    if (rawCandles.length < config.ALMA_SLOW) {
        console.log(`[WARMUP] ${rawCandles.length}/${config.ALMA_SLOW}`);
        return;
    }

    const ha = toHA(rawCandles);
    const haClose = ha.map(c => c.close);
    const fast = alma(haClose, config.ALMA_FAST);
    const fastPrev = alma(haClose.slice(0, -1), config.ALMA_FAST);
    const slow = alma(haClose, config.ALMA_SLOW);
    const currentATR = atr(rawCandles);

    if (!fast || !slow || !fastPrev || !currentATR) return;

    runSignals(rawCandle.close, fast, fastPrev, slow, currentATR, false);
}

module.exports = { runSignals, processCandle };