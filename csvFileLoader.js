// csvFileLoader.js — parse a local instrument-dump CSV file.
//
// Produces the exact same row shape kc.getInstruments() returns (same
// field names: instrument_token, exchange_token, tradingsymbol, name,
// expiry, tick_size, lot_size, instrument_type, segment, exchange) — so
// csvRepository.js's indexRows() never needs to know or care whether a row
// came from a file or the live API.
"use strict";

const fs = require("fs");

// Minimal CSV line parser — handles quoted fields (Kite quotes `name` even
// when it doesn't strictly need to) and escaped quotes ("" inside a quoted
// field). Not a full RFC4180 implementation, but covers what this dump
// actually contains.
function parseCsvLine(line) {
    const fields = [];
    let field    = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            fields.push(field);
            field = "";
        } else {
            field += ch;
        }
    }
    fields.push(field);
    return fields;
}

function loadInstrumentCsvFile(filePath) {
    const text  = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length < 2) return [];

    const headers = parseCsvLine(lines[0]);
    const rows    = [];

    for (let i = 1; i < lines.length; i++) {
        const values = parseCsvLine(lines[i]);
        const row    = {};
        headers.forEach((h, idx) => { row[h] = values[idx]; });
        rows.push(row);
    }
    return rows;
}

module.exports = { loadInstrumentCsvFile, parseCsvLine };
