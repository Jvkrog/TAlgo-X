// telegram.js — Telegram alert sender.
//
// CHANGED: was a singleton reading `config.TG_TOKEN`/`TG_CHAT_ID`/`TG_PREFIX`
// directly. TG_TOKEN/TG_CHAT_ID are engine-level (now in engineConfig.js) but
// TG_PREFIX is instrument identity (now context.tgPrefix in context.js) —
// so this can't stay a plain singleton require once two instruments might
// share a process. createTelegram(context, engineConfig) returns a `tg`
// function scoped to one instrument's prefix.
//
// CHANGED: prefix now also carries the strategy label, not just tgPrefix
// (instrument name). Running the same instrument under two strategies at
// once (two engine.js processes, same tgPrefix, different context.strategy)
// used to produce Telegram messages that were indistinguishable — both just
// showed "[NATGASMINI]". context.strategy (set by getDefinition/engine.js)
// is resolved through STRATEGY_INFO's `.label` here, same lookup engine.js
// already does for its own boot-time console line, so the Telegram prefix
// and that console line always agree. Falls back to the raw strategy key if
// STRATEGY_INFO has no entry, and omits the strategy segment entirely when
// context.strategy isn't set at all (e.g. scannerService.js's
// `{ tgPrefix: "SCANNER" }` context, which isn't strategy-specific).
"use strict";

const axios = require("axios");
const { STRATEGY_INFO } = require("./strategies");

const RETRY_DELAYS = [3000, 8000]; // 2 retries: after 3s, then 8s

// CHANGED: tgPrefixFor() can now be overridden per-context via
// context.tgLabel — added Sep 2026 for hedgePairEngine.js's legs, which
// never had a real context.strategy of their own (that engine isn't a
// strategies.js entry — see hedgePairEngine.js's own header) and so
// silently inherited context.js's getDefinition() global default,
// "DPI_TREND_MEANREV" (label "DPI Trend (pure)"). Every hedge-pair
// Telegram message was tagged "· DPI Trend (pure)" as a result — pure
// accident, the hedge-pair engine has never run any DPI logic at all.
// Deliberately did NOT change context.strategy itself to fix this:
// db.js's createDb() derives its SQLite filename from context.strategy,
// and a running hedge pair's existing .db file (open positions, trade
// history) is keyed to whatever context.strategy has been since it first
// booted — changing it would silently orphan that history on the next
// restart (see db.js's own header comment on exactly this class of bug).
// context.tgLabel is display-only, read nowhere else.
function tgPrefixFor(context) {
    if (context.tgLabel) return `${context.tgPrefix} · ${context.tgLabel}`;
    if (!context.strategy) return context.tgPrefix;
    const label = (STRATEGY_INFO[context.strategy] || {}).label || context.strategy;
    return `${context.tgPrefix} · ${label}`;
}

function createTelegram(context, engineConfig) {
    async function tg(msg) {
        const prefix = tgPrefixFor(context);
        if (!engineConfig.TG_TOKEN || !engineConfig.TG_CHAT_ID) {
            console.log(`[TG:${prefix}]`, msg);
            return;
        }

        const payload = {
            chat_id: engineConfig.TG_CHAT_ID,
            text:    `[${prefix}]\n${msg}`,
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
