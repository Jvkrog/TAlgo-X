// Strategy-params plumbing: STRATEGY_PARAMS_OVERRIDE is written EXPLICITLY on every deploy/restart path (CLI + WebDash), read by the
// engine, and survives the pm2-env round trip. (write-asymmetry / pm2 merge-restart bug classes)
"use strict";
const assert = require("assert"), fs = require("fs"), vm = require("vm");
const root = __dirname + "/../";
const srv = fs.readFileSync(root + "webdash/server.js", "utf8"), tbx = fs.readFileSync(root + "toolbox.js", "utf8"), eng = fs.readFileSync(root + "engine.js", "utf8");
const app = fs.readFileSync(root + "webdash/public/app.js", "utf8"), flow = fs.readFileSync(root + "backtest/backtestFlow.js", "utf8");
const { paramsToEnv, paramsFromEnv } = require("../strategies/strategyParams");
let fail = 0; const t = (n, f) => { try { f(); console.log("  ok   " + n); } catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); } };

function loadBuilder(src, name) {
    const a = src.indexOf("function " + name), b = src.indexOf("\n}\n", a) + 2;
    const ctx = { process: { env: {} }, console, String, Number, Object, Math, JSON, Date, Array, Boolean, paramsToEnv, engineConfig: {}, STRATEGY_INFO: {}, normalizeCandleType: x => x, __dirname: "/x" };
    vm.createContext(ctx); vm.runInContext(src.slice(a, b), ctx); return ctx[name];
}
for (const [label, src] of [["WebDash buildProcessEnv", srv], ["CLI buildProcessEnv", tbx]]) {
    t(label + ": STRATEGY_PARAMS_OVERRIDE always written, '' when none, JSON when set, round-trips", () => {
        const f = loadBuilder(src, "buildProcessEnv"), base = { name: "N", underlying: "NATURALGAS", exchange: "MCX", timeframe: "1h", lots: "1", product: "NRML", carryOvernight: true };
        const mk = p => { try { return f({ ...base, ...p }); } catch (e) { throw new Error(e.message); } };
        const set = mk({ strategy: "TREND_DONCHIAN_VT", strategyParams: { entryN: 55, equity: 2500000 } });
        assert.strictEqual(typeof set.STRATEGY_PARAMS_OVERRIDE, "string");
        const back = paramsFromEnv("TREND_DONCHIAN_VT", set.STRATEGY_PARAMS_OVERRIDE).values; assert(back.entryN === 55 && back.equity === 2500000 && back.exitN === 10);
        // a restart after the settings were cleared MUST overwrite the old value with "" (pm2 merges env)
        assert.strictEqual(mk({ strategy: "TREND_DONCHIAN_VT", strategyParams: null }).STRATEGY_PARAMS_OVERRIDE, "");
        assert.strictEqual(mk({ strategy: "DSB_DUAL", strategyParams: { entryN: 5 } }).STRATEGY_PARAMS_OVERRIDE, "");
        assert("STRATEGY_PARAMS_OVERRIDE" in mk({ strategy: "DAILY_HA_BIAS" }), "key present even for strategies without settings");
    });
}
t("add-instrument paths write it explicitly (CLI + WebDash) and the engine reads it", () => {
    assert(/env\.STRATEGY_PARAMS_OVERRIDE = paramsToEnv\(strategy, strategyParams\)/.test(tbx), "CLI add flow");
    assert(/STRATEGY_PARAMS_OVERRIDE: paramsEnv/.test(srv), "WebDash add route");
    assert(/process\.env\.STRATEGY_PARAMS_OVERRIDE/.test(eng) && /context\.strategyParams = r\.values/.test(eng), "engine");
    assert(/forceCarry/.test(eng) && /forceCarry/.test(srv), "NRML + carry enforced in engine and WebDash add route");
});
t("WebDash: strategies endpoint exposes params, edit/add validate them, backtest passes them + cost switches", () => {
    assert(/params: STRATEGY_PARAM_SPEC\[key\] \|\| null/.test(srv) && /validateParams\(p\.strategy, strategyParams/.test(srv) && /validateParams\(stratKey, strategyParams/.test(srv));
    assert(/parsedParams\.strategyParams = v\.params/.test(srv) && /parsedParams\.BT_COSTS/.test(srv));
});
t("UI: dynamic settings form in add / edit / backtest; costs switch; apply-from-backtest carries strategyParams", () => {
    assert(/spFormHtml\(spec, \{\}, "addSp"\)/.test(app) && /spFormHtml\(inst\.strategyParamSpec, inst\.strategyParams, "editSp"\)/.test(app) && /spFormHtml\(sinfo\.params, \{\}, "btSp"\)/.test(app));
    assert(/id="btCosts"/.test(app) && /btCosts: tbBacktestBody/.test(app) && /"dailyHaGateEnabled", "strategyParams"\]/.test(app));
});
t("CLI backtest wizard asks for the settings + costs", () => { assert(/STRATEGY_PARAM_SPEC\[strategyKey\]/.test(flow) && /params\.BT_COSTS/.test(flow)); });
t("gate policy is explicit: the CLI says the universal gates are not applied; registry flags set", () => {
    assert(/gates are NOT applied/.test(tbx) && /gates are NOT applied/.test(flow) && /Chop \/ volume \/ long-candle/.test(app));
    const { STRATEGY_INFO } = require("../strategies/strategies"); const i = STRATEGY_INFO.TREND_DONCHIAN_VT;
    assert(i.costsDefault && i.forceCarry && i.dailyBars && i.params);
});
console.log(fail ? `\n${fail} FAILED` : "\nall passed"); process.exit(fail ? 1 : 0);
