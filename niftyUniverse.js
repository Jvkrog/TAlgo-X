// niftyUniverse.js — NIFTY 50 + NIFTY BANK constituent tradingsymbols.
//
// Used by csvRepository.js to filter NSE's equity dump (~9k rows across
// main-board + SME + everything else) down to just the underlyings this
// platform actually trades, instead of indexing all of it into memory on
// every boot.
//
// Hand-maintained, same convention as shortNames.js — NOT fetched live.
// Both indices are reviewed semi-annually (Jan 31 / Jul 31 cutoffs) and
// constituents DO change between reviews on corporate actions. NIFTY BANK
// specifically is mid-transition as of this writing: SEBI mandated an
// increase from 12 to 14 constituents (phased in through FY26), so this
// list may already be one or two names behind NSE's actual published set
// by the time you're reading this.
//
// VERIFY AGAINST NSE'S OFFICIAL CONSTITUENT LIST (or your own Kite
// instrument dump's `name` field) BEFORE RELYING ON THIS FOR LIVE TRADING.
// This is a filter allowlist, not a source of truth — being a name short
// here just means that stock silently isn't included, not that anything
// wrong gets traded, but it's still worth getting right.
"use strict";

// NIFTY 50 — compiled July 2026. A couple of symbols carry real
// uncertainty and are flagged inline: Zomato's post-rename tradingsymbol,
// and Tata Motors' post-demerger (CV vs Passenger Vehicles) symbol.
const NIFTY_50 = [
    "RELIANCE", "BHARTIARTL", "HDFCBANK", "ICICIBANK", "SBIN",
    "TCS", "BAJFINANCE", "LT", "HINDUNILVR", "SUNPHARMA",
    "INFY", "MARUTI", "TITAN", "ADANIPORTS", "M&M",
    "ADANIENT", "KOTAKBANK", "AXISBANK", "ITC", "ULTRACEMCO",
    "NTPC", "HCLTECH", "ONGC", "BAJAJ-AUTO", "JSWSTEEL",
    "BAJAJFINSV", "BEL", "NESTLEIND",
    "ETERNAL",       // formerly ZOMATO — renamed 2025; verify this is the live tradingsymbol
    "POWERGRID", "COALINDIA", "ASIANPAINT", "SHRIRAMFIN", "TATASTEEL",
    "HINDALCO", "EICHERMOT", "GRASIM",
    "INDIGO",        // InterGlobe Aviation
    "SBILIFE", "WIPRO", "JIOFIN", "TRENT", "TECHM",
    "APOLLOHOSP",
    "TATAMOTORS",    // UNVERIFIED — Tata Motors demerged into commercial-vehicle and
                      // passenger-vehicle entities; confirm which entity is actually
                      // the NIFTY 50 constituent and its live tradingsymbol before relying on this
    "HDFCLIFE", "CIPLA", "TATACONSUM", "MAXHEALTH", "DRREDDY",
];

// NIFTY BANK — compiled July 2026, using the pre-expansion 12 (still
// confirmed active) plus Union Bank of India, which recent weightage data
// suggests has already been added as part of SEBI's 12->14 mandate. The
// 14th slot is NOT included here because it couldn't be confirmed — check
// NSE's current published list before trading it.
const NIFTY_BANK = [
    "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK",
    "INDUSINDBK", "AUBANK", "IDFCFIRSTB", "BANKBARODA",
    "PNB", "CANBK", "FEDERALBNK",
    "UNIONBANK",   // recently added per SEBI's 12->14 expansion — unconfirmed, verify
];

// Combined, deduped — csvRepository.js filters NSE EQ rows against this.
const NIFTY_UNIVERSE = new Set([...NIFTY_50, ...NIFTY_BANK]);

// The two index names themselves — NOT equity tradingsymbols, these are
// what an NFO option-chain row's `name` field will read for NIFTY/BANKNIFTY
// index options. Kept here (not in NIFTY_UNIVERSE, which is equities-only)
// for whenever the options-indexing branch gets built — that work still
// needs csvRepository.js to grow a CE/PE branch, this just reserves where
// its own allowlist would live.
const INDEX_OPTION_UNDERLYINGS = ["NIFTY", "BANKNIFTY"];

module.exports = { NIFTY_50, NIFTY_BANK, NIFTY_UNIVERSE, INDEX_OPTION_UNDERLYINGS };
