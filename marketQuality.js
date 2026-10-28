// marketQuality.js — market-quality gate for ALMA-band-driven entries.
//
// Problem this addresses: in a compressed/choppy market, the ALMA band
// itself is narrow, so ordinary-sized candles cross it repeatedly —
// breakout, entry, band re-entry, exit, breakout again — flip-flopping
// even though each individual entry/exit is firing exactly per its own
// rules. The rules aren't wrong; the market condition they're being
// applied to is poor.
//
// Approach (per instruction: use what we already compute, ATR and ALMA
// band width — no new indicator): a single ratio, ATR / bandWidth. A large
// ratio means a single candle's typical range is big relative to the
// entire band — i.e. the band is compressed relative to current
// volatility, so ordinary noise is enough to cross it back and forth
// repeatedly. A small ratio means the band is wide relative to candle
// size, so a genuine breakout is more likely to actually mean something.
//
// This is a GATE, not a strategy: it only ever says "the last-resolved
// signal — LONG, SHORT, or block — but does not know or decide direction
// itself, and it does not touch exits. If it can't evaluate (missing ATR
// or band data), it fails OPEN (passes) rather than silently blocking
// entries forever — this is a soft quality filter, not a safety-critical
// guard like the tickSize/lotMult checks elsewhere, so blocking trading
// entirely on a data gap would be the wrong failure mode here.
"use strict";

function evaluateMarketQuality(atrVal, bandWidth, engineConfig) {
    if (!engineConfig.QUALITY_GATE_ENABLED) {
        return { pass: true, atr: atrVal, bandWidth, ratio: null, reason: "quality gate disabled" };
    }

    if (atrVal === null || atrVal === undefined || bandWidth === null || bandWidth === undefined || bandWidth <= 0) {
        return { pass: true, atr: atrVal, bandWidth, ratio: null, reason: "insufficient data to evaluate — passing open" };
    }

    const ratio = atrVal / bandWidth;
    const pass  = ratio <= engineConfig.QUALITY_MAX_ATR_TO_BAND_RATIO;

    return {
        pass,
        atr: atrVal,
        bandWidth,
        ratio,
        reason: pass
            ? "band width adequate relative to ATR"
            : "High volatility inside compressed band",
    };
}

module.exports = { evaluateMarketQuality };
