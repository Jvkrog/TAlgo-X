// config.js
require("dotenv").config();

module.exports = {
    API_KEY: process.env.API_KEY,
    ACCESS_TOKEN_FILE: "access_code.txt",

    // Zinc Instrument
    TOKEN: 125131527,           // ← Make sure this is correct for ZINCMINIAPRFUT
    SYMBOL: "ZINCMINIAPRFUT",
    LOT_MULT: 1000,
    LOTS: 1,

    // Indicators
    ALMA_FAST: 14,
    BAND_LEN: 30,
    ATR_LEN: 14,
    ALMA_OFFSET: 0.85,
    ALMA_SIGMA: 6,

    // Filters from your Pine v3
    COMPRESS_MULT: 0.78,
    SLOPE_MULT: 0.020,
    BUFFER_MULT: 0.20,

    // Risk
    SL_ATR_MULT: 1.5,
    MAX_LOSS: 2000,

    // Telegram
    TG_TOKEN: process.env.TELEGRAM_TOKEN || "",
    TG_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
};