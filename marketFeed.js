// marketFeed.js — the Scanner's price feed. Generalizes candlePoll.js's
// single-instrument candle-close detection to N instruments watched by one
// process, on the Scanner's OWN fixed cadence (see the design doc's §5 for
// why this deliberately does NOT inherit whatever timeframe any particular
// instrument's live strategy happens to be running on).
//
// One real architectural departure from engine.js worth being explicit
// about: engine.js is one OS process per instrument, one WebSocket
// subscription per process. This file is the opposite shape on purpose —
// ONE process, ONE WebSocket connection, subscribed to every watched
// instrument's token at once. The Scanner's job is a fleet-wide view; N
// separate single-instrument processes would each need to somehow
// aggregate into that view anyway, so doing it in one process from the
// start is both simpler and cheaper (one WS connection instead of N).
//
// Kite's historical-data endpoint has no bulk/multi-token call, so the
// candle-close check below still costs one REST call per watched
// instrument per cycle — that's a real, known cost of this design, not
// hidden. Fine at the scale this platform runs at (tens of instruments,
// not thousands); would need rethinking well before that stopped being true.
"use strict";

const { KiteConnect, KiteTicker } = require("kiteconnect");
const fs = require("fs");
const c  = require("./c");
const { istParts } = require("./istTime");

// createMarketFeed({ engineConfig, resolvedInstruments, onCandle, timeframeMinutes })
//
//   resolvedInstruments — array of { key, token, symbol, exchange }, already
//   resolved (token/symbol/expiry) the same way engine.js resolves a single
//   instrument at boot — see scannerService.js for where that resolution
//   happens. This file only deals with already-resolved tokens; it doesn't
//   itself know about contractResolver.js/instrumentResolution.js — keeping
//   the two concerns (resolving WHICH contract, vs watching a KNOWN token
//   for candle closes) separate, same split engine.js already has.
//
//   onCandle(instrumentKey, candle) — called once per instrument, once per
//   completed candle. This is the ONLY thing marketFeed.js produces —
//   nothing about indicators or classification lives in this file.
//
//   timeframeMinutes — the Scanner's own fixed cadence (default 15).
function createMarketFeed({ engineConfig, resolvedInstruments, onCandle, timeframeMinutes = 15 }) {
    const ACCESS_TOKEN = fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim();

    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(ACCESS_TOKEN);

    // Last-processed candle date per instrument key — same "don't
    // re-process the same candle twice" bookkeeping candlePoll.js does for
    // one instrument, just keyed by instrument here.
    const lastProcessedDate = new Map();

    async function fetchLastCandle(inst) {
        try {
            const now = new Date();
            const lookbackMs = Math.max(2 * 60 * 60 * 1000, timeframeMinutes * 60 * 1000 * 4);
            const from = new Date(now.getTime() - lookbackMs);

            const bars = await kc.getHistoricalData(
                inst.token,
                `${timeframeMinutes}minute`,
                from.toISOString().split("T")[0],
                now.toISOString().split("T")[0]
            );

            if (!bars || bars.length < 2) return null;

            // Second-to-last bar = last COMPLETED candle — identical
            // reasoning to candlePoll.js's fetchLastCandle(): the last bar
            // in the response is always the still-forming current one.
            const b = bars[bars.length - 2];
            return {
                open:  parseFloat(b.open),
                high:  parseFloat(b.high),
                low:   parseFloat(b.low),
                close: parseFloat(b.close),
                volume: b.volume != null ? parseFloat(b.volume) : null,
                date:  String(b.date),
            };
        } catch (err) {
            console.error(c.red(`SCANNER  candle fetch failed for ${inst.key}: ${err.message}`));
            return null;
        }
    }

    // One cycle: check every watched instrument for a newly-closed candle.
    // Deliberately sequential (not Promise.all) — a burst of N simultaneous
    // historical-data calls risks Kite's rate limit the same way
    // historicalFetch.js's backtester chunking already worries about
    // (CHUNK_DELAY_MS exists there for the identical reason). A small delay
    // between each instrument's check keeps this well under that limit.
    const INTER_INSTRUMENT_DELAY_MS = 350;
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async function checkAllInstruments() {
        for (const inst of resolvedInstruments) {
            const candle = await fetchLastCandle(inst);
            if (!candle) { await sleep(INTER_INSTRUMENT_DELAY_MS); continue; }

            const candleTime = new Date(candle.date).getTime();
            const lastTime   = lastProcessedDate.has(inst.key) ? lastProcessedDate.get(inst.key) : 0;

            if (candleTime > lastTime) {
                lastProcessedDate.set(inst.key, candleTime);
                try {
                    await onCandle(inst.key, candle);
                } catch (err) {
                    // A classification error for ONE instrument must never
                    // stop the cycle from checking the rest — same
                    // isolation principle as everything else in this
                    // design (one instrument's problem stays that
                    // instrument's problem).
                    console.error(c.red(`SCANNER  onCandle failed for ${inst.key}: ${err.message}`));
                }
            }

            await sleep(INTER_INSTRUMENT_DELAY_MS);
        }
    }

    // Same explicit IST slot-boundary math candlePoll.js/istTime.js already
    // use — the Scanner's cadence is fixed and shared across every
    // instrument, so there's exactly one schedule to compute, not one per
    // instrument.
    function msUntilNextSlotPlus10() {
        const now = new Date();
        const { hours, minutes } = istParts(now);
        const totalMinNow  = hours * 60 + minutes;
        const minIntoSlot  = totalMinNow % timeframeMinutes;
        const secNow       = now.getSeconds() * 1000 + now.getMilliseconds();
        const msToNextSlot = (timeframeMinutes - minIntoSlot) * 60 * 1000 - secNow;
        return msToNextSlot + 10 * 1000;
    }

    let timer = null;
    function scheduleNext() {
        timer = setTimeout(async () => {
            await checkAllInstruments();
            scheduleNext();
        }, msUntilNextSlotPlus10());
    }

    // Tick-driven updates are deliberately NOT part of this file's job —
    // the Scanner classifies on CANDLE CLOSE only (the requirement was
    // "update every candle," not "update on every tick"). A live WebSocket
    // subscription across every watched token would still be reasonable to
    // add later (e.g. for a live-price display on a dashboard), but it's
    // not needed for regime classification itself, so it's left out rather
    // than built speculatively.
    function start() {
        checkAllInstruments(); // boot catch-up, same reasoning as candlePoll.js's startPoll()
        scheduleNext();
    }

    function stop() {
        if (timer) clearTimeout(timer);
    }

    return { start, stop };
}

module.exports = { createMarketFeed };
