// Real-browser check (Playwright/Chromium) of the linked hedge-pair UI against a mocked API: home page placement, the Hedge Pairs
// modal (list + linked add/backtest flow incl. DSB 1/2 fields) and the exact request bodies it sends.
const http = require("http"), fs = require("fs"), path = require("path"), assert = require("assert");
let chromium; try { ({ chromium } = require("playwright")); } catch { console.log("playwright not available — skipped"); process.exit(0); }
const PUB = path.join(__dirname, "..", "webdash/public"); const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const inst = (name, x) => ({ name, underlying: "NATGASMINI", status: "online", live: false, lots: "1", product: "MIS", exchange: "MCX", timeframe: "15m", ...x });
const INSTR = [inst("NATGASMINI-DSB", { strategy: "DSB_DUAL", hedgeGroup: "NGLink", hedgeRole: "A" }), inst("NATGASMINI-DHAB", { strategy: "DAILY_HA_BIAS", product: "NRML", hedgeGroup: "NGLink", hedgeRole: "B" }), inst("GOLDM-x", { underlying: "GOLDM", strategy: "DSB_DUAL" })];
const posted = [];
(async () => {
    const srv = http.createServer((req, res) => { const f = path.join(PUB, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); } res.setHeader("Content-Type", mime[path.extname(f)] || "application/octet-stream"); res.end(fs.readFileSync(f)); }).listen(0);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 430, height: 900 } }); const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.route(/\/api\//, route => {
        const u = new URL(route.request().url()), p = u.pathname, m = route.request().method(), json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
        if (m !== "GET") posted.push({ p, body: route.request().postData() ? JSON.parse(route.request().postData()) : null });
        if (p === "/api/auth/status") return json({ enabled: false });
        if (p === "/api/instruments") return json(INSTR);
        if (p === "/api/toolbox/hedgepairs") return json({ pairs: [] });
        if (p === "/api/toolbox/dualhedge") return json({ deployments: [] });
        if (p === "/api/toolbox/instruments") return json({ matches: ["NATGASMINI", "GOLDM"] });
        if (p.startsWith("/api/toolbox/hedgepairs/contracts") || p.startsWith("/api/toolbox/hedgepairs/lotmult")) return json({ contracts: [], lotMultRequired: false });
        if (p === "/api/toolbox/backtest/linked") return json({ ok: true, summary: { trades: 3, winRate: 0.5, netPnL: 120, maxDrawdown: 10, profitFactor: 1.2 }, legs: [{ role: "A", label: "Dual DSB", metrics: { trades: 2, winRate: 0.5, netPnL: 100, maxDrawdown: 5 } }, { role: "B", label: "Daily HA Bias", metrics: { trades: 1, winRate: 1, netPnL: 20, maxDrawdown: 0 } }], hedge: { hedgedPct: 12.5, hedgeEvents: 2, unhedgeEvents: 2, hedgedDays: 1 }, reportUrl: "/r.html", jsonUrl: "/r.json", logLines: ["x"] });
        if (p === "/api/toolbox/instrument") return json({ ok: true, name: "n_" + posted.length, timeframe: "15m" });
        return json({});
    });
    await page.route(/\/(ws|socket)/, r => r.abort());
    await page.goto(base + "/"); await page.waitForTimeout(1500);
    let n = 0; const ok = m => { n++; console.log("  ok   " + m); };

    // home page
    const homeInstr = await page.$$eval("#instrumentGrid .card .card-underlying", els => els.length), linked = await page.$$eval("#linkedPairsGrid .card", els => els.length);
    assert.strictEqual(homeInstr, 1, "Instruments panel should hold only the standalone engine"); assert.strictEqual(linked, 2); assert.ok(await page.isVisible("#hedgePairsPanel"));
    assert.ok((await page.textContent("#linkedPairsGrid")).includes("LINKED HEDGE PAIR")); ok("home: standalone engine under Instruments, both legs under Hedge Pairs");

    // modal list shows linked pair
    await page.evaluate(() => openHedgePairsModal()); await page.waitForSelector("#hpLinkAddBtn");
    const listText = await page.textContent("#tbHedgePairsBody"); assert.ok(listText.includes("NGLink") && listText.includes("leg A") && listText.includes("leg B")); ok("modal: linked pair and its legs are listed");
    // linked add flow: same contract
    const pick = async name => { await page.waitForSelector("#hpSearchPickList .tb-pick-item"); await page.click(`#hpSearchPickList .tb-pick-item:text-is("${name}")`); };
    await page.click("#hpLinkAddBtn"); await pick("NATGASMINI"); await pick("NATGASMINI"); await page.waitForSelector("#lpSubmit");
    assert.ok(await page.isVisible("#lpADsbRow") && !(await page.isVisible("#lpBDsbRow")), "DSB fields only on the Dual DSB leg");
    assert.strictEqual(await page.inputValue("#lpAProd"), "MIS"); assert.strictEqual(await page.inputValue("#lpBProd"), "NRML"); ok("same contract: one MIS, one NRML by default; DSB fields on the DSB leg only");
    await page.selectOption("#lpAProd", "NRML"); assert.strictEqual(await page.inputValue("#lpBProd"), "MIS", "changing one product flips the other"); await page.selectOption("#lpAProd", "MIS"); ok("changing one leg's product flips the other");
    await page.selectOption("#lpAStrat", "DAILY_HA_BIAS"); assert.strictEqual(await page.inputValue("#lpBStrat"), "DSB_DUAL"); assert.ok(await page.isVisible("#lpBDsbRow") && !(await page.isVisible("#lpADsbRow"))); await page.selectOption("#lpAStrat", "DSB_DUAL"); ok("swapping strategies moves the DSB fields");
    await page.fill("#lpADsb1", "2"); await page.fill("#lpADsb2", "3"); await page.selectOption("#lpADsbMode", "EXIT"); await page.fill("#lpName", "NGLink2");
    posted.length = 0; await page.click("#lpSubmit"); await page.waitForTimeout(700);
    const legs = posted.filter(x => x.p === "/api/toolbox/instrument").map(x => x.body); assert.strictEqual(legs.length, 2, JSON.stringify(posted));
    const A = legs.find(l => l.hedgeRole === "A"), B = legs.find(l => l.hedgeRole === "B");
    assert.strictEqual(A.strategy, "DSB_DUAL"); assert.strictEqual(A.bandStep, "2"); assert.strictEqual(A.bandStep2, "3"); assert.strictEqual(A.dsbDualMode, "EXIT"); assert.strictEqual(A.hedgeGroup, "NGLink2"); assert.strictEqual(A.product, "MIS");
    assert.strictEqual(B.strategy, "DAILY_HA_BIAS"); assert.strictEqual(B.bandStep, undefined); assert.strictEqual(B.product, "NRML"); assert.strictEqual(B.hedgeGroup, "NGLink2"); ok("deploy: two add-instrument requests with DSB 1/2/mode on the DSB leg, link group/roles, MIS + NRML");

    // backtest flow
    await page.waitForSelector("#hpLinkBtBtn"); await page.click("#hpLinkBtBtn"); await pick("NATGASMINI"); await pick("NATGASMINI"); await page.waitForSelector("#lpFrom");
    await page.fill("#lpADsb1", "1.5"); await page.fill("#lpADsb2", "4"); await page.fill("#lpFrom", "2026-09-01"); await page.fill("#lpTo", "2026-09-10");
    posted.length = 0; await page.click("#lpSubmit"); await page.waitForSelector("#lpResult table");
    const bt = posted.find(x => x.p === "/api/toolbox/backtest/linked").body, la = bt.legs.find(l => l.strategy === "DSB_DUAL");
    assert.deepStrictEqual(la.params, { BAND_STEP_DEFAULT: "1.5" }); assert.strictEqual(la.bandStep2, "4"); assert.strictEqual(la.bandStep, undefined); assert.strictEqual(bt.from, "2026-09-01"); assert.ok(bt.legs.every(l => l.timeframe === "15m" && !("hedgeGroup" in l)));
    const res = await page.textContent("#lpResult"); assert.ok(res.includes("Combined") && res.includes("Leg A") && res.includes("12.5%")); ok("backtest: DSB 1 as BAND_STEP_DEFAULT param, DSB 2 as bandStep2, results table + hedge stats rendered");
    // classic flow still works
    await page.click("#hpBack"); await page.waitForSelector("#hpAddBtn"); await page.click("#hpAddBtn"); await page.waitForSelector("#hpSearchInput");
    assert.ok((await page.textContent("#tbHedgePairsBody")).includes("core underlying")); ok("classic add flow still starts at the core picker");
    assert.deepStrictEqual(errors, [], errors.join("\n"));
    console.log(`\nall ${n} passed`); await browser.close(); srv.close(); process.exit(0);
})().catch(e => { console.error("FAIL", e && (e.stack || e.message)); process.exit(1); });
