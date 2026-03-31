// config.js
require("dotenv").config();

module.exports = {
    API_KEY: process.env.API_KEY,
    ACCESS_TOKEN_FILE: process.env.ACCESS_FILE || "access_code.txt",

    // Instruments
    SLOW_TOKEN: 124791047,
    SLOW_SYMBOL: "NATGAS26APRFUT",
    SLOW_LOT_MULT: 1250,
    SLOW_LOTS: 1,

    FAST_TOKEN: 124791303,
    FAST_SYMBOL: "NATGASMINI26APRFUT",
    FAST_LOT_MULT: 250,
    FAST_LOTS: 5,

    // ALMA & Indicators
    ALMA_FAST: 20,
    ALMA_SLOW: 100,
    HIST_INTERVAL: "60minute",
    MAX_CANDLES: 200,
    CANDLE_MS: 60 * 60 * 1000,

    // Risk
    ATR_LEN: 14,
    ATR_MULT: 1.2,
    SL_ATR_MULT: 1.5,
    MAX_LOSS_SLOW: 2000,

    // Fast Color Logic
    BAND_LEN: 50,
    COMPRESS_MULT: 0.4,
    SLOPE_MULT: 0.05,

    // Telegram
    TG_TOKEN: process.env.TELEGRAM_TOKEN || "",
    TG_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
};
