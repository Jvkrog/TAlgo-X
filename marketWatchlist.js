// marketWatchlist.js — which instruments the Scanner continuously watches.
// Deliberately SEPARATE from getEngineProcesses()'s list of currently
// PM2-managed instruments (see the design doc's §4) — the whole point of
// this list is that it can include instruments nobody has started trading
// yet. If it were just "whatever's currently running," the Scanner could
// never do what the original brief asked for (recommending LEAD as
// RANGING when nobody has a LEAD engine running at all).
//
// Same flat-JSON-file pattern as contractPins.js — this is operator intent
// (what to watch), not trading state, so it doesn't belong in SQLite next
// to positions/trades/market profiles.
"use strict";

const fs   = require("fs");
const path = require("path");

function createMarketWatchlist(filePath = path.join(__dirname, "marketWatchlist.json")) {
    function load() {
        try {
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch {
            return []; // missing file / bad JSON — treat as "watching nothing yet"
        }
    }

    function save(list) {
        fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    }

    function getAll() {
        return load();
    }

    // add(underlying, exchange) — idempotent, matches contractPins.js's
    // own style (getPin/setPin/clearPin all just load-mutate-save, no
    // in-memory cache to keep in sync).
    function add(underlying, exchange) {
        const list = load();
        if (!list.some(entry => entry.underlying === underlying)) {
            list.push({ underlying, exchange });
            save(list);
        }
    }

    function remove(underlying) {
        save(load().filter(entry => entry.underlying !== underlying));
    }

    function has(underlying) {
        return load().some(entry => entry.underlying === underlying);
    }

    return { getAll, add, remove, has };
}

module.exports = { createMarketWatchlist };
