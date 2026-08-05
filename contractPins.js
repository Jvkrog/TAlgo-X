// contractPins.js — manual roll overrides.
//
// A pin says: "ignore the roll policy for this underlying, use exactly
// this contract." Written by toolbox.js's Roll Contract screen, read by
// engine.js at boot (via instrumentResolution.js) so a manual roll actually
// sticks across restarts.
//
// Two shapes of pin:
//   { symbol }                                   — CSV-validated. Looked up
//     fresh against the CSV repository every boot; if it's gone or expired,
//     it self-heals back to the roll policy.
//   { symbol, token, lotSize, tickSize, manual: true } — fully manual. Used
//     when the next contract isn't in the CSV yet (broker hasn't listed it,
//     or the local file is stale). Trusted as-is, since CSV validation is
//     exactly what isn't possible for it yet.
//
// Flat JSON file, not SQLite — this is operator intent, not trading state.
"use strict";

const fs   = require("fs");
const path = require("path");

function createContractPinStore(filePath = path.join(__dirname, "contractPins.json")) {
    function load() {
        try {
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch {
            return {};   // missing file / bad JSON — treat as "no pins"
        }
    }

    function save(pins) {
        fs.writeFileSync(filePath, JSON.stringify(pins, null, 2));
    }

    function getPin(underlying)         { return load()[underlying] || null; }
    function setPin(underlying, pin)    { const p = load(); p[underlying] = pin; save(p); }
    function clearPin(underlying)       { const p = load(); delete p[underlying]; save(p); }

    return { getPin, setPin, clearPin };
}

module.exports = { createContractPinStore };
