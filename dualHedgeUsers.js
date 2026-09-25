// dualHedgeUsers.js — named Kite-account credential store for dual-account
// hedging (dualHedgeEngine.js): one account trades LONG-only, a DIFFERENT
// account trades SHORT-only, on the same instrument/band signal.
//
// WHY THIS IS SEPARATE FROM engineConfig.js's single API_KEY/API_SECRET/
// ACCESS_TOKEN: those three are THE ONE account every other engine.js/
// hedgePairEngine.js process in this codebase already authenticates as.
// Dual-account hedging is explicitly about TWO (or more) DIFFERENT Kite
// logins trading the same instrument in opposite directions — reusing the
// single global account for both legs would defeat the entire point (both
// legs would just net against each other inside one account instead of
// being genuinely separate books). So this stores an arbitrary number of
// ADDITIONAL named accounts, each with their own API_KEY/API_SECRET/
// ACCESS_TOKEN, independent of the global engineConfig ones.
//
// STORAGE: same .env file, same envFile.js primitives (upsertEnvVar/
// readEnvVarFresh) engineConfig.js's own getAccessToken() already uses for
// the single-account case — no new storage mechanism invented. Keys are
// name-scoped:
//   DH_USERS                        comma-separated registry of user names
//   DH_USER_<NAME>_API_KEY
//   DH_USER_<NAME>_API_SECRET
//   DH_USER_<NAME>_ACCESS_TOKEN      rotates daily via Kite's login flow,
//                                    same as the single-account ACCESS_TOKEN
//                                    — see toolbox.js's updateAccessToken()
//                                    for the exchange pattern this mirrors
//                                    per-user (toolbox.js's Dual Hedge
//                                    screen > Users submenu implements
//                                    this exchange per user).
// <NAME> is the user's own name, uppercased and restricted to [A-Z0-9_]
// (sanitizeName() below) so it's safe to embed in an env var key — the
// original (unsanitized) display name is NOT separately stored; toolbox/
// webdash display the sanitized form back.
//
// Every read goes through readEnvVarFresh() (re-reads the .env FILE on
// disk every call, bypassing process.env's boot-time snapshot) — same
// reasoning as engineConfig.getAccessToken(): a long-lived
// dualHedgeEngine.js process needs to see a token refreshed by a SEPARATE
// toolbox/webdash process without itself restarting.
"use strict";

const { upsertEnvVar, readEnvVarFresh } = require("./envFile");

function sanitizeName(name) {
    return String(name).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function listUserNames() {
    const raw = readEnvVarFresh("DH_USERS") || "";
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// Returns { name, apiKey, apiSecret, accessToken } for one user, all
// re-read fresh, or null fields if that user was never fully configured.
// Does NOT check DH_USERS membership — callers that need "is this a known
// user" should check listUserNames() first; this just reads whatever is
// on disk for that sanitized name, same fail-open posture
// readEnvVarFresh() itself has everywhere else in this codebase.
function getUser(name) {
    const n = sanitizeName(name);
    return {
        name: n,
        apiKey:      (readEnvVarFresh(`DH_USER_${n}_API_KEY`) || "").trim(),
        apiSecret:   (readEnvVarFresh(`DH_USER_${n}_API_SECRET`) || "").trim(),
        accessToken: (readEnvVarFresh(`DH_USER_${n}_ACCESS_TOKEN`) || "").trim(),
    };
}

function listUsers() {
    return listUserNames().map(getUser);
}

// Adds (or updates) a user's API key/secret and registers them in DH_USERS
// if not already present. Access token is set separately (saveUserToken
// below) since it's obtained through a different flow (request_token
// exchange) and rotates far more often than the key/secret pair.
function saveUserCredentials(name, { apiKey, apiSecret }) {
    const n = sanitizeName(name);
    if (apiKey)    upsertEnvVar(`DH_USER_${n}_API_KEY`, apiKey);
    if (apiSecret) upsertEnvVar(`DH_USER_${n}_API_SECRET`, apiSecret);
    const names = listUserNames();
    if (!names.includes(n)) {
        names.push(n);
        upsertEnvVar("DH_USERS", names.join(","));
    }
    return n;
}

function saveUserToken(name, accessToken) {
    const n = sanitizeName(name);
    upsertEnvVar(`DH_USER_${n}_ACCESS_TOKEN`, accessToken);
}

// Removes a user from the DH_USERS registry only — mirrors how nothing
// else in this codebase scrubs individual .env lines on "remove" (e.g.
// contractPins.js's own precedent), just stops treating them as active.
// The DH_USER_<NAME>_* lines are left in .env (harmless, unreferenced
// once out of the registry) rather than deleted, so re-adding the same
// name later doesn't require re-entering the key/secret.
function removeUser(name) {
    const n = sanitizeName(name);
    const names = listUserNames().filter(x => x !== n);
    upsertEnvVar("DH_USERS", names.join(","));
}

module.exports = { sanitizeName, listUserNames, listUsers, getUser, saveUserCredentials, saveUserToken, removeUser };
