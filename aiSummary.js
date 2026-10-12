// aiSummary.js — TAlgo-Ai pattern summary across many trades. OBSERVER ONLY.
// All statistics are computed here from the instrument journals (read-only); Gemini only narrates the
// aggregates (never raw credentials), its reply is schema-validated and cached by a hash of the aggregates.
"use strict";

const crypto = require("crypto");
const ai = require("./aiReview");

const IST_MS = 5.5 * 3600000;
const r0 = v => Math.round(v);
const bucket = (m, k, pnl) => { const b = m[k] || (m[k] = { trades: 0, wins: 0, pnl: 0 }); b.trades++; if (pnl > 0) b.wins++; b.pnl += pnl; };
const finish = m => Object.entries(m).map(([k, b]) => ({ key: k, trades: b.trades, winRate: b.trades ? Math.round(b.wins / b.trades * 100) : 0, pnl: r0(b.pnl) }));

async function riskEvents(db, sinceDay) {
    return ai.all(db, `SELECT engine, day, kind, detail FROM risk_events WHERE day >= ? ORDER BY id`, [sinceDay]).catch(() => []);
}

async function buildSummary(days = 7) {
    days = Math.max(1, Math.min(90, Number(days) || 7));
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
    const sinceDay = new Date(Date.now() - days * 86400000 + IST_MS).toISOString().slice(0, 10);
    const trades = [], limiter = [];
    for (const file of ai.journalFiles()) {
        const db = await ai.openRo(file);
        if (!db) continue;
        try {
            const rows = await ai.all(db, `SELECT * FROM trades WHERE status = 'CLOSED' AND exit_time >= ? ORDER BY id`, [sinceIso]);
            for (const r of rows) trades.push({ journal: file, ...r });
            for (const e of await riskEvents(db, sinceDay)) {
                let d = null; try { d = e.detail ? JSON.parse(e.detail) : null; } catch { /* ignore */ }
                limiter.push({ journal: file, engine: e.engine, day: e.day, kind: e.kind, detail: d });
            }
        } catch { /* not a trades journal */ }
        db.close();
    }
    const day = t => new Date(new Date(t.exit_time).getTime() + IST_MS).toISOString().slice(0, 10);
    const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
    const sum = a => a.reduce((x, t) => x + t.pnl, 0);
    const byInstrument = {}, byExit = {}, bySide = {}, byHour = {}, byWeekday = {};
    let givenBackWinners = [], wentRedAfterGreen = 0, withExc = 0;
    const perDay = {};
    for (const t of trades) {
        bucket(byInstrument, `${t.instrument}`, t.pnl); bucket(byExit, t.exit_reason || "?", t.pnl); bucket(bySide, t.side, t.pnl);
        const ist = new Date(new Date(t.entry_time).getTime() + IST_MS);
        bucket(byHour, String(ist.getUTCHours()).padStart(2, "0") + ":00", t.pnl);
        bucket(byWeekday, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][ist.getUTCDay()], t.pnl);
        if (Number.isFinite(t.peak_pnl) && Number.isFinite(t.trough_pnl)) {
            withExc++;
            if (t.peak_pnl > 0 && t.pnl < 0) wentRedAfterGreen++;
            if (t.peak_pnl > 0 && t.pnl > 0) givenBackWinners.push(t.peak_pnl - t.pnl);
        }
        const k = `${t.instrument}|${day(t)}`;
        (perDay[k] = perDay[k] || []).push(t);
    }
    // worst losing streak inside any one instrument-day
    let worstStreak = { length: 0, instrument: null, day: null };
    const dayRows = Object.entries(perDay).map(([k, ts]) => {
        const [instrument, d] = k.split("|"); let run = 0, best = 0;
        for (const t of ts) { run = t.pnl < 0 ? run + 1 : 0; best = Math.max(best, run); }
        if (best > worstStreak.length) worstStreak = { length: best, instrument, day: d };
        return { instrument, day: d, trades: ts.length, pnl: r0(sum(ts)), losingTrades: ts.filter(t => t.pnl < 0).length };
    });
    // reviews + tags for the same trades
    const reviews = await ai.all(ai.cache(), `SELECT journal, trade_id, review FROM ai_reviews WHERE status = 'OK'`).catch(() => []);
    const rv = new Map(reviews.map(r => [`${r.journal}#${r.trade_id}`, r.review]));
    const grades = { A: 0, B: 0, C: 0 }, tags = {};
    for (const t of trades) {
        const raw = rv.get(`${t.journal}#${t.id}`); if (!raw) continue;
        try { const r = JSON.parse(raw); if (grades[r.grade] !== undefined) grades[r.grade]++; for (const g of r.tags || []) tags[g] = (tags[g] || 0) + 1; } catch { /* skip */ }
    }
    const limiterDays = limiter.map(e => {
        const dr = dayRows.find(d => d.instrument === (trades.find(t => t.journal === e.journal) || {}).instrument && d.day === e.day);
        return { instrument: e.engine, day: e.day, kind: e.kind, detail: e.detail, dayPnl: dr ? dr.pnl : null, dayTrades: dr ? dr.trades : null };
    });
    const gp = sum(wins), gl = -sum(losses);
    return {
        days, trades: trades.length, wins: wins.length, losses: losses.length,
        winRate: trades.length ? Math.round(wins.length / trades.length * 100) : 0,
        netPnl: r0(sum(trades)), avgWin: wins.length ? r0(gp / wins.length) : null, avgLoss: losses.length ? r0(-gl / losses.length) : null,
        profitFactor: gl > 0 ? Math.round(gp / gl * 100) / 100 : null,
        byInstrument: finish(byInstrument).sort((a, b) => a.pnl - b.pnl), byExitReason: finish(byExit).sort((a, b) => a.pnl - b.pnl),
        bySide: finish(bySide), byEntryHourIst: finish(byHour).sort((a, b) => a.key.localeCompare(b.key)), byWeekday: finish(byWeekday),
        worstLosingStreakInADay: worstStreak,
        worstDays: dayRows.sort((a, b) => a.pnl - b.pnl).slice(0, 5),
        excursion: { tradesWithData: withExc, wentRedAfterBeingGreen: wentRedAfterGreen,
            avgProfitGivenBackOnWinners: givenBackWinners.length ? r0(givenBackWinners.reduce((a, b) => a + b, 0) / givenBackWinners.length) : null },
        aiReviewed: { grades, tags },
        limiterDays,
    };
}

// ── Gemini narration of the aggregates ───────────────────────────────────
const SUMMARY_PROMPT = `You analyse AGGREGATE statistics of an algorithmic futures trading system (MCX commodities, Dynamic Step Band family strategies among others).
All numbers are verified and computed by the system: do not recompute, contradict or invent figures, instruments, causes or market views. Small samples (a few trades) cannot support strong claims — say so.
"limiterDays" lists days when a daily risk limiter fired (LOSING_REVERSALS_LIMIT: max losing signal reversals reached; LOSING_TRADES_LIMIT: max losing trades reached). After the limiter fires the engine takes no more entries that day. The journals contain no counterfactual (what the blocked trades would have done), so judge only what the data shows (day P&L, how many trades before the lock) and never claim the limiter saved or cost money.
Reply with ONLY this JSON:
{"headline":"one sentence","patterns":[{"finding":"...","evidence":"the numbers it rests on"}],"limiter_assessment":"what the limiter days show, or 'no limiter days in this window'","suggestions":["a concrete thing to review or test (backtest), not an order to change live settings"],"limitations":["..."]}
Give 2-5 patterns and 1-4 suggestions.`;

const s2 = (v, m = 500) => typeof v === "string" && v.trim() ? v.trim().slice(0, m) : null;
function validateNarration(text) {
    let j;
    try { j = JSON.parse(String(text).trim().replace(/^```json\s*/i, "").replace(/```$/, "")); } catch { throw new Error("AI reply was not valid JSON"); }
    const patterns = Array.isArray(j.patterns) ? j.patterns.map(p => ({ finding: s2(p && p.finding), evidence: s2(p && p.evidence) })).filter(p => p.finding && p.evidence).slice(0, 6) : null;
    const list = v => Array.isArray(v) ? v.map(x => s2(x, 300)).filter(Boolean).slice(0, 6) : null;
    const out = { headline: s2(j.headline, 300), patterns, limiter_assessment: s2(j.limiter_assessment, 700), suggestions: list(j.suggestions), limitations: list(j.limitations) };
    const bad = Object.entries(out).filter(([, v]) => v === null || (Array.isArray(v) && !v.length && v !== out.limitations)).map(([k]) => k);
    if (bad.length) throw new Error("AI reply failed validation: " + bad.join(", "));
    return out;
}

let tableReady = false;
async function ensureTable() {
    if (tableReady) return;
    await ai.run(ai.cache(), `CREATE TABLE IF NOT EXISTS ai_summaries (hash TEXT PRIMARY KEY, days INTEGER, result TEXT, model TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    tableReady = true;
}

async function narrate(summary, force = false, opts = {}) {
    await ensureTable();
    const hash = crypto.createHash("sha256").update((opts.kind || "") + JSON.stringify(summary)).digest("hex").slice(0, 32);
    if (!force) {
        const hit = (await ai.all(ai.cache(), `SELECT result FROM ai_summaries WHERE hash = ?`, [hash]))[0];
        if (hit) return JSON.parse(hit.result);
    }
    const text = await ai.callGemini(summary, { systemPrompt: opts.prompt || SUMMARY_PROMPT, label: opts.label || "Verified aggregate statistics:" });
    const out = validateNarration(text);
    await ai.run(ai.cache(), `INSERT OR REPLACE INTO ai_summaries (hash, days, result, model) VALUES (?, ?, ?, ?)`, [hash, summary.days, JSON.stringify(out), ai.MODEL]);
    return out;
}

// ── backtest report analysis ─────────────────────────────────────────────
const BACKTEST_PROMPT = `You analyse ONE backtest of an algorithmic futures strategy (MCX commodities) from verified, system-computed statistics.
Do not recompute or contradict the numbers and do not invent causes, market views or figures. A backtest is in-sample history: it is not evidence of future results, P&L is gross (no brokerage, taxes or slippage) and a short window or few trades supports only weak conclusions - say so. "settings" lists every filter/limit used; "limiter" (when present) is the daily losing-reversal / losing-trade limit and its counts.
Reply with ONLY this JSON:
{"headline":"one sentence verdict on what the run shows","patterns":[{"finding":"...","evidence":"the numbers it rests on"}],"limiter_assessment":"what the limiter counts show, or 'no limiter used in this run'","suggestions":["a concrete variant worth backtesting next (a setting change, timeframe, filter), not a live-trading instruction"],"limitations":["..."]}
Give 2-5 patterns and 1-4 suggestions.`;

function backtestFacts(report) {
    const trades = (report.trades || []).filter(t => t.status === "CLOSED" || t.exit_time);
    const by = {}, side = {}, hour = {}, dayMap = {};
    let run = 0, streak = 0, streakAt = null;
    for (const t of trades) {
        const pnl = t.pnl || 0;
        bucket(by, t.exit_reason || "?", pnl); bucket(side, t.side, pnl);
        const ist = new Date(new Date(t.entry_time).getTime() + IST_MS);
        bucket(hour, String(ist.getUTCHours()).padStart(2, "0") + ":00", pnl);
        const d = ist.toISOString().slice(0, 10); dayMap[d] = (dayMap[d] || 0) + pnl;
        run = pnl < 0 ? run + 1 : 0;
        if (run > streak) { streak = run; streakAt = d; }
    }
    const days = Object.entries(dayMap).map(([d, p]) => ({ day: d, pnl: r0(p) }));
    const m = report.metrics || {};
    return {
        instrument: report.instrument, strategy: report.strategyLabel || report.strategy, timeframe: report.timeframe, range: report.range,
        settings: Object.fromEntries((report.settings || []).map(([k, v]) => [k, v])), params: report.params || {},
        metrics: { trades: m.trades, winRatePct: Math.round((m.winRate || 0) * 1000) / 10, profitFactor: m.profitFactor ?? null, netPnL: r0(m.netPnL || 0),
            netPoints: Math.round((m.netPoints || 0) * 100) / 100, maxDrawdown: r0(m.maxDrawdown || 0), largestWin: r0(m.largestWin || 0), largestLoss: r0(m.largestLoss || 0),
            avgTrade: r0(m.avgTrade || 0), avgHoldMinutes: Math.round((m.avgHoldTimeMs || 0) / 60000) },
        byExitReason: finish(by).sort((a, b) => a.pnl - b.pnl), bySide: finish(side), byEntryHourIst: finish(hour).sort((a, b) => a.key.localeCompare(b.key)),
        tradingDays: days.length, profitableDays: days.filter(d => d.pnl > 0).length,
        worstDays: days.sort((a, b) => a.pnl - b.pnl).slice(0, 3), bestDay: days.sort((a, b) => b.pnl - a.pnl)[0] || null,
        longestLosingStreak: { trades: streak, endedOn: streakAt },
        limiter: report.losingSwitch || null,
    };
}

async function narrateBacktest(report, force = false) {
    const facts = backtestFacts(report);
    if (!facts.metrics.trades) throw Object.assign(new Error("This backtest has no trades to analyse"), { status: 400 });
    return narrate(facts, force, { kind: "backtest:", prompt: BACKTEST_PROMPT, label: "Verified backtest statistics:" });
}

module.exports = { buildSummary, narrate, validateNarration, backtestFacts, narrateBacktest };
