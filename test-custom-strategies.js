// Custom strategies: DB delete + server in-use guard + UI (saved list with delete, "Custom strategies" group in the add / backtest lists).
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
process.env.TALGO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "csdb-"));
const db = require("./customStrategyDb"), T = [], t = (n, f) => T.push([n, f]);
const spec = n => ({ name: n, candleType: "raw", timeframe: "15m", indicators: [{ type: "rsi" }], entryLong: [{ a: 1 }], entryShort: null, exitConfig: {} });
t("db.deleteStrategy removes by name and reports changes", async () => { await new Promise(r => setTimeout(r, 300)); await db.saveStrategy(spec("s1")); await db.saveStrategy(spec("s2")); assert.strictEqual(await db.deleteStrategy("s1"), 1); assert.strictEqual(await db.deleteStrategy("s1"), 0); assert.deepStrictEqual((await db.listStrategies()).map(x => x.name), ["s2"]); });
const srv = fs.readFileSync(__dirname + "/webdash/server.js", "utf8");
t("server DELETE route: 409 while an engine uses it, 404 unknown, otherwise deletes", async () => {
    const a = srv.indexOf('app.delete("/api/strategy-builder/custom-strategies/:name"'), b = srv.indexOf("\n});\n", a) + 5; let handler;
    const vmCtx = { app: { delete: (_p, h) => { handler = h; } }, pm2List: async () => [{ name: "ENG-1", pm2_env: { env: { UNDERLYING: "GOLD", STRATEGY_OVERRIDE: "s2" } } }, { name: "other", pm2_env: { env: {} } }], customStrategyDb: db, String };
    require("vm").runInNewContext(srv.slice(a, b), vmCtx);
    const call = async name => { let out = {}; const res = { status(c) { out.code = c; return this; }, json(o) { out.body = o; out.code = out.code || 200; } }; await handler({ params: { name } }, res); return out; };
    const busy = await call("s2"); assert.strictEqual(busy.code, 409); assert.ok(/ENG-1/.test(busy.body.error)); assert.strictEqual((await db.listStrategies()).length, 1);
    assert.strictEqual((await call("nope")).code, 404); await db.saveStrategy(spec("s3")); const ok = await call("s3"); assert.strictEqual(ok.code, 200); assert.deepStrictEqual((await db.listStrategies()).map(x => x.name), ["s2"]);
});
(async () => {
    let fail = 0, browserTests = true, chromium; try { ({ chromium } = require("playwright")); } catch { browserTests = false; }
    for (const [n, f] of T) { try { await f(); console.log("  ok   " + n); } catch (e) { fail++; console.log("  FAIL " + n + "\n       " + String(e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }
    if (browserTests) {
        const PUB = path.join(__dirname, "webdash/public"), mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
        const server = http.createServer((q, r) => { const f = path.join(PUB, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { "content-type": mime[path.extname(f)] || "x" }); r.end(fs.readFileSync(f)); });
        await new Promise(r => server.listen(0, r)); const br = await chromium.launch(), page = await br.newPage({ viewport: { width: 700, height: 900 } }), deleted = []; page.on("dialog", d => d.accept());
        let custom = [{ id: 1, name: "my_rsi_break", candleType: "ha", timeframe: "15m", indicators: [{ type: "rsi" }, { type: "adx" }], entryLong: [{ x: 1 }], entryShort: [], exitConfig: {} }, { id: 2, name: "half_done", candleType: "raw", timeframe: "5m", indicators: [{ type: "rsi" }], entryLong: null, entryShort: null, exitConfig: null }];
        await page.route(/\/api\//, route => { const u = new URL(route.request().url()), p = u.pathname, m = route.request().method(), json = (o, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) });
            if (p === "/api/auth/status") return json({ enabled: false }); if (p === "/api/instruments") return json([]);
            if (p === "/api/strategy-builder/indicators") return json({ indicators: [] });
            if (p === "/api/strategy-builder/custom-strategies" && m === "GET") return json({ strategies: custom });
            if (p.startsWith("/api/strategy-builder/custom-strategies/") && m === "DELETE") { const nm = decodeURIComponent(p.split("/").pop()); if (nm === "half_done") return json({ error: "In use by ENG-9 — remove that engine first" }, 409); deleted.push(nm); custom = custom.filter(x => x.name !== nm); return json({ ok: true }); }
            if (p === "/api/toolbox/strategies") return json({ default: "DSB_DUAL", strategies: [{ key: "DSB_DUAL", label: "Dual DSB", description: "d", timeframe: "15m", custom: false }, { key: "my_rsi_break", label: "my_rsi_break", description: "ha · 15m", timeframe: "15m", custom: true }, { key: "PURE_HA", label: "Pure HA", description: "p", timeframe: "15m", custom: false }], timeframes: ["15m"] });
            if (p === "/api/toolbox/instruments") return json({ matches: ["GOLDM"] }); return json({}); });
        await page.route(/\/(ws|socket)/, r => r.abort()); await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForTimeout(1200);
        const bt = [["saved list shows both, flags the one without entry conditions", async () => { await page.evaluate(() => document.getElementById("tbOpenCustomStrategy").click()); await page.waitForSelector("[data-del]"); const tx = await page.textContent("#tbCustomBody"); assert.ok(tx.includes("my_rsi_break") && tx.includes("half_done") && /not deployable/.test(tx)); assert.strictEqual(await page.$$eval("[data-del]", e => e.length), 2); }],
            ["delete asks to confirm, calls DELETE, and the row disappears", async () => { await page.click('[data-del="0"]'); await page.waitForFunction(() => document.querySelectorAll("[data-del]").length === 1); assert.deepStrictEqual(deleted, ["my_rsi_break"]); assert.ok(/deleted/.test(await page.textContent("#csbHomeNote"))); }],
            ["a refused delete (in use) shows the server's reason and keeps the row", async () => { await page.click('[data-del="0"]'); await page.waitForFunction(() => /In use by ENG-9/.test(document.getElementById("csbHomeNote").textContent)); assert.ok((await page.textContent("#tbCustomBody")).includes("half_done")); }],
            ["+ New strategy opens the wizard", async () => { await page.click("#csbNew"); await page.waitForSelector("#csbCandleChoice"); }],
            ["add-instrument list: Custom strategies group first, tagged, then Built-in", async () => { await page.click("#tbCustomClose"); await page.evaluate(() => openAddInstrumentModal()); await page.waitForSelector("#tbAddBody .tb-pick-item, #tbAddBody [class*=pick]"); await page.evaluate(() => selectAddUnderlying("GOLDM")); await page.waitForSelector("#addStrategyList .tb-strategy-item");
                const kids = await page.$$eval("#addStrategyList > *", els => els.map(e => e.classList.contains("tb-strategy-item") ? "item:" + e.querySelector(".tb-strategy-item-label").textContent.trim() : "hdr:" + e.textContent.trim()));
                assert.deepStrictEqual(kids.slice(0, 2), ["hdr:Custom strategies", "item:my_rsi_break custom"], JSON.stringify(kids)); assert.ok(kids.includes("hdr:Built-in strategies") && kids.indexOf("hdr:Built-in strategies") === 2, JSON.stringify(kids)); }]];
        for (const [n, f] of bt) { try { await f(); console.log("  ok   " + n); } catch (e) { fail++; console.log("  FAIL " + n + "\n       " + String(e.message).split("\n").slice(0, 3).join("\n       ")); } }
        await br.close(); server.close();
    }
    console.log(fail ? `\n${fail} FAILED` : "\nall passed"); process.exit(fail ? 1 : 0);
})();
