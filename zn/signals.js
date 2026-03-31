// signals.js
const config = require("./config");
const { tg } = require("./telegram");
const { FAST } = require("./state");
const { closeFast, unrealisedFast } = require("./positions");
const { alma, almaHL, atr, toHA } = require("./indicators");
const { getRawCandles } = require("./candleBuilder");
const db = require("./db");

let prevState = 0;
let fastProbation = false;

async function persistPosition(position, entryPrice, slPrice) {
    db.savePosition("FAST", config.TOKEN, config.SYMBOL, position, entryPrice, slPrice);
}

function getFastState(fast, fastPrev, rawCandles, currentATR) {
    const slope = fast - fastPrev;
    const band = almaHL(rawCandles);
    const bandWidth = (band.high !== null && band.low !== null) 
        ? band.high - band.low 
        : null;

    // Sideways Grey
    if (bandWidth < currentATR * config.COMPRESS_MULT) return 0;

    const strong_up   = slope > currentATR * config.SLOPE_MULT;
    const strong_down = slope < -currentATR * config.SLOPE_MULT;

    const buffer = currentATR * config.BUFFER_MULT;
    const above_band = rawCandles.at(-1).close > band.high + buffer;
    const below_band = rawCandles.at(-1).close < band.low  - buffer;

    if (strong_up && above_band) return 1;
    if (strong_down && below_band) return -1;
    return 0;
}

async function runSignals(price, fast, fastPrev, currentATR, isBootCheck = false) {
    const newState = getFastState(fast, fastPrev, getRawCandles(), currentATR);
    const stateChanged = newState !== prevState && newState !== 0;

    const fastUPnL = unrealisedFast(price);

    // Candle Summary
    if (!isBootCheck) {
        const ts = new Date().toLocaleTimeString("en-IN", { hour12: false });
        const pnl = FAST.position ? fastUPnL : 0;
        console.log(`${ts}  ${price.toFixed(2)}   FAST: ${pnl.toFixed(0)}`);
        tg(`${ts}\nFAST: ${pnl.toFixed(0)}`);
    }

    // FAST SL
    if (FAST.position) {
        const fastSLHit = (FAST.position === "LONG" && price < fast) || 
                         (FAST.position === "SHORT" && price > fast);
        if (fastSLHit) {
            await closeFast(price, "SL_FAST_ALMA");
            await persistPosition(null, 0, 0);
            fastProbation = false;
        }
    }

    // FAST Entry with Smart Probation
    if (stateChanged) {
        const side = newState === 1 ? "LONG" : "SHORT";
        const slope = fast - fastPrev;
        const slopeStrength = Math.abs(slope) / currentATR;

        if (slopeStrength > 2.5) {
            // Strong move - enter immediately
            if (FAST.position && FAST.position !== side) {
                await closeFast(price, "STATE_CHANGE");
                await persistPosition(null, 0, 0);
            }
            FAST.position = side;
            FAST.entryPrice = price;
            FAST.slPrice = price + (side === "LONG" ? -1 : 1) * currentATR * config.SL_ATR_MULT;

            console.log(`→ FAST ${side} ENTRY (STRONG) @ ${price.toFixed(2)}`);
            tg(`→ FAST ${side} ENTRY (STRONG) @ ₹${price.toFixed(2)}`);

            await persistPosition(side, price, FAST.slPrice);
            fastProbation = false;
        } else {
            // Normal move - probation
            if (!fastProbation) {
                fastProbation = true;
                console.log(`→ FAST ${side} PROBATION @ ${price.toFixed(2)}`);
                return;
            }

            if (FAST.position && FAST.position !== side) {
                await closeFast(price, "STATE_CHANGE");
                await persistPosition(null, 0, 0);
            }

            FAST.position = side;
            FAST.entryPrice = price;
            FAST.slPrice = price + (side === "LONG" ? -1 : 1) * currentATR * config.SL_ATR_MULT;

            console.log(`→ FAST ${side} ENTRY CONFIRMED @ ${price.toFixed(2)}`);
            tg(`→ FAST ${side} ENTRY CONFIRMED @ ₹${price.toFixed(2)}`);

            await persistPosition(side, price, FAST.slPrice);
            fastProbation = false;
        }
    } else {
        fastProbation = false;
    }

    // MAX LOSS protection
    if (FAST.position && fastUPnL < -config.MAX_LOSS) {
        await closeFast(price, "MAX_LOSS");
        await persistPosition(null, 0, 0);
    }

    prevState = newState;
    FAST.color = newState === 1 ? "GREEN" : newState === -1 ? "RED" : "GREY";
}

function processCandle(rawCandle) {
    const rawCandles = getRawCandles();
    if (rawCandles.length < config.ALMA_FAST) {
        console.log(`[WARMUP] ${rawCandles.length}/${config.ALMA_FAST}`);
        return;
    }

    const ha = toHA(rawCandles);
    const haClose = ha.map(c => c.close);
    const fast = alma(haClose, config.ALMA_FAST);
    const fastPrev = alma(haClose.slice(0, -1), config.ALMA_FAST);
    const currentATR = atr(rawCandles);

    if (!fast || !fastPrev || !currentATR) return;

    runSignals(rawCandle.close, fast, fastPrev, currentATR, false);
}

module.exports = { runSignals, processCandle };