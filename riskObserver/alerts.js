// riskObserver/alerts.js — Phase 6: alert gate. Informational alerts only (Telegram text); nothing here can act on a position.
// Prevents alert storms with (1) a cooldown for identical messages, and (2) a global rate limit per window, after which further
// alerts are suppressed and ONE summary is sent when the window ends. Sending failures (sync throw / async reject) are contained
// and counted; an alert problem can never reach the caller, the evaluation loop or trading. The clock is injected.
"use strict";

const normalise = s => String(s).replace(/\d+(\.\d+)?/g, "#");   // "3 candles" and "4 candles" are the same alert for dedup

function createAlertGate({ send, now = () => Date.now(), cooldownMs = 120000, windowMs = 600000, maxPerWindow = 12, onError = null } = {}) {
    const lastSent = new Map(); let windowStart = null, sentInWindow = 0, suppressedInWindow = 0;
    const stats = { sent: 0, deduped: 0, rateLimited: 0, failures: 0, summaries: 0 };
    const fail = err => { stats.failures++; if (onError) { try { onError(err); } catch { /* contained */ } } };
    const deliver = text => { try { const r = send(text); if (r && typeof r.catch === "function") r.catch(fail); return true; } catch (err) { fail(err); return false; } };
    const rollWindow = t => {
        if (windowStart === null) { windowStart = t; return; }
        if (t - windowStart >= windowMs) {
            if (suppressedInWindow > 0) { stats.summaries++; deliver(`[RISK OBSERVER] ${suppressedInWindow} further alert(s) were suppressed in the last ${Math.round(windowMs / 60000)} min to prevent an alert storm. Details are in the Risk Observer timeline. Trading is unaffected.`); }
            windowStart = t; sentInWindow = 0; suppressedInWindow = 0;
        }
    };
    function alert(text, { key = null, critical = false } = {}) {
        try {
            if (typeof send !== "function" || typeof text !== "string" || !text) return false;
            const t = now(); rollWindow(t); const k = key || normalise(text), prev = lastSent.get(k);
            if (prev !== undefined && t - prev < cooldownMs) { stats.deduped++; return false; }
            if (!critical && sentInWindow >= maxPerWindow) { stats.rateLimited++; suppressedInWindow++; return false; }
            lastSent.set(k, t); sentInWindow++; stats.sent++;
            if (lastSent.size > 500) for (const [kk, vv] of lastSent) if (t - vv > cooldownMs) lastSent.delete(kk);   // bounded memory
            return deliver(text);
        } catch (err) { fail(err); return false; }
    }
    alert.stats = () => ({ ...stats, suppressedInWindow, tracked: lastSent.size });
    return alert;
}
module.exports = { createAlertGate, normalise };
