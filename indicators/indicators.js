"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TALGO X — INDICATORS
// Single source of truth for all technical computations.
// All functions are pure (no side effects, no global state).
// ─────────────────────────────────────────────────────────────────────────────

function alma(values, length = 20, offset = 0.85, sigma = 6) {
    const m = offset * (length - 1);
    const s = length / sigma;
    const result = [];
    for (let i = length - 1; i < values.length; i++) {
        let sum = 0, norm = 0;
        for (let j = 0; j < length; j++) {
            const w = Math.exp(-((j - m) ** 2) / (2 * s * s));
            sum += values[i - length + 1 + j] * w;
            norm += w;
        }
        result.push(sum / norm);
    }
    return result;
}

function ema(values, length) {
    const k = 2 / (length + 1);
    const result = [];
    let prev = values[0];
    result.push(prev);
    for (let i = 1; i < values.length; i++) {
        const cur = values[i] * k + prev * (1 - k);
        result.push(cur);
        prev = cur;
    }
    return result;
}

function calcATR(data, length = 14) {
    const trs = [];
    for (let i = 1; i < data.length; i++) {
        const { high, low } = data[i];
        const pc = data[i - 1].close;
        trs.push(Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc)));
    }
    return trs.slice(-length).reduce((a, b) => a + b, 0) / length;
}

function smoothATR(rawATR, atrHistory, smoothLength = 10) {
    if (atrHistory.length < smoothLength) return rawATR;
    const alpha = 2 / (smoothLength + 1);
    let val = atrHistory[0];
    for (let i = 1; i < atrHistory.length; i++) {
        val = atrHistory[i] * alpha + val * (1 - alpha);
    }
    return val;
}

function heikinAshi(data) {
    const ha = [];
    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        if (i === 0) {
            ha.push({
                open:  (c.open + c.close) / 2,
                close: (c.open + c.high + c.low + c.close) / 4,
                high:  c.high,
                low:   c.low
            });
        } else {
            const haOpen  = (ha[i - 1].open + ha[i - 1].close) / 2;
            const haClose = (c.open + c.high + c.low + c.close) / 4;
            ha.push({
                open:  haOpen,
                close: haClose,
                high:  Math.max(c.high, haOpen, haClose),
                low:   Math.min(c.low,  haOpen, haClose)
            });
        }
    }
    return ha;
}

module.exports = { alma, ema, calcATR, smoothATR, heikinAshi };
