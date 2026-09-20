// envFile.js — read/write a single KEY=VALUE line in the project's .env
// file in place, without disturbing anything else already in it. Added
// Sep 2026 (reported directly) for two things that both needed the same
// primitive: webdash prompting for and saving a WEBDASH_PIN on first run,
// and pushing a refreshed Kite ACCESS_TOKEN into .env directly instead of
// only the separate access_code.txt file (see engineConfig.js's own header
// on ACCESS_TOKEN_FILE for why that file still exists too).
//
// Anchored to __dirname (this file's own location, repo root) rather than
// cwd or a path passed in — same reasoning as engineConfig.js's own .env
// resolution: `talgox`/`webdash` can be run as global commands from any
// directory, so cwd can't be trusted, and this must point at the exact
// same .env engineConfig.js's dotenv.config() already loads.
"use strict";

const fs   = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, ".env");

// Replaces an existing `KEY=...` line if present, otherwise appends a new
// one. Every other line in the file is left untouched. Also sets
// process.env[key] on the current process immediately — the whole point
// for WEBDASH_PIN is that the same process that just prompted for it can
// start using it right away, no restart needed.
function upsertEnvVar(key, value) {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
        content = content.replace(re, line);
    } else {
        if (content.length > 0 && !content.endsWith("\n")) content += "\n";
        content += line + "\n";
    }
    fs.writeFileSync(ENV_PATH, content);
    process.env[key] = value;
}

// Re-reads the key straight from the .env FILE on disk, bypassing
// process.env's cache — needed anywhere something else (another process,
// or a person editing .env by hand) may have changed it since this
// process's own dotenv.config() ran once at boot.
function readEnvVarFresh(key) {
    if (!fs.existsSync(ENV_PATH)) return null;
    const content = fs.readFileSync(ENV_PATH, "utf8");
    const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1] : null;
}

module.exports = { upsertEnvVar, readEnvVarFresh, ENV_PATH };
