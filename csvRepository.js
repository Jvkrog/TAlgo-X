// csvRepository.js — broker instrument master data. Load once, index, serve
// lookups without re-parsing.
//
// "CSV" because that's what the broker actually publishes (Kite's instrument
// dump is a CSV under the hood) — but this takes an injected `fetchRows()`
// rather than parsing raw CSV text itself, since Kite's SDK already returns
// it as parsed objects via getInstruments(). If you ever needed to load from
// an actual downloaded .csv file instead, you'd just swap what fetchRows does
// — nothing else in this file or its callers would change.
"use strict";

const { NIFTY_UNIVERSE } = require("./niftyUniverse");

function createCsvRepository({ fetchRows }) {
    let byToken            = new Map();
    let bySymbol           = new Map();
    let byUnderlyingExpiry = new Map();   // underlying -> [contract, ...] sorted by expiry asc
    let byEquitySymbol     = new Map();   // tradingsymbol -> contract (no expiry, no roll)
    let loadedAt           = null;

    function indexRows(rows) {
        const nextByToken  = new Map();
        const nextBySymbol = new Map();
        const nextByUE     = new Map();
        const nextByEquity = new Map();

        for (const r of rows) {
            // Futures — unchanged from before.
            if (r.instrument_type === "FUT") {
                if (!r.instrument_token || !r.tradingsymbol || !r.expiry) continue;

                const contract = {
                    token:      Number(r.instrument_token),
                    symbol:     r.tradingsymbol,
                    underlying: r.name,                    // e.g. "NATGASMINI" — must match context.js definitions
                    exchange:   r.exchange,
                    expiry:     new Date(r.expiry),
                    lotSize:    Number(r.lot_size),
                    tickSize:   Number(r.tick_size),
                };

                nextByToken.set(contract.token, contract);
                nextBySymbol.set(contract.symbol, contract);

                if (!nextByUE.has(contract.underlying)) nextByUE.set(contract.underlying, []);
                nextByUE.get(contract.underlying).push(contract);
                continue;
            }

            // Equities — cash market, no expiry, nothing to roll. Identity
            // IS the tradingsymbol (unlike futures, there's no separate
            // "underlying name -> pick a month" step — the symbol itself is
            // the whole instrument, forever). r.segment === r.exchange is
            // what separates real tradable equities from index quotes
            // (segment "INDICES" for things like "NIFTY 50", which have no
            // real lot_size/tick_size and aren't tradable) — both carry
            // instrument_type "EQ" in the broker's dump, segment is the
            // actual signal.
            if (r.instrument_type === "EQ" && r.segment === r.exchange) {
                if (!r.instrument_token || !r.tradingsymbol) continue;

                // NSE's equity dump is ~9k rows (main-board + SME + everything
                // else) but this platform only trades NIFTY 50 / NIFTY BANK
                // constituents — indexing all 9k into three maps on every boot
                // is wasted memory/CPU for ~8.9k symbols nothing here will ever
                // look up. Only filters NSE rows (r.exchange === "NSE") — any
                // other exchange's EQ rows (if this ever runs against one)
                // pass through unfiltered, same as before.
                if (r.exchange === "NSE" && !NIFTY_UNIVERSE.has(r.tradingsymbol)) continue;

                const contract = {
                    token:      Number(r.instrument_token),
                    symbol:     r.tradingsymbol,
                    underlying: r.tradingsymbol,           // own identity — see comment above
                    exchange:   r.exchange,
                    expiry:     null,                       // equities don't expire
                    lotSize:    1,                           // cash market — 1 unit = 1 share, always
                    tickSize:   Number(r.tick_size),
                };

                nextByToken.set(contract.token, contract);
                nextBySymbol.set(contract.symbol, contract);
                nextByEquity.set(contract.symbol, contract);
            }
        }

        // Pre-sorted so the Contract Resolver never has to sort per lookup.
        for (const arr of nextByUE.values()) arr.sort((a, b) => a.expiry - b.expiry);

        // Atomic swap — a lookup mid-load never sees a half-built index.
        byToken            = nextByToken;
        bySymbol           = nextBySymbol;
        byUnderlyingExpiry = nextByUE;
        byEquitySymbol     = nextByEquity;
        loadedAt           = new Date();
    }

    async function load() {
        const rows = await fetchRows();
        if (!rows || rows.length === 0) {
            throw new Error("CsvRepository: broker returned 0 instrument rows — refusing to index an empty dump");
        }
        indexRows(rows);
    }

    async function refresh() { await load(); }

    function findByToken(token)         { return byToken.get(Number(token)) || null; }
    function findBySymbol(symbol)       { return bySymbol.get(symbol) || null; }
    function findFuturesFor(underlying) { return byUnderlyingExpiry.get(underlying) || []; }
    function listUnderlyings()          { return Array.from(byUnderlyingExpiry.keys()).sort(); }
    function findEquity(symbol)         { return byEquitySymbol.get(symbol) || null; }
    function listEquitySymbols()        { return Array.from(byEquitySymbol.keys()).sort(); }
    function getLoadedAt()              { return loadedAt; }

    return { load, refresh, findByToken, findBySymbol, findFuturesFor, listUnderlyings, findEquity, listEquitySymbols, getLoadedAt };
}

module.exports = { createCsvRepository };
