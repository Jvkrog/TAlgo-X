// indicators.js
const config = require("./config");

function alma(values, len = config.ALMA_FAST, offset = 0.85, sigma = 6) {
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

function almaHL(candles, len = config.BAND_LEN, offset = 0.85, sigma = 6) {
    if (candles.length < len) return { high: null, low: null };
    const highs = candles.slice(-len).map(c => c.high);
    const lows = candles.slice(-len).map(c => c.low);
    const m = offset * (len - 1), s = len / sigma;
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
    const slice = candles.slice(-(len + 1));
    let trSum = 0;
    for (let i = 1; i <= len; i++) {
        const high = slice[i].high;
        const low = slice[i].low;
        const prev = slice[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
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