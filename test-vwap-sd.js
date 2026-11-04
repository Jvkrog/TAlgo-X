// VWAP_SD_BANDS: band math, play classification, strategy behaviour (fade / ride / breakout-against / gates) and a full backtest replay.
const assert = require("assert");
const { vwapBandSeries, classify, backInside } = require("./vwapBands");
const { createVwapSdStrategy, STRATEGIES, STRATEGY_INFO, STRATEGY_TIMEFRAME } = require("./strategies");
const { createSLStore } = require("./sl");
const { createState } = require("./state");
const realLog = console.log; const T = []; const t = (n, f) => T.push([n, f]);
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const k = (h, l, c, v = 10) => ({ high: h, low: l, close: c, volume: v });

t("band math: volume-weighted VWAP and SD, bands = VWAP +/- mult*SD", () => {
    const s = [k(101, 99, 100), k(102, 100, 101), k(100, 98, 99), k(101, 99, 100)];
    const b = vwapBandSeries(s, 1); near(b[1].vwap, 100.5); near(b[1].sd, 0.5); near(b[2].sd, Math.sqrt(2 / 3)); near(b[3].upper, b[3].vwap + b[3].sd);
    const b2 = vwapBandSeries(s, 2); near(b2[3].upper - b2[3].vwap, 2 * b[3].sd);
    const w = vwapBandSeries([k(101, 99, 100, 1), k(111, 109, 110, 99)], 1); assert.ok(w[1].vwap > 109, "heavy volume dominates VWAP: " + w[1].vwap);
});
t("band math: no volume anywhere -> time-weighted fallback; empty -> []", () => {
    const b = vwapBandSeries([k(101, 99, 100, 0), k(103, 101, 102, 0)], 1); near(b[1].vwap, 101); assert.deepStrictEqual(vwapBandSeries([], 1), []);
});
t("classify: breakout needs `confirm` closes outside; wick-and-reject is a fade; inside is nothing", () => {
    const CL = [100, 100.4, 99.7, 100.3, 99.8, 100.2, 99.9, 100.1], base = CL.map(x => k(x + 0.3, x - 0.3, x));   // ordinary session: closes scatter inside +/-1 SD
    const mk = extra => { const s = [...base, ...extra], b = vwapBandSeries(s, 1); return classify(s, b, 2); };
    assert.strictEqual(mk([k(100.05, 99.95, 100.0)]), null);
    assert.strictEqual(mk([k(104, 101, 103.5), k(106, 103, 105.5)]), "BREAKOUT_LONG");
    assert.strictEqual(mk([k(99, 96, 96.5), k(97, 94, 94.5)]), "BREAKOUT_SHORT");
    assert.notStrictEqual(mk([k(104, 101, 103.5)]), "BREAKOUT_LONG", "one close outside is not enough");
    // fade long: low pierces the lower band but the close is back above it
    let hit = null; for (let c = 99.0; c < 100 && !hit; c += 0.01) { const r = mk([k(c + 0.3, c - 4, c)]); if (r === "FADE_LONG") hit = c; } assert.ok(hit !== null, "a rejected lower edge reads as FADE_LONG");
    let hit2 = null; for (let c = 101.0; c > 100 && !hit2; c -= 0.01) { const r = mk([k(c + 4, c - 0.3, c)]); if (r === "FADE_SHORT") hit2 = c; } assert.ok(hit2 !== null, "a rejected upper edge reads as FADE_SHORT");
});
t("backInside: all of the last `confirm` closes inside the band", () => {
    const s = [k(102, 98, 100), k(102, 98, 101), k(102, 98, 99), k(102, 98, 100)]; const b = vwapBandSeries(s, 1);
    assert.strictEqual(backInside("LONG", s, b, 2), true); assert.strictEqual(backInside("SHORT", s, b, 2), false, "a close below the lower band is not back inside");
    const s3 = [s[0], s[1], k(102, 98, 100.5), k(102, 98, 100)]; assert.strictEqual(backInside("SHORT", s3, vwapBandSeries(s3, 1), 2), true);
    const s2 = [...s.slice(0, 3), k(110, 106, 109)]; assert.strictEqual(backInside("LONG", s2, vwapBandSeries(s2, 1), 2), false);
});

// ── strategy harness ──
const IST = 5.5 * 3600e3, at = (d, h, m) => new Date(Date.UTC(2026, 9, d, h, m) - IST);
function day(dn, f) { const o = []; let tt = at(dn, 9, 0); for (let i = 0; i < 40; i++) { const b = f(i); o.push({ date: new Date(tt), open: b.c, high: b.h, low: b.l, close: b.c, volume: b.v ?? 100 }); tt = new Date(+tt + 15 * 60e3); } return o; }
const flatDay = (dn, base = 100) => day(dn, i => ({ h: base + 0.01, l: base - 0.01, c: base }));   // identical candles: zero SD, so day 1 never signals
async function run(candlesArr, extraCtx = {}, engOver = {}, { startAt = 0 } = {}) {
    const state = createState(), sl = createSLStore(); let now = null, live = null, idx = 0; const buf = []; const log = [], exits = [], enters = [], entersAt = [];
    const eng = { ENGINE_ENABLED: true, LIVE_ORDERS: false, RESUME_INTRADAY_ONLY: true, ST_ATR_LEN: 10, ATR_SL_MULT: 2, TRADE_START_HOUR: 0, TRADE_START_MINUTE: 0, MAX_CANDLES: 600, ...engOver };
    const strat = createVwapSdStrategy({ context: { tgPrefix: "T", symbol: "X", token: 1, lots: 1, lotMult: 1, ...extraCtx }, engineConfig: eng, state,
        db: { savePosition() {}, insertOpenTrade: async () => 1, loadPosition: async () => null, getRealizedPnlToday: async () => 0, getTradeCountToday: async () => 0, getOpenTrade: async () => null },
        candles: { getRawCandles: () => buf, getLivePrice: () => live }, slStore: sl, targetStore: { clearTarget() {}, setTarget() {} },
        orders: { enter: async s => { enters.push(s); entersAt.push(idx); return {}; }, exit: async s => { exits.push(s); return {}; }, reconcile: async () => {} },
        positionsClose: async (px, reason) => { log.push(reason); state.position = null; state.positionSource = null; return 0; }, positionsUnrealised: () => 0,
        lifecycle: { isShutdown: () => false }, tg() {}, clock: { now: () => now }, htf: { isBlocked: async () => false }, dailyHa: { isBlocked: async () => false } });
    const trace = [];
    for (let i = 0; i < candlesArr.length; i++) { const cd = candlesArr[i]; idx = i; buf.push(cd); now = new Date(cd.date); live = cd.close; console.log = () => {}; try { await strat.processCandle(cd); } finally { console.log = realLog; }
        trace.push({ i, pos: state.position, src: state.positionSource, stop: sl.getTrail().trail }); }
    return { state, sl, log, enters, entersAt, exits, trace };
}
// session built so a clean fade / breakout appears at a known index
function fadeLongSession() {
    const CL = [100, 100.4, 99.7, 100.3, 99.8, 100.2, 99.9, 100.1], base = CL.map(x => ({ h: x + 0.3, l: x - 0.3, c: x })); let c = null;
    for (let x = 99.0; x < 100 && c === null; x += 0.01) { const s = [...base.map(b => k(b.h, b.l, b.c)), k(x + 0.3, x - 4, x)]; if (classify(s, vwapBandSeries(s, 1), 2) === "FADE_LONG") c = x; }
    return [...base, { h: c + 0.3, l: c - 4, c }];
}
t("strategy: FADE_LONG enters long as VWAP_FADE with a fixed ATR stop, then exits at the VWAP cross", async () => {
    const sess = fadeLongSession(); const arr = [...flatDay(1), ...day(2, i => (i < sess.length ? sess[i] : { h: 100.3, l: 99.9, c: 100.05 }))];
    // after the fade candle, lift price back through VWAP (~99.9..100)
    arr[arr.length - 31 + sess.length] ; const r = await run([...flatDay(1), ...day(2, i => i < sess.length ? sess[i] : i === sess.length ? { h: 101.5, l: 99.5, c: 101.2 } : { h: 100.4, l: 99.8, c: 100.1 })].slice(0, 40 + sess.length + 2));
    const enteredAt = r.trace.findIndex(x => x.pos === "LONG"); assert.ok(enteredAt >= 0, "no entry: " + JSON.stringify(r.trace.slice(-6)));
    assert.strictEqual(r.trace[enteredAt].src, "VWAP_FADE"); assert.ok(r.trace[enteredAt].stop < r.state.entryPrice || r.trace[enteredAt].stop < 100, "stop below entry");
    assert.ok(r.log.includes("VWAP TARGET"), "exit reasons: " + r.log.join(","));
});
t("strategy: confirmed breakout rides (VWAP_RIDE), the stop only tightens, exits when closes are back inside the band", async () => {
    const CLb = [100, 100.4, 99.7, 100.3, 99.8, 100.2, 99.9, 100.1], f = i => i < 8 ? { h: CLb[i] + 0.3, l: CLb[i] - 0.3, c: CLb[i] } : i < 12 ? { h: 100 + (i - 7) * 2 + 0.5, l: 100 + (i - 7) * 2 - 0.5, c: 100 + (i - 7) * 2 } : { h: 100.3, l: 99.3, c: 99.9 };
    const r = await run([...flatDay(1), ...day(2, f)].slice(0, 40 + 20));
    const idx = r.trace.findIndex(x => x.pos === "LONG" && x.src === "VWAP_RIDE"); assert.ok(idx >= 0, "no ride entry: " + JSON.stringify(r.trace.slice(40, 56)));
    let prev = -Infinity; for (const x of r.trace.slice(idx)) { if (x.pos === "LONG" && x.stop !== null) { assert.ok(x.stop >= prev - 1e-9, "stop loosened"); prev = x.stop; } }
    assert.ok(r.log.includes("BACK INSIDE BAND"), "exit reasons: " + r.log.join(","));
});
t("strategy: min-candles gate — nothing happens in the first VWAP_MIN_CANDLES of a session", async () => {
    const f = i => ({ h: 100 + i * 2 + 0.5, l: 100 + i * 2 - 0.5, c: 100 + i * 2 });
    const r = await run([...flatDay(1), ...day(2, f)].slice(0, 40 + 5), {}, { VWAP_MIN_CANDLES: 6 }); assert.strictEqual(r.trace.slice(40).some(x => x.pos), false);
    const r2 = await run([...flatDay(1), ...day(2, f)].slice(0, 40 + 12), {}, { VWAP_MIN_CANDLES: 3 }); assert.ok(r2.trace.some(x => x.pos), "with a smaller minimum the breakout is taken");
});
t("strategy: a breakout is never faded — while closes run outside the band there is no short", async () => {
    const CLc = [100, 100.4, 99.7, 100.3, 99.8, 100.2, 99.9, 100.1], f = i => i < 8 ? { h: CLc[i] + 0.3, l: CLc[i] - 0.3, c: CLc[i] } : { h: 100 + (i - 7) * 3 + 1.5, l: 100 + (i - 7) * 3 - 1.5, c: 100 + (i - 7) * 3 };
    const r = await run([...flatDay(1), ...day(2, f)].slice(0, 40 + 20)); const afterBase = r.enters.filter((_, j) => r.entersAt[j] >= 40 + 8);
    assert.ok(afterBase.length > 0 && !afterBase.includes("SHORT"), "entered SHORT during a run-up: " + afterBase.join(","));
});
t("strategy: breakout AGAINST a fade exits it and rides the breakout the other way", async () => {
    const sess = fadeLongSession(); const f = i => i < sess.length ? sess[i] : { h: sess[sess.length - 1].c - (i - sess.length + 1) * 3 + 0.5, l: sess[sess.length - 1].c - (i - sess.length + 1) * 3 - 0.5, c: sess[sess.length - 1].c - (i - sess.length + 1) * 3 };
    const r = await run([...flatDay(1), ...day(2, f)].slice(0, 40 + 16));
    const iFade = r.trace.findIndex(x => x.pos === "LONG" && x.src === "VWAP_FADE"), iRide = r.trace.findIndex(x => x.pos === "SHORT" && x.src === "VWAP_RIDE");
    assert.ok(iFade >= 0, "a fade long is taken at the lower edge"); assert.ok(r.log.includes("BREAKOUT AGAINST"), "the breakout down ends the fade: " + r.log.join(","));
    assert.ok(iRide > iFade, "and the breakout is then ridden short");
});
t("strategy: registered (STRATEGIES / STRATEGY_INFO / timeframe) and native candle type is RAW", () => {
    assert.strictEqual(STRATEGIES.VWAP_SD_BANDS, createVwapSdStrategy); assert.ok(STRATEGY_INFO.VWAP_SD_BANDS.label); assert.strictEqual(STRATEGY_TIMEFRAME.VWAP_SD_BANDS, "15m");
    assert.strictEqual(require("./candleType").nativeCandleType("VWAP_SD_BANDS"), "RAW");
    assert.ok(require("./backtestFlow").STRATEGY_PARAMS.VWAP_SD_BANDS.every(p => p.key in require("./engineConfig")), "every backtest param has an engineConfig default");
});
(async () => { let fail = 0; for (const [n, f] of T) { try { await f(); realLog("  ok   " + n); } catch (e) { console.log = realLog; fail++; realLog("  FAIL " + n + "\n       " + String(e && (e.stack || e.message)).split("\n").slice(0, 4).join("\n       ")); } } realLog(fail ? `\n${fail} FAILED` : `\nall ${T.length} passed`); process.exit(fail ? 1 : 0); })();
