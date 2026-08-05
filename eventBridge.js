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
"use strict";

const WebSocket = require("ws");

const BRIDGE_URL = process.env.WEBDASH_BRIDGE_URL || "ws://127.0.0.1:4790/engine";
const RECONNECT_MS = 4000;

let ws = null;
let connecting = false;
const queue = []; // small buffer so events sent just before/while reconnecting aren't silently dropped
const MAX_QUEUE = 200;

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

function emitEvent(engine, type, payload) {
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

module.exports = { emitEvent };
