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
const { closeSlow, closeFast, unrealisedSlow, unrealisedFast } = require("./positions");
const { toHA, alma, supertrend, adx, rsi } = require("./indicators");
const { getRawCandles } = require("./candleBuilder");
const { setSlowSL, setFastSL, clearSlowSL, clearFastSL } = require("./sl");
const db = require("./db");
const {
    broadcast,
    setDashRegime,
    setDashSTDir,
    setDashAlma,
    setDashRSI,
    setDashTrail,
} = require("./dashboard");

// ─── MODULE STATE ─────────────────────────────────────────────────────────────
let slowRegime = 0;
let prevSTDir  = 0;

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
async function runSignals(price, almaVal, stResult, adxVal, rsiVal) {
    const stLast = stResult[stResult.length - 1];
    const stDir  = stLast ? stLast.dir   : prevSTDir;
    const trail  = stLast ? stLast.trend : null;

    // ── Push indicator state to dashboard ────────────────────────────────────
    setDashSTDir(stDir);
    setDashAlma(almaVal);
    setDashRSI(rsiVal);
    setDashTrail(trail);

    // ── ADX gate — entry filter only, never affects exits ───────────────────────
    const adxOk = !config.USE_ADX_FILTER || (adxVal !== null && adxVal >= config.ADX_MIN);
    // Log ADX only when a ST flip is happening — meaningful context only
    const stFlipping = stDir !== 0 && stDir !== prevSTDir;
    if (stFlipping && config.USE_ADX_FILTER) {
        const adxStr = adxVal !== null ? adxVal.toFixed(1) : "n/a";
        if (!adxOk) console.log(`ADX ${adxStr}  < ${config.ADX_MIN}  entry blocked`);
        else        console.log(`ADX ${adxStr}  entry ok`);
    }

    // ── RSI directional gates — entry filter only, never affects exits ──────────
    const rsiLongOk  = !config.USE_RSI_FILTER || (rsiVal !== null && rsiVal >  config.RSI_LONG_MIN);
    const rsiShortOk = !config.USE_RSI_FILTER || (rsiVal !== null && rsiVal <  config.RSI_SHORT_MAX);
    if (stFlipping && config.USE_RSI_FILTER) {
        const rsiStr = rsiVal !== null ? rsiVal.toFixed(1) : "n/a";
        const side   = stDir === 1 ? "LONG" : "SHORT";
        const ok     = stDir === 1 ? rsiLongOk : rsiShortOk;
        if (!ok) console.log(`RSI ${rsiStr}  ${side} blocked (need ${stDir === 1 ? ">" + config.RSI_LONG_MIN : "<" + config.RSI_SHORT_MAX})`);
        else     console.log(`RSI ${rsiStr}  ${side} ok`);
    }

    // ── Console tick ─────────────────────────────────────────────────────────
    const slowUPnL = unrealisedSlow(price);
    const fastUPnL = unrealisedFast(price);
    const ts       = new Date().toLocaleTimeString("en-IN", { hour12: false });
    const clr      = stDir === 1 ? "▲" : stDir === -1 ? "▼" : "● ";
    const fmt      = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(0);

    const session  = (SLOW.pnl || 0) + (FAST.pnl || 0) + slowUPnL + fastUPnL;
    const p      = price.toFixed(2).padStart(7);
    const fUpnl  = fmt(fastUPnL).padStart(7);
    const tot    = fmt(session).padStart(8);
    const sPart  = config.SLOW_ENABLED ? `  S${fmt(slowUPnL).padStart(7)}` : "";
    const fPart  = config.FAST_ENABLED ? `  F${fUpnl}` : "";
    console.log(`${ts} ${clr} ${p}${sPart}${fPart}  ${tot}`);

    // ── REGIME ────────────────────────────────────────────────────────────────
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
    setDashRegime(slowRegime);

    // ── SLOW ENGINE ───────────────────────────────────────────────────────────
    if (config.SLOW_ENABLED && SLOW.position) {
        setSlowSL(almaVal);

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
        const rsiOk    = side === "LONG" ? rsiLongOk : rsiShortOk;
        if (regimeOk && adxOk && rsiOk) {
            SLOW.position   = side;
            SLOW.entryPrice = price;
            setSlowSL(almaVal);
            persistSlow(side, price);
            console.log();
            console.log(`S ${side} ENTRY @ ${price.toFixed(2)}  SL:${almaVal.toFixed(2)}`);
            console.log();
            tg(`S ${side} ENTRY @ ₹${price.toFixed(2)}\nSL: ₹${almaVal.toFixed(2)}`);
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
        const rsiOk     = stDir === 1 ? rsiLongOk : rsiShortOk;
        if (!rsiOk) {
            // RSI blocked — log and skip (ST flip already logged above)
        } else {
            FAST.position   = side;
            FAST.entryPrice = price;
            if (trail !== null) setFastSL(trail, stDir);
            persistFast(side, price);
            console.log();
            console.log(`F ${side} ENTRY @ ${price.toFixed(2)}  Tr:${trail?.toFixed(2) ?? "-"}`);
            console.log();
            tg(`F ${side} ENTRY @ ₹${price.toFixed(2)}\nTrail: ₹${trail?.toFixed(2) ?? "-"}`);
        }
    }

    if (config.FAST_ENABLED && FAST.position && trail !== null) {
        setFastSL(trail, stDir);
    }

    prevSTDir = stDir;

    // ── Push full state to dashboard after processing each candle ────────────
    broadcast();
}

// ─── PROCESS CANDLE ───────────────────────────────────────────────────────────
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

    // ADX computed on raw candles (not HA) — measures raw directional strength
    const adxArr = adx(rawCandles, config.ADX_LEN);
    const adxVal = adxArr[adxArr.length - 1];

    // RSI computed on HA closes — same source as ALMA for consistency
    const rsiArr = rsi(haCloses, config.RSI_LEN);
    const rsiVal = rsiArr[rsiArr.length - 1];

    await runSignals(rawCandle.close, almaVal, stResult, adxVal, rsiVal);
}

// ─── MARKET HOURS CHECK ───────────────────────────────────────────────────────
function isMarketHours() {
    const now = new Date();
    const h   = now.getHours();
    const m   = now.getMinutes();
    // MCX NatGas: 9:00 AM – 11:30 PM
    const afterOpen   = h > 9 || (h === 9 && m >= 0);
    const beforeClose = h < 23 || (h === 23 && m <= 30);
    return afterOpen && beforeClose;
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function initSignals() {
    try {
        const savedSlow   = await db.loadPosition("SLOW", config.SLOW_TOKEN);
        const savedFast   = await db.loadPosition("FAST", config.FAST_TOKEN);
        const savedRegime = await db.loadRegime(config.SLOW_TOKEN);

        // SLOW: always resume — positional engine survives overnight and reboots
        if (config.RESUME_SLOW_ALWAYS && savedSlow?.position) {
            SLOW.position   = savedSlow.position;
            SLOW.entryPrice = savedSlow.entry_price;
        }

        // FAST: only resume if same market session (PM2 crash recovery only)
        if (config.RESUME_FAST_INTRADAY_ONLY && savedFast?.position) {
            const today     = new Date().toISOString().split("T")[0];
            const entryDate = savedFast.entry_date ?? null;
            const sameDay   = entryDate === today;
            const inMarket  = isMarketHours();

            if (sameDay && inMarket) {
                FAST.position   = savedFast.position;
                FAST.entryPrice = savedFast.entry_price;
                prevSTDir       = savedFast.position === "LONG" ? 1 : -1;
                console.log(`F  resume  ${FAST.position}@${FAST.entryPrice}`);
            } else {
                console.log(`F  carry rejected`);
                console.log(`   sameDay:${sameDay}  market:${inMarket}  — cleared`);
                db.savePosition("FAST", config.FAST_TOKEN, config.FAST_SYMBOL, null, 0);
            }
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
