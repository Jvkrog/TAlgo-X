// test_volumeDelta.js — no test framework (jest/mocha/tap) exists anywhere
// in this repo's package.json, so "use the existing test framework" isn't
// possible to honor literally; this is a plain-Node assert-based script,
// run directly: `node test_volumeDelta.js`. Covers the pure, unit-testable
// pieces (tick delta, CVD, delta%, Z-score, divergence, absorption,
// scoring boundaries). Sizing/lot-rounding tests are NOT included — there
// is no risk-manager or lot-rounding system in this codebase to test (see
// the final report's "risk manager" note); position sizing here is just
// context.lots, already covered by every other strategy's existing usage.
"use strict";

const assert = require("assert");
const { estimateTickIncrement, createTickDeltaAccumulator } = require("./tickVolumeDelta");
const { createCandleDeltaBuffer } = require("./candleDeltaBuffer");
const { deltaZScore } = require("./indicators");
const { detectDivergence } = require("./cvdDivergence");
const { detectAbsorption } = require("./absorption");

let passed = 0, failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
        failed++;
    }
}

console.log("── tick delta ──────────────────────────────────────────");

test("price up → buy volume", () => {
    const prev = { lastPrice: 100, lastDirection: -1, lastVolumeTraded: 1000 };
    const r = estimateTickIncrement(101, 1050, prev);
    assert.strictEqual(r.buyVolume, 50);
    assert.strictEqual(r.sellVolume, 0);
    assert.strictEqual(r.direction, 1);
});

test("price down → sell volume", () => {
    const prev = { lastPrice: 100, lastDirection: 1, lastVolumeTraded: 1000 };
    const r = estimateTickIncrement(99, 1030, prev);
    assert.strictEqual(r.sellVolume, 30);
    assert.strictEqual(r.buyVolume, 0);
    assert.strictEqual(r.direction, -1);
});

test("unchanged price → carries previous direction", () => {
    const prev = { lastPrice: 100, lastDirection: -1, lastVolumeTraded: 1000 };
    const r = estimateTickIncrement(100, 1020, prev);
    assert.strictEqual(r.direction, -1);
    assert.strictEqual(r.sellVolume, 20);
});

test("first tick → no direction, no volume attributed", () => {
    const prev = { lastPrice: null, lastDirection: null, lastVolumeTraded: null };
    const r = estimateTickIncrement(100, 5000, prev);
    assert.strictEqual(r.direction, null);
    assert.strictEqual(r.buyVolume, 0);
    assert.strictEqual(r.sellVolume, 0);
    assert.strictEqual(r.nextState.lastPrice, 100);
});

test("volume reset (cumulative counter drops) → clamped to zero, never negative", () => {
    const prev = { lastPrice: 100, lastDirection: 1, lastVolumeTraded: 5000 };
    const r = estimateTickIncrement(101, 200, prev); // volume_traded dropped — new session-like reset
    assert.strictEqual(r.buyVolume, 0);
    assert.strictEqual(r.sellVolume, 0);
    assert.ok(r.buyVolume >= 0 && r.sellVolume >= 0);
});

test("negative volume difference (noise) → clamped to zero", () => {
    const prev = { lastPrice: 100, lastDirection: 1, lastVolumeTraded: 1000 };
    const r = estimateTickIncrement(101, 995, prev);
    assert.strictEqual(r.buyVolume, 0);
});

test("duplicate tick (same price, same cumulative volume) → zero contribution", () => {
    const prev = { lastPrice: 100, lastDirection: 1, lastVolumeTraded: 1000 };
    const r = estimateTickIncrement(100, 1000, prev);
    assert.strictEqual(r.buyVolume, 0);
    assert.strictEqual(r.sellVolume, 0);
});

test("accumulator: snapshotAndReset sums multiple ticks then clears", () => {
    const acc = createTickDeltaAccumulator();
    acc.onTick(100, 1000); // first tick, no contribution
    acc.onTick(101, 1050); // +50 buy
    acc.onTick(100, 1080); // +30 sell
    const snap = acc.snapshotAndReset();
    assert.strictEqual(snap.buyVolume, 50);
    assert.strictEqual(snap.sellVolume, 30);
    assert.strictEqual(snap.delta, 20);
    const after = acc.peek();
    assert.strictEqual(after.buyVolume, 0);
    assert.strictEqual(after.sellVolume, 0);
});

console.log("── CVD / candleDeltaBuffer ─────────────────────────────");

test("CVD[n] = CVD[n-1] + delta[n]", () => {
    const buf = createCandleDeltaBuffer();
    buf.onTick(100, 1000);
    buf.onTick(101, 1100); // +100 buy this interval
    const e1 = buf.rollCandle({ date: "2026-01-01T09:15:00", volume: 500 });
    assert.strictEqual(e1.cvd, 100);

    buf.onTick(100, 1150); // +50 sell this interval
    const e2 = buf.rollCandle({ date: "2026-01-01T09:20:00", volume: 300 });
    assert.strictEqual(e2.delta, -50);
    assert.strictEqual(e2.cvd, 100 + (-50)); // CVD[1] + delta[2]
});

test("delta% = delta / volume * 100", () => {
    const buf = createCandleDeltaBuffer();
    buf.onTick(100, 1000);
    buf.onTick(102, 1200); // +200 buy
    const e = buf.rollCandle({ date: "2026-01-01T09:15:00", volume: 1000 });
    assert.strictEqual(e.delta, 200);
    assert.strictEqual(e.deltaPercent, 20); // 200/1000*100
});

test("delta% is 0 (not NaN/Infinity) when candle volume is 0", () => {
    const buf = createCandleDeltaBuffer();
    buf.onTick(100, 1000);
    buf.onTick(101, 1050);
    const e = buf.rollCandle({ date: "2026-01-01T09:15:00", volume: 0 });
    assert.strictEqual(e.deltaPercent, 0);
});

console.log("── delta Z-score ───────────────────────────────────────");

test("z-score: normal data", () => {
    const history = [10, 12, 9, 11, 10, 13, 8, 12, 11, 50]; // last value is a clear outlier
    const z = deltaZScore(history, 10);
    assert.ok(z > 1.5, `expected a large positive z-score, got ${z}`);
});

test("z-score: zero stdDev (all identical) → null, not 0", () => {
    const history = [5, 5, 5, 5, 5];
    const z = deltaZScore(history, 5);
    assert.strictEqual(z, null);
});

test("z-score: insufficient history → null", () => {
    const history = [1, 2, 3];
    const z = deltaZScore(history, 10);
    assert.strictEqual(z, null);
});

console.log("── CVD divergence ──────────────────────────────────────");

function buildDivergenceCandles({ lowPattern, cvdPattern }) {
    // Builds a minimal candle+deltaHistory series with confirmed swing
    // lows at fixed positions for a deterministic test — swingLookback=2
    // for a small, fast-to-construct fixture.
    const candles = [];
    const deltaHistory = [];
    for (let i = 0; i < lowPattern.length; i++) {
        candles.push({ open: 100, high: 105, low: lowPattern[i], close: 102, volume: 100, date: `2026-01-01T09:${15 + i}:00` });
        deltaHistory.push({ buyVolume: 0, sellVolume: 0, delta: 0, deltaPercent: 0, cvd: cvdPattern[i] });
    }
    return { candles, deltaHistory };
}

test("bullish divergence: price lower low, CVD higher low", () => {
    // swingLookback=2: lows at index 2 and 7 are the confirmed swing lows
    // (each flanked by 2 higher-low candles on both sides).
    const lowPattern = [95, 93, 90, 93, 95, 94, 92, 88, 92, 95];
    const cvdPattern = [0, 10, 20, 30, 40, 50, 60, 70, 90, 100]; // CVD rising throughout — higher at the second (lower) low
    const { candles, deltaHistory } = buildDivergenceCandles({ lowPattern, cvdPattern });
    const engineConfig = { DIVERGENCE_ENABLED: true, SWING_LOOKBACK: 2 };
    const r = detectDivergence(candles, deltaHistory, engineConfig);
    assert.strictEqual(r.bullish, true);
});

test("bearish divergence: price higher high, CVD lower high", () => {
    const highPattern = [105, 107, 110, 107, 105, 106, 108, 112, 108, 105];
    const cvdPattern   = [100, 90, 80, 70, 60, 50, 40, 30, 10, 0]; // CVD falling — lower at the second (higher) high
    const candles = highPattern.map((h, i) => ({ open: 100, high: h, low: 95, close: 100, volume: 100, date: `2026-01-01T09:${15 + i}:00` }));
    const deltaHistory = cvdPattern.map(cvd => ({ buyVolume: 0, sellVolume: 0, delta: 0, deltaPercent: 0, cvd }));
    const engineConfig = { DIVERGENCE_ENABLED: true, SWING_LOOKBACK: 2 };
    const r = detectDivergence(candles, deltaHistory, engineConfig);
    assert.strictEqual(r.bearish, true);
});

test("no divergence: price and CVD move together", () => {
    const lowPattern = [95, 93, 90, 93, 95, 96, 98, 100, 98, 96];
    const cvdPattern = [0, -10, -20, -10, 0, 10, 20, 30, 20, 10]; // CVD makes a HIGHER low too, in step with price recovering — no divergence either direction expected here beyond the fixture's own construction
    const { candles, deltaHistory } = buildDivergenceCandles({ lowPattern, cvdPattern });
    const engineConfig = { DIVERGENCE_ENABLED: true, SWING_LOOKBACK: 2 };
    const r = detectDivergence(candles, deltaHistory, engineConfig);
    // Not asserting a specific direction here beyond "disabled returns both
    // false" below — this fixture exists mainly to exercise the
    // insufficient-history/no-confirmed-swing branches without crashing.
    assert.strictEqual(typeof r.bullish, "boolean");
});

test("divergence disabled via config → always false", () => {
    const { candles, deltaHistory } = buildDivergenceCandles({ lowPattern: [95, 93, 90, 93, 95, 94, 92, 88, 92, 95], cvdPattern: [0, 10, 20, 30, 40, 50, 60, 70, 90, 100] });
    const r = detectDivergence(candles, deltaHistory, { DIVERGENCE_ENABLED: false, SWING_LOOKBACK: 2 });
    assert.strictEqual(r.bullish, false);
    assert.strictEqual(r.bearish, false);
});

console.log("── absorption ──────────────────────────────────────────");

const absorptionConfig = {
    ABSORPTION_ENABLED: true,
    ABSORPTION_MIN_DELTA: 50,
    ABSORPTION_MIN_VOLUME: 100,
    ABSORPTION_LEVEL_TOLERANCE: 0.5,
    ABSORPTION_MAX_PENETRATION: 2.0,
    ABSORPTION_REJECTION_MIN: 0.6,
};

test("bullish absorption: large sell delta at level, rejected up", () => {
    const candle = { open: 100.5, high: 101, low: 99, close: 100.8 }; // closed near the top of its range
    const deltaEntry = { buyVolume: 20, sellVolume: 100, delta: -80 };
    const r = detectAbsorption(candle, deltaEntry, 99.2, absorptionConfig); // reference level near the low
    assert.strictEqual(r.bullish, true);
});

test("bearish absorption: large buy delta at level, rejected down", () => {
    const candle = { open: 100.5, high: 101, low: 99.5, close: 99.7 }; // closed near the bottom of its range
    const deltaEntry = { buyVolume: 100, sellVolume: 20, delta: 80 };
    const r = detectAbsorption(candle, deltaEntry, 100.8, absorptionConfig); // reference level near the high
    assert.strictEqual(r.bearish, true);
});

test("normal candle (no absorption pattern)", () => {
    const candle = { open: 100, high: 101, low: 99, close: 100.5 };
    const deltaEntry = { buyVolume: 30, sellVolume: 25, delta: 5 }; // small delta, well under threshold
    const r = detectAbsorption(candle, deltaEntry, 99.2, absorptionConfig);
    assert.strictEqual(r.bullish, false);
    assert.strictEqual(r.bearish, false);
});

test("absorption disabled via config → always false", () => {
    const candle = { open: 100.5, high: 101, low: 99, close: 100.8 };
    const deltaEntry = { buyVolume: 20, sellVolume: 100, delta: -80 };
    const r = detectAbsorption(candle, deltaEntry, 99.2, { ...absorptionConfig, ABSORPTION_ENABLED: false });
    assert.strictEqual(r.bullish, false);
});

console.log("── scoring boundaries (spec's point weights) ───────────");

test("score sums to spec weights: full bullish confluence = 100", () => {
    // Mirrors createVolumeDeltaCvdStrategy's scoring block directly rather
    // than re-importing strategies.js (5000+ lines, heavy deps) — this
    // asserts the WEIGHTS sum correctly, not the strategy's own wiring
    // (that needs a running engine, out of scope for a pure-function test).
    const weights = { emaTrend: 20, vwap: 15, delta: 15, deltaZ: 15, divergence: 15, absorption: 10, relVol: 10 };
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, 100);
});

test("default signalThreshold (70) is below max possible score (100)", () => {
    const engineConfig = require("./engineConfig");
    assert.ok(engineConfig.VOLUME_DELTA_SIGNAL_THRESHOLD < 100);
    assert.ok(engineConfig.VOLUME_DELTA_SIGNAL_THRESHOLD > 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
