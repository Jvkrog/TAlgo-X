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
    // underlying -> expiry (ISO date string, no time) -> { ce: Map<strike, contract>, pe: Map<strike, contract> }
    let optionsByUE        = new Map();
    let loadedAt           = null;

    function indexRows(rows) {
        const nextByToken  = new Map();
        const nextBySymbol = new Map();
        const nextByUE     = new Map();
        const nextByEquity = new Map();
        const nextOptions  = new Map();

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

            // Options — CE/PE, added Sep 2026 for the toolbox's manual
            // Options screen (reported directly). Both NFO (index options —
            // "name" is the index, e.g. "NIFTY"/"BANKNIFTY") and MCX
            // (commodity options — "name" matches the same underlying string
            // as that commodity's futures contract, e.g. "CRUDEOIL") carry
            // instrument_type CE/PE, so no exchange-specific branching is
            // needed here — the exchange itself just comes along on the row
            // (r.exchange), same as futures above. Keyed by expiry as an ISO
            // date string (not the raw Date object) so lookups don't need a
            // separate "same calendar day" comparison — dates as Map keys
            // compare by reference, not value.
            if (r.instrument_type === "CE" || r.instrument_type === "PE") {
                if (!r.instrument_token || !r.tradingsymbol || !r.expiry || !r.strike) continue;

                const contract = {
                    token:      Number(r.instrument_token),
                    symbol:     r.tradingsymbol,
                    underlying: r.name,
                    exchange:   r.exchange,
                    expiry:     new Date(r.expiry),
                    strike:     Number(r.strike),
                    type:       r.instrument_type,          // "CE" | "PE"
                    lotSize:    Number(r.lot_size),
                    tickSize:   Number(r.tick_size),
                };

                const expiryKey = contract.expiry.toISOString().slice(0, 10);
                if (!nextOptions.has(contract.underlying)) nextOptions.set(contract.underlying, new Map());
                const byExpiry = nextOptions.get(contract.underlying);
                if (!byExpiry.has(expiryKey)) byExpiry.set(expiryKey, { ce: new Map(), pe: new Map() });
                const bucket = byExpiry.get(expiryKey);
                (contract.type === "CE" ? bucket.ce : bucket.pe).set(contract.strike, contract);

                nextByToken.set(contract.token, contract);
                nextBySymbol.set(contract.symbol, contract);
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
        optionsByUE        = nextOptions;
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

    // ── Options accessors — see indexRows() above for the shape being read.
    function listOptionUnderlyings() { return Array.from(optionsByUE.keys()).sort(); }
    function listOptionExpiries(underlying) {
        const byExpiry = optionsByUE.get(underlying);
        if (!byExpiry) return [];
        return Array.from(byExpiry.keys()).sort(); // ISO strings sort chronologically as-is
    }
    // expiryKey: ISO date string (YYYY-MM-DD), as returned by listOptionExpiries.
    // Returns null if the underlying/expiry combination has no chain (e.g. a
    // stale expiry after a repo refresh) rather than throwing — callers
    // already have to handle "nothing here" for a blank chain either way.
    function getOptionChain(underlying, expiryKey) {
        const bucket = optionsByUE.get(underlying)?.get(expiryKey);
        if (!bucket) return null;
        const strikes = Array.from(new Set([...bucket.ce.keys(), ...bucket.pe.keys()])).sort((a, b) => a - b);
        return { strikes, ce: bucket.ce, pe: bucket.pe };
    }
    function getOption(underlying, expiryKey, strike, type) {
        const bucket = optionsByUE.get(underlying)?.get(expiryKey);
        if (!bucket) return null;
        return (type === "CE" ? bucket.ce : bucket.pe).get(strike) || null;
    }

    return {
        load, refresh, findByToken, findBySymbol, findFuturesFor, listUnderlyings, findEquity, listEquitySymbols, getLoadedAt,
        listOptionUnderlyings, listOptionExpiries, getOptionChain, getOption,
    };
}

module.exports = { createCsvRepository };
