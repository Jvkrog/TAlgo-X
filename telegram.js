// telegram.js — Telegram alert sender.
//
// CHANGED: was a singleton reading `config.TG_TOKEN`/`TG_CHAT_ID`/`TG_PREFIX`
// directly. TG_TOKEN/TG_CHAT_ID are engine-level (now in engineConfig.js) but
// TG_PREFIX is instrument identity (now context.tgPrefix in context.js) —
// so this can't stay a plain singleton require once two instruments might
// share a process. createTelegram(context, engineConfig) returns a `tg`
// function scoped to one instrument's prefix.
"use strict";

const axios = require("axios");

const RETRY_DELAYS = [3000, 8000]; // 2 retries: after 3s, then 8s

function createTelegram(context, engineConfig) {
    async function tg(msg) {
        if (!engineConfig.TG_TOKEN || !engineConfig.TG_CHAT_ID) {
            console.log(`[TG:${context.tgPrefix}]`, msg);
            return;
        }

        const payload = {
            chat_id: engineConfig.TG_CHAT_ID,
            text:    `[${context.tgPrefix}]\n${msg}`,
        };

        for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
            try {
                await axios.post(
                    `https://api.telegram.org/bot${engineConfig.TG_TOKEN}/sendMessage`,
                    payload,
                    { timeout: 8000 }
                );
                return; // success
            } catch (e) {
                const detail = e.response?.data?.description || e.message || e.code || "unknown";
                if (attempt < RETRY_DELAYS.length) {
                    console.log(`TG error: ${detail} — retry in ${RETRY_DELAYS[attempt] / 1000}s`);
                    await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
                } else {
                    console.log(`TG error: ${detail} — gave up`);
                }
            }
        }
    }

    return { tg };
}

module.exports = { createTelegram };
