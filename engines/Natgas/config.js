// config.js
require("dotenv").config({ quiet: true });

module.exports = {
    API_KEY:           process.env.API_KEY,
    ACCESS_TOKEN_FILE: process.env.ACCESS_FILE || "access_code.txt",

    // Instruments
    SLOW_TOKEN:    129091847,
    SLOW_SYMBOL:   "NATURALGAS26JUNFUT",
    SLOW_LOT_MULT: 1250,
    SLOW_LOTS:     1,

    FAST_TOKEN:    129092103,
    FAST_SYMBOL:   "NATGASMINI26JUNFUT",
    FAST_LOT_MULT: 250,
    FAST_LOTS:     5,

    // Candle source — unified 1H HA
    HIST_INTERVAL: "15minute",
    MAX_CANDLES:   200,                  // 200 × 15m = ~3 trading sessions                  // 200 × 1H = ~125 trading sessions

    // SLOW engine — ALMA on 1H HA closes
    ALMA_LEN:    20,
    ALMA_OFFSET: 0.85,
    ALMA_SIGMA:  6,

    // FAST engine — SuperTrend on 1H HA candles
    ST_ATR_LEN:  10,                     // SuperTrend ATR period
    ST_FACTOR:   1.0,                    // SuperTrend multiplier


    // Observation window: first entry on 9:30 candle close
    // fetch fires at 9:30:10 IST → canEnter() passes → 9:30 close is first tradeable
    TRADE_START_HOUR:   9,
    TRADE_START_MINUTE: 15,

    // Engine toggles
    SLOW_ENABLED: true,
    FAST_ENABLED: true,

    // Resume behaviour
    // SLOW: always resumes — positional across sessions and overnight
    // FAST: only resumes on same-day PM2 crash/restart during market hours
    RESUME_SLOW_ALWAYS:        true,
    RESUME_FAST_INTRADAY_ONLY: true,

    // ADX filter — gates new entries only, never exits
    ADX_LEN:        14,
    ADX_MIN:        20,
    USE_ADX_FILTER: true,

    // RSI filter — directional momentum bias gate, entries only
    RSI_LEN:        14,
    RSI_LONG_MIN:   55,   // LONG entry only if RSI > this
    RSI_SHORT_MAX:  45,   // SHORT entry only if RSI < this
    USE_RSI_FILTER: true,

    // Telegram
    TG_TOKEN:   process.env.TELEGRAM_TOKEN   || "",
    TG_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
};
