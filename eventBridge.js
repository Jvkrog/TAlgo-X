// eventBridge.js — outbound WebSocket client used by strategies.js /
// positions.js to stream live events (ticks, ENTRY, EXIT, mode transitions)
// to the webdash bridge server, purely for the web dashboard.
//
// Deliberately isolated and fail-soft: if the bridge server isn't running
// (or the dashboard was never started), every call here is a silent no-op.
// This must NEVER be able to throw, block, or slow down the trading loop —
// it sits entirely alongside the existing console.log/tg() calls, never
// replaces them, and has zero effect on order placement, SL, or entries/
// exits if it fails or is simply absent.
//
// CHANGED: added setEmitSuppressed(). webdash/server.js runs backtests
// in-process (runBacktest() calls the SAME strategy factories live trading
// uses), and this very module is what those factories call into on every
// replayed candle. Since server.js is also the process hosting the /engine
// WS endpoint those events target, an in-process backtest was connecting
// to itself and flooding the real Live Log panel with thousands of replayed
// TICK/ENTRY/EXIT events indistinguishable from actual live engines. A
// depth counter (not a plain boolean) so concurrent/nested backtest
// requests in the same process can't have one finishing early re-enable
// emission while another is still mid-replay.
"use strict";

const WebSocket = require("ws");

const BRIDGE_URL = process.env.WEBDASH_BRIDGE_URL || "ws://127.0.0.1:4790/engine";
const RECONNECT_MS = 4000;

let ws = null;
let connecting = false;
const queue = []; // small buffer so events sent just before/while reconnecting aren't silently dropped
const MAX_QUEUE = 200;
let suppressDepth = 0;

function connect() {
    if (connecting || (ws && ws.readyState === WebSocket.OPEN)) return;
    connecting = true;
    try {
        ws = new WebSocket(BRIDGE_URL);
        ws.on("open", () => {
            connecting = false;
            while (queue.length) ws.send(queue.shift());
        });
        ws.on("close", () => { connecting = false; ws = null; setTimeout(connect, RECONNECT_MS); });
        ws.on("error", () => { /* swallow — reconnect handled by 'close' */ });
    } catch {
        connecting = false;
        setTimeout(connect, RECONNECT_MS);
    }
}
connect();

// setEmitSuppressed(true) / (false) — nestable. While the depth is above
// zero, emitEvent() is a pure no-op (doesn't even queue). Callers MUST pair
// every true with a false (use try/finally) or emission stays off for the
// rest of the process's life.
function setEmitSuppressed(suppressed) {
    suppressDepth = Math.max(0, suppressDepth + (suppressed ? 1 : -1));
}

function emitEvent(engine, type, payload) {
    if (suppressDepth > 0) return;
    try {
        const msg = JSON.stringify({ engine, type, ts: Date.now(), ...payload });
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        } else {
            if (queue.length >= MAX_QUEUE) queue.shift(); // drop oldest, never grow unbounded
            queue.push(msg);
            connect();
        }
    } catch {
        // never let a dashboard-streaming failure touch the trading loop
    }
}

module.exports = { emitEvent, setEmitSuppressed };
