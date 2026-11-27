// Some strategy modules are not part of this repository: they live in a separate private repo (see scripts/sync-core.sh) and are copied into this tree.
// Code that can run without them loads them through here, so a missing module is a clear "not installed" instead of a crash.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

/** require() a module that may not be installed; `fallback` is returned when the module itself is missing (errors inside it still throw). */
function optionalRequire(rel, fallback) {
    try { return require(path.join(ROOT, rel)); }
    catch (e) {
        if (e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes(path.basename(rel))) return fallback;
        throw e;
    }
}
const UNDER_DEV = "Under development — not available in this build.";
const isInstalled = rel => fs.existsSync(path.join(ROOT, rel));
/** Throws a plain error when an engine script is not installed (used before pm2 start). */
function assertInstalled(rel) {
    if (!isInstalled(rel)) throw new Error(UNDER_DEV);
}
const missing = () => async () => { throw new Error(UNDER_DEV); };
module.exports = { optionalRequire, isInstalled, assertInstalled, missing, UNDER_DEV };
