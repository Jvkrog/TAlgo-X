// candlePoll.js — API candle poll + WebSocket SL monitor
//
// Poll: watches for IST hour boundary every 30s → fetchLastCandle() → processCandle()
// SL:   every WebSocket tick → checkSL(price)
//       SLOW: price crosses ALMA line
//       FAST: price crosses active SuperTrend trail
"use strict";

const { KiteConnect } = require("kiteconnect");
const fs      = require("fs");
const config  = require("./config");
const { tg }  = require("./telegram");
const { SLOW, FAST } = require("./state");
const { closeSlow, closeFast } = require("./positions");
const { getRawCandles, setRawCandles } = require("./candleBuilder");
const { processCandle } = require("./signals");
const { getSlowSL, getFastSL, clearSlowSL, clearFastSL } = require("./sl");
const db = require("./db");

const kc = new KiteConnect({ api_key: config.API_KEY });
kc.setAccessToken(fs.readFileSync(config.ACCESS_TOKEN_FILE, "utf8").trim());

// ─── SL MONITOR — every WebSocket tick ───────────────────────────────────────
async function checkSL(price) {
    if (!price) return;

    // SLOW: exits if price crosses the ALMA line
    const slowLevel = getSlowSL();
    if (config.SLOW_ENABLED && SLOW.position && slowLevel !== null) {
        const breached =
            (SLOW.position === "LONG"  && price < slowLevel) ||
            (SLOW.position === "SHORT" && price > slowLevel);
        if (breached) {
            console.log();
            console.log(`S ${SLOW.position} STOP (SL) @ ${price.toFixed(2)}  ALMA:${slowLevel.toFixed(2)}`);
            console.log();
            tg(`🛑 S ${SLOW.position} STOP @ ₹${price.toFixed(2)}`);
            closeSlow(price, "SL_ALMA");
            db.savePosition("SLOW", config.SLOW_TOKEN, config.SLOW_SYMBOL, null, 0);
            clearSlowSL();
        }
    }

    // FAST: exits if price crosses active SuperTrend trail
    const { trail: fastTrail } = getFastSL();
    if (config.FAST_ENABLED && FAST.position && fastTrail !== null) {
        const breached =
            (FAST.position === "LONG"  && price < fastTrail) ||
            (FAST.position === "SHORT" && price > fastTrail);
        if (breached) {
            console.log();
            console.log(`F ${FAST.position} STOP (SL) @ ${price.toFixed(2)}  trail:${fastTrail.toFixed(2)}`);
            console.log();
            tg(`🛑 F ${FAST.position} STOP @ ₹${price.toFixed(2)}`);
            closeFast(price, "SL_ST");
            db.savePosition("FAST", config.FAST_TOKEN, config.FAST_SYMBOL, null, 0);
            clearFastSL();
        }
    }
}

// ─── FETCH LAST COMPLETED CANDLE from API ────────────────────────────────────
async function fetchLastCandle() {
    try {
        const now  = new Date();
        const from = new Date(now.getTime() - 2 * 60 * 60 * 1000);

        const bars = await kc.getHistoricalData(
            config.FAST_TOKEN,
            config.HIST_INTERVAL,
            from.toISOString().split("T")[0],
            now.toISOString().split("T")[0]
        );

        if (!bars || bars.length < 2) return null;

        // Last bar is still-forming — take second to last (last completed candle)
        const b = bars[bars.length - 2];
        return {
            open:  parseFloat(b.open),
            high:  parseFloat(b.high),
            low:   parseFloat(b.low),
            close: parseFloat(b.close),
            date:  String(b.date),
        };
    } catch (err) {
        console.error(`CANDLE  fetch failed: ${err.message}`);
        tg(`⚠ Candle fetch failed: ${err.message}`);
        return null;
    }
}

// ─── CANDLE CLOSE WATCHER ─────────────────────────────────────────────────────
// Schedules an exact setTimeout to fire 10s after each 15m slot close.
// 15m slots close at HH:00, HH:15, HH:30, HH:45 IST.
// On each fire: fetch last completed candle → run signals.
// No polling drift. Fixed 10s delay every time.
let lastProcessedDate = null;

function msUntilNextSlotPlus10() {
    // Returns milliseconds until 10s after the next 15m slot close in IST
    const now    = new Date();
    const istMs  = now.getTime() + (5.5 * 60 * 60 * 1000);
    const istMin = new Date(istMs).getUTCMinutes();
    const istSec = new Date(istMs).getUTCSeconds();
    const istMsIntoMin = new Date(istMs).getUTCMilliseconds();

    // Seconds elapsed since last 15m boundary
    const secInSlot = (istMin % 15) * 60 + istSec;
    // ms remaining until next slot close, then add 10s
    const msToNextClose = (15 * 60 - secInSlot) * 1000 - istMsIntoMin;
    return msToNextClose + 10 * 1000;
}

async function onCandleClose() {
    const candle = await fetchLastCandle();
    if (!candle) return scheduleNext();

    const candleTime = new Date(candle.date).getTime();
    const lastTime   = lastProcessedDate ? new Date(lastProcessedDate).getTime() : 0;

    if (candleTime > lastTime) {
        lastProcessedDate = candle.date;
        const buf = getRawCandles();
        buf.push(candle);
        if (buf.length > config.MAX_CANDLES) buf.shift();
        setRawCandles(buf);
        await processCandle(candle);
    }

    scheduleNext();
}

function scheduleNext() {
    const ms = msUntilNextSlotPlus10();
    setTimeout(onCandleClose, ms);
}

// ─── START — schedule first fire + immediate boot catchup ─────────────────────
function startPoll() {
    // On boot: immediately fetch and process any candle newer than preload.
    fetchLastCandle().then(async candle => {
        if (!candle) return;
        const buf = getRawCandles();
        const lastBufTime = buf.length > 0 ? new Date(buf[buf.length - 1].date).getTime() : 0;
        const candleTime  = new Date(candle.date).getTime();
        if (candleTime > lastBufTime) {
            lastProcessedDate = candle.date;
            buf.push(candle);
            if (buf.length > config.MAX_CANDLES) buf.shift();
            setRawCandles(buf);
            await processCandle(candle);
        } else {
            lastProcessedDate = buf.length > 0 ? buf[buf.length - 1].date : null;
        }
    });

    // Schedule first candle fetch exactly 10s after next slot close
    scheduleNext();
}

module.exports = { startPoll, checkSL };
