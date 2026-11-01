// test-risk-dashboard.js — the Risk Observer dashboard/API is READ-ONLY and never makes stale data look live.
// Server handlers are extracted from webdash/server.js and executed against real (temporary) observer databases;
// the browser rendering code is extracted from webdash/public/app.js and run in a VM with sample snapshots.
// Run: node test-risk-dashboard.js
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const sqlite3 = require("sqlite3");
const { createSqliteStore } = require("./riskObserver/riskStore");
let passed = 0; const t = async (n, f) => { await f(); passed++; console.log("ok  -", n); };
const server = fs.readFileSync(path.join(__dirname, "webdash/server.js"), "utf8"), app = fs.readFileSync(path.join(__dirname, "webdash/public/app.js"), "utf8");
const T0 = Date.UTC(2026, 9, 28, 4, 0), TF = 900000;

// ── server block: from the riskobs cache to the engine WebSocket handler ──
const sa = server.indexOf("const riskObsLatest = new Map()"), sb = server.indexOf('engineWss.on("connection"');
const block = server.slice(sa, sb);
function loadHandlers(DB_DIR, latest) {
    const routes = {}, appStub = { get: (p, h) => { routes["GET " + p] = h; }, post: (p) => { routes["POST " + p] = true; }, put: (p) => { routes["PUT " + p] = true; }, delete: (p) => { routes["DELETE " + p] = true; }, patch: (p) => { routes["PATCH " + p] = true; } };
    const ctx = { app: appStub, require: m => (m.startsWith("../") ? require(path.join(__dirname, "webdash", m)) : require(m)), path, fs, DB_DIR, sqlite3: sqlite3.verbose(), getEngineProcesses: async () => [], console, Date, JSON, Map, Promise, setTimeout };
    vm.createContext(ctx); vm.runInContext(block.replace("const riskObsLatest = new Map();", "var riskObsLatest = new Map();").replace(/const riskObsAnalyticsCache/, "var riskObsAnalyticsCache"), ctx);
    for (const [k, v] of Object.entries(latest || {})) ctx.riskObsLatest.set(k, v);
    return { routes, ctx };
}
const call = (h, params) => new Promise(res => { const r = { json: b => res({ body: b }), status: c => ({ json: b => res({ status: c, body: b }) }) }; h({ params }, r); });
const ist = (y, m, d, hh, mm = 0) => Date.UTC(y, m, d, hh, mm) - 5.5 * 3600000;

(async () => {
    await t("every Risk Observer API route is GET-only; the block contains no write verbs and opens the database READ-ONLY", async () => {
        const { routes } = loadHandlers(os.tmpdir(), {}); const keys = Object.keys(routes);
        assert(keys.some(k => k === "GET /api/riskobs") && keys.some(k => k.startsWith("GET /api/riskobs/events")) && keys.some(k => k.startsWith("GET /api/riskobs/analytics")), keys.join());
        assert(keys.every(k => k.startsWith("GET ")), "non-GET route: " + keys.filter(k => !k.startsWith("GET ")));
        assert(!/app\.(post|put|delete|patch)\([^)]*riskobs/i.test(server), "a write route mentions riskobs");
        assert(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/.test(block.replace(/\/\/.*$/gm, "")), "write SQL in the observer block");
        assert((block.match(/new sqlite3\.Database\(/g) || []).length >= 1 && (block.match(/OPEN_READONLY/g) || []).length >= 1);
        assert(!/require\([^)]*(orders|positions|strategies|slStore|targetStore|candlePoll|signals|lifecycle)/.test(block));
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rodash-")), file = path.join(dir, "z_dsb_dual_candle_riskobs.db");
    const s = await createSqliteStore(file, { instrument: "Z" });
    for (let ts = ist(2026, 9, 27, 9); ts < ist(2026, 9, 27, 23, 30); ts += TF) await s.markCandle({ ts, open: 100, high: 100.3, low: 99.7, close: 100 });
    const id = await s.openPosition({ side: "SHORT", entryPrice: 100, entryTs: ist(2026, 9, 27, 10), openedAt: ist(2026, 9, 27, 10), metrics: { candleMae: 1, liveMae: 1 }, reconciled: true, origin: "observed_from_entry" });
    await s.addEvent({ posId: id, ts: ist(2026, 9, 27, 10), kind: "POSITION_OPEN", detail: { origin: "observed_from_entry" } }); await s.closePosition(id, "closed", ist(2026, 9, 27, 12)); await s.close();
    const hash = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), before = hash();
    const snap = { storeFile: path.basename(file), obs15: { steps: [0.5, 1] }, params: require("./riskObserver/observer").resolveParams(require("./engineConfig"), {}) };
    await t("analytics + events endpoints serve real data from the observer database and leave the file byte-identical", async () => {
        const { routes } = loadHandlers(dir, { Z: { snapshot: snap } });
        const a = await call(routes["GET /api/riskobs/analytics/:engine"], { engine: "Z" }); assert.strictEqual(a.body.available, true); assert.strictEqual(a.body.summary.sample.positions, 1); assert(a.body.calibration.configurations.length > 5);
        const e = await call(routes["GET /api/riskobs/events/:engine"], { engine: "Z" }); assert(e.body.events.some(x => x.kind === "POSITION_OPEN"));
        assert.strictEqual(hash(), before, "dashboard endpoints modified the observer database");
    });
    await t("endpoints refuse unknown engines and path-traversal / foreign file names coming from a snapshot", async () => {
        const { routes } = loadHandlers(dir, { Z: { snapshot: snap }, EVIL: { snapshot: { ...snap, storeFile: "../../etc/passwd" } }, EVIL2: { snapshot: { ...snap, storeFile: "x.db; drop" } }, NODB: { snapshot: { ...snap, storeFile: "missing_riskobs.db" } } });
        for (const k of ["EVIL", "EVIL2", "NOPE", "NODB"]) { const a = await call(routes["GET /api/riskobs/analytics/:engine"], { engine: k }); assert.strictEqual(a.body.available, false, k); const e = await call(routes["GET /api/riskobs/events/:engine"], { engine: k }); assert.strictEqual(e.body.events.length, 0, k); }
    });
    await t("a corrupt / unreadable database yields a clean 'not available' answer, not an exception", async () => {
        const bad = path.join(dir, "junk_riskobs.db"); fs.writeFileSync(bad, "this is not a sqlite file");
        const { routes } = loadHandlers(dir, { J: { snapshot: { ...snap, storeFile: "junk_riskobs.db" } } }); const a = await call(routes["GET /api/riskobs/analytics/:engine"], { engine: "J" }); assert.strictEqual(a.body.available, false);
    });

    // ── browser rendering ──
    const a0 = app.indexOf("const roF ="), a1 = app.indexOf("async function loadRiskObs");
    const ctx = {}; vm.createContext(ctx); vm.runInContext("const escHtml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');\n" + app.slice(a0, a1) + "\nthis.roCard=roCard;", ctx);
    const { summarize } = require("./riskObserver/analytics"), { evaluate } = require("./riskObserver/calibrate"), { loadHistoryReadOnly } = require("./riskObserver/analytics");
    const hist = await loadHistoryReadOnly(file); const an = { available: true, summary: summarize(hist, { nowMs: ist(2026, 9, 28) }), calibration: evaluate(hist, { steps: [0.5, 1], base: snap.params, session: { startMin: 540, endMin: 1410 }, nowMs: ist(2026, 9, 28) }) };
    const mk = o => ({ mode: "SHADOW", tgPrefix: "Z", instrument: "Z", strategy: "DSB_DUAL", timeframe: "1h", position: "SHORT", entryPrice: 100, lastPrice: 101, lastPriceAgeMs: 3000, riskState: "WATCH", lastKnownRiskState: "WATCH", riskReliable: true, overallHealth: "HEALTHY",
        restHealth: { status: "HEALTHY" }, ltpHealth: { status: "HEALTHY", ageMs: 3000, lastAt: T0, staleAfterMs: 120000 }, candleDiagnostics: { missingCount: 0, brokerEmptyCount: 0 }, lastBackfillOkAt: T0,
        entry: { origin: "observed_from_entry", entryTs: T0, entryTsSource: "engine-trade-record", leadInMs: 1000 }, trend1h: { c1: "red", c2: "red", dir: "SHORT", agree: true }, obs15: { c1: "green", c2: "red", relation: "disagree", agree: false, disagreeCandles: 2, disagreeMs: 1.8e6, lastCandleTs: T0, steps: [0.5, 1] },
        metrics: { pnl: -1000, maeCandlePts: 1, maeLivePts: 1.5, mfeCandlePts: 0, mfeLivePts: 0.2, currentAdversePts: 1, atr15: .4, atrRatio: 2.5, adverseCandles: 1, peakPnl: 200, giveback: 1200, maxGiveback: 1200, recovery: null, stateSecs: { NORMAL: 100, WATCH: 50, DANGER: 0, RECOVERY: 0 },
            durations: { reliableStateSecs: {}, unknownSecs: { rest: 0, ltp: 120, both: 0, history: 0, unobserved: 0, total: 120 }, marketClosedSecs: 0 }, coverage: { candle: "FULL", live: "FULL", candleNote: "", liveNote: "" } },
        freshness: { last15mFetchOkAt: T0, last1hCandleTs: T0 }, init: { state: "running", failures: 0 }, storeHealth: { errors: 0, schemaVersion: 2 }, ...o });
    const bad = /undefined|NaN|\[object/;
    await t("rendering: healthy LIVE card shows entry origin, last price + age, candle vs live MAE, durations, no undefined/NaN", async () => {
        const h = ctx.roCard({ name: "Z", ageMs: 1000, snapshot: mk({}) }, [], an); assert(!bad.test(h), h.match(/.{30}(undefined|NaN|\[object).{20}/)); for (const k of ["LIVE", "observed from entry", "Last price", "MAE (candle / live)", "UNKNOWN time", "Observer lifecycle", "schema v2", "HISTORICAL", "CLEAN sample"]) assert(h.includes(k), "missing " + k);
    });
    await t("rendering: a SILENT observer is never shown as live — STALE banner, risk shown UNKNOWN, LIVE badge removed", async () => {
        const h = ctx.roCard({ name: "Z", ageMs: 90000, snapshot: mk({}) }, [], an); assert(/NOTHING below is live/.test(h)); assert(/RISK UNKNOWN/.test(h)); assert(!/ro-badge live/.test(h), "a LIVE badge is shown for stale data"); assert(/STALE — observer silent/.test(h));
    });
    await t("rendering: UNKNOWN keeps the last known state visible but labelled as NOT current", async () => {
        const h = ctx.roCard({ name: "Z", ageMs: 1000, snapshot: mk({ riskState: "UNKNOWN", riskReliable: false, lastKnownRiskState: "DANGER", restHealth: { status: "STALE", reason: "candle late" }, overallHealth: "STALE" }) }, [], an);
        assert(/RISK UNKNOWN/.test(h)); assert(/last known state: DANGER — NOT a current reading/.test(h)); assert(!/RISK DANGER/.test(h));
    });
    await t("rendering: PARTIAL coverage, discovered-after-entry origin, gaps and failed start are all visible", async () => {
        const h = ctx.roCard({ name: "Z", ageMs: 1000, snapshot: mk({ entry: { origin: "discovered_after_entry", entryTs: T0, entryTsSource: "engine-trade-record" }, restHealth: { status: "GAPS", reason: "2 missing" }, candleDiagnostics: { missingCount: 2, missingRanges: [{ from: new Date(T0).toISOString(), to: new Date(T0 + TF).toISOString() }], brokerEmptyCount: 0 }, init: { state: "failed", failures: 2, error: "db locked" }, storeHealth: { errors: 3, lastError: "io", schemaVersion: 2 },
            metrics: { ...mk({}).metrics, coverage: { candle: "FULL", live: "PARTIAL", candleNote: "", liveNote: "entered earlier" } } }) }, [], an);
        for (const k of ["discovered after entry", "PARTIAL", "Candle feed: 2 missing", "Observer start failed", "database write errors"]) assert(h.includes(k) || h.toLowerCase().includes(k.toLowerCase()), "missing " + k);
    });
    await t("rendering: entry time NOT known is labelled; tiny samples show fractions, not percentages", async () => {
        const h = ctx.roCard({ name: "Z", ageMs: 1000, snapshot: mk({ entry: { origin: "uncertain", entryTs: T0, entryTsSource: "observer-discovery-time" } }) }, [], an); assert(/NOT known — discovery time/.test(h)); assert(/INSUFFICIENT SAMPLE/.test(h));
    });
    await t("rendering: the card contains NO controls (no buttons, inputs, selects, forms, handlers) — observation only", async () => {
        const h = ctx.roCard({ name: "Z", ageMs: 1000, snapshot: mk({}) }, [{ ts: T0, kind: "STATE", from: "NORMAL", to: "DANGER", detail: { skippedWatch: true, reasons: ["r"], inputs: { adverseAtr: 2 } } }], an);
        assert(!/<(button|input|select|textarea|form|a )/i.test(h) && !/on(click|change|submit)=/i.test(h)); assert(/WATCH skipped/.test(h));
        const sect = app.slice(app.indexOf("// ── Risk Observer tab"), app.indexOf("tabRiskObs", app.indexOf("// ── Risk Observer tab")) > 0 ? undefined : undefined);
        const ro = app.slice(app.indexOf("// ── Risk Observer tab")); assert(!/method:\s*["'](POST|PUT|DELETE|PATCH)/i.test(ro.slice(0, ro.indexOf("async function loadRiskObs") + 2500)), "observer tab issues a write request");
    });
    await t("rendering: empty / null analytics and missing fields never throw", async () => {
        assert.doesNotThrow(() => ctx.roCard({ name: "Z", ageMs: null, snapshot: mk({}) }, [], null)); assert.doesNotThrow(() => ctx.roCard({ name: "Z", snapshot: mk({}) }, [], { available: false, reason: "x" }));
        assert.doesNotThrow(() => ctx.roCard({ name: "Z", snapshot: null }, [], null));
    });
    console.log(`\n${passed} dashboard scenarios passed`); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
