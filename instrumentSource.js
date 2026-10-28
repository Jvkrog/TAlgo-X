// instrumentSource.js — where csvRepository.js's rows actually come from.
//
// Option 1: local CSV file (fast, no network dependency, works if Kite's
//           endpoint is slow or down) — used if it exists and parses to at
//           least one row.
// Option 2: live Kite API fetch — fallback when there's no local file, or
//           the local file is missing/empty/broken.
//
// csvRepository.js doesn't know or care which one ran — it just gets an
// array of rows back from fetchRows().
"use strict";

const fs = require("fs");
const { loadInstrumentCsvFile } = require("./csvFileLoader");

function createInstrumentSource({ filePath, kc, exchange }) {
    async function fetchRows() {
        if (filePath && fs.existsSync(filePath)) {
            try {
                const rows = loadInstrumentCsvFile(filePath);
                if (rows.length > 0) {
                    console.log(`  instrument source: local file (${filePath}, ${rows.length} rows)`);
                    return rows;
                }
                console.warn(`  local CSV file ${filePath} parsed to 0 rows — falling back to Kite API`);
            } catch (err) {
                console.warn(`  failed to read local CSV file ${filePath}: ${err.message} — falling back to Kite API`);
            }
        }

        console.log(`  instrument source: Kite API (${exchange})`);
        return kc.getInstruments(exchange);
    }

    return { fetchRows };
}

module.exports = { createInstrumentSource };
