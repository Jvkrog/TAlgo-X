// index.js
const config = require("./config");
const { tg } = require("./telegram");
const { preload } = require("./preload");
const { onTick } = require("./candleBuilder");
const { startLifecycle } = require("./lifecycle");
const { processCandle } = require("./signals");
const db = require("./db");
const { KiteTicker } = require("kiteconnect");
const fs = require("fs");

const ACCESS_TOKEN = fs.readFileSync(config.ACCESS_TOKEN_FILE, "utf8").trim();

console.log(`Zinc Engine booting...`);

db.initDB();

const ticker = new KiteTicker({ 
    api_key: config.API_KEY, 
    access_token: ACCESS_TOKEN 
});

ticker.connect();

ticker.on("connect", async () => {
    console.log("WebSocket Connected");
    
    ticker.subscribe([config.TOKEN]);
    ticker.setMode(ticker.modeLTP, [config.TOKEN]);

    await preload();
    startLifecycle();

    tg(`Zinc Engine Started\nSymbol: ${config.SYMBOL}`);
});

ticker.on("ticks", (ticks) => {
    if (!ticks.length) return;
    
    const price = ticks[0].last_price;
    if (price) {
        onTick(price, processCandle);
    }
});

ticker.on("error", (err) => {
    if (err.message && err.message.includes("403")) {
        console.log("WS: Market closed (normal outside hours)");
    } else {
        console.log("WS Error:", err.message || err);
    }
});

ticker.on("close", () => console.log("WebSocket Closed"));
ticker.on("reconnect", (attempt) => console.log(`WebSocket Reconnecting... Attempt ${attempt}`));