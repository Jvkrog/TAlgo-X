// preload.js — loads historical 15m raw candles into buffer
// HA conversion happens inside processCandle, not here.
"use strict";

const { KiteConnect } = require("kiteconnect");
const fs     = require("fs");
const config = require("./config");
const { setRawCandles } = require("./candleBuilder");
const { tg } = require("./telegram");

const kc = new KiteConnect({ api_key: config.API_KEY });
kc.setAccessToken(fs.readFileSync(config.ACCESS_TOKEN_FILE, "utf8").trim());

async function preload() {
    try {
        const to   = new Date();
        // 5 days covers weekends comfortably for 200 15m bars
        const from = new Date(to.getTime() - 5 * 24 * 60 * 60 * 1000);

        const bars = await kc.getHistoricalData(
            config.FAST_TOKEN,
            config.HIST_INTERVAL,
            from.toISOString().split("T")[0],
            to.toISOString().split("T")[0]
        );

        if (!bars || bars.length === 0) {
            throw new Error("API returned 0 bars — check token or instrument");
        }

        // Drop the last bar — it's the still-forming current candle
        // (last completed candle is always second-to-last)
        const completed = bars.slice(0, -1);

        const candles = completed.slice(-config.MAX_CANDLES).map(b => ({
            open:  parseFloat(b.open),
            high:  parseFloat(b.high),
            low:   parseFloat(b.low),
            close: parseFloat(b.close),
            date:  String(b.date),
        }));

        setRawCandles(candles);

        const last = candles.at(-1);
        const d = last ? new Date(last.date) : null;
        const lastStr = d ? `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')} ${d.getDate()}/${d.getMonth()+1}` : "-";
        console.log(`preload  ${candles.length}  last:${lastStr}`);
        const minRequired = config.ALMA_LEN + config.ST_ATR_LEN + 5;
        if (candles.length < minRequired) {
            console.warn(`PRELOAD  only ${candles.length} bars — need ${minRequired}`);
        }

    } catch (err) {
        console.error(`PRELOAD  failed: ${err.message}`);
        tg(`⚠ Preload failed: ${err.message}`);
    }
}

module.exports = { preload };
