// dbArchive.js — when an instrument is deleted, its SQLite files are MOVED (never deleted) to databases/deleted/ so a later deploy of
// the same instrument + strategy + candle type starts from a clean database instead of silently adopting the old position/trade rows
// (db.js derives the file name from exactly those three, and would otherwise reopen — or re-copy from a legacy name — the old file).
"use strict";

const fs = require("fs");
const path = require("path");
const { DB_DIR, ROOT } = require("./dbDir");
const { candleSuffix, nativeCandleType } = require("../indicators/candleType");

const DELETED_DIR = path.join(DB_DIR, "deleted");
const SIDECARS = ["", "-wal", "-shm", "-journal"];
const norm = s => String(s || "").toLowerCase().replace(/\s+/g, "");

// Files (absolute) that belong to this deployment. `includeLegacy`: also the older instrument+strategy names, in databases/ AND the
// project root — db.js re-copies those into a missing new-name file, so leaving them would bring the old history back. Only safe to
// move when no other deployment of the same instrument + strategy remains (it may still inherit from them).
function dbFilesFor({ underlying, strategy, candleType, includeLegacy }) {
    const legacyBase = `${norm(underlying)}_${norm(strategy)}`;
    const suffix = candleSuffix(candleType || nativeCandleType(strategy));
    const names = [`${legacyBase}_${suffix}.db`, `${legacyBase}_${suffix}_riskobs.db`];
    const dirs = [DB_DIR, ROOT].filter((d, i, a) => a.indexOf(d) === i);
    if (includeLegacy) names.push(`${legacyBase}.db`, `${legacyBase}_raw.db`);
    const out = [];
    for (const d of dirs) for (const n of names) for (const sc of SIDECARS) out.push(path.join(d, n + sc));
    return out.filter((f, i, a) => a.indexOf(f) === i && fs.existsSync(f));   // dedupe: the legacy `_raw.db` name can equal the exact one
}

function stamp(now) { return now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-"); }

function moveToDeleted(files, now, res) {
    if (!files.length) return;
    fs.mkdirSync(DELETED_DIR, { recursive: true });
    const ts = stamp(now);
    for (const f of files) {
        const base = path.basename(f);
        const m = base.match(/^(.*?\.db)(-wal|-shm|-journal)?$/);
        const inRoot = path.dirname(f) !== DB_DIR ? "root_" : "";
        const to = path.join(DELETED_DIR, `${inRoot}${m[1].replace(/\.db$/, "")}__deleted-${ts}.db${m[2] || ""}`);
        try { fs.renameSync(f, to); res.moved.push({ from: f, to }); }
        catch (e) {
            if (e.code === "EXDEV") { try { fs.copyFileSync(f, to); fs.unlinkSync(f); res.moved.push({ from: f, to }); continue; } catch (e2) { res.errors.push(`${base}: ${e2.message}`); continue; } }
            res.errors.push(`${base}: ${e.message}`);
        }
    }
}

// Move the deployment's database files into databases/deleted/<name>__deleted-<UTC timestamp>.db (sidecars keep their suffix).
// `others` = the deployments that REMAIN (each { underlying, strategy }), used to decide whether the legacy names are safe to move.
// Never throws: returns { moved: [{from,to}], errors: [string] }.
function archiveInstrumentDbs(dep, others = [], now = new Date()) {
    const res = { moved: [], errors: [] };
    try {
        const sharedLegacy = others.some(o => norm(o.underlying) === norm(dep.underlying) && norm(o.strategy) === norm(dep.strategy));
        moveToDeleted(dbFilesFor({ ...dep, includeLegacy: !sharedLegacy }), now, res);
    } catch (e) { res.errors.push(e.message); }
    return res;
}

// ── hedge pair / dual hedge (db.js dbNoStrategy): file = <context.name sanitised to [a-z0-9_]>_<raw|ha|range>.db; an older scheme
// was <name without spaces>_<strategy>[_<candle>].db and is re-copied by db.js when the new name is missing, so it is archived too.
const sanitize = n => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function legDbFiles(contextName) {
    const s = sanitize(contextName), legacyPrefix = norm(contextName) + "_";
    const exact = new RegExp("^" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "_(raw|ha|range)\\.db(-wal|-shm|-journal)?$");
    const out = [];
    for (const d of [DB_DIR, ROOT].filter((x, i, a) => a.indexOf(x) === i)) {
        let names = []; try { names = fs.readdirSync(d); } catch { continue; }
        for (const n of names) {
            const base = n.replace(/-(wal|shm|journal)$/, "");
            if (exact.test(n) || (base.endsWith(".db") && n.toLowerCase().startsWith(legacyPrefix))) out.push(path.join(d, n));
        }
    }
    return out;
}
// context.name of each DB-owning leg: pair = "<core> (CORE)" + "<hedge> (HEDGE)"; dual hedge / dual bias hedge = "<u> (Dual [Bias ]Hedge <SIDE>: <account>)"
const hedgePairLegNames = p => [`${p.coreUnderlying} (CORE)`, `${p.hedgeUnderlying} (HEDGE)`];
const dualHedgeLegNames = p => ["Dual Hedge", "Dual Bias Hedge"].flatMap(k => [[ "LONG", p.longUser ], ["SHORT", p.shortUser]].filter(x => x[1]).map(([side, user]) => `${p.underlying} (${k} ${side}: ${user})`));

// `legNames` = this deployment's leg context names; `othersLegNames` = flat list of the remaining deployments' leg names (a leg whose
// name is still used by another deployment keeps its file — they would share it anyway).
function archiveLegDbs(legNames, othersLegNames = [], now = new Date()) {
    const res = { moved: [], errors: [] };
    try {
        const keep = new Set(othersLegNames.map(sanitize));
        const files = legNames.filter(n => !keep.has(sanitize(n))).flatMap(legDbFiles).filter((f, i, a) => a.indexOf(f) === i);
        moveToDeleted(files, now, res);
    } catch (e) { res.errors.push(e.message); }
    return res;
}

module.exports = { archiveInstrumentDbs, archiveLegDbs, hedgePairLegNames, dualHedgeLegNames, dbFilesFor, DELETED_DIR };
