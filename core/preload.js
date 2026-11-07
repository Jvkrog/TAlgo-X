// preload.js — loads historical 15m raw candles into buffer.
// HA conversion happens inside processCandle, not here.
//
// CHANGED: was a module reading `config.FAST_TOKEN`/`API_KEY`/etc and calling
// the `candleBuilder` singleton's `setRawCandles` directly. Now
// createPreload({ context, engineConfig, candles, tg }) takes all of that
// as injected dependencies, same pattern as every other file in this pass.
"use strict";

const { KiteConnect } = require("kiteconnect");

function createPreload({ context, engineConfig, candles, tg }) {
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(engineConfig.getAccessToken());

    async function preload() {
        try {
            const to   = new Date();
            const daily = context.timeframe === "1d";
            // 5 days covers weekends comfortably for 200 15m bars; daily engines need months of daily bars
            const from = new Date(to.getTime() - (daily ? 250 : 5) * 24 * 60 * 60 * 1000);

            const bars = await kc.getHistoricalData(
                context.token,
                daily ? "day" : engineConfig.HIST_INTERVAL,
                from.toISOString().split("T")[0],
                to.toISOString().split("T")[0]
            );

            if (!bars || bars.length === 0) {
                throw new Error("API returned 0 bars — check token or instrument");
            }

            // Drop the last bar — it's the still-forming current candle
            // (last completed candle is always second-to-last)
            // Daily: keep only bars older than the newest completed one. That newest completed bar (yesterday's)
            // is deliberately left for the candle poll's boot catch-up to process, so a daily engine acts on it
            // today (entry-time gate / held-entry retry still apply) instead of seeing it only as history.
            const istDay = d => new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
            const todayIst = istDay(Date.now());
            const completed = daily ? bars.filter(x => istDay(x.date) < todayIst).slice(0, -1) : bars.slice(0, -1);

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
