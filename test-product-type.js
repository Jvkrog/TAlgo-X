// test-product-type.js — order product (MIS / NRML) and NRML end-of-day handling (carry vs close at EOD).
// Fake broker client only; nothing is sent anywhere. Run: node test-product-type.js
"use strict";
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm");
let passed = 0; const t = async (n, f) => { await f(); passed++; console.log("ok  -", n); };
const engineConfig = require("./engineConfig"); engineConfig.LIVE_ORDERS = true;
const { createOrders } = require("./orders");
const silent = () => {}; const realLog = console.log; 

function fakeKc() { const placed = []; return { placed, getLTP: async k => ({ [Object.keys({})[0] || "MCX:T"]: { last_price: 100 }, "MCX:T": { last_price: 100 } }), placeOrder: async (v, p) => { placed.push(p); return { order_id: "ID" + placed.length }; }, getOrderHistory: async () => [{ status: "COMPLETE", average_price: 100 }] }; }
async function productsFor(ctx) {
    const kc = fakeKc(), o = createOrders({ tgPrefix: "T", exchange: "MCX", symbol: "T", token: 1, lots: 1, lotMult: 1, tickSize: 0.05, name: "T", strategy: "DSB_DUAL", ...ctx }, silent, kc);
    console.log = silent; try { await o.exit("LONG"); await new Promise(r => setTimeout(r, 2100)); } finally { console.log = realLog; }
    return kc.placed.map(p => p.product);
}

(async () => {
    await t("orders: legacy contexts keep their exact product (carry => NRML, otherwise MIS) when no product is set", async () => {
        assert.deepStrictEqual(await productsFor({ carryOvernight: false }), ["MIS"]); assert.deepStrictEqual(await productsFor({ carryOvernight: true }), ["NRML"]);
        assert.deepStrictEqual(await productsFor({ carryOvernight: false, product: null }), ["MIS"]);
    });
    await t("orders: NRML + close-at-EOD uses NRML orders even though carry is off", async () => {
        assert.deepStrictEqual(await productsFor({ carryOvernight: false, product: "NRML" }), ["NRML"]);
    });
    await t("orders: explicit MIS stays MIS; carry-overnight can NEVER produce an MIS order (broker would square it off)", async () => {
        assert.deepStrictEqual(await productsFor({ carryOvernight: false, product: "MIS" }), ["MIS"]); assert.deepStrictEqual(await productsFor({ carryOvernight: true, product: "MIS" }), ["NRML"]); assert.deepStrictEqual(await productsFor({ carryOvernight: true, product: "NRML" }), ["NRML"]);
    });

    // ── engine.js boot resolution, executed exactly as written ──
    const eng = fs.readFileSync(path.join(__dirname, "engine.js"), "utf8");
    const a = eng.indexOf('if (process.env.PRODUCT_OVERRIDE === "MIS"'), b = eng.indexOf("\n", eng.indexOf("context.product = context.carryOvernight ?", a));
    assert(a > 0 && b > a, "engine product block not found"); const block = eng.slice(a, b);
    function boot(env, carry, tf = "15m") { const ctx = { carryOvernight: carry, product: null, tgPrefix: "T", timeframe: tf }; const logs = []; vm.runInNewContext(block, { process: { env }, context: ctx, console: { log: m => logs.push(m) }, c: { yellow: x => x } }); return { ...ctx, logs }; }
    await t("engine boot: MIS => closes at EOD; NRML+carry => holds; NRML+close => NRML orders but carry OFF (engine closes at EOD)", async () => {
        let r = boot({ PRODUCT_OVERRIDE: "MIS" }, false); assert.deepStrictEqual([r.product, r.carryOvernight], ["MIS", false]);
        r = boot({ PRODUCT_OVERRIDE: "NRML" }, true); assert.deepStrictEqual([r.product, r.carryOvernight], ["NRML", true]);
        r = boot({ PRODUCT_OVERRIDE: "NRML" }, false); assert.deepStrictEqual([r.product, r.carryOvernight], ["NRML", false]);
    });
    await t("engine boot: legacy env (no PRODUCT_OVERRIDE) is unchanged; MIS+carry conflict resolves to NRML with a warning", async () => {
        let r = boot({}, false); assert.deepStrictEqual([r.product, r.carryOvernight], ["MIS", false]); r = boot({}, true); assert.deepStrictEqual([r.product, r.carryOvernight], ["NRML", true]);
        r = boot({ PRODUCT_OVERRIDE: "MIS" }, true); assert.deepStrictEqual([r.product, r.carryOvernight], ["NRML", true]); assert(r.logs.some(l => /conflicts/.test(l)));
        r = boot({ PRODUCT_OVERRIDE: "garbage" }, false); assert.strictEqual(r.product, "MIS");
    });
    await t("EOD behaviour depends ONLY on carryOvernight (lifecycle.js never reads product), so NRML+close is force-closed like MIS", async () => {
        const life = fs.readFileSync(path.join(__dirname, "lifecycle.js"), "utf8"); assert(!/context\.product/.test(life)); assert(/state\.position && context\.carryOvernight/.test(life));
        const strat = fs.readFileSync(path.join(__dirname, "strategies.js"), "utf8"); assert(!/context\.product/.test(strat), "strategy resume logic must not depend on product");
    });

    // ── server-side resolution ──
    const srv = fs.readFileSync(path.join(__dirname, "webdash/server.js"), "utf8");
    const fa = srv.indexOf("function resolveProductMode"), fb = srv.indexOf("\n}\n", fa) + 2; const fn = srv.slice(fa, fb);
    const resolve = vm.runInNewContext("(" + fn.replace("function resolveProductMode", "function") + ")");
    const j = o => JSON.parse(JSON.stringify(o));
    await t("server: MIS / NRML+CARRY / NRML+CLOSE map to the right (product, carry) pair", async () => {
        assert.deepStrictEqual(j(resolve({ product: "MIS" })), { product: "MIS", carryOvernight: false }); assert.deepStrictEqual(j(resolve({ product: "MIS", nrmlEod: "CARRY" })), { product: "MIS", carryOvernight: false }, "EOD choice is ignored for MIS");
        assert.deepStrictEqual(j(resolve({ product: "NRML", nrmlEod: "CARRY" })), { product: "NRML", carryOvernight: true }); assert.deepStrictEqual(j(resolve({ product: "NRML", nrmlEod: "CLOSE" })), { product: "NRML", carryOvernight: false });
        assert.deepStrictEqual(j(resolve({ product: "nrml", nrmlEod: "close" })), { product: "NRML", carryOvernight: false }, "case-insensitive"); assert.deepStrictEqual(j(resolve({ product: "NRML" })), { product: "NRML", carryOvernight: true }, "NRML default = carry");
    });
    await t("server: legacy callers (only carryOvernight) keep the old meaning; nothing sent => no change requested", async () => {
        assert.deepStrictEqual(j(resolve({ carryOvernight: true })), { product: "NRML", carryOvernight: true }); assert.deepStrictEqual(j(resolve({ carryOvernight: false })), { product: "MIS", carryOvernight: false }); assert.deepStrictEqual(j(resolve({})), {});
    });
    await t("server: invalid input is rejected; a 1d engine is always NRML + carry", async () => {
        assert(resolve({ product: "CNC" }).error); assert(resolve({ product: "NRML", nrmlEod: "MAYBE" }).error);
        for (const p of [{ product: "MIS" }, { product: "NRML", nrmlEod: "CLOSE" }, { carryOvernight: false }]) assert.deepStrictEqual(j(resolve(p, { timeframe: "1d" })), { product: "NRML", carryOvernight: true });
    });
    await t("server wiring: add / edit / mode / list / buildProcessEnv all carry PRODUCT_OVERRIDE; env is always written explicitly", async () => {
        assert(/PRODUCT_OVERRIDE: pm\.product/.test(srv)); assert(/PRODUCT_OVERRIDE: p\.product === "MIS"/.test(srv)); assert(/PRODUCT_OVERRIDE: r\.product/.test(srv)); assert(/product:\s+p\.pm2_env\.env\?\.PRODUCT_OVERRIDE/.test(srv));
        assert(/if \(pm\.error\) return res\.status\(400\)/.test(srv), "invalid add request must be a 400");
    });
    await t("dashboard form: product select + NRML EOD select, EOD choice only shown for NRML, values sent on add and edit", async () => {
        const ui = fs.readFileSync(path.join(__dirname, "webdash/public/app.js"), "utf8");
        for (const k of ['id="addProduct"', 'id="addNrmlEod"', 'id="editProduct"', 'id="editNrmlEod"', "close at EOD (like MIS)", "carry overnight"]) assert(ui.includes(k), k);
        assert(/product: tbAddBody\.querySelector\("#addProduct"\)\.value/.test(ui)); assert(/body\.product = tbEditBody/.test(ui)); assert(/e\.target.*addProduct|t\.id !== "addProduct"/.test(ui));
        assert(!/id="addCarry"/.test(ui), "old carry checkbox must be gone from the add form");
    });
    await t("backtest form prefill: the instrument's DSB 1 / DSB 2 steps (e.g. NATGAS 2 and 3) fill the step fields instead of leaving the engine defaults", async () => {
        const ui = fs.readFileSync(path.join(__dirname, "webdash/public/app.js"), "utf8");
        const a = ui.indexOf("{ const setParam = (key, v)"), b = ui.indexOf("\n", ui.indexOf('setParam("BAND_STEP_DEFAULT"', a)); assert(a > 0 && b > a, "prefill block not found"); const block = ui.slice(a, b);
        const run = (strategy, pf) => { const els = { BAND_STEP_DEFAULT: { value: "" }, BAND_STEP2_DEFAULT: { value: "" } }; vm.runInNewContext(block, { tbBacktestBody: { querySelector: sel => { const m = /data-param="(\w+)"/.exec(sel); return m ? els[m[1]] : null; } }, btState: { strategy }, pf, Number }); return [els.BAND_STEP_DEFAULT.value, els.BAND_STEP2_DEFAULT.value]; };
        assert.deepStrictEqual(run("DSB_DUAL", { bandStep: "2", bandStep2: "3" }), [2, 3]); assert.deepStrictEqual(run("DSB_DUAL", { bandStep: null, bandStep2: null }), ["", ""], "blank instrument value keeps the default");
        assert.deepStrictEqual(run("DYNAMIC_BAND", { bandStep: "1.5", bandStep2: "9" }), [1.5, ""], "DSB 2 is only for DSB_DUAL"); assert.deepStrictEqual(run("DSB_DUAL", { bandStep: "abc", bandStep2: "0" }), ["", ""], "invalid / zero values are ignored");
    });
    console.log(`\n${passed} product-type scenarios passed`); process.exit(0);
})().catch(e => { console.log = realLog; console.error("FAIL", e); process.exit(1); });
