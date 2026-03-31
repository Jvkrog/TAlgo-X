// telegram.js
const axios = require("axios");
const config = require("./config");

async function tg(msg) {
    if (!config.TG_TOKEN || !config.TG_CHAT_ID) {
        console.log("[TG]", msg);
        return;
    }
    try {
        await axios.post(`https://api.telegram.org/bot${config.TG_TOKEN}/sendMessage`, {
            chat_id: config.TG_CHAT_ID,
            text: `[Zinc] ${msg}`
        });
    } catch (e) {
        console.log("TG error:", e.message);
    }
}

module.exports = { tg };