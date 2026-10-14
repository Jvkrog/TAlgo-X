// depthHub.js — streams 5-level market depth (the order book) from Kite's WebSocket to browsers.
// One shared KiteTicker (mode "full") for the whole dashboard server; browsers subscribe per instrument over the
// existing /ws socket ({type:"DEPTH_SUB", name} / {type:"DEPTH_UNSUB"}). Ticks are pushed as {type:"DEPTH", name, data}
// (~1 per second per instrument at Kite's own rate, throttled here to MIN_GAP_MS). The ticker is created on the first
// subscription, re-created when the day's access token changes, and closed shortly after the last subscriber leaves.
"use strict";
const { KiteTicker } = require("kiteconnect");

const MIN_GAP_MS = 250;
const IDLE_CLOSE_MS = 30000;

function createDepthHub({ getCreds }) {
    let ticker = null, tickerToken = null, connected = false, idleTimer = null;
    const byToken = new Map();   // instrument token -> { key, name -> Set<ws> , last: ms }
    const bySocket = new Map();  // ws -> Set<token>

    const levels = arr => (arr || []).map(l => ({ price: Number(l.price), qty: Number(l.quantity), orders: Number(l.orders) })).filter(l => l.price > 0 || l.qty > 0);
    function payload(key, t) {
        return {
            symbol: key, ltp: t.last_price, volume: t.volume_traded ?? t.volume ?? null, oi: t.oi ?? null,
            totalBuy: t.total_buy_quantity ?? t.buy_quantity ?? null, totalSell: t.total_sell_quantity ?? t.sell_quantity ?? null,
            bids: levels(t.depth && t.depth.buy), asks: levels(t.depth && t.depth.sell), at: Date.now(), stream: true,
        };
    }

    function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch { /* socket gone */ } }

    function closeTicker() {
        if (!ticker) return;
        try { ticker.autoReconnect(false); ticker.disconnect(); } catch { /* ignore */ }
        ticker = null; connected = false; tickerToken = null;
    }

    function ensureTicker() {
        const { apiKey, accessToken } = getCreds();
        if (!apiKey || !accessToken) throw new Error("no Kite credentials for the stream");
        if (ticker && tickerToken !== accessToken) closeTicker();   // a new day's token: rebuild
        if (ticker) return;
        tickerToken = accessToken;
        ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
        ticker.autoReconnect(true, 50, 5);
        ticker.on("connect", () => {
            connected = true;
            const tokens = [...byToken.keys()];
            if (tokens.length) { ticker.subscribe(tokens); ticker.setMode(ticker.modeFull, tokens); }
        });
        ticker.on("disconnect", () => { connected = false; });
        ticker.on("error", err => console.warn("depth stream error:", err && err.message ? err.message : err));
        ticker.on("ticks", ticks => {
            const now = Date.now();
            for (const t of ticks) {
                const sub = byToken.get(t.instrument_token);
                if (!sub || !t.depth) continue;
                if (now - sub.last < MIN_GAP_MS) continue;
                sub.last = now;
                const data = payload(sub.key, t);
                for (const [name, set] of sub.names) for (const ws of set) send(ws, { type: "DEPTH", name, data });
            }
        });
        ticker.connect();
    }

    function subscribe(ws, { name, token, key }) {
        ensureTicker();
        clearTimeout(idleTimer);
        let sub = byToken.get(token);
        const isNew = !sub;
        if (!sub) { sub = { key, names: new Map(), last: 0 }; byToken.set(token, sub); }
        if (!sub.names.has(name)) sub.names.set(name, new Set());
        sub.names.get(name).add(ws);
        if (!bySocket.has(ws)) bySocket.set(ws, new Set());
        bySocket.get(ws).add(token);
        if (isNew && connected) { ticker.subscribe([token]); ticker.setMode(ticker.modeFull, [token]); }
    }

    function dropSocket(ws, onlyToken) {
        const tokens = onlyToken !== undefined ? [onlyToken] : [...(bySocket.get(ws) || [])];
        for (const token of tokens) {
            const sub = byToken.get(token);
            if (!sub) continue;
            for (const [name, set] of sub.names) { set.delete(ws); if (!set.size) sub.names.delete(name); }
            if (!sub.names.size) { byToken.delete(token); if (ticker && connected) { try { ticker.unsubscribe([token]); } catch { /* ignore */ } } }
            const mine = bySocket.get(ws); if (mine) mine.delete(token);
        }
        if (onlyToken === undefined) bySocket.delete(ws);
        if (!byToken.size) { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!byToken.size) closeTicker(); }, IDLE_CLOSE_MS); }
    }

    return { subscribe, dropSocket, isStreaming: () => connected };
}

module.exports = { createDepthHub };
