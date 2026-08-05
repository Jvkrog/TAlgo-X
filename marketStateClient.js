// marketStateClient.js — the ONLY thing OneBrain (engine.js/strategies.js),
// toolbox.js, or a future dashboard should ever import from the Market
// State Engine. This file never imports strategies.js/signals.js/orders.js
// — the dependency arrow points one way, consumers depend on this, this
// never depends on them.
//
// Built to degrade gracefully by design, not as an afterthought: every
// function here returns a well-formed "unknown" profile instead of
// throwing, whether the Scanner has never run, its DB file doesn't exist
// yet, the row for this instrument is missing, or the row is simply too
// old to trust. A caller (especially inside engine.js's own live trading
// path) should NEVER need a try/catch around this — that safety already
// lives in here, once, rather than being re-implemented at every call site.
"use strict";

const fs   = require("fs");
const path = require("path");
const { createMarketStateStore } = require("./marketStateStore");

// If the Scanner hasn't updated an instrument's profile within this long,
// treat it as stale rather than trusting a number that might no longer
// reflect the market. 30 minutes comfortably covers this platform's
// fastest strategy cadence (15m candles) with room for one missed cycle.
const DEFAULT_STALE_MS = 30 * 60 * 1000;

function unknownProfile(instrument, reason = "unavailable") {
    return {
        instrument,
        trend:         { score: null, direction: "UNKNOWN" },
        volatility:    { score: null, state: "UNKNOWN" },
        participation: { score: null },
        structure:     { state: "UNKNOWN", rawState: "UNKNOWN" },
        confidence: 0,
        updatedAt: null,
        unavailableReason: reason, // "unavailable" | "stale" | "error" — informational only, no caller should branch on this to change trading behavior
    };
}

function createMarketStateClient({ dbPath, staleMs = DEFAULT_STALE_MS } = {}) {
    const resolvedPath = dbPath || path.join(__dirname, "marketState.db");
    let store = null;

    function getStore() {
        if (store) return store;
        // Scanner may simply never have run yet — that's a normal, expected
        // state (e.g. a fresh checkout, or before the Scanner's first boot),
        // not an error condition.
        if (!fs.existsSync(resolvedPath)) return null;
        store = createMarketStateStore(resolvedPath);
        return store;
    }

    async function getProfile(instrument) {
        try {
            const s = getStore();
            if (!s) return unknownProfile(instrument, "unavailable");

            const profile = await s.getProfile(instrument);
            if (!profile) return unknownProfile(instrument, "unavailable");

            const age = Date.now() - new Date(profile.updatedAt).getTime();
            if (!Number.isFinite(age) || age > staleMs) return unknownProfile(instrument, "stale");

            return profile;
        } catch (err) {
            return unknownProfile(instrument, "error");
        }
    }

    async function getAllProfiles() {
        try {
            const s = getStore();
            if (!s) return [];
            const all = await s.getAllProfiles();
            // Same staleness filter applied per-row for a fleet overview —
            // a stale row is worse than no row for a CLI/dashboard listing,
            // since it looks current but isn't.
            const now = Date.now();
            return all.map(p => {
                const age = now - new Date(p.updatedAt).getTime();
                return (!Number.isFinite(age) || age > staleMs) ? unknownProfile(p.instrument, "stale") : p;
            });
        } catch (err) {
            return [];
        }
    }

    return { getProfile, getAllProfiles };
}

module.exports = { createMarketStateClient };
