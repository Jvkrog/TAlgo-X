// preload.js
const { KiteConnect } = require("kiteconnect");
const config = require("./config");
const { setRawCandles } = require("./candleBuilder");
const { tg } = require("./telegram");
const { toHA } = require("./indicators");

const kc = new KiteConnect({ api_key: config.API_KEY });
kc.setAccessToken(require("fs").readFileSync(config.ACCESS_TOKEN_FILE, "utf8").trim());

async function preload() {
    try {
        console.log(`[PRELOAD] Fetching historical 1H candles for Zinc...`);

        const to = new Date();
        const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000); // last 7 days

        const bars = await kc.getHistoricalData(
            config.TOKEN,
            "60minute",
            from.toISOString().slice(0, 19).replace('T', ' '),
            to.toISOString().slice(0, 19).replace('T', ' '),
            false
        );

        if (!bars || bars.length === 0) {
            console.log("⚠ No historical data");
            tg("Preload: No historical data");
            return;
        }

        const candles = bars.slice(-60).map(b => ({
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close
        }));

        setRawCandles(candles);
        console.log(`[PRELOAD] Loaded ${candles.length} candles`);
        tg(`Preloaded ${candles.length} 1H candles for Zinc`);

    } catch (err) {
        console.log(`⚠ Preload failed: ${err.message}`);
        tg(`Preload failed: ${err.message}`);
    }
}

module.exports = { preload };