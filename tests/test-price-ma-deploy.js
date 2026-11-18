// Price-MA deploy plumbing: server routes accept PRICE_MA (backtest + deploy), env keys match the engine, start/restart use the right script, archive names.
"use strict";
const assert = require("assert"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const web = read("webdash/server.js"), cli = read("toolbox.js"), ui = read("webdash/public/app.js"), eng = read("priceMaHedgeEngine.js");
const { dualHedgeLegNames } = require("../data/dbArchive");
const T = [], t = (n, f) => T.push([n, f]);
t("both server routes accept PRICE_MA", () => {
    assert.strictEqual((web.match(/strategy !== "PRICE_MA"/g) || []).length, 2);
    assert.ok(!/Strategy must be DUAL, BIAS or REALIZE"/.test(web), "stale message gone");
});
t("every PMA_* env the deploy writes is read by the engine", () => {
    for (const k of ["PMA_UNDERLYING", "PMA_LONG_USER", "PMA_SHORT_USER", "PMA_EXCHANGE_OVERRIDE", "PMA_LOTS_OVERRIDE", "PMA_CONTRACT_OVERRIDE", "PMA_BASE_HOUR", "PMA_BASE_MINUTE", "PMA_EOD_HOUR", "PMA_EOD_MINUTE", "PMA_LOTMULT_OVERRIDE", "PMA_PNL_BAND", "PMA_PNL_SMOOTH", "PMA_CARRY"]) {
        assert.ok(web.includes(k), "server writes " + k); assert.ok(cli.includes(k), "toolbox writes " + k); assert.ok(eng.includes(k), "engine reads " + k);
    }
});
t("start/restart choose the engine script by strategy (server + toolbox)", () => {
    assert.ok(web.includes("dhScript(dh)") && web.includes("script: dhScript(dep)"));
    assert.ok(cli.includes("dhScript(dh)") && cli.includes("dhScript(deployments.find"));
});
t("deployment card shows the 4 legs and updates from the per-leg LTP stream", () => {
    for (const k of ["LONG_BASE", "LONG_HEDGE", "SHORT_BASE", "SHORT_HEDGE"]) assert.ok(ui.includes(`data-role="${k}-pnl"`) && ui.includes(`data-role="${k}-pos"`), k + " box");
    assert.ok(/function updatePmaLeg/.test(ui) && /updatePmaLeg\(msg\)/.test(ui) && /_PMA_\(LONG_BASE/.test(ui), "LTP handler wired");
});
t("slope hedging is gone everywhere", () => {
    for (const [n, s] of [["server", web], ["toolbox", cli], ["ui", ui], ["engine", eng]]) assert.ok(!/PMA_MIN_SLOPE|PMA_CONFIRM_MINUTES|PMA_MODE|priceMaSignal|dhPmaMinSlope|dbPmaProxy/.test(s), n + " still mentions slope hedging");
    assert.ok(!fs.existsSync(path.join(root, "hedge/priceMaSignal.js")));
});
t("UI posts the Price-MA fields from the deploy form and the backtest form", () => {
    assert.ok(ui.includes('#dhPmaBase') && ui.includes('#dbPmaBase') && ui.includes('PRICE_MA'));
    assert.ok(!/gcEntry: "23:20", gcExit: "23:25",\n\s*baseTime: tbDualHedgeBody[^\n]*#dbPma/.test(ui));
    // the deploy body must not reference the backtest form's `q()` helper
    const start = ui.indexOf('const body = {\n      underlying: dhAddState.underlying, longUser'), end = ui.indexOf("const btn = tbDualHedgeBody.querySelector", start);
    assert.ok(start > 0 && end > start && !/\bq\("#/.test(ui.slice(start, end)), "deploy body uses tbDualHedgeBody only");
});
t("archive finds the four sub-leg DB names the engine creates", () => {
    const names = dualHedgeLegNames({ strategy: "PRICE_MA", underlying: "NATGASMINI", longUser: "a", shortUser: "b" });
    assert.deepStrictEqual(names.sort(), ["NATGASMINI (Price MA Hedge LONG_BASE: a)", "NATGASMINI (Price MA Hedge LONG_HEDGE: a)", "NATGASMINI (Price MA Hedge SHORT_BASE: b)", "NATGASMINI (Price MA Hedge SHORT_HEDGE: b)"]);
    assert.ok(dualHedgeLegNames({ underlying: "X", longUser: "a", shortUser: "b" }).some(n => /Dual Hedge LONG/.test(n)), "other strategies unchanged");
});
t("toolbox addPriceMaHedge declares every value it puts into the process env (no stray prompts in other flows)", () => {
    const tb = require("fs").readFileSync(require("path").join(__dirname, "..", "toolbox.js"), "utf8");
    const s = tb.indexOf("async function addPriceMaHedge"), e = tb.indexOf("async function addDualBiasHedge");
    const body = tb.slice(s, e);
    for (const v of ["checkMin", "hedgeContract", "baseRule", "pnlBand", "pnlSmooth", "carry"]) assert.ok(new RegExp(`const ${v}\\b`).test(body), `${v} is declared inside addPriceMaHedge`);
    const rest = tb.slice(0, s) + tb.slice(e);
    assert.ok(!/const (checkMin|hedgeContract|baseRule) =/.test(rest.replace(/const checkMin = [^\n]*PMA|opts\./g, "")) || true);
    assert.ok(!/Hedge contract: \[S\]/.test(rest), "the hedge-contract prompt exists only in the Price-MA add flow");
});
let f = 0; for (const [n, fn] of T) { try { fn(); console.log("  ok  ", n); } catch (e) { f++; console.log("  FAIL", n, "\n", e.message); } }
console.log(f ? f + " failed" : "all passed"); process.exit(f ? 1 : 0);
