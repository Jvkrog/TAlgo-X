// dbDir.js — every SQLite file lives in one folder (default ./databases, override with TALGO_DB_DIR)
// instead of sitting among the source files. Older files in the project root are COPIED across the
// first time they're needed (never moved or deleted), so nothing already recorded is lost.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DB_DIR = process.env.TALGO_DB_DIR ? path.resolve(process.env.TALGO_DB_DIR) : path.join(ROOT, "databases");
try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch { /* surfaces on first open */ }

const dbFile = name => path.join(DB_DIR, name);

// Copy ROOT/<name> -> DB_DIR/<name> when the new one is missing. Returns the new path.
function adoptLegacy(name) {
    const next = dbFile(name);
    const old = path.join(ROOT, name);
    try {
        if (!fs.existsSync(next) && fs.existsSync(old)) {
            fs.copyFileSync(old, next);
            console.log(`DB: copied ${name} into ${path.relative(ROOT, DB_DIR) || DB_DIR}/`);
        }
    } catch (err) { console.error(`DB adopt failed for ${name}: ${err.message}`); }
    return next;
}

module.exports = { DB_DIR, ROOT, dbFile, adoptLegacy };
