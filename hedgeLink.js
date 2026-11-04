// hedgeLink.js — links two ordinary engine.js processes (the legs of a "linked hedge pair") so each can see the other's side.
//
// Rule (the whole point): when BOTH legs hold a position and they point in OPPOSITE directions they hedge each other, so neither
// carries a stop. Every other state (peer flat, or same direction) = stops are active. Pure decision lives in isHedged().
//
// Transport: one tiny JSON file per leg in DB_DIR (hedgelink_<group>_<role>.json). A leg only ever WRITES its own file and only
// READS its peer's, so there is no write race. A file is kept while a position is open (an NRML carry keeps the hedge alive
// across restarts) and written {side:null} when flat. A missing / unreadable peer file = peer unknown = NOT hedged (stops on).
"use strict";
const fs = require("fs");
const path = require("path");

const ROLES = ["A", "B"];
const peerRole = r => (r === "A" ? "B" : "A");
const GROUP_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Hedged only when both sides are known and opposite.
function isHedged(mine, peer) {
    return (mine === "LONG" || mine === "SHORT") && (peer === "LONG" || peer === "SHORT") && mine !== peer;
}

function createHedgeLink({ group, role, dir }) {
    if (!GROUP_RE.test(String(group || ""))) throw new Error(`hedgeLink: invalid group "${group}"`);
    if (!ROLES.includes(role)) throw new Error(`hedgeLink: role must be A or B, got "${role}"`);
    const file = r => path.join(dir, `hedgelink_${group}_${r}.json`);
    let lastWritten;   // undefined = never written, so the first publish always lands
    return {
        group, role,
        publish(side) {
            const s = side === "LONG" || side === "SHORT" ? side : null;
            if (s === lastWritten) return false;
            const tmp = file(role) + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify({ side: s, at: new Date().toISOString(), pid: process.pid }));
            fs.renameSync(tmp, file(role));
            lastWritten = s; return true;
        },
        peerSide() {
            try { const j = JSON.parse(fs.readFileSync(file(peerRole(role)), "utf8")); return j.side === "LONG" || j.side === "SHORT" ? j.side : null; }
            catch { return null; }
        },
    };
}

module.exports = { createHedgeLink, isHedged, ROLES, GROUP_RE };
