"use strict";
// marketDataHealth.js — no existing WS/tick health diagnostics module was
// found in this codebase (checked marketQuality.js — that's an unrelated
// ALMA-band compression gate, not connectivity health), so this is
// genuinely new, not an extension of something pre-existing. Kept
// generic/instrument-agnostic rather than volume-delta-specific, since
// every strategy benefits from knowing whether its tick feed is alive —
// wired in engine.js's tick handler for whichever strategy is running.

// CHANGED Sep 2026 — warnAfterMs 30s / throttleMs 60s was tuned before any
// MCX mini contract ran this check. ALUMINI/ZINCMINI (minis, not the parent
// ALUMINIUM/ZINC futures) routinely go 30-40s with zero prints around
// midday — normal thin-liquidity behavior, not a dead feed — which read as
// spam (see engine.js: onTick fires on ANY tick with last_price, volume
// just rides along in the same Full-mode payload, it isn't a separate
// stream gating this). 90s/5min gives real outages plenty of margin to
// still get caught while no longer tripping on ordinary quiet patches.
function createMarketDataHealth({ tg, warnAfterMs = 90000, throttleMs = 300000 } = {}) {
    let tickCount = 0;
    let lastTickTime = null;
    let lastTradedPrice = null;
    let lastTradedVolume = null;
    let wsStatus = "disconnected";
    let subscribed = false;
    let lastWarnTime = 0;

    function onConnect() { wsStatus = "connected"; }
    function onSubscribe() { subscribed = true; }
    function onClose() { wsStatus = "disconnected"; subscribed = false; }

    function onTick(tick) {
        tickCount += 1;
        lastTickTime = Date.now();
        lastTradedPrice = tick.last_price ?? lastTradedPrice;
        lastTradedVolume = tick.volume_traded ?? lastTradedVolume;
    }

    // Call periodically (engine.js runs this off a setInterval) — throttled
    // so a prolonged outage doesn't spam Telegram every check, just once
    // per throttleMs while the condition persists.
    function checkStale() {
        if (wsStatus !== "connected" || !subscribed) return;
        if (lastTickTime === null) return; // never ticked yet since connect — not "stale", just still waiting
        const silentMs = Date.now() - lastTickTime;
        if (silentMs < warnAfterMs) return;
        if (Date.now() - lastWarnTime < throttleMs) return;

        lastWarnTime = Date.now();
        const msg = `WARNING: NO MARKET TICKS FOR ${Math.round(silentMs / 1000)}+ SECONDS`;
        console.warn(msg);
        if (tg) tg(`\u26a0 ${msg}`);
    }

    function getStatus() {
        return {
            wsStatus, subscribed, tickCount, lastTickTime, lastTradedPrice, lastTradedVolume,
            silentMs: lastTickTime !== null ? Date.now() - lastTickTime : null,
        };
    }

    return { onConnect, onSubscribe, onClose, onTick, checkStale, getStatus };
}

module.exports = { createMarketDataHealth };
