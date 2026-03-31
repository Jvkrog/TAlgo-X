// index.js
const config = require("./config");
const { tg } = require("./telegram");
const { preload } = require("./preload");
const { onTick } = require("./candleBuilder");
const { startLifecycle } = require("./lifecycle");
const { processCandle } = require("./signals");
const db = require("./db");                    // ← New
const { KiteTicker } = require("kiteconnect");
const fs = require("fs");

const ACCESS_TOKEN = fs.readFileSync(config.ACCESS_TOKEN_FILE, "utf8").trim();

console.log(`TAlgo-X booting... Token: ${config.ACCESS_TOKEN_FILE}`);

// Initialize Database
db.initDB();

const ticker = new KiteTicker({ 
    api_key: config.API_KEY, 
    access_token: ACCESS_TOKEN 
});

ticker.connect();

ticker.on("connect", async () => {
    console.log("WebSocket Connected");
    
    const tokens = [config.SLOW_TOKEN, config.FAST_TOKEN];
    ticker.subscribe(tokens);
    ticker.setMode(ticker.modeLTP, tokens);

    await preload();
    startLifecycle();

    tg(`TAlgo-X Started\nSlow: ${config.SLOW_SYMBOL} | Fast: ${config.FAST_SYMBOL}`);
});

ticker.on("ticks", (ticks) => {
    if (!ticks.length) return;
    
    for (const tick of ticks) {
        const price = tick.last_price;
        if (tick.instrument_token === config.FAST_TOKEN && price) {
            onTick(price, processCandle);
        }
    }
});

ticker.on("error", (err) => {
    if (err.message && err.message.includes("403")) {
        console.log("WS: Market is closed (403) - Normal outside trading hours");
    } else {
        console.log("WS Error:", err.message || err);
    }
});

ticker.on("close", () => console.log("WebSocket Closed"));
ticker.on("reconnect", (attempt) => console.log(`WebSocket Reconnecting... Attempt ${attempt}`));