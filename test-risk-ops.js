// test-risk-ops.js — Phase 6: alert gate, observer health, observability endpoints, dashboard panels, fault containment.
// Isolated temp DBs; no network, no broker. Run: node test-risk-ops.js
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const sqlite3 = require("sqlite3");
const { createAlertGate } = require("./riskObserver/alerts"), { observerHealth } = require("./riskObserver/obsHealth");
const { createSqliteStore } = require("./riskObserver/riskStore"), { resolveParams } = require("./riskObserver/observer");
let passed = 0; const t = async (n, f) => { await f(); passed++; console.log("ok  -", n); };
let unhandled = 0; process.on("unhandledRejection", () => unhandled++);
const server = fs.readFileSync(path.join(__dirname, "webdash/server.js"), "utf8"), app = fs.readFileSync(path.join(__dirname, "webdash/public/app.js"), "utf8");
const TF = 900000, ist = (y, m, d, hh, mm = 0) => Date.UTC(y, m, d, hh, mm) - 5.5 * 3600000;

(async () => {
    // ── alert gate ──
    await t("alert dedup: identical alerts inside the cooldown are sent once; numbers differing does not defeat dedup", async () => {
        let now = 0; const sent = []; const g = createAlertGate({ send: x => sent.push(x), now: () => now, cooldownMs: 1000 });
        g("candle feed STALE (3 min)"); g("candle feed STALE (4 min)"); g("candle feed STALE (5 min)"); assert.strictEqual(sent.length, 1); now = 1500; g("candle feed STALE (6 min)"); assert.strictEqual(sent.length, 2); assert.strictEqual(g.stats().deduped, 2);
    });
    await t("alert storm: beyond the per-window limit alerts are suppressed and ONE summary is sent when the window rolls; critical alerts still pass", async () => {
        let now = 0; const sent = []; const g = createAlertGate({ send: x => sent.push(x), now: () => now, cooldownMs: 1, windowMs: 1000, maxPerWindow: 3 });
        for (let i = 0; i < 10; i++) { now = i * 10; g("distinct alert " + String.fromCharCode(97 + i) + String.fromCharCode(103 + i)); }
        assert.strictEqual(sent.length, 3); assert.strictEqual(g.stats().rateLimited, 7); g("CRITICAL thing", { critical: true, key: "crit" }); assert.strictEqual(sent.length, 4);
        now = 2000; g("fresh alert after window"); assert(sent.some(x => /7 further alert\(s\) were suppressed/.test(x)), "summary missing"); assert.strictEqual(g.stats().summaries, 1);
    });
    await t("Telegram failure: sync throw and async rejection are contained, counted, never thrown or unhandled", async () => {
        const errs = []; const a = createAlertGate({ send: () => { throw new Error("tg down"); }, onError: e => errs.push(e.message) }); assert.doesNotThrow(() => a("x")); const b = createAlertGate({ send: () => Promise.reject(new Error("401")) }); assert.doesNotThrow(() => b("y"));
        await new Promise(r => setTimeout(r, 20)); assert.strictEqual(a.stats().failures, 1); assert.strictEqual(b.stats().failures, 1); assert.strictEqual(unhandled, 0); assert.doesNotThrow(() => createAlertGate({ send: null })("z")); assert.doesNotThrow(() => createAlertGate({ send: () => {}, onError: () => { throw new Error("bad handler"); } })("q"));
    });
    await t("alert memory is bounded (cooldown table is pruned)", async () => {
        let now = 0; const g = createAlertGate({ send: () => {}, now: () => now, cooldownMs: 10, maxPerWindow: 1e9 }); for (let i = 0; i < 2000; i++) { now = i * 20; g("unique-" + "x".repeat(i % 7) + i.toString(36) + "k".repeat(i % 5), { key: "k" + i }); } assert(g.stats().tracked <= 520, String(g.stats().tracked));
    });
    await t("observer wiring: the observer's Telegram output goes through the gate (repeated identical transitions don't spam)", async () => {
        const src = fs.readFileSync(path.join(__dirname, "riskObserver/observer.js"), "utf8"); assert(/createAlertGate\(\{ send: tgSend/.test(src)); assert(!/tgRaw/.test(src));
    });

    // ── observer health ──
    const snap = o => ({ ts: 100000, riskReliable: true, init: { state: "running", failures: 0 }, restHealth: { status: "HEALTHY" }, ltpHealth: { status: "HEALTHY" }, storeHealth: { errors: 0, schemaVersion: 2 }, runtime: { startedAt: 40000, lastEvalMs: 12 }, freshness: {}, entry: { origin: "observed_from_entry" }, ...o });
    await t("health: OK when everything is reliable; uptime and latency reported", async () => { const h = observerHealth(snap({}), 99000, 100000); assert.strictEqual(h.level, "OK"); assert.strictEqual(h.liveness, "LIVE"); assert.strictEqual(h.uptimeMs, 60000); assert.strictEqual(h.processingLatencyMs, 12); assert.strictEqual(h.dataReliability, "RELIABLE"); });
    await t("health: a SILENT observer is DOWN/STALE — never 'last known OK'", async () => { const h = observerHealth(snap({}), 1000, 200000); assert.strictEqual(h.level, "DOWN"); assert.strictEqual(h.liveness, "SILENT"); assert.strictEqual(h.dataReliability, "STALE"); assert.strictEqual(h.uptimeMs, null); assert(/NOT live/.test(h.reasons[0])); });
    await t("health: failed start, DB errors, feed and LTP problems each degrade it with a reason; no snapshot is UNKNOWN", async () => {
        assert.strictEqual(observerHealth(snap({ init: { state: "failed", failures: 2, error: "locked" } }), 99000, 100000).level, "DOWN");
        const d = observerHealth(snap({ storeHealth: { errors: 3, lastError: "io", schemaVersion: 2 }, restHealth: { status: "GAPS" }, ltpHealth: { status: "STALE" } }), 99000, 100000); assert.strictEqual(d.level, "DEGRADED"); assert(d.reasons.length === 3); assert.strictEqual(d.database.healthy, false);
        assert.strictEqual(observerHealth(null, null, 1).level, "UNKNOWN"); assert.strictEqual(observerHealth(snap({ riskReliable: false }), 99000, 100000).dataReliability, "UNRELIABLE");
        assert.strictEqual(observerHealth(snap({ ltpHealth: { status: "CLOSED" } }), 99000, 100000).level, "OK");
    });

    // ── endpoints ──
    const block = server.slice(server.indexOf("const riskObsLatest = new Map()"), server.indexOf('engineWss.on("connection"'));
    function load(DB_DIR, latest) {
        const routes = {}, appStub = { get: (p, h) => { routes["GET " + p] = h; }, post: p => { routes["POST " + p] = 1; }, put: p => { routes["PUT " + p] = 1; }, delete: p => { routes["DELETE " + p] = 1; }, patch: p => { routes["PATCH " + p] = 1; } };
        const ctx = { app: appStub, require: m => (m.startsWith("../") ? require(path.join(__dirname, "webdash", m)) : require(m)), path, fs, DB_DIR, sqlite3: sqlite3.verbose(), getEngineProcesses: async () => [], console, Date, JSON, Map, Promise, setTimeout, Math, Number, Array, Object, Set };
        vm.createContext(ctx); vm.runInContext(block.replace("const riskObsLatest = new Map();", "var riskObsLatest = new Map();").replace(/^const /gm, "var "), ctx);
        for (const [k, v] of Object.entries(latest || {})) ctx.riskObsLatest.set(k, v); return { routes, ctx };
    }
    const call = (h, params) => new Promise(res => h({ params }, { json: b => res({ body: b }), status: c => ({ json: b => res({ status: c, body: b }) }) }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roops-")), file = path.join(dir, "z_dsb_dual_candle_riskobs.db"), file2 = path.join(dir, "n_dsb_dual_candle_riskobs.db");
    for (const [f, inst, base] of [[file, "Z", 100], [file2, "N", 50]]) {
        const s = await createSqliteStore(f, { instrument: inst });
        for (let i = 0, ts = ist(2026, 9, 27, 9); ts < ist(2026, 9, 27, 23, 30); ts += TF, i++) { const c = base + Math.sin(i / 4) * 0.8 * (inst === "Z" ? 1 : 0.5); await s.markCandle({ ts, open: c, high: c + 0.3, low: c - 0.3, close: c + 0.05 }); }
        const id = await s.openPosition({ side: "LONG", entryPrice: base, entryTs: ist(2026, 9, 27, 10), openedAt: ist(2026, 9, 27, 10), metrics: { perPoint: 10 }, origin: "observed_from_entry" }); await s.addEvent({ posId: id, ts: ist(2026, 9, 27, 10), kind: "POSITION_OPEN", detail: {} }); await s.closePosition(id, "closed", ist(2026, 9, 27, 14)); await s.close();
    }
    const params = resolveParams(require("./engineConfig"), {});
    const mkSnap = (inst, f, o = {}) => ({ instrument: inst, tgPrefix: inst, storeFile: path.basename(f), position: "LONG", entryPrice: 100, lastPrice: 101, pnl: 50, riskReliable: true, riskState: "NORMAL", init: { state: "running", failures: 0 }, restHealth: { status: "HEALTHY" }, ltpHealth: { status: "HEALTHY" }, storeHealth: { errors: 0, schemaVersion: 2 }, runtime: { startedAt: Date.now() - 60000, lastEvalMs: 4, alerts: {} }, entry: { origin: "observed_from_entry" }, freshness: {}, ts: Date.now(),
        metrics: { raw: { perPoint: 10, tradeId: 7 }, currentAdverse: 0, adverseCandles: 0, peakPnl: 0, giveback: 0, coverage: { candle: "FULL", live: "FULL" } }, obs15: { relation: "aligned", disagreeCandles: 0, steps: [0.5, 1] }, params: params.riskCfg || params, ...o });
    const fresh = Date.now(), latest = { Z: { snapshot: mkSnap("Z", file), receivedAt: fresh }, N: { snapshot: mkSnap("N", file2, { position: "SHORT", pnl: -20, lastPrice: 50, entryPrice: 50 }), receivedAt: fresh }, OLD: { snapshot: mkSnap("OLD", file, { position: "LONG" }), receivedAt: fresh - 300000 } };
    await t("every observer route is GET-only (incl. health/portfolio/intel/sim) and no write SQL or trading import exists in the block", async () => {
        const { routes } = load(dir, latest); const keys = Object.keys(routes); for (const k of ["health", "portfolio", "intel/:engine", "sim/:engine"]) assert(keys.includes("GET /api/riskobs/" + k), k); assert(keys.every(k => k.startsWith("GET ")), keys.join());
        assert(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/.test(block.replace(/\/\/.*$/gm, ""))); assert(!/require\([^)]*(orders|positions|strategies|slStore|targetStore|candlePoll|signals|lifecycle)/.test(block));
    });
    await t("health endpoint: live vs silent observers; the silent one is DOWN", async () => {
        const { routes } = load(dir, latest); const r = (await call(routes["GET /api/riskobs/health"], {})).body; assert.strictEqual(r.observers.length, 3); assert.strictEqual(r.observers.find(o => o.engine === "Z").level, "OK"); assert.strictEqual(r.observers.find(o => o.engine === "OLD").level, "DOWN");
    });
    await t("portfolio endpoint: silent observer excluded & flagged unreliable; broker-vs-estimate labels; correlation computed or honestly INSUFFICIENT; DB bytes unchanged", async () => {
        const before = fs.readFileSync(file).toString("hex").length; const { routes } = load(dir, latest); const r = (await call(routes["GET /api/riskobs/portfolio"], {})).body;
        assert.strictEqual(r.portfolio.positions, 3); assert.strictEqual(r.portfolio.reliablePositions, 2); assert.strictEqual(r.portfolio.unreliable.length, 1); assert.strictEqual(r.portfolio.gross.provenance, "estimate"); assert.strictEqual(r.portfolio.pnl.complete, false);
        const c = r.correlation["Z|N"] || r.correlation["N|Z"]; assert(c && (c.status === "OK" || c.status === "INSUFFICIENT")); assert(r.limitations.length >= 3); assert.strictEqual(fs.readFileSync(file).toString("hex").length, before);
    });
    await t("intel endpoint: LIVE assessment with explanation for a live observer; STALE label (and UNKNOWN classification) for a silent one; missing snapshot handled", async () => {
        const { routes } = load(dir, latest); const live = (await call(routes["GET /api/riskobs/intel/:engine"], { engine: "Z" })).body; assert.strictEqual(live.available, true); assert.strictEqual(live.label, "LIVE"); assert.strictEqual(live.informational, true); assert(live.assessment.explanation.length > 5);
        const old = (await call(routes["GET /api/riskobs/intel/:engine"], { engine: "OLD" })).body; assert.strictEqual(old.label, "STALE"); assert.strictEqual(old.assessment.classification, "UNKNOWN"); assert.strictEqual((await call(routes["GET /api/riskobs/intel/:engine"], { engine: "NOPE" })).body.available, false);
    });
    await t("sim endpoint: SIMULATED label, scenario suite with baseline vs simulated, limitations; unknown engine handled", async () => {
        const { routes } = load(dir, latest); const r = (await call(routes["GET /api/riskobs/sim/:engine"], { engine: "Z" })).body; assert.strictEqual(r.available, true, JSON.stringify(r).slice(0, 200)); assert.strictEqual(r.label, "SIMULATED"); assert(r.results.length >= 4); for (const x of r.results) { assert(x.baseline && x.simulated && x.sensitivity); } assert(r.limitations.length >= 3);
        assert.strictEqual((await call(routes["GET /api/riskobs/sim/:engine"], { engine: "NOPE" })).body.available, false);
    });
    await t("API failure containment: a corrupt database makes every new endpoint answer 'unavailable', never throw", async () => {
        const bad = path.join(dir, "j_dsb_dual_candle_riskobs.db"); fs.writeFileSync(bad, "garbage"); const { routes } = load(dir, { J: { snapshot: mkSnap("J", bad), receivedAt: Date.now() } });
        for (const k of ["intel/:engine", "sim/:engine"]) { const r = (await call(routes["GET /api/riskobs/" + k], { engine: "J" })).body; assert.strictEqual(r.available, false, k); } const p = (await call(routes["GET /api/riskobs/portfolio"], {})).body; assert(p.portfolio || p.error);
    });

    // ── dashboard panels ──
    const a0 = app.indexOf("const roF ="), a1 = app.indexOf("async function loadRiskObs"); const ctx = {}; vm.createContext(ctx);
    vm.runInContext("const escHtml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');\n" + app.slice(a0, a1) + "\nthis.roOverview=roOverview;this.roIntel=roIntel;this.roSim=roSim;", ctx);
    const bad = /undefined|NaN|\[object/;
    const { routes } = load(dir, latest); const H = (await call(routes["GET /api/riskobs/health"], {})).body, P = (await call(routes["GET /api/riskobs/portfolio"], {})).body, I = (await call(routes["GET /api/riskobs/intel/:engine"], { engine: "Z" })).body, I2 = (await call(routes["GET /api/riskobs/intel/:engine"], { engine: "OLD" })).body, S = (await call(routes["GET /api/riskobs/sim/:engine"], { engine: "Z" })).body;
    await t("dashboard overview renders real endpoint data: health levels, STALE label for the silent observer, estimate/UNKNOWN P&L, drawdown, no undefined/NaN", async () => {
        const h = ctx.roOverview(JSON.parse(JSON.stringify(H)), JSON.parse(JSON.stringify(P))); assert(!bad.test(h), h.match(/.{30}(undefined|NaN|\[object).{20}/)); for (const k of ["Overview", "READ-ONLY", "STALE — silent", "ESTIMATE", "Gross exposure", "Concentration", "UNKNOWN", "Drawdown from peak", "not broker margin"]) assert(h.includes(k), "missing " + k);
    });
    await t("dashboard intelligence + simulation panels: LIVE/STALE/INFORMATIONAL/SIMULATED labels, no controls", async () => {
        const a = ctx.roIntel(JSON.parse(JSON.stringify(I))), b = ctx.roIntel(JSON.parse(JSON.stringify(I2))), c = ctx.roSim(JSON.parse(JSON.stringify(S))); const all = a + b + c;
        assert(!bad.test(all), all.match(/.{30}(undefined|NaN|\[object).{20}/)); assert(a.includes("LIVE") && a.includes("INFORMATIONAL")); assert(b.includes("STALE") && b.includes("UNKNOWN")); assert(c.includes("SIMULATED — not actual results") && c.includes("Candle-close"));
        assert(!/<(button|input|select|textarea|form|a )/i.test(all) && !/on(click|change|submit)=/i.test(all));
        assert.doesNotThrow(() => { ctx.roIntel(null); ctx.roIntel({ available: false }); ctx.roSim(null); ctx.roOverview(null, null); ctx.roOverview({ observers: [] }, { portfolio: null }); });
    });
    await t("no unhandled rejections anywhere in this file", async () => { await new Promise(r => setImmediate(r)); assert.strictEqual(unhandled, 0); });
    console.log(`\n${passed} operations scenarios passed`); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
