// test-risk-parity.js — the Risk Observer's 1H Dual DSB must equal what the REAL DSB_DUAL strategy computes on identical raw
// candles. The real strategy (strategies.js createDsbDualStrategy) is driven candle by candle; its two band steppers are
// captured through a test-only wrapper around dynamicBandReader.createBandStepper (the strategy itself is unmodified), and
// the colours it ended on are compared with the observer's trend1h over the SAME raw candles and parameters.
// Run: node test-risk-parity.js
"use strict";
const assert = require("assert");
const dbr = require("./dynamicBandReader");
const { createBacktestLedger } = require("./backtestLedger");
const { createState } = require("./state");
const { createSLStore } = require("./sl");
const { createTargetStore } = require("./target");
const positions = require("./positions");
const indicators = require("./indicators");
const engineConfig = { ...require("./engineConfig") };
const { createDsbDualStrategy } = require("./strategies");
const { createRiskObserver, resolveParams } = require("./riskObserver/observer");
const { createMemoryStore } = require("./riskObserver/riskStore");
engineConfig.ENGINE_ENABLED = true; engineConfig.LIVE_ORDERS = false; engineConfig.CHOP_GATE_ALWAYS_FORCE = false; engineConfig.ST_ATR_LEN = 3;

const IST = 5.5 * 3600000;
const realCreate = dbr.createBandStepper;
function strategyRig(step1, step2) {
    let now = new Date(Date.UTC(2026, 8, 11, 10) - IST);
    const clock = { now: () => now };
    const ledger = createBacktestLedger({ clock });
    ["countLosingFlipExitsSince", "countScalpTpSince", "countLosingTradesSince", "countWinningTradesSince"].forEach(k => ledger[k] = async () => 0);
    const context = { tgPrefix: "T", symbol: "T", token: 1, lots: 1, lotMult: 1, name: "T", strategy: "DSB_DUAL", bandStep: step1, bandStep2: step2, dsbDualMode: "HOLD", chopFilterEnabled: false, htfGateEnabled: false, dailyHaGateEnabled: false };
    const state = createState(); const raw = []; let candle = null; const nop = () => {};
    const feed = { getLivePrice: () => candle && candle.close, getRawCandles: () => raw, getSourceCandles: () => raw, onTick() {} };
    const strat = createDsbDualStrategy({ context, engineConfig, state, db: ledger, candles: feed, slStore: createSLStore(), targetStore: createTargetStore(),
        orders: { enter: async () => "id", exit: async () => "id", slExit: async () => "id", reconcile: async () => {} },
        positionsClose: (p, r) => positions.close(context, state, ledger, nop, p, r), positionsUnrealised: p => positions.unrealised(context, state, p),
        lifecycle: { isShutdown: () => false }, tg: nop, clock, htf: { isBlocked: async () => false }, dailyHa: { isBlocked: async () => false } });
    return { raw, context, async feedBar(open, close) {
        now = new Date(now.getTime() + 3600000); candle = { open, high: Math.max(open, close) + 0.1 + Math.abs(Math.sin(raw.length)) * .2, low: Math.min(open, close) - 0.1 - Math.abs(Math.cos(raw.length)) * .2, close, date: now.toISOString() };
        raw.push(candle);
        const made = []; dbr.createBandStepper = s => { const st = realCreate(s); made.push(st); return st; };   // test-only spy; behaviour is identical
        const l = console.log; console.log = () => {};
        try { await strat.processCandle(candle); } finally { console.log = l; dbr.createBandStepper = realCreate; }
        if (made.length < 2) return null;                       // strategy did not compute (warm-up)
        const col = st => { const p = st.state() && st.state().position; return p === "LONG" ? "green" : p === "SHORT" ? "red" : "none"; };
        return { c1: col(made[0]), c2: col(made[1]) };
    } };
}
function observerTrend(r, step1, step2) {
    const obs = createRiskObserver({ context: { name: "T", tgPrefix: "T", strategy: "DSB_DUAL", timeframe: "1h", lotMult: 1, lots: 1, bandStep: step1, bandStep2: step2 }, engineConfig, state: { position: null }, candles: { getRawCandles: () => r.raw },
        store: createMemoryStore(), fetchRaw: async () => [], params: resolveParams(engineConfig, {}), clock: { now: () => Date.UTC(2026, 8, 11, 12) } });
    return obs.evaluate().then(() => obs.snapshot().trend1h);
}
let passed = 0; const t = async (n, f) => { await f(); passed++; console.log("ok  -", n); };
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

(async () => {
    for (const [label, passthrough, maxCandles] of [["standard HA", false, 5000], ["MAX_CANDLES window slicing", false, 40], ["HA passthrough (raw/range bars)", true, 5000]]) {
        await t(`parity vs the REAL strategy (${label}): observer colours equal the strategy's after every candle, including warm-up/insufficient history`, async () => {
            indicators.setHaPassthrough(passthrough); const saved = engineConfig.MAX_CANDLES; engineConfig.MAX_CANDLES = maxCandles;
            try {
                const r = strategyRig(1, 2); let price = 100, compared = 0, warm = 0, diffs = 0;
                for (let i = 0; i < 160; i++) {
                    const open = price; price = Math.max(50, price + (rnd() - 0.5) * 3 + Math.sin(i / 17) * 0.9);
                    const real = await r.feedBar(open, price), obs = await observerTrend(r, 1, 2);
                    if (real === null) { warm++; assert.strictEqual(obs.dir, "NONE", `candle ${i}: strategy is warming up, observer must not report a trend`); assert.strictEqual(obs.c1, "none"); continue; }
                    assert.deepStrictEqual([obs.c1, obs.c2], [real.c1, real.c2], `candle ${i} (${label}): observer ${obs.c1}/${obs.c2} vs strategy ${real.c1}/${real.c2}`); compared++;
                    if (real.c1 !== real.c2) diffs++;
                }
                assert(warm === engineConfig.ST_ATR_LEN + 4, `warm-up candles ${warm}`); assert(compared > 100); if (!passthrough) assert(diffs > 3, "scenario never produced a DSB disagreement");
            } finally { indicators.setHaPassthrough(false); engineConfig.MAX_CANDLES = saved; }
        });
    }
    await t("a double Heikin-Ashi conversion WOULD have disagreed with the strategy on this data (the regression is real, not vacuous)", async () => {
        const r = strategyRig(1, 2); let price = 100, mism = 0;
        for (let i = 0; i < 200; i++) {
            const open = price; price = Math.max(50, price + (rnd() - 0.5) * 3 + Math.sin(i / 17) * 0.9); const real = await r.feedBar(open, price); if (!real) continue;
            const ha2 = indicators.toHAAlways(indicators.toHA(r.raw)), a = realCreate(1), b = realCreate(2); for (const k of ha2) { a.push(k); b.push(k); }
            const col = st => (st.state().position === "LONG" ? "green" : st.state().position === "SHORT" ? "red" : "none"); if (col(a) !== real.c1 || col(b) !== real.c2) mism++;
        }
        assert(mism > 0, "double conversion never differed — the regression test would be vacuous");
    });
    await t("strategy source still uses ONE toHA + MAX_CANDLES slice + step1-then-step2 steppers (drift guard)", async () => {
        const src = require("fs").readFileSync(require("path").join(__dirname, "strategies.js"), "utf8"), i = src.indexOf("async function processCandle(rawCandle) {", src.indexOf("function createDsbDualStrategy")), body = src.slice(i, i + 1400);
        assert.strictEqual((body.match(/toHA\(/g) || []).length, 1); assert(/haCandles\.slice\(-engineConfig\.MAX_CANDLES\)/.test(body)); assert(/s1\.push\(k\); s2\.push\(k\)/.test(body)); assert(/engineConfig\.ST_ATR_LEN \+ 5/.test(body));
    });
    console.log(`\n${passed} parity scenarios passed`); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
