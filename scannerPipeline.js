// scannerPipeline.js — the "what happens when a candle closes" logic for
// the Market State Engine, split out of scannerService.js specifically so
// it can be imported and tested without triggering that file's live boot
// sequence (scannerService.js calls main() at module scope, same pattern
// engine.js uses — requiring it for anything other than actually running
// it as a process is a mistake, the same way nothing else in this codebase
// ever requires engine.js itself).
"use strict";

const c = require("./c");
const { computeRegimeIndicators } = require("./regimeIndicators");

// createScannerPipeline({ store, profiler, rawCandleBuffers, maxBufferLen, tg })
// -> { onCandle }
//
// store/profiler are plain injected dependencies (same convention as
// engine.js's own instantiation block) — this factory doesn't know or care
// whether `store` is a real SQLite-backed marketStateStore.js instance or
// a test double, as long as it has saveProfile()/logTransition().
//
// rawCandleBuffers — a Map the caller owns (instrument key -> growing
// candle array). Passed in rather than created here so scannerService.js
// and a test harness can both inspect/reset it independently.
//
// tg — OPTIONAL. Telegram alert on a structure.state transition only (not
// every candle — same "changed" event that writes to market_profile_history).
// Purely a notification, same as every other tg() call in this codebase —
// it never decides anything, it just tells a human (or eventually
// OneBrain) that something changed, in time to act on it. Defaults to a
// no-op so tests and any caller that doesn't want alerts don't need to
// pass one.
function createScannerPipeline({ store, profiler, rawCandleBuffers, maxBufferLen = 500, tg = async () => {} }) {
    async function onCandle(instrumentKey, candle) {
        let buf = rawCandleBuffers.get(instrumentKey);
        if (!buf) { buf = []; rawCandleBuffers.set(instrumentKey, buf); }
        buf.push(candle);
        if (buf.length > maxBufferLen) buf.shift(); // bounded buffer — regime indicators need history, not the whole session

        const ind = computeRegimeIndicators(buf);
        if (!ind) return null; // still warming up for this instrument

        const result = profiler.profile(instrumentKey, ind);
        if (!result) return null;

        await store.saveProfile(instrumentKey, result.profile);

        if (result.changed) {
            await store.logTransition(instrumentKey, result.previousState, result.profile.structure.state, result.profile.confidence);
            console.log(c.green(
                `SCANNER  [${instrumentKey}] ${result.previousState} -> ${result.profile.structure.state}  ` +
                `(confidence ${result.profile.confidence}%, trend ${result.profile.trend.direction} ${result.profile.trend.score})`
            ));
            // Alert on EVERY transition, not just ones that look like a
            // reason to stop something — deciding "this transition matters,
            // that one doesn't" would be exactly the kind of judgment call
            // this file isn't supposed to make (see the design doc's core
            // boundary). If every transition alert turns out to be too
            // noisy in practice, filtering which ones are worth a message
            // is a decision for whoever's ACTING on them (you, or later
            // OneBrain/a Runtime Advisor) to make — not baked in here.
            await tg(
                `📊 ${instrumentKey}: ${result.previousState} → ${result.profile.structure.state}\n` +
                `Confidence: ${result.profile.confidence}%\n` +
                `Trend: ${result.profile.trend.direction} ${result.profile.trend.score}  ` +
                `Vol: ${result.profile.volatility.state} ${result.profile.volatility.score}\n` +
                `Check the toolbox's Market Status (K) screen — if an engine is running on this instrument, decide there whether to stop/adjust it.`
            );
        }

        return result;
    }

    return { onCandle };
}

module.exports = { createScannerPipeline };
