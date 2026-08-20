// scannerService.js — the Scanner's boot sequence, same role for the
// Market State Engine that engine.js plays for a single trading instrument.
// Run as its own PM2 process (see the design doc's §6/§8) — NOT
// per-instrument, started once, watching every instrument on the
// marketWatchlist.
//
// Wiring, in order: resolve every watchlist instrument to a real
// token/symbol (reusing context.js/csvRepository.js/instrumentResolution.js
// exactly the way engine.js does for one instrument — just looped here) ->
// marketFeed.js watches all of them -> each closed candle runs through
// regimeIndicators.js -> marketProfiler.js -> marketStateStore.js.
//
// Deliberately imports NOTHING from strategies.js/signals.js/orders.js/
// positions.js — this file has no way to place a trade even if it wanted
// to. That's not an oversight, it's the whole point of the "Scanner never
// decides" boundary from the design doc.
"use strict";

const fs = require("fs");
const { KiteConnect } = require("kiteconnect");
const c = require("./c");

const { getDefinition, buildContext } = require("./context");
const { createCsvRepository }    = require("./csvRepository");
const { createInstrumentSource } = require("./instrumentSource");
const { createContractPinStore } = require("./contractPins");
const { resolveCurrent }         = require("./instrumentResolution");
const engineConfig               = require("./engineConfig");
const { createTelegram }         = require("./telegram");

const { createMarketWatchlist }   = require("./marketWatchlist");
const { createMarketFeed }        = require("./marketFeed");
const { createMarketProfiler }     = require("./marketProfiler");
const { createMarketStateStore }   = require("./marketStateStore");
const { createScannerPipeline }    = require("./scannerPipeline");

const SCANNER_TIMEFRAME_MINUTES = 15; // the Scanner's own fixed cadence — see marketFeed.js's header

// Same lookback preload.js uses for engine.js's own per-instrument warmup
// ("5 days covers weekends comfortably for 200 15m bars") — regimeIndicators.js
// only needs ~34 15m bars minimum (see its own minLen math), so 5 days of
// history is comfortably more than enough margin, holidays included.
const HIST_LOOKBACK_DAYS = 5;

// Same per-instrument spacing marketFeed.js already uses between its own
// historical-data calls, for the same reason: stay comfortably under Kite's
// ~3 req/sec historical-data rate limit when looping over N instruments.
const INTER_INSTRUMENT_DELAY_MS = 350;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// backfillCandles(kc, resolved, rawCandleBuffers) — seeds each instrument's
// buffer with real historical candles BEFORE the live feed starts, instead
// of the Scanner silently starting from an empty buffer and needing ~34
// live 15m candles (~8.5 hours — essentially a full trading day) before
// regimeIndicators.js emits its first non-null result. Without this, the
// Scanner looks like it's "not working" for most of day one: every candle
// close still comes in, but computeRegimeIndicators() returns null and
// nothing ever gets logged or saved. Mirrors preload.js's shape (fetch ->
// drop the still-forming last bar -> parse) and marketFeed.js's candle
// shape (open/high/low/close/volume/date-as-string), so a backfilled
// buffer looks identical to one that grew from real live candles.
async function backfillCandles(kc, resolved, rawCandleBuffers) {
    const to   = new Date();
    const from = new Date(to.getTime() - HIST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    for (const inst of resolved) {
        try {
            const bars = await kc.getHistoricalData(
                inst.token,
                `${SCANNER_TIMEFRAME_MINUTES}minute`,
                from.toISOString().split("T")[0],
                to.toISOString().split("T")[0]
            );

            if (bars && bars.length > 1) {
                // Last bar is always the still-forming current candle —
                // same rule preload.js and marketFeed.js's fetchLastCandle
                // both apply; the live feed will deliver it for real once
                // it actually closes.
                const completed = bars.slice(0, -1).map(b => ({
                    open:   parseFloat(b.open),
                    high:   parseFloat(b.high),
                    low:    parseFloat(b.low),
                    close:  parseFloat(b.close),
                    volume: b.volume != null ? parseFloat(b.volume) : null,
                    date:   String(b.date),
                }));
                rawCandleBuffers.set(inst.key, completed);
                console.log(c.dim(`SCANNER  [${inst.key}] backfilled ${completed.length} historical candle(s)`));
            } else {
                console.log(c.yellow(`SCANNER  [${inst.key}] no historical bars returned — will warm up live instead`));
            }
        } catch (err) {
            // Same isolation principle as resolveWatchlist's own per-entry
            // try/catch — one instrument's failed backfill must not stop
            // the rest from backfilling, and must not stop the Scanner from
            // starting at all. Worst case for that one instrument: it just
            // warms up live like the old behavior, same ~8.5hr delay.
            console.error(c.red(`SCANNER  [${inst.key}] backfill failed: ${err.message} — will warm up live instead`));
        }
        await sleep(INTER_INSTRUMENT_DELAY_MS);
    }
}

// Resolves every watchlist entry to a real { key, token, symbol, exchange },
// reusing exactly the same resolution path engine.js uses for a single
// instrument at boot (getDefinition -> csvRepo.load -> resolveCurrent ->
// buildContext) — just looped across the watchlist, and lazily loading
// each distinct exchange's instrument dump only once regardless of how
// many watched instruments share it.
async function resolveWatchlist(watchlistEntries) {
    const pinStore = createContractPinStore();
    const csvReposByExchange = new Map();
    const rawCandleBuffers   = new Map(); // instrument key -> growing candle array, kept here so regimeIndicators.js gets a real warmup history per instrument

    async function getCsvRepoFor(exchange) {
        if (csvReposByExchange.has(exchange)) return csvReposByExchange.get(exchange);

        const ACCESS_TOKEN = fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim();
        const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
        kc.setAccessToken(ACCESS_TOKEN);

        const csvFilePath = exchange === "NSE" ? engineConfig.NSE_INSTRUMENT_CSV_PATH : engineConfig.INSTRUMENT_CSV_PATH;
        const repo = createCsvRepository({
            fetchRows: createInstrumentSource({ filePath: csvFilePath, kc, exchange }).fetchRows,
        });
        await repo.load();
        csvReposByExchange.set(exchange, repo);
        return repo;
    }

    const resolved = [];
    for (const entry of watchlistEntries) {
        try {
            const def  = getDefinition(entry.underlying, entry.exchange);
            const repo = await getCsvRepoFor(def.exchange);
            const { contract } = resolveCurrent(def.underlying, def, repo, pinStore);
            const context = buildContext(def, contract);

            resolved.push({ key: entry.underlying, token: context.token, symbol: context.symbol, exchange: def.exchange });
            rawCandleBuffers.set(entry.underlying, []);
        } catch (err) {
            // One bad watchlist entry (a typo, an expired-with-no-next-
            // contract underlying, whatever) must not take down the whole
            // Scanner boot — log it and keep resolving the rest. Same
            // "one instrument's problem stays that instrument's problem"
            // isolation principle as marketFeed.js's per-candle error
            // handling.
            console.error(c.red(`SCANNER  failed to resolve "${entry.underlying}" (${entry.exchange}): ${err.message} — skipping`));
        }
    }

    return { resolved, rawCandleBuffers };
}

async function main() {
    console.log(c.bold("SCANNER  booting..."));

    const watchlist = createMarketWatchlist();
    const entries    = watchlist.getAll();
    if (entries.length === 0) {
        console.error(c.red("SCANNER  watchlist is empty — nothing to watch. Add instruments via the toolbox's Market Watchlist screen first."));
        process.exit(1);
    }

    const { resolved, rawCandleBuffers } = await resolveWatchlist(entries);
    if (resolved.length === 0) {
        console.error(c.red("SCANNER  every watchlist entry failed to resolve — refusing to start with nothing to watch."));
        process.exit(1);
    }
    console.log(c.dim(`SCANNER  watching ${resolved.length}/${entries.length} instrument(s): ${resolved.map(r => r.key).join(", ")}`));

    // Backfill BEFORE the live feed starts — see backfillCandles' own
    // header for why this matters (without it, regimeIndicators.js stays
    // null for ~8.5 hours of live candles on every instrument). One shared
    // kc instance is fine here regardless of exchange — same as
    // marketFeed.js's own single kc for all resolved instruments — Kite's
    // historical-data endpoint doesn't require a per-exchange client.
    console.log(c.dim("SCANNER  backfilling historical candles..."));
    const ACCESS_TOKEN = fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim();
    const backfillKc = new KiteConnect({ api_key: engineConfig.API_KEY });
    backfillKc.setAccessToken(ACCESS_TOKEN);
    await backfillCandles(backfillKc, resolved, rawCandleBuffers);

    const store = createMarketStateStore();
    store.initDB();

    const profiler = createMarketProfiler();
    // One shared tg sender for the whole Scanner process — unlike
    // engine.js's per-instrument createTelegram(context, ...), there's no
    // single instrument context here, so messages carry the instrument
    // name inline (see scannerPipeline.js) rather than via a per-instrument
    // prefix. Same TG_TOKEN/TG_CHAT_ID from engineConfig.js — one bot,
    // every message (trading alerts AND regime alerts) lands in the same
    // chat, just distinguishable by their own prefix/emoji.
    const { tg } = createTelegram({ tgPrefix: "SCANNER" }, engineConfig);
    const pipeline = createScannerPipeline({ store, profiler, rawCandleBuffers, tg });

    const feed = createMarketFeed({
        engineConfig,
        resolvedInstruments: resolved,
        onCandle: pipeline.onCandle,
        timeframeMinutes: SCANNER_TIMEFRAME_MINUTES,
    });

    feed.start();
    console.log(c.bold("SCANNER  running."));
}

main().catch(err => {
    console.error("SCANNER BOOT FAILED", err);
    process.exit(1);
});

process.on("uncaughtException",  err => console.error("SCANNER UNCAUGHT",  err));
process.on("unhandledRejection", err => console.error("SCANNER UNHANDLED", err));

module.exports = { resolveWatchlist, backfillCandles };
