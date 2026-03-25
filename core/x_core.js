"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TALGO X — X-CORE (Elite Engine)
//
// Source: vk.js (ZINC 1H engine)
// Runs:   Every 1H candle close
//
// Responsibilities:
//   - Market Personality (TRENDING/RANGING/VOLATILE/DEAD)
//   - Volatility Regime (LOW/NORMAL/HIGH/EXTREME)
//   - Trend Regime (UPTREND/DOWNTREND/SIDEWAYS)
//   - Market Session (OPENING/MIDDAY/US_SESSION)
//   - 4H macro bias (derived from 1H array, no extra API call)
//   - Scoring router (hard blocks + soft scoring)
//   - Strategy performance memory
//   - Liquidity zone memory
//
// Does NOT: place orders, manage position, track PnL, evaluate risk state.
// Output: elite object written to G.elite each candle.
// ─────────────────────────────────────────────────────────────────────────────

const { alma, ema, calcATR, smoothATR, heikinAshi } = require("../indicators/indicators");
const { G } = require("./state");

// ── Config ───────────────────────────────────────────────────────────────────
const ALMA_LENGTH  = 20;
const EMA_LENGTH   = 20;
const ATR_REGIME_WINDOW  = 20;
const ATR_SMOOTH_LENGTH  = 10;
const STRATEGY_MEMORY_SIZE = 20;
const WIN_RATE_THRESHOLD   = 0.35;
const PRESSURE_THRESHOLD   = 6;

// ── ATR history (rolling, for regime detection) ──────────────────────────────
let atrHistory = [];

function updateAtrHistory(v) {
    atrHistory.push(v);
    if (atrHistory.length > ATR_REGIME_WINDOW) atrHistory.shift();
}

// ── Strategy performance memory ──────────────────────────────────────────────
const strategyMemory = {
    TREND_LONG:     [],
    TREND_SHORT:    [],
    MEAN_REVERSION: [],
    MOMENTUM_SHORT: []
};

function recordStrategyOutcome(name, won) {
    if (!strategyMemory[name]) return;
    strategyMemory[name].push(won ? 1 : 0);
    if (strategyMemory[name].length > STRATEGY_MEMORY_SIZE)
        strategyMemory[name].shift();
}

function strategyWinRate(name) {
    const buf = strategyMemory[name];
    if (!buf || buf.length < 5) return 0.5;
    return buf.reduce((s, v) => s + v, 0) / buf.length;
}

function strategyWeight(name) {
    const wr = strategyWinRate(name);
    if (wr > 0.65) return 1.3;
    if (wr > 0.55) return 1.1;
    if (wr > 0.45) return 1.0;
    if (wr > 0.35) return 0.8;
    return 0.6;
}

// ── Liquidity zones ──────────────────────────────────────────────────────────
const liquidityZones = { highs: [], lows: [] };
const MAX_ZONES = 6;
const LIQUIDITY_ZONE_DISTANCE = 0.5;

function updateLiquidityZones(candles, atrVal) {
    const lookback = 3;
    const last = candles.length - 2;
    if (last < lookback) return;
    const high = candles[last].high;
    const low  = candles[last].low;
    let swingHigh = true, swingLow = true;
    for (let i = 1; i <= lookback; i++) {
        if (candles[last - i].high >= high) swingHigh = false;
        if (candles[last - i].low  <= low)  swingLow  = false;
        if (candles[last + i] && candles[last + i].high >= high) swingHigh = false;
        if (candles[last + i] && candles[last + i].low  <= low)  swingLow  = false;
    }
    const dd = atrVal * 0.3;
    if (swingHigh && !liquidityZones.highs.some(h => Math.abs(h - high) < dd)) {
        liquidityZones.highs.push(high);
        if (liquidityZones.highs.length > MAX_ZONES) liquidityZones.highs.shift();
    }
    if (swingLow && !liquidityZones.lows.some(l => Math.abs(l - low) < dd)) {
        liquidityZones.lows.push(low);
        if (liquidityZones.lows.length > MAX_ZONES) liquidityZones.lows.shift();
    }
}

function liquidityWallAhead(price, atrVal) {
    const threshold = atrVal * LIQUIDITY_ZONE_DISTANCE;
    for (const h of liquidityZones.highs) {
        if (h > price && h - price < threshold) return true;
    }
    for (const l of liquidityZones.lows) {
        if (l < price && price - l < threshold) return true;
    }
    return false;
}

// ── Detectors ────────────────────────────────────────────────────────────────

function detectVolatilityRegime(smoothed, history) {
    if (history.length < 5) return "NORMAL_VOL";
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    if (smoothed < mean * 0.7)  return "LOW_VOL";
    if (smoothed < mean * 1.3)  return "NORMAL_VOL";
    if (smoothed < mean * 1.8)  return "HIGH_VOL";
    return "EXTREME_VOL";
}

function detectTrendRegime(price, almaHigh, almaLow, emaSlope) {
    if (price > almaHigh && emaSlope > 0) return "UPTREND";
    if (price < almaLow  && emaSlope < 0) return "DOWNTREND";
    return "SIDEWAYS";
}

function detectMarketPersonality(candles, atrVal) {
    const window = candles.slice(-20);
    const atrAvg = window.reduce((sum, c) => {
        return sum + Math.max(c.high - c.low, Math.abs(c.high - c.close), Math.abs(c.low - c.close));
    }, 0) / window.length;
    if (atrVal > atrAvg * 1.4) return "VOLATILE_DAY";
    if (atrVal < atrAvg * 0.6) return "DEAD_DAY";
    const threshold = atrVal * 0.4;
    let bullCount = 0, bearCount = 0;
    for (const c of window) {
        const body = c.close - c.open;
        if (body >  threshold) bullCount++;
        if (body < -threshold) bearCount++;
    }
    const dominant = Math.max(bullCount, bearCount);
    if (dominant / window.length > 0.6) return "TRENDING_DAY";
    return "RANGING_DAY";
}

function getMarketSession() {
    const now  = new Date();
    const time = now.getHours() + now.getMinutes() / 60;
    if (time >= 9    && time < 11)   return "OPENING";
    if (time >= 11   && time < 18.5) return "MIDDAY";
    if (time >= 18.5 && time < 23)   return "US_SESSION";
    return "OFF";
}

function detectMarketSpeed(candle, atrVal) {
    if (atrVal === 0) return "NORMAL";
    const speed = (candle.high - candle.low) / atrVal;
    if (speed < 0.7) return "SLOW";
    if (speed > 1.5) return "FAST";
    return "NORMAL";
}

function detectCompression(candles, atrVal) {
    if (atrVal === 0) return false;
    const last5 = candles.slice(-5);
    const avgRange = last5.reduce((s, c) => s + (c.high - c.low), 0) / last5.length;
    return avgRange < atrVal * 0.5;
}

function detectLiquidityVacuum(candle, atrVal) {
    const body  = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    if (range === 0) return false;
    return (body / range) > 0.8 && range > atrVal * 1.5;
}

function detectLiquiditySweep(candle, prevHigh, prevLow) {
    if (candle.high > prevHigh && candle.close < prevHigh) return "BEAR_SWEEP";
    if (candle.low  < prevLow  && candle.close > prevLow)  return "BULL_SWEEP";
    return "NONE";
}

function detectVolatilityExpansion(candle, atrVal) {
    return Math.abs(candle.close - candle.open) > atrVal * 1.8;
}

function isCleanStructure(almaHigh, almaLow, atrVal) {
    return (almaHigh - almaLow) > atrVal * 1.2;
}

function get4hTrend(candles) {
    if (candles.length < 50) return "SIDEWAYS";
    const c4h = [];
    for (let i = 0; i + 3 < candles.length; i += 4) {
        const chunk = candles.slice(i, i + 4);
        c4h.push({
            open:  chunk[0].open,
            high:  Math.max(...chunk.map(c => c.high)),
            low:   Math.min(...chunk.map(c => c.low)),
            close: chunk[3].close
        });
    }
    if (c4h.length < ALMA_LENGTH + 2) return "SIDEWAYS";
    const ha       = heikinAshi(c4h);
    const emaVals  = ema(ha.map(x => x.close), EMA_LENGTH);
    const slope    = emaVals.at(-1) - emaVals.at(-2);
    const almaH    = alma(c4h.map(x => x.high), ALMA_LENGTH).at(-1);
    const almaL    = alma(c4h.map(x => x.low),  ALMA_LENGTH).at(-1);
    return detectTrendRegime(c4h.at(-1).close, almaH, almaL, slope);
}

// ── Strategy Router ───────────────────────────────────────────────────────────
//
// HARD blocks: EXTREME_VOL, DEAD_DAY, 4H counter-trend, OFF session.
// Everything else is a scored signal — no single soft filter can veto alone.
//
// FIX (from review): score thresholds lowered.
//   score < 1.0 → block
//   score < 2.0 → LIMIT (1 lot, still trades)
//   score >= 2.0 → ALLOW
//
function strategyRouter(ctx) {
    const {
        trendRegime, volatilityRegime, htfBias, htfAligned,
        liquidityVacuum, liquidityWall, volumeSpike, liquiditySweep,
        volatilityExpansion, marketSession, marketPersonality,
        aggressiveBuy, aggressiveSell, marketSpeed, compression, trend4h
    } = ctx;

    // ── HARD BLOCKS ────────────────────────────────────────────────────────
    if (volatilityRegime === "EXTREME_VOL")
        return { strategy: "NO_TRADE", reason: "EXTREME_VOL", score: 0 };
    if (marketPersonality === "DEAD_DAY")
        return { strategy: "NO_TRADE", reason: "DEAD_DAY", score: 0 };
    if (marketSession === "OFF")
        return { strategy: "NO_TRADE", reason: "MARKET_CLOSED", score: 0 };

    // 4H counter-trend hard block
    if (trend4h === "UPTREND"   && trendRegime === "DOWNTREND")
        return { strategy: "NO_TRADE", reason: "COUNTER_4H_UP",   score: 0 };
    if (trend4h === "DOWNTREND" && trendRegime === "UPTREND")
        return { strategy: "NO_TRADE", reason: "COUNTER_4H_DOWN", score: 0 };

    // ── MOMENTUM OVERRIDE ─────────────────────────────────────────────────
    if (trendRegime === "DOWNTREND" && htfAligned && volatilityRegime !== "EXTREME_VOL") {
        if (volatilityExpansion && marketSession === "US_SESSION")
            return { strategy: "MOMENTUM_SHORT", reason: "PANIC+DOWNTREND+HTF+US", score: 5.0 };
        if (aggressiveSell && marketSession === "US_SESSION")
            return { strategy: "MOMENTUM_SHORT", reason: "SELLFLOW+DOWNTREND+HTF+US", score: 4.5 };
    }

    // ── TREND SCORING ─────────────────────────────────────────────────────
    if (trendRegime !== "SIDEWAYS") {
        let score = 0;
        const tags = [];

        // HTF bias
        if (htfBias ===  1 && trendRegime === "UPTREND")   { score += 1.2; tags.push("+HTF_UP"); }
        if (htfBias === -1 && trendRegime === "DOWNTREND") { score += 1.2; tags.push("+HTF_DOWN"); }
        if (htfBias ===  0)                                { score += 0.3; tags.push("+HTF_NEUT"); }
        if (htfBias ===  1 && trendRegime === "DOWNTREND") { score -= 0.5; tags.push("-HTF_COUNTER"); }
        if (htfBias === -1 && trendRegime === "UPTREND")   { score -= 0.5; tags.push("-HTF_COUNTER"); }

        // Soft boosters
        if (volumeSpike)                                         { score += 0.8; tags.push("+VOL"); }
        if (compression)                                         { score += 0.8; tags.push("+COMP"); }
        if (marketSession === "US_SESSION")                      { score += 0.8; tags.push("+US"); }
        if (marketPersonality === "TRENDING_DAY")                { score += 0.7; tags.push("+TREND_DAY"); }
        if (marketSpeed === "FAST")                              { score += 0.5; tags.push("+FAST"); }
        if (aggressiveBuy  && trendRegime === "UPTREND")         { score += 0.7; tags.push("+BUYFLOW"); }
        if (aggressiveSell && trendRegime === "DOWNTREND")       { score += 0.7; tags.push("+SELLFLOW"); }
        if (volatilityRegime === "NORMAL_VOL")                   { score += 0.5; tags.push("+NORM_VOL"); }
        if (marketSession === "OPENING")                         { score += 0.3; tags.push("+OPEN"); }

        // Soft penalties
        if (liquidityWall)                                       { score -= 0.7; tags.push("-WALL"); }
        if (liquidityVacuum)                                     { score -= 0.5; tags.push("-VAC"); }
        if (marketSpeed === "SLOW")                              { score -= 0.5; tags.push("-SLOW"); }
        if (marketPersonality === "VOLATILE_DAY")                { score -= 0.5; tags.push("-VOLATILE"); }
        if (liquiditySweep === "BEAR_SWEEP" && trendRegime === "UPTREND")   { score -= 1.2; tags.push("-BEAR_SWEEP"); }
        if (liquiditySweep === "BULL_SWEEP" && trendRegime === "DOWNTREND") { score -= 1.2; tags.push("-BULL_SWEEP"); }
        if (aggressiveBuy  && trendRegime === "DOWNTREND")       { score -= 0.8; tags.push("-COUNTER_BUY"); }
        if (aggressiveSell && trendRegime === "UPTREND")         { score -= 0.8; tags.push("-COUNTER_SELL"); }

        const tStrat = trendRegime === "UPTREND" ? "TREND_LONG" : "TREND_SHORT";
        const wt     = strategyWeight(tStrat);
        const weighted = +(score * wt).toFixed(2);
        tags.push(`×${wt}`);

        // FIX: tiered thresholds — 1.0 hard block, 1.0–2.0 limit, 2.0+ allow
        if (weighted < 1.0)
            return { strategy: "NO_TRADE", reason: `TREND_SCORE_${weighted}<1.0 [${tags.join(",")}]`, score: weighted };
        if (weighted < 2.0)
            return { strategy: tStrat, mode: "LIMIT", reason: `TREND_LOW_CONF_${weighted} [${tags.join(",")}]`, score: weighted };

        return { strategy: tStrat, mode: "ALLOW", reason: `TREND_${weighted} [${tags.join(",")}]`, score: weighted };
    }

    // ── MEAN REVERSION SCORING ────────────────────────────────────────────
    if (trendRegime === "SIDEWAYS") {
        let score = 0;
        const tags = [];

        if (volatilityRegime === "LOW_VOL")          { score += 1.0; tags.push("+LOWVOL"); }
        if (volatilityRegime === "NORMAL_VOL")        { score += 0.7; tags.push("+NORM_VOL"); }
        if (marketPersonality === "RANGING_DAY")      { score += 1.0; tags.push("+RANGE"); }
        if (marketSpeed === "SLOW")                   { score += 0.7; tags.push("+SLOW"); }
        if (compression)                              { score += 0.6; tags.push("+COMP"); }
        if (!liquidityWall)                           { score += 0.4; tags.push("+NO_WALL"); }
        if (marketSession === "MIDDAY")               { score += 0.5; tags.push("+MIDDAY"); }

        if (liquidityWall)                            { score -= 0.5; tags.push("-WALL"); }
        if (liquiditySweep !== "NONE")                { score -= 0.5; tags.push("-SWEEP"); }
        if (marketSpeed === "FAST")                   { score -= 0.7; tags.push("-FAST"); }
        if (volatilityRegime === "HIGH_VOL")          { score -= 0.5; tags.push("-HIGH_VOL"); }
        if (marketPersonality === "VOLATILE_DAY")     { score -= 0.8; tags.push("-VOLATILE"); }
        if (marketPersonality === "TRENDING_DAY")     { score -= 0.8; tags.push("-TREND_DAY"); }

        const mrWR = strategyWinRate("MEAN_REVERSION");
        if (mrWR < WIN_RATE_THRESHOLD) { score -= 0.5; tags.push(`-WR${(mrWR * 100).toFixed(0)}%`); }

        const wt       = strategyWeight("MEAN_REVERSION");
        const weighted = +(score * wt).toFixed(2);
        tags.push(`×${wt}`);

        if (weighted < 1.0)
            return { strategy: "NO_TRADE", reason: `MR_SCORE_${weighted}<1.0 [${tags.join(",")}]`, score: weighted };
        if (weighted < 1.5)
            return { strategy: "MEAN_REVERSION", mode: "LIMIT", reason: `MR_LOW_CONF_${weighted} [${tags.join(",")}]`, score: weighted };

        return { strategy: "MEAN_REVERSION", mode: "ALLOW", reason: `MR_${weighted} [${tags.join(",")}]`, score: weighted };
    }

    return { strategy: "NO_TRADE", reason: "FALLBACK", score: 0 };
}

// ── Main run function — called by data layer each 1H candle ──────────────────

function runXCore(candles, aggressiveBuy, aggressiveSell) {
    if (candles.length < 40) return null;

    const ha       = heikinAshi(candles);
    const emaVals  = ema(ha.map(x => x.close), EMA_LENGTH);
    const emaSlope = emaVals.at(-1) - emaVals.at(-2);

    const almaHigh = alma(candles.map(x => x.high), ALMA_LENGTH).at(-1);
    const almaLow  = alma(candles.map(x => x.low),  ALMA_LENGTH).at(-1);

    const rawATR = calcATR(candles);
    updateAtrHistory(rawATR);
    const sATR   = smoothATR(rawATR, atrHistory, ATR_SMOOTH_LENGTH);

    const price = candles.at(-1).close;

    const volatilityRegime   = detectVolatilityRegime(sATR, atrHistory);
    const trendRegime        = detectTrendRegime(price, almaHigh, almaLow, emaSlope);
    const marketPersonality  = detectMarketPersonality(candles, rawATR);
    const marketSession      = getMarketSession();
    const marketSpeed        = detectMarketSpeed(candles.at(-1), rawATR);
    const compression        = detectCompression(candles, rawATR);
    const trend4h            = get4hTrend(candles);
    const htfBias            = trend4h === "UPTREND" ? 1 : trend4h === "DOWNTREND" ? -1 : 0;
    const htfAligned         = (trend4h === trendRegime) && trendRegime !== "SIDEWAYS";
    const liquidityVacuum    = detectLiquidityVacuum(candles.at(-1), rawATR);
    const volatilityExpansion = detectVolatilityExpansion(candles.at(-1), rawATR);
    const liquiditySweep     = detectLiquiditySweep(candles.at(-1), candles.at(-2).high, candles.at(-2).low);
    const volumeSpike        = candles.at(-1).volume > candles.at(-2).volume * 1.2
                            && candles.at(-1).volume > rawATR * 100;

    updateLiquidityZones(candles, rawATR);
    const liquidityWall = liquidityWallAhead(price, rawATR);

    const cleanStructure = isCleanStructure(almaHigh, almaLow, rawATR);

    const routerCtx = {
        trendRegime, volatilityRegime, htfBias, htfAligned,
        liquidityVacuum, liquidityWall, volumeSpike, liquiditySweep,
        volatilityExpansion, marketSession, marketPersonality,
        aggressiveBuy, aggressiveSell, marketSpeed, compression, trend4h
    };

    const routerOutput = strategyRouter(routerCtx);

    const elite = {
        trend: trendRegime,
        trend4h,
        personality: marketPersonality,
        volatility: volatilityRegime,
        session: marketSession,
        speed: marketSpeed,
        compression,
        liquidityWall,
        liquidityVacuum,
        liquiditySweep,
        volumeSpike,
        volatilityExpansion,
        htfBias,
        htfAligned,
        cleanStructure,
        routerOutput,
        atr: rawATR,
        smoothedAtr: sATR,
        almaHigh,
        almaLow,
        emaSlope,
        price,
        ts: Date.now()
    };

    G.elite = elite;
    return elite;
}

module.exports = { runXCore, recordStrategyOutcome, strategyWinRate };
