// test-product-type.js — order product (MIS / NRML) and NRML end-of-day handling (carry vs close at EOD).
// Fake broker client only; nothing is sent anywhere. Run: node test-product-type.js
"use strict";
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm");
let passed = 0; const t = async (n, f) => { await f(); passed++; console.log("ok  -", n); };
const engineConfig = require("../core/engineConfig"); engineConfig.LIVE_ORDERS = true;
const { createOrders } = require("../core/orders");
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
    const eng = fs.readFileSync(path.join(__dirname, "..", "engine.js"), "utf8");
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
        const life = fs.readFileSync(path.join(__dirname, "..", "core", "lifecycle.js"), "utf8"); assert(!/context\.product/.test(life)); assert(/state\.position && context\.carryOvernight/.test(life));
        const strat = fs.readFileSync(path.join(__dirname, "..", "strategies", "strategies.js"), "utf8"); assert(!/context\.product/.test(strat), "strategy resume logic must not depend on product");
    });

    // ── server-side resolution ──
    const srv = fs.readFileSync(path.join(__dirname, "..", "webdash/server.js"), "utf8");
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
        const ui = fs.readFileSync(path.join(__dirname, "..", "webdash/public/app.js"), "utf8");
        for (const k of ['id="addProduct"', 'id="addNrmlEod"', 'id="editProduct"', 'id="editNrmlEod"', "close at EOD (like MIS)", "carry overnight"]) assert(ui.includes(k), k);
        assert(/product: tbAddBody\.querySelector\("#addProduct"\)\.value/.test(ui)); assert(/body\.product = tbEditBody/.test(ui)); assert(/e\.target.*addProduct|t\.id !== "addProduct"/.test(ui));
        assert(!/id="addCarry"/.test(ui), "old carry checkbox must be gone from the add form");
    });
    await t("backtest form prefill: the instrument's DSB 1 / DSB 2 steps (e.g. NATGAS 2 and 3) fill the step fields instead of leaving the engine defaults", async () => {
        const ui = fs.readFileSync(path.join(__dirname, "..", "webdash/public/app.js"), "utf8");
        const a = ui.indexOf("{ const setParam = (key, v)"), b = ui.indexOf("\n", ui.indexOf('setParam("BAND_STEP_DEFAULT"', a)); assert(a > 0 && b > a, "prefill block not found"); const block = ui.slice(a, b);
        const run = (strategy, pf) => { const els = { BAND_STEP_DEFAULT: { value: "" }, BAND_STEP2_DEFAULT: { value: "" } }; vm.runInNewContext(block, { tbBacktestBody: { querySelector: sel => { const m = /data-param="(\w+)"/.exec(sel); return m ? els[m[1]] : null; } }, btState: { strategy }, pf, Number }); return [els.BAND_STEP_DEFAULT.value, els.BAND_STEP2_DEFAULT.value]; };
        assert.deepStrictEqual(run("DSB_DUAL", { bandStep: "2", bandStep2: "3" }), [2, 3]); assert.deepStrictEqual(run("DSB_DUAL", { bandStep: null, bandStep2: null }), ["", ""], "blank instrument value keeps the default");
        assert.deepStrictEqual(run("DYNAMIC_BAND", { bandStep: "1.5", bandStep2: "9" }), [1.5, ""], "DSB 2 is only for DSB_DUAL"); assert.deepStrictEqual(run("DSB_DUAL", { bandStep: "abc", bandStep2: "0" }), ["", ""], "invalid / zero values are ignored");
    });
    await t("Switch Mode: nothing selected = product and carry are KEPT exactly (a paper<->live switch must not turn carried NRML into MIS)", async () => {
        const ma = srv.indexOf("function resolveModeProduct"), mb = srv.indexOf("\n}\n", ma) + 2;
        const modeFn = vm.runInNewContext("(function(){ " + fn + "\n" + srv.slice(ma, mb) + "\n return resolveModeProduct; })()");
        const cur = (product, carry, tf = "15m") => ({ product, carryOvernight: carry, timeframe: tf });
        for (const [prod, carry] of [["MIS", false], ["NRML", false], ["NRML", true]]) assert.deepStrictEqual(j(modeFn(cur(prod, carry), {})), { product: prod, carryOvernight: carry }, prod + carry);
        assert.deepStrictEqual(j(modeFn({ carryOvernight: true }, {})), { product: "NRML", carryOvernight: true }, "legacy listing without product");
        assert.deepStrictEqual(j(modeFn(cur("MIS", false), { product: "NRML", nrmlEod: "CLOSE" })), { product: "NRML", carryOvernight: false });
        assert.deepStrictEqual(j(modeFn(cur("MIS", false), { product: "NRML", nrmlEod: "CARRY" })), { product: "NRML", carryOvernight: true });
        assert.deepStrictEqual(j(modeFn(cur("NRML", true), { product: "MIS" })), { product: "MIS", carryOvernight: false });
        assert.deepStrictEqual(j(modeFn(cur("NRML", true), { nrmlEod: "CLOSE" })), { product: "NRML", carryOvernight: false }, "EOD choice alone keeps NRML");
        assert.deepStrictEqual(j(modeFn(cur("MIS", false), { carryOvernight: true })), { product: "NRML", carryOvernight: true }, "legacy carry flag");
        assert.deepStrictEqual(j(modeFn(cur("MIS", false, "1d"), { product: "MIS" })), { product: "NRML", carryOvernight: true }, "1d always carries"); assert(modeFn(cur("MIS", false), { product: "CNC" }).error);
    });
    await t("Switch Mode dialog: product select (Keep current / MIS / NRML) + NRML EOD select replace the old carry checkbox and are sent with the request", async () => {
        const ui = fs.readFileSync(path.join(__dirname, "..", "webdash/public/app.js"), "utf8");
        for (const k of ['id="tbProduct"', 'id="tbNrmlEod"', "Keep current", "close at EOD (like MIS)"]) assert(ui.includes(k), k); assert(!ui.includes("tbCarryCheck"), "old checkbox must be gone");
        assert(/product: productSel\.value === "KEEP" \? undefined/.test(ui)); assert(/nrmlEod: productSel\.value === "NRML"/.test(ui)); assert(!/carryOvernight: carryCheck/.test(ui));
    });
    await t("edit / mode / add routes actually RUN with a product choice (a ReferenceError such as 'product is not defined' is a failure)", async () => {
        const ra = srv.indexOf("function resolveProductMode"), rb = srv.indexOf("\n}\n", ra) + 2, ma = srv.indexOf("function resolveModeProduct"), mb = srv.indexOf("\n}\n", ma) + 2;
        const bpA = srv.indexOf("function buildProcessEnv"), bpB = srv.indexOf("\n}\n", bpA) + 2;
        for (const [route, body] of [["/api/toolbox/edit", { name: "N", product: "MIS" }], ["/api/toolbox/edit", { name: "N", product: "NRML", nrmlEod: "CLOSE" }], ["/api/toolbox/edit", { name: "N", nrmlEod: "CARRY" }], ["/api/toolbox/mode", { name: "N", live: false, product: "NRML", nrmlEod: "CLOSE" }], ["/api/toolbox/mode", { name: "N", live: false }]]) {
            const ha = srv.indexOf(`app.post("${route}"`), hb = srv.indexOf("\n});", ha) + 4; const handler = srv.slice(ha, hb);
            const routes = {}, stubs = {}; let result = null, lastErr = null;
            for (let attempt = 0; attempt < 80; attempt++) {
                const env = []; result = null;
                const ctx = { app: { post: (r, h) => { routes[r] = h; } }, console, Object, Array, Number, String, Date, JSON, Math, Set, Map, Promise, Error, process: { env: {} }, ...stubs,
                    getEngineProcesses: async () => [{ name: "N", underlying: "NATGAS", strategy: "DSB_DUAL", timeframe: "15m", live: false, carryOvernight: true, product: "NRML", exchange: "MCX", lots: "1" }],
                    pm2RestartWithConfig: async o => { env.push(o.env); }, pm2Restart: async o => { env.push(o.env); } };
                vm.createContext(ctx); vm.runInContext(srv.slice(ra, rb) + "\n" + srv.slice(ma, mb) + "\n" + srv.slice(bpA, bpB) + "\n" + handler, ctx);
                result = await new Promise(res => { routes[route]({ body: JSON.parse(JSON.stringify(body)), params: {} }, { json: b => res({ status: 200, body: b }), status: c => ({ json: b => res({ status: c, body: b }) }) }); });
                const m = result.status === 500 && result.body && /^(\w+) is not defined$/.exec(String(result.body.error || ""));
                if (!m) { lastErr = result; break; }
                assert(!["product", "nrmlEod", "carryOvernight", "resolveProductMode", "resolveModeProduct"].includes(m[1]), `${route}: ${m[1]} is not defined`);
                stubs[m[1]] = new Proxy(function () {}, { get: () => () => {}, apply: () => ({}) });   // unrelated dependency: stub it and retry
            }
            assert(lastErr && !(lastErr.status === 500 && /product|nrmlEod|is not defined/.test(JSON.stringify(lastErr.body))), route + " " + JSON.stringify(body) + " -> " + JSON.stringify(lastErr));
        }
    });
    console.log(`\n${passed} product-type scenarios passed`); process.exit(0);
})().catch(e => { console.log = realLog; console.error("FAIL", e); process.exit(1); });
