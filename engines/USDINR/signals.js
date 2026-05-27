// signals.js — NatGas Dual Engine
//
// SLOW: ALMA 20 on 1H HA — regime memory + dynamic ALMA SL
// FAST: SuperTrend(10, 1.0) on 1H HA — structural containment + trail SL
//
// Entries only after 10:00. Engine boots at 9:00, fetches 9AM candle via API.
// That candle naturally validates any carry position — no special Monday logic needed.
"use strict";

const config = require("./config");
const { tg }  = require("./telegram");
const { SLOW, FAST } = require("./state");
const { closeSlow, closeFast } = require("./positions");
const { toHA, alma, supertrend, adx } = require("./indicators");
const { getRawCandles } = require("./candleBuilder");
const { setSlowSL, setFastSL, clearSlowSL, clearFastSL } = require("./sl");
const db = require("./db");

// ─── MODULE STATE — only what's needed ───────────────────────────────────────
let slowRegime = 0;   // 1 = long regime, -1 = short regime
let prevSTDir  = 0;   // last SuperTrend direction: 1 | -1

// ─── TRADING WINDOW ───────────────────────────────────────────────────────────
function canEnter() {
    const now = new Date();
    return now.getHours() > config.TRADE_START_HOUR ||
        (now.getHours() === config.TRADE_START_HOUR &&
         now.getMinutes() >= config.TRADE_START_MINUTE);
}

// ─── PERSIST ──────────────────────────────────────────────────────────────────
function persistSlow(position, entryPrice) {
    db.savePosition("SLOW", config.SLOW_TOKEN, config.SLOW_SYMBOL, position, entryPrice || 0);
}
function persistFast(position, entryPrice) {
    db.savePosition("FAST", config.FAST_TOKEN, config.FAST_SYMBOL, position, entryPrice || 0);
}

// ─── MAIN SIGNAL LOOP ─────────────────────────────────────────────────────────
async function runSignals(price, almaVal, stResult, adxVal) {
    const stLast = stResult[stResult.length - 1];
    const stDir  = stLast ? stLast.dir   : prevSTDir;
    const trail  = stLast ? stLast.trend : null;

    // ── ADX gate — entry filter only, never affects exits ────────────────────
    const adxOk = !config.USE_ADX_FILTER || (adxVal !== null && adxVal >= config.ADX_MIN);

    // ── REGIME — immediate ALMA cross, no debounce ────────────────────────────
    // 1H HA candles are already smoothed — debounce was compensating for tick noise
    // that no longer exists in this architecture.
    const crossNow = price >= almaVal ? 1 : -1;
    if (slowRegime === 0) {
        slowRegime = crossNow;
        db.saveRegime(config.SLOW_TOKEN, slowRegime);
        console.log(`regime seeded  ${slowRegime > 0 ? "↑" : "↓"}`);
    } else if (crossNow !== slowRegime) {
        slowRegime = crossNow;
        db.saveRegime(config.SLOW_TOKEN, slowRegime);
        const label = crossNow === 1 ? "long regime ↑" : "short regime ↓";
        console.log();
        console.log(`REGIME ${label}  @ ${price.toFixed(2)}`);
        console.log();
        tg(`REGIME ${label} @ ${price.toFixed(2)}`);
    }

    // ── SLOW ENGINE ───────────────────────────────────────────────────────────

    if (config.SLOW_ENABLED && SLOW.position) {
        // Refresh SL to current ALMA line every candle
        setSlowSL(almaVal);

        // Catch candle-close breach (WebSocket catches intrabar breach)
        const breached =
            (SLOW.position === "LONG"  && price < almaVal) ||
            (SLOW.position === "SHORT" && price > almaVal);
        if (breached) {
            console.log();
            console.log(`S ${SLOW.position} EXIT (ALMA_CLOSE) @ ${price.toFixed(2)}`);
            console.log();
            tg(`S ${SLOW.position} EXIT (ALMA_CLOSE) @ ${price.toFixed(2)}`);
            closeSlow(price, "ALMA_CLOSE");
            clearSlowSL();
            persistSlow(null, 0);
        }
    }

    if (config.SLOW_ENABLED && !SLOW.position && canEnter()) {
        const side     = stDir === 1 ? "LONG" : stDir === -1 ? "SHORT" : null;
        const regimeOk = side &&
            ((side === "LONG"  && slowRegime ===  1) ||
             (side === "SHORT" && slowRegime === -1));
        if (regimeOk && adxOk) {
            SLOW.position   = side;
            SLOW.entryPrice = price;
            setSlowSL(almaVal);
            persistSlow(side, price);
            console.log();
            console.log(`S ${side} ENTRY @ ${price.toFixed(2)}  SL:${almaVal.toFixed(2)}`);
            console.log();
            tg(`S ${side} ENTRY @ ₹${price.toFixed(2)}
SL: ₹${almaVal.toFixed(2)}`);
        }
    }

    // ── FAST ENGINE ───────────────────────────────────────────────────────────

    if (config.FAST_ENABLED && FAST.position && stDir !== 0 && stDir !== prevSTDir) {
        const flipped =
            (FAST.position === "LONG"  && stDir === -1) ||
            (FAST.position === "SHORT" && stDir ===  1);
        if (flipped) {
            console.log();
            console.log(`F ${FAST.position} EXIT (ST_FLIP) @ ${price.toFixed(2)}`);
            console.log();
            tg(`F ${FAST.position} EXIT (ST_FLIP) @ ₹${price.toFixed(2)}`);
            closeFast(price, "ST_FLIP");
            clearFastSL();
            persistFast(null, 0);
        }
    }

    if (config.FAST_ENABLED && !FAST.position && stDir !== 0 && stDir !== prevSTDir && canEnter() && adxOk) {
        const side      = stDir === 1 ? "LONG" : "SHORT";
        FAST.position   = side;
        FAST.entryPrice = price;
        if (trail !== null) setFastSL(trail, stDir);
        persistFast(side, price);
        console.log();
        console.log(`F ${side} ENTRY @ ${price.toFixed(2)}  Tr:${trail?.toFixed(2) ?? "-"}`);
        console.log();
        tg(`F ${side} ENTRY @ ₹${price.toFixed(2)}
Trail: ₹${trail?.toFixed(2) ?? "-"}`);
    }

    // Refresh FAST SL every candle — trail tightens as price moves in favour
    if (config.FAST_ENABLED && FAST.position && trail !== null) {
        setFastSL(trail, stDir);
    }

    prevSTDir = stDir;

}

// ─── PROCESS CANDLE — called by candlePoll on every completed 1H candle ───────
async function processCandle(rawCandle) {
    const rawCandles = getRawCandles();

    if (rawCandles.length < config.ALMA_LEN + 1) {
        console.log(`WARMUP  ${rawCandles.length}/${config.ALMA_LEN + 1}`);
        return;
    }

    const haCandles = toHA(rawCandles);
    const haCloses  = haCandles.map(c => c.close);
    const almaVal   = alma(haCloses, config.ALMA_LEN, config.ALMA_OFFSET, config.ALMA_SIGMA);
    const stResult  = supertrend(haCandles, config.ST_ATR_LEN, config.ST_FACTOR);

    if (!almaVal || !stResult) return;

    // ADX on raw candles — measures raw directional strength
    const adxArr = adx(rawCandles, config.ADX_LEN);
    const adxVal = adxArr[adxArr.length - 1];

    await runSignals(rawCandle.close, almaVal, stResult, adxVal);
}

// ─── INIT — restore from DB on startup ────────────────────────────────────────
async function initSignals() {
    try {
        const savedSlow   = await db.loadPosition("SLOW", config.SLOW_TOKEN);
        const savedFast   = await db.loadPosition("FAST", config.FAST_TOKEN);
        const savedRegime = await db.loadRegime(config.SLOW_TOKEN);

        if (savedSlow?.position) {
            SLOW.position   = savedSlow.position;
            SLOW.entryPrice = savedSlow.entry_price;
        }
        if (savedFast?.position) {
            FAST.position   = savedFast.position;
            FAST.entryPrice = savedFast.entry_price;
            prevSTDir       = savedFast.position === "LONG" ? 1 : -1;
        }
        if (savedRegime) {
            slowRegime = savedRegime.slow_regime ?? 0;
        }

        const slowInfo  = SLOW.position ? `${SLOW.position}@${SLOW.entryPrice}` : "-";
        const fastInfo  = FAST.position ? `${FAST.position}@${FAST.entryPrice}` : "-";
        const regimeSym = slowRegime === 1 ? "↑" : slowRegime === -1 ? "↓" : "-";
        console.log();
        console.log(`S:${slowInfo}   F:${fastInfo}   R:${regimeSym}`);
        console.log();

    } catch (err) {
        console.warn("INIT  restore failed:", err.message);
    }
}

module.exports = { processCandle, initSignals };
