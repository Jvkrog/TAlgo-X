// preload.js — loads historical 15m raw candles into buffer.
// HA conversion happens inside processCandle, not here.
//
// CHANGED: was a module reading `config.FAST_TOKEN`/`API_KEY`/etc and calling
// the `candleBuilder` singleton's `setRawCandles` directly. Now
// createPreload({ context, engineConfig, candles, tg }) takes all of that
// as injected dependencies, same pattern as every other file in this pass.
"use strict";

const { KiteConnect } = require("kiteconnect");
const fs = require("fs");

function createPreload({ context, engineConfig, candles, tg }) {
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim());

    async function preload() {
        try {
            const to   = new Date();
            // 5 days covers weekends comfortably for 200 15m bars
            const from = new Date(to.getTime() - 5 * 24 * 60 * 60 * 1000);

            const bars = await kc.getHistoricalData(
                context.token,
                engineConfig.HIST_INTERVAL,
                from.toISOString().split("T")[0],
                to.toISOString().split("T")[0]
            );

            if (!bars || bars.length === 0) {
                throw new Error("API returned 0 bars — check token or instrument");
            }

            // Drop the last bar — it's the still-forming current candle
            // (last completed candle is always second-to-last)
            const completed = bars.slice(0, -1);

            const parsed = completed.slice(-engineConfig.MAX_CANDLES).map(b => ({
                open:  parseFloat(b.open),
                high:  parseFloat(b.high),
                low:   parseFloat(b.low),
                close: parseFloat(b.close),
                date:  String(b.date),
            }));

            candles.setRawCandles(parsed);

            const minRequired = engineConfig.DPI_LEN + engineConfig.ST_ATR_LEN + 5;
            if (parsed.length < minRequired) {
                console.warn(`PRELOAD  [${context.tgPrefix}] only ${parsed.length} bars — need ${minRequired}`);
            }

        } catch (err) {
            console.error(`PRELOAD  [${context.tgPrefix}] failed: ${err.message}`);
            tg(`⚠ Preload failed: ${err.message}`);
        }
    }

    return { preload };
}

module.exports = { createPreload };
