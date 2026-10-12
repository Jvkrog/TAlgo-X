// aiReview.js — TAlgo-Ai: post-trade review. OBSERVER ONLY.
//
// Reads CLOSED trades from the per-instrument SQLite journals (read-only), computes every number
// deterministically here, and asks Gemini only to INTERPRET that evidence. The reply is schema-validated
// and cached in databases/ai_reviews.db. Nothing in the trading engines imports this file, and a failed
// or invalid AI reply never touches trade data.
//
// Not sent to Gemini: credentials, tokens, account ids. Only the trade facts built in buildFacts().
"use strict";

const fs = require("fs");
const https = require("https");
const sqlite3 = require("sqlite3").verbose();
const { DB_DIR, dbFile } = require("./dbDir");

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const GRADES = ["A", "B", "C"];

// ── review cache ─────────────────────────────────────────────────────────
let cacheDb = null;
function cache() {
    if (cacheDb) return cacheDb;
    cacheDb = new sqlite3.Database(dbFile("ai_reviews.db"));
    cacheDb.serialize(() => {
        cacheDb.run(`CREATE TABLE IF NOT EXISTS ai_reviews (
            journal TEXT NOT NULL, trade_id INTEGER NOT NULL,
            status TEXT NOT NULL,            -- OK | FAILED
            review TEXT, error TEXT, model TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (journal, trade_id)
        )`);
    });
    return cacheDb;
}
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));

// ── journal reading ──────────────────────────────────────────────────────
function journalFiles() {
    try { return fs.readdirSync(DB_DIR).filter(f => f.endsWith(".db") && f !== "ai_reviews.db"); } catch { return []; }
}

function openRo(file) {
    return new Promise(resolve => {
        const db = new sqlite3.Database(dbFile(file), sqlite3.OPEN_READONLY, err => resolve(err ? null : db));
    });
}

// Newest CLOSED trades across every instrument journal, with cached review state attached.
async function listTrades(limit = 60) {
    const out = [];
    for (const file of journalFiles()) {
        const db = await openRo(file);
        if (!db) continue;
        try {
            const rows = await all(db, `SELECT * FROM trades WHERE status = 'CLOSED' ORDER BY id DESC LIMIT ?`, [limit]);
            const recent = await recentRows(db);
            for (const r of rows) out.push({ journal: file, ...r, _day: dayContextFor(recent, r) });
        } catch { /* file without a trades table (other kind of db) */ }
        db.close();
    }
    out.sort((a, b) => String(b.exit_time || "").localeCompare(String(a.exit_time || "")));
    const top = out.slice(0, limit);
    const reviews = await all(cache(), `SELECT journal, trade_id, status, review, error FROM ai_reviews`);
    const byKey = new Map(reviews.map(r => [`${r.journal}#${r.trade_id}`, r]));
    return top.map(t => {
        const facts = buildFacts(t);
        const rv = byKey.get(`${t.journal}#${t.id}`);
        return {
            journal: t.journal, id: t.id, facts,
            review: rv && rv.status === "OK" ? JSON.parse(rv.review) : null,
            reviewError: rv && rv.status === "FAILED" ? rv.error : null,
        };
    });
}

async function getTrade(journal, id) {
    if (!journalFiles().includes(journal)) return null;
    const db = await openRo(journal);
    if (!db) return null;
    try {
        const rows = await all(db, `SELECT * FROM trades WHERE id = ? AND status = 'CLOSED'`, [id]);
        if (!rows[0]) return null;
        return { journal, ...rows[0], _day: dayContextFor(await recentRows(db), rows[0]) };
    } catch { return null; } finally { db.close(); }
}

// Earlier closed trades of the same journal and trade_date -> what the day looked like before this trade.
function dayContextFor(rows, t) {
    const prior = rows.filter(r => r.trade_date === t.trade_date && r.id < t.id && r.status === "CLOSED").sort((a, b) => a.id - b.id);
    let streak = 0;
    for (let i = prior.length - 1; i >= 0 && prior[i].pnl < 0; i--) streak++;
    const prev = prior[prior.length - 1];
    return {
        tradeNumberToday: prior.length + 1,
        dayPnlBefore: Math.round(prior.reduce((a, r) => a + (r.pnl || 0), 0)),
        lossesBeforeToday: prior.filter(r => r.pnl < 0).length,
        consecutiveLossesBefore: streak,
        previousTrade: prev ? { side: prev.side, pnl: Math.round(prev.pnl), exitReason: prev.exit_reason } : null,
    };
}
async function recentRows(db) {
    return all(db, `SELECT id, trade_date, status, pnl, side, exit_reason FROM trades WHERE trade_date >= date('now','-4 day')`).catch(() => []);
}

// ── deterministic facts (authoritative — the model never computes these) ──
let strategyInfo;
function strategyDescription(key) {
    try { strategyInfo = strategyInfo || require("./strategies").STRATEGY_INFO || {}; } catch { strategyInfo = {}; }
    const i = strategyInfo[key];
    return i ? `${i.label}: ${i.description}` : null;
}

// Trades closed before the journal stored a settings snapshot still carry the strategy and candle type
// in the journal's file name (<instrument>_<strategy>_<raw|ha|range>.db).
function fromFileName(journal) {
    const parts = String(journal || "").replace(/\.db$/, "").split("_");
    if (parts.length < 3) return {};
    const suffix = parts[parts.length - 1];
    if (!["raw", "ha", "range"].includes(suffix)) return {};
    return { strategy: parts.slice(1, -1).join("_").toUpperCase(), candleType: suffix.toUpperCase() };
}

function buildFacts(t) {
    let ctx = {};
    try { ctx = t.ctx ? JSON.parse(t.ctx) : {}; } catch { /* leave empty */ }
    const fn = fromFileName(t.journal);
    ctx = { ...ctx, strategy: ctx.strategy || fn.strategy, candleType: ctx.candleType || fn.candleType };
    const dir = t.side === "LONG" ? 1 : -1;
    const points = (t.exit_price - t.entry_price) * dir;
    const durationMin = (t.entry_time && t.exit_time) ? Math.round((new Date(t.exit_time) - new Date(t.entry_time)) / 60000) : null;
    const hasExc = Number.isFinite(t.peak_pnl) && Number.isFinite(t.trough_pnl);
    let entryCtx = null;
    try { entryCtx = t.entry_ctx ? JSON.parse(t.entry_ctx) : null; } catch { /* leave null */ }
    const giveback = hasExc && t.peak_pnl > 0 ? Math.round(t.peak_pnl - t.pnl) : null;
    return {
        instrument: t.instrument, strategy: ctx.strategy || null, timeframe: ctx.timeframe || null, candleType: ctx.candleType || null,
        side: t.side, qty: t.qty, lots: ctx.lots ?? null,
        entryPrice: t.entry_price, exitPrice: t.exit_price, entryTime: t.entry_time, exitTime: t.exit_time,
        durationMinutes: durationMin,
        pnlRupees: Math.round(t.pnl * 100) / 100,
        points: Math.round(points * 100) / 100,
        exitReason: t.exit_reason,
        // observed from the live tick stream (sampled ~every 400 ms); null when the engine restarted mid-trade
        peakPnl: hasExc ? Math.round(t.peak_pnl) : null,
        troughPnl: hasExc ? Math.round(t.trough_pnl) : null,
        profitGivenBack: giveback,
        strategyRules: strategyDescription(ctx.strategy),
        // entry-time snapshot (null for trades opened before this was recorded) and the day so far
        entryContext: entryCtx,
        dayContext: t._day || null,
        stop: ctx.hardSlRupees ? `hard Rs ${ctx.hardSlRupees}` : (ctx.atrSlMult ? `ATR x ${ctx.atrSlMult}` : null),
    };
}

// ── Gemini ───────────────────────────────────────────────────────────────
const TAGS = ["good_entry", "late_entry", "chop_entry", "against_band_context", "revenge_trade", "overtrading", "gave_back_profit", "normal_stop_out", "forced_eod_exit", "reversal_whipsaw", "clean_win", "limiter_relevant"];
const SYSTEM_PROMPT = `You review ONE completed trade from an algorithmic futures trading engine (MCX commodities).
You are given verified facts computed by the system. Do not recompute or contradict them; never invent prices, indicator values or market context that are not in the facts. Anything you cannot judge goes ONLY in "limitations".
How to read the facts:
- exitReason: EOD_FORCE = the engine's scheduled end-of-day close (a rule, not a market signal); reasons containing SL = stop-loss hit; others (LONG/SHORT REVERSAL, COLOR FLIP EXIT, DSB FLIP EXIT) are strategy signal exits.
- entryContext (may be null for older trades — then say so in limitations, not in the assessments): priceVsBand = where price sat relative to the Dynamic Step Band at entry; chop = Choppiness Index (higher = choppier; the platform blocks entries above about 58); atr14 and lastCandleRangeAtrX = volatility and how stretched the signal candle was (>2 means unusually long); entryTimeIst/weekday = when it entered; lastCandles = the 3 candles before entry.
- dayContext: tradeNumberToday, consecutiveLossesBefore, dayPnlBefore and previousTrade show whether this was a fresh attempt or part of a losing streak (repeated entries after losses can be revenge/overtrading, but only say so when the numbers show it).
- peakPnl/troughPnl/profitGivenBack: best and worst unrealised P&L observed live (sampled ~every 400 ms); null = data gap, not a flaw.
Judge decision quality and rule adherence, not profit: a loss can be a good trade and a win a bad one. Every assessment sentence must rest on at least one provided fact; do not restate raw numbers as evidence without linking them to a conclusion. Be specific, not generic.
Grade: A = behaved as designed and the entry/exit were efficient; B = acceptable with some inefficiency; C = a clear problem visible in the facts. With thin evidence prefer B and explain.
"tags": pick 0-4 that clearly apply from this list only: ${TAGS.join(", ")}.
Reply with ONLY this JSON:
{"grade":"A|B|C","entry_assessment":"1-2 sentences","trade_behaviour":"1-2 sentences","exit_assessment":"1-2 sentences","evidence":["fact -> conclusion"],"limitations":["what could not be judged"],"tags":["..."],"takeaway":"one line"}`;

function callGemini(facts, opts = {}) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return Promise.reject(new Error("GEMINI_API_KEY is not set"));
    const body = JSON.stringify({
        system_instruction: { parts: [{ text: opts.systemPrompt || SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: (opts.label || "Verified trade facts:") + "\n" + JSON.stringify(facts, null, 2) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1200, responseMimeType: "application/json" },
    });
    return new Promise((resolve, reject) => {
        const req = https.request(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
            method: "POST", timeout: 30000,
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "x-goog-api-key": key },
        }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const j = JSON.parse(data);
                    if (j.error) return reject(new Error(j.error.message || "Gemini error"));
                    resolve(j.candidates?.[0]?.content?.parts?.[0]?.text || "");
                } catch (e) { reject(new Error("Unreadable Gemini response")); }
            });
        });
        req.on("timeout", () => req.destroy(new Error("Gemini request timed out")));
        req.on("error", reject);
        req.write(body); req.end();
    });
}

const str = (v, max = 600) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const strList = v => Array.isArray(v) ? v.map(x => str(x, 300)).filter(Boolean).slice(0, 8) : null;

// Strict validation: anything off-schema is rejected, never patched up.
function validateReview(text) {
    let j;
    try { j = JSON.parse(String(text).trim().replace(/^```json\s*/i, "").replace(/```$/, "")); }
    catch { throw new Error("AI reply was not valid JSON"); }
    const r = {
        grade: GRADES.includes(j.grade) ? j.grade : null,
        entry_assessment: str(j.entry_assessment), trade_behaviour: str(j.trade_behaviour), exit_assessment: str(j.exit_assessment),
        evidence: strList(j.evidence), limitations: strList(j.limitations), takeaway: str(j.takeaway, 300),
        tags: Array.isArray(j.tags) ? [...new Set(j.tags.filter(x => TAGS.includes(x)))].slice(0, 4) : [],
    };
    const bad = Object.entries(r).filter(([, v]) => v === null).map(([k]) => k);
    if (bad.length) throw new Error("AI reply failed validation: " + bad.join(", "));
    return r;
}

// Review one trade (cached). force=true re-runs. Never throws into the caller's trading path.
async function reviewTrade(journal, id, force = false) {
    const t = await getTrade(journal, id);
    if (!t) throw Object.assign(new Error("closed trade not found"), { status: 404 });
    const db = cache();
    if (!force) {
        const hit = (await all(db, `SELECT review FROM ai_reviews WHERE journal = ? AND trade_id = ? AND status = 'OK'`, [journal, id]))[0];
        if (hit) return JSON.parse(hit.review);
    }
    try {
        const review = validateReview(await callGemini(buildFacts(t)));
        await run(db, `INSERT OR REPLACE INTO ai_reviews (journal, trade_id, status, review, model) VALUES (?, ?, 'OK', ?, ?)`, [journal, id, JSON.stringify(review), MODEL]);
        return review;
    } catch (e) {
        await run(db, `INSERT OR REPLACE INTO ai_reviews (journal, trade_id, status, error, model) VALUES (?, ?, 'FAILED', ?, ?)`, [journal, id, e.message, MODEL]).catch(() => {});
        throw e;
    }
}

module.exports = { listTrades, reviewTrade, buildFacts, validateReview, callGemini, journalFiles, openRo, all, cache, run, TAGS, MODEL };
