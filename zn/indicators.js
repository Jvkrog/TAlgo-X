// indicators.js
const config = require("./config");

function alma(values, len = config.ALMA_FAST, offset = config.ALMA_OFFSET, sigma = config.ALMA_SIGMA) {
    if (values.length < len) return null;
    const m = offset * (len - 1);
    const s = len / sigma;
    const slice = values.slice(-len);
    let sum = 0, norm = 0;
    for (let i = 0; i < len; i++) {
        const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
        sum += slice[i] * w;
        norm += w;
    }
    return sum / norm;
}

function almaHL(candles, len = config.BAND_LEN) {
    if (candles.length < len) return { high: null, low: null };
    const highs = candles.slice(-len).map(c => c.high);
    const lows = candles.slice(-len).map(c => c.low);
    const m = config.ALMA_OFFSET * (len - 1);
    const s = len / config.ALMA_SIGMA;
    let sumH = 0, sumL = 0, norm = 0;
    for (let i = 0; i < len; i++) {
        const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
        sumH += highs[i] * w;
        sumL += lows[i] * w;
        norm += w;
    }
    return { high: sumH / norm, low: sumL / norm };
}

function atr(candles, len = config.ATR_LEN) {
    if (candles.length < len + 1) return null;
    let trSum = 0;
    for (let i = 1; i <= len; i++) {
        const c = candles[i];
        const prev = candles[i - 1];
        const tr = Math.max(
            c.high - c.low,
            Math.abs(c.high - prev.close),
            Math.abs(c.low - prev.close)
        );
        trSum += tr;
    }
    return trSum / len;
}

function toHA(raw) {
    const ha = [];
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        const haClose = (c.open + c.high + c.low + c.close) / 4;
        const haOpen = i === 0
            ? (c.open + c.close) / 2
            : (ha[i - 1].open + ha[i - 1].close) / 2;
        ha.push({
            open: haOpen,
            high: Math.max(c.high, haOpen, haClose),
            low: Math.min(c.low, haOpen, haClose),
            close: haClose,
        });
    }
    return ha;
}

module.exports = { alma, almaHL, atr, toHA };