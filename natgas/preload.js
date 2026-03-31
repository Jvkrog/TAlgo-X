// preload.js
const { KiteConnect } = require("kiteconnect");
const config = require("./config");
const { setRawCandles } = require("./candleBuilder");
const { tg } = require("./telegram");
const { toHA, alma, atr } = require("./indicators");
const { getFastState } = require("./signals"); // we'll use the function

const kc = new KiteConnect({ api_key: config.API_KEY });
kc.setAccessToken(require("fs").readFileSync(config.ACCESS_TOKEN_FILE, "utf8").trim());

async function preload() {
    try {
        console.log(` Preloading ${config.MAX_CANDLES} historical 1H candles...`);
        const to = new Date();
        const from = new Date(to.getTime() - config.MAX_CANDLES * config.CANDLE_MS * 1.5);

        const bars = await kc.getHistoricalData(config.FAST_TOKEN, config.HIST_INTERVAL, from, to);
        if (!bars || bars.length === 0) {
            console.log("⚠ No historical data");
            return;
        }

        const candles = bars.slice(-config.MAX_CANDLES).map(b => ({
            open: b.open, high: b.high, low: b.low, close: b.close
        }));

        setRawCandles(candles);

        const ha = toHA(candles);
        const haClose = ha.map(c => c.close);
        const fast = alma(haClose, config.ALMA_FAST);
        const fastPrev = alma(haClose.slice(0, -1), config.ALMA_FAST);
        const slow = alma(haClose, config.ALMA_SLOW);
        const preloadATR = atr(candles);

        console.log(` Preloaded ${candles.length} candles | Ready: ${candles.length >= config.ALMA_SLOW}`);
        tg(` Preloaded ${candles.length} 1H candles\nReady: ${candles.length >= config.ALMA_SLOW}`);
    } catch (err) {
        console.log(`⚠ Preload failed: ${err.message}`);
    }
}

module.exports = { preload };