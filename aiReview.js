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
            for (const r of rows) out.push({ journal: file, ...r });
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
        return rows[0] ? { journal, ...rows[0] } : null;
    } catch { return null; } finally { db.close(); }
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
        stop: ctx.hardSlRupees ? `hard Rs ${ctx.hardSlRupees}` : (ctx.atrSlMult ? `ATR x ${ctx.atrSlMult}` : null),
    };
}

// ── Gemini ───────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You review ONE completed trade from an algorithmic futures trading engine (MCX commodities).
You are given verified facts computed by the system. Do not recompute or contradict them; do not invent prices, indicator values or market context that are not in the facts. If something cannot be judged from the facts, say so in "limitations".
Exit reasons: EOD_FORCE = the engine's scheduled end-of-day close of any open position (a rule, not a market signal); reasons containing SL = a stop-loss was hit; other reasons are strategy signal exits. durationMinutes is entry to exit. Missing optional facts (null) are data gaps, not trade flaws: list them under "limitations" only, never in the entry/behaviour/exit text, and do not restate the raw numbers as evidence — evidence should connect facts to a conclusion.
Judge decision quality and rule adherence, not just profit: a loss can be a good trade and a win can be a bad one.
Grade: A = behaved as designed and exit was efficient; B = acceptable with some inefficiency; C = clear problem visible in the facts (e.g. large profit given back, exit far from what the stop implies). With little evidence prefer B and explain.
Reply with ONLY this JSON:
{"grade":"A|B|C","entry_assessment":"...","trade_behaviour":"...","exit_assessment":"...","evidence":["fact-based bullet"],"limitations":["what could not be judged"],"takeaway":"one line"}`;

function callGemini(facts) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return Promise.reject(new Error("GEMINI_API_KEY is not set"));
    const body = JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: "Verified trade facts:\n" + JSON.stringify(facts, null, 2) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 900, responseMimeType: "application/json" },
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

module.exports = { listTrades, reviewTrade, buildFacts, validateReview };
