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
const { DB_DIR, dbFile } = require("../data/dbDir");

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
// Reviews written before times were switched to IST quote raw UTC stamps (2026-10-09T17:30:11Z) — regenerate those.
const isStale = text => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(text));
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));

// ── journal reading ──────────────────────────────────────────────────────
function journalFiles() {
    try { return fs.readdirSync(DB_DIR).filter(f => f.endsWith(".db") && f !== "ai_reviews.db"); } catch { return []; }
}
const PMA_FILE = /^(.+?)_price_ma_hedge_(long|short)_(base|hedge)_(.+)_(raw|ha|range)\.db$/;
const PAIR_FILE = /^(.+)_(core|hedge)_(raw|ha|range)\.db$/;
const DUAL_FILE = /^(.+?)_(dual_bias_hedge|dual_hedge)_(long|short)_(.+)_(raw|ha|range)\.db$/;
const isPairLegJournal = f => PMA_FILE.test(f) || PAIR_FILE.test(f);
// A dual-hedge journal leaves the single-trade list only when it can be paired with its opposite account's journal (otherwise it stays a lone trade).
const singleJournalFiles = () => { const dual = new Set(pairGroups().filter(g => g.kind === "DUAL_HEDGE").flatMap(g => g.anchors)); return journalFiles().filter(f => !isPairLegJournal(f) && !dual.has(f)); };

function openRo(file) {
    return new Promise(resolve => {
        const db = new sqlite3.Database(dbFile(file), sqlite3.OPEN_READONLY, err => resolve(err ? null : db));
    });
}

// Newest CLOSED trades across every instrument journal, with cached review state attached.
async function listTrades(limit = 60) {
    const out = [];
    for (const file of singleJournalFiles()) {
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
    const reviews = await all(cache(), `SELECT journal, trade_id, status, review, error, created_at FROM ai_reviews`);
    const byKey = new Map(reviews.map(r => [`${r.journal}#${r.trade_id}`, r]));
    return top.map(t => {
        const facts = buildFacts(t);
        const rv = byKey.get(`${t.journal}#${t.id}`);
        return {
            journal: t.journal, id: t.id, facts,
            review: rv && rv.status === "OK" && !isStale(rv.review) ? JSON.parse(rv.review) : null,
            reviewError: rv && rv.status === "FAILED" ? rv.error : null,
            failedAt: rv && rv.status === "FAILED" ? rv.created_at : null,
        };
    });
}

async function getTrade(journal, id) {
    if (!singleJournalFiles().includes(journal)) return null;
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

const fmtIst = iso => {
    if (!iso) return null;
    const d = new Date(new Date(iso).getTime() + 5.5 * 3600000);
    return isNaN(d) ? null : d.toISOString().replace("T", " ").slice(0, 19) + " IST";
};
// What Gemini sees: same facts but with IST wall times only (raw UTC ISO stamps removed).
function forModel(facts) {
    const { entryTime, exitTime, ...rest } = facts;
    return rest;
}

// ── deterministic facts (authoritative — the model never computes these) ──
let strategyInfo;
function strategyDescription(key) {
    try { strategyInfo = strategyInfo || require("../strategies/strategies").STRATEGY_INFO || {}; } catch { strategyInfo = {}; }
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
        entryPrice: t.entry_price, exitPrice: t.exit_price, entryTime: t.entry_time, exitTime: t.exit_time, entryTimeIst: fmtIst(t.entry_time), exitTimeIst: fmtIst(t.exit_time),
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
You are given verified facts computed by the system. All times are IST (Asia/Kolkata); quote times only in IST. Do not recompute or contradict them; never invent prices, indicator values or market context that are not in the facts. Anything you cannot judge goes ONLY in "limitations".
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
function validateReview(text, allowedTags = TAGS) {
    let j;
    try { j = JSON.parse(String(text).trim().replace(/^```json\s*/i, "").replace(/```$/, "")); }
    catch { throw new Error("AI reply was not valid JSON"); }
    const r = {
        grade: GRADES.includes(j.grade) ? j.grade : null,
        entry_assessment: str(j.entry_assessment), trade_behaviour: str(j.trade_behaviour) || "", exit_assessment: str(j.exit_assessment),
        evidence: strList(j.evidence) || [], limitations: strList(j.limitations) || [], takeaway: str(j.takeaway, 300),
        tags: Array.isArray(j.tags) ? [...new Set(j.tags.filter(x => allowedTags.includes(x)))].slice(0, 4) : [],
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
        if (hit && !isStale(hit.review)) return JSON.parse(hit.review);
    }
    try {
        const facts = forModel(buildFacts(t));
        let review;
        try { review = validateReview(await callGemini(facts)); }
        catch (e) { if (!/validation|valid JSON/.test(e.message)) throw e; review = validateReview(await callGemini(facts)); }   // one retry for a malformed reply
        await run(db, `INSERT OR REPLACE INTO ai_reviews (journal, trade_id, status, review, model) VALUES (?, ?, 'OK', ?, ?)`, [journal, id, JSON.stringify(review), MODEL]);
        return review;
    } catch (e) {
        await run(db, `INSERT OR REPLACE INTO ai_reviews (journal, trade_id, status, error, model) VALUES (?, ?, 'FAILED', ?, ?)`, [journal, id, e.message, MODEL]).catch(() => {});
        throw e;
    }
}


function pairGroups() {
    const files = journalFiles(), groups = [];
    for (const f of files) {
        const m = f.match(PMA_FILE);
        if (m && m[3] === "hedge") {
            const base = files.find(x => { const k = x.match(PMA_FILE); return k && k[1] === m[1] && k[2] === m[2] && k[3] === "base" && k[4] === m[4]; });
            if (base) groups.push({ kind: "PRICE_MA_HEDGE", instrument: m[1], account: m[2].toUpperCase(), user: m[4].toUpperCase(), baseJournal: base, hedgeJournal: f, anchors: [f] });
        }
    }
    const cores = files.filter(f => PAIR_FILE.test(f) && f.match(PAIR_FILE)[2] === "core" && !PMA_FILE.test(f));
    const hedges = files.filter(f => PAIR_FILE.test(f) && f.match(PAIR_FILE)[2] === "hedge" && !PMA_FILE.test(f));
    for (const core of cores) {
        const pre = core.match(PAIR_FILE)[1];
        let hedge = hedges.find(h => h.match(PAIR_FILE)[1] === pre);
        if (!hedge && cores.length === 1 && hedges.length === 1) hedge = hedges[0];   // two-instrument pair: names differ, only one pair on this server
        if (hedge) groups.push({ kind: "HEDGE_PAIR", instrument: pre, account: null, user: null, baseJournal: core, hedgeJournal: hedge, anchors: [hedge] });
    }
    // Dual hedge (band-following / bias / realize): one LONG-account journal + one SHORT-account journal of the same instrument and family.
    const dual = files.map(f => ({ f, m: f.match(DUAL_FILE) })).filter(x => x.m);
    for (const key of [...new Set(dual.map(x => x.m[1] + "|" + x.m[2]))]) {
        const longs = dual.filter(x => x.m[1] + "|" + x.m[2] === key && x.m[3] === "long"), shorts = dual.filter(x => x.m[1] + "|" + x.m[2] === key && x.m[3] === "short");
        if (longs.length === 1 && shorts.length === 1)   // several deployments of one instrument can't be told apart from file names: those stay lone trades
            groups.push({ kind: "DUAL_HEDGE", family: longs[0].m[2], instrument: longs[0].m[1], longJournal: longs[0].f, shortJournal: shorts[0].f, longUser: longs[0].m[4].toUpperCase(), shortUser: shorts[0].m[4].toUpperCase(), anchors: [longs[0].f, shorts[0].f] });
    }
    return groups;
}

const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
function buildPairFacts(g, h, b, sibs, sameDayPrior, oppBase = null) {
    let hctx = {}; try { hctx = h.ctx ? JSON.parse(h.ctx) : {}; } catch { /* none */ }
    const hDir = h.side === "LONG" ? 1 : -1, bDir = b ? (b.side === "LONG" ? 1 : -1) : null;
    const hPts = (h.exit_price - h.entry_price) * hDir;
    const perPoint = (Number(hctx.lotMult) * Number(hctx.lots)) || (Math.abs(hPts) > 1e-9 ? Math.abs(h.pnl / hPts) : null);
    const durMin = h.entry_time && h.exit_time ? Math.round((new Date(h.exit_time) - new Date(h.entry_time)) / 60000) : null;
    const sameContract = !!b && b.instrument === h.instrument;
    const f = {
        pairType: g.kind === "PRICE_MA_HEDGE" ? "Price-MA base-loss hedge" : "Hedge pair (core + hedge)",
        account: g.account ? `${g.account} account (${g.user})` : "single account",
        base: b ? { role: g.kind === "PRICE_MA_HEDGE" ? "base" : "core", side: b.side, contract: b.instrument, lots: b.qty, entryPrice: b.entry_price, entryTimeIst: fmtIst(b.entry_time),
            statusNow: b.status, daysHeldWhenHedgeOpened: dayDiff(b.trade_date, h.trade_date), exitPrice: b.exit_price ?? null, exitReason: b.exit_reason ?? null } : null,
        hedge: { side: h.side, contract: h.instrument, lots: h.qty, entryPrice: h.entry_price, exitPrice: h.exit_price, entryTimeIst: fmtIst(h.entry_time), exitTimeIst: fmtIst(h.exit_time),
            durationMinutes: durMin, pnlRupees: Math.round(h.pnl * 100) / 100, points: Math.round(hPts * 100) / 100, exitReason: h.exit_reason,
            peakPnl: Number.isFinite(h.peak_pnl) ? Math.round(h.peak_pnl) : null, troughPnl: Number.isFinite(h.trough_pnl) ? Math.round(h.trough_pnl) : null },
        sameContract,
    };
    if (b && sameContract && perPoint) {
        const bPerPoint = perPoint * (b.qty / (h.qty || 1));
        const openPts = bDir * (h.entry_price - b.entry_price), closePts = bDir * (h.exit_price - b.entry_price);
        const baseMove = bDir * (h.exit_price - h.entry_price) * bPerPoint;
        f.window = {
            baseP_LAtHedgeOpenPoints: Math.round(openPts * 100) / 100, baseP_LAtHedgeClosePoints: Math.round(closePts * 100) / 100,
            baseMoveDuringHedgeRupees: Math.round(baseMove), hedgePnlRupees: Math.round(h.pnl),
            pairNetDuringHedgeRupees: Math.round(h.pnl + baseMove),
            hedgeOffsetOfBaseLossPct: baseMove < 0 && h.pnl > 0 ? Math.min(100, Math.round(h.pnl / -baseMove * 100)) : null,
        };
    } else if (b) {
        f.window = null; f.windowNote = "hedge is on a different contract than the base (calendar hedge) — base P&L over the hedge window cannot be computed from journals";
    }
    // The hedge's EOD close is mechanical (avoid the broker's costlier square-off). When the base is still open it carries on UNHEDGED overnight and the next
    // session re-evaluates it from scratch — the EOD close is not the end of the trade and says nothing about the base's outcome.
    const eodClose = /EOD/i.test(String(h.exit_reason || ""));
    f.hedgeExitKind = eodClose && b && b.status === "OPEN" ? "EOD_BASE_CARRIED" : eodClose ? "EOD" : "SIGNAL";
    if (f.hedgeExitKind === "EOD_BASE_CARRIED" && f.window) f.baseStillOpenAfterHedgeClosePoints = f.window.baseP_LAtHedgeClosePoints;
    f.dayContext = { hedgeCyclesBeforeThisToday: sameDayPrior.length, hedgePnlBeforeToday: Math.round(sameDayPrior.reduce((a, r) => a + (r.pnl || 0), 0)),
        consecutiveLosingHedgesBefore: (() => { let n = 0; for (let i = sameDayPrior.length - 1; i >= 0 && sameDayPrior[i].pnl < 0; i--) n++; return n; })() };
    const inside = x => x.entry_time >= h.entry_time && x.exit_time <= h.exit_time;
    if (sibs.length) f.oppositeAccountHedgesOverlapping = sibs.map(x => ({ account: x.account, side: x.side, pnlRupees: Math.round(x.pnl), entryTimeIst: fmtIst(x.entry_time), exitTimeIst: fmtIst(x.exit_time), fullyInsideThisWindow: inside(x) }));
    if (oppBase) {
        f.oppositeAccountBase = { account: oppBase.account, side: oppBase.side, contract: oppBase.instrument, lots: oppBase.qty, entryPrice: oppBase.entry_price, statusNow: oppBase.status };
        if (f.window && perPoint && oppBase.instrument === h.instrument) {
            const oDir = oppBase.side === "LONG" ? 1 : -1, oMove = oDir * (h.exit_price - h.entry_price) * perPoint * (oppBase.qty / (h.qty || 1));
            f.window.oppositeBaseMoveDuringHedgeRupees = Math.round(oMove);
            f.window.twoAccountNetDuringHedgeRupees = Math.round(f.window.pairNetDuringHedgeRupees + oMove + sibs.filter(inside).reduce((a, x) => a + (x.pnl || 0), 0));
            f.window.twoAccountNetNote = "this pair's net + the other account's base move + the other account's hedges that opened AND closed inside this window (partial overlaps are not counted)";
        }
    }
    return f;
}

// Dual hedge: anchor = one closed trade of one account; context = the OPPOSITE account's trades overlapping it (open or closed).
async function loadDual(g, journal, id) {
    const aAcc = journal === g.longJournal ? "LONG" : "SHORT", oJournal = aAcc === "LONG" ? g.shortJournal : g.longJournal, oAcc = aAcc === "LONG" ? "SHORT" : "LONG";
    const adb = await openRo(journal), odb = await openRo(oJournal);
    if (!adb || !odb) { if (adb) adb.close(); if (odb) odb.close(); return null; }
    try {
        const a = (await all(adb, `SELECT * FROM trades WHERE id = ? AND status = 'CLOSED'`, [id]))[0];
        if (!a) return null;
        const prior = await all(adb, `SELECT id, pnl FROM trades WHERE status = 'CLOSED' AND trade_date = ? AND id < ? ORDER BY id`, [a.trade_date, a.id]);
        const opp = await all(odb, `SELECT * FROM trades WHERE entry_time <= ? AND (status = 'OPEN' OR exit_time >= ?) ORDER BY entry_time`, [a.exit_time, a.entry_time]).catch(() => []);
        let actx = {}; try { actx = a.ctx ? JSON.parse(a.ctx) : {}; } catch { /* none */ }
        const aDir = a.side === "LONG" ? 1 : -1, pts = (a.exit_price - a.entry_price) * aDir;
        const perPoint = (Number(actx.lotMult) * Number(actx.lots)) || (Math.abs(pts) > 1e-9 ? Math.abs(a.pnl / pts) : null);
        const dur = a.entry_time && a.exit_time ? Math.round((new Date(a.exit_time) - new Date(a.entry_time)) / 60000) : null;
        const covers = o => o.entry_time <= a.entry_time && (o.status === "OPEN" || o.exit_time >= a.exit_time);
        const f = {
            pairType: g.family === "dual_bias_hedge" ? "Dual bias hedge (two accounts)" : "Dual hedge (two accounts, one long-only / one short-only)", isDual: true,
            account: `${aAcc} account (${aAcc === "LONG" ? g.longUser : g.shortUser})`, oppositeAccountName: `${oAcc} account (${oAcc === "LONG" ? g.longUser : g.shortUser})`,
            hedge: { side: a.side, contract: a.instrument, lots: a.qty, entryPrice: a.entry_price, exitPrice: a.exit_price, entryTimeIst: fmtIst(a.entry_time), exitTimeIst: fmtIst(a.exit_time),
                durationMinutes: dur, pnlRupees: Math.round(a.pnl * 100) / 100, points: Math.round(pts * 100) / 100, exitReason: a.exit_reason,
                peakPnl: Number.isFinite(a.peak_pnl) ? Math.round(a.peak_pnl) : null, troughPnl: Number.isFinite(a.trough_pnl) ? Math.round(a.trough_pnl) : null,
                heldOvernight: dayDiff(a.entry_time.slice(0, 10), (a.exit_time || a.entry_time).slice(0, 10)) > 0 },
            opposite: opp.map(o => ({ side: o.side, contract: o.instrument, lots: o.qty, entryPrice: o.entry_price, entryTimeIst: fmtIst(o.entry_time), statusNow: o.status, exitPrice: o.exit_price ?? null,
                exitTimeIst: fmtIst(o.exit_time), pnlRupees: o.pnl != null ? Math.round(o.pnl) : null, exitReason: o.exit_reason ?? null, coversWholeWindow: covers(o) })),
            sameContract: opp.every(o => o.instrument === a.instrument),
            dayContext: { sameAccountTradesBeforeToday: prior.length, sameAccountPnlBeforeToday: Math.round(prior.reduce((x, r) => x + (r.pnl || 0), 0)) },
        };
        const cov = opp.find(covers);
        if (cov && perPoint && cov.instrument === a.instrument) {
            const oDir = cov.side === "LONG" ? 1 : -1, oMove = oDir * (a.exit_price - a.entry_price) * perPoint * (cov.qty / (a.qty || 1));
            f.window = { thisTradeRupees: Math.round(a.pnl), oppositeAccountMoveDuringTradeRupees: Math.round(oMove), pairNetDuringHedgeRupees: Math.round(a.pnl + oMove),
                note: "this trade's result + what the opposite account's position (open across the whole window) gained/lost over the same price move" };
        } else f.window = null;
        return { h: a, b: null, facts: f };
    } catch { return null; } finally { adb.close(); odb.close(); }
}

async function loadPair(g, journal, hedgeId) {
    if (g.kind === "DUAL_HEDGE") return loadDual(g, journal, hedgeId);
    const hdb = await openRo(g.hedgeJournal), bdb = await openRo(g.baseJournal);
    if (!hdb || !bdb) { if (hdb) hdb.close(); if (bdb) bdb.close(); return null; }
    try {
        const h = (await all(hdb, `SELECT * FROM trades WHERE id = ? AND status = 'CLOSED'`, [hedgeId]))[0];
        if (!h) return null;
        const bases = await all(bdb, `SELECT * FROM trades WHERE entry_time <= ? ORDER BY entry_time DESC LIMIT 5`, [h.entry_time]);
        const b = bases.find(x => x.status === "OPEN" || (x.exit_time && x.exit_time >= h.entry_time)) || null;
        const sameDayPrior = (await all(hdb, `SELECT id, pnl FROM trades WHERE status = 'CLOSED' AND trade_date = ? AND id < ? ORDER BY id`, [h.trade_date, h.id]));
        const sibs = [];
        for (const o of pairGroups().filter(x => x.kind === g.kind && x.instrument === g.instrument && x.account !== g.account && g.kind === "PRICE_MA_HEDGE")) {
            const odb = await openRo(o.hedgeJournal); if (!odb) continue;
            try { for (const r of await all(odb, `SELECT * FROM trades WHERE status = 'CLOSED' AND entry_time <= ? AND exit_time >= ?`, [h.exit_time, h.entry_time])) sibs.push({ ...r, account: o.account }); } catch { /* no table */ }
            odb.close();
        }
        let oppBase = null;
        for (const o of pairGroups().filter(x => x.kind === g.kind && x.instrument === g.instrument && x.account !== g.account && g.kind === "PRICE_MA_HEDGE")) {
            const obdb = await openRo(o.baseJournal); if (!obdb) continue;
            try { const rows = await all(obdb, `SELECT * FROM trades WHERE entry_time <= ? ORDER BY entry_time DESC LIMIT 5`, [h.entry_time]); const r = rows.find(x => x.status === "OPEN" || (x.exit_time && x.exit_time >= h.entry_time)); if (r) oppBase = { ...r, account: o.account }; } catch { /* no table */ }
            obdb.close();
        }
        return { h, b, facts: buildPairFacts(g, h, b, sibs, sameDayPrior, oppBase) };
    } catch { return null; } finally { hdb.close(); bdb.close(); }
}

async function listPairs(limit = 40) {
    const out = [];
    for (const g of pairGroups()) {
        for (const journal of g.anchors) {
            const hdb = await openRo(journal); if (!hdb) continue;
            let rows = [];
            try { rows = await all(hdb, `SELECT id, exit_time FROM trades WHERE status = 'CLOSED' ORDER BY id DESC LIMIT ?`, [limit]); } catch { /* no table */ }
            hdb.close();
            for (const r of rows) out.push({ g, journal, id: r.id, exit_time: r.exit_time });
        }
    }
    out.sort((a, b) => String(b.exit_time || "").localeCompare(String(a.exit_time || "")));
    const reviews = await all(cache(), `SELECT journal, trade_id, status, review, error, created_at FROM ai_reviews WHERE journal LIKE 'PAIR:%'`);
    const byKey = new Map(reviews.map(r => [`${r.journal}#${r.trade_id}`, r]));
    const res = [];
    for (const x of out.slice(0, limit)) {
        const p = await loadPair(x.g, x.journal, x.id); if (!p) continue;
        const rv = byKey.get(`PAIR:${x.journal}#${x.id}`);
        res.push({ journal: x.journal, id: x.id, facts: p.facts, exitTime: p.h.exit_time,
            review: rv && rv.status === "OK" && !isStale(rv.review) ? JSON.parse(rv.review) : null,
            reviewError: rv && rv.status === "FAILED" ? rv.error : null, failedAt: rv && rv.status === "FAILED" ? rv.created_at : null });
    }
    return res;
}

const PAIR_TAGS = ["hedge_timely", "hedge_late", "hedge_protected_loss", "hedge_gave_back", "whipsaw_cycle", "flipflop_hedging", "forced_eod_close", "basis_risk", "clean_cycle", "hedge_closed_too_early", "unhedged_overnight"];
const DUAL_TAGS = ["good_entry", "stop_loss_hit", "take_profit_hit", "held_through_adverse_move", "opposite_leg_offset", "one_sided_exposure", "whipsaw_entry", "gave_back_profit", "carried_overnight", "slow_exit", "clean_win", "forced_eod_close"];
const DUAL_SYSTEM_PROMPT = `You review ONE closed trade of a TWO-ACCOUNT dual hedge from an algorithmic futures trading engine (MCX commodities), together with what the OPPOSITE account was doing at the same time. You are given verified facts computed by the system. All times are IST (Asia/Kolkata). Do not recompute or contradict the numbers; never invent prices, indicator values or market context. Anything you cannot judge goes ONLY in "limitations".
The setup (rules, not opinions): two separate broker accounts trade the SAME instrument. One account is LONG-only, the other SHORT-only, so together they form a hedge: when one loses the other tends to gain. Three variants exist (the journal only tells you "dual hedge" vs "dual bias hedge"; exit reasons tell the rest):
- Dual hedge (band-following): both accounts watch one Dynamic Step Band. The LONG account enters when flat and the band is green, the SHORT account when flat and the band is red. There is NO exit before the band turns against a held position ("flip"); after a flip the leg is exited by a take-profit ("... Exit") or a stop-loss ("... Exit SL") in rupees (or ATR). Positions are NRML and carried overnight; no end-of-day close.
- Dual bias hedge: one account is the CORE (side chosen by the daily Heikin-Ashi / daily band bias), the other account HEDGES when a faster band turns against the core and closes it when the band returns; at EOD both may be force-closed depending on the mode.
- Realize (profit-lock): LONG in the long account and SHORT in the short account at all times; when a leg's profit passes a threshold it is closed (realized) and the same side re-opened at once; the losing leg is never closed by the engine.
A single account's loss while the opposite account gains is by design — judge the PAIR of accounts, not one account's P&L alone.
How to read the facts: "hedge" = the trade under review (the key name is shared with other pair reviews). "opposite" = the other account's trades that overlapped it (statusNow OPEN = still open now; coversWholeWindow = it was held for the whole span of the reviewed trade). window.thisTradeRupees + window.oppositeAccountMoveDuringTradeRupees = pairNetDuringHedgeRupees: the two accounts' combined result over the reviewed trade's span (only present when the opposite position covered the whole span on the same contract). heldOvernight = the reviewed trade crossed an overnight carry. exitReason containing "SL" = stop-loss; "Exit" = take-profit exit; EOD_FORCE / EOD = scheduled close; peakPnl/troughPnl = observed unrealised extremes (null = data gap). dayContext shows earlier trades of the same account that day.
Grade the DECISIONS and rule adherence: A = behaved as designed and the two accounts together stayed controlled; B = acceptable with inefficiency; C = a clear problem visible in the facts (e.g. a long hold while one-sided, a large giveback, both accounts adverse). With thin evidence prefer B and explain.
Field meaning (the JSON keys are fixed): "entry_assessment" = this account's entry in the context of the opposite account; "trade_behaviour" = how the two accounts behaved together; "exit_assessment" = the exit.
"tags": pick 0-4 that clearly apply from this list only: ${DUAL_TAGS.join(", ")}.
Reply with ONLY this JSON:
{"grade":"A|B|C","entry_assessment":"1-2 sentences","trade_behaviour":"1-2 sentences","exit_assessment":"1-2 sentences","evidence":["fact -> conclusion"],"limitations":["what could not be judged"],"tags":["..."],"takeaway":"one line"}`;
const PAIR_SYSTEM_PROMPT = `You review ONE hedge cycle from an algorithmic futures trading engine (MCX commodities): a closed HEDGE trade together with the BASE (or CORE) position it was hedging. You are given verified facts computed by the system. All times are IST (Asia/Kolkata). Do not recompute or contradict the numbers; never invent prices, indicator values or market context. Anything you cannot judge goes ONLY in "limitations".
The strategies (rules, not opinions):
- Price-MA base-loss hedge (pairType "Price-MA base-loss hedge"): each account holds a constant base (LONG account long, SHORT account short, NRML, usually carried over many days and never closed by the engine). Every N minutes the engine checks the base's own P&L versus its entry price: base P&L below -band points -> open an OPPOSITE hedge (MIS) on the same account; base P&L back above +band -> close the hedge. At the EOD time the hedge is closed (before the broker's own square-off, which costs more); the base stays. The hedge may be on the next-expiry contract ("sameContract": false) which adds basis risk.
- Hedge pair (core + hedge, one account): an NRML core and an opposite MIS hedge opened by the engine's own rule (base-loss: core P&L below the band; or a daily/hourly band flip against the core) and closed when the rule releases it or at EOD.
A hedge is NOT meant to make money on its own: it is insurance that limits the base's loss while it is on. Judge the PAIR, not the hedge's P&L alone.
How to read the facts:
- window.baseP_LAtHedgeOpenPoints: the base's P&L (points) when the hedge opened; negative = the trigger. baseP_LAtHedgeClosePoints: when it closed. baseMoveDuringHedgeRupees = what the base gained/lost while the hedge was on; hedgePnlRupees = the hedge's result; pairNetDuringHedgeRupees = their sum (negative = the cycle cost money overall, near zero = the hedge froze the loss as intended). hedgeOffsetOfBaseLossPct = share of the base's loss during the window that the hedge made back.
- A hedge that loses while the base gains is the expected cost of insurance (whipsaw) — only call it a problem if the day shows repeated cycles (dayContext.hedgeCyclesBeforeThisToday, consecutiveLosingHedgesBefore) = flip-flop.
- exitReason EOD / EOD_FORCE = scheduled end-of-day close (a rule, not a market signal). hedgeExitKind "EOD_BASE_CARRIED" means the hedge was closed at EOD while the base stays OPEN (carried overnight): there is NO end of the cycle at EOD — the base carries on unhedged (baseStillOpenAfterHedgeClosePoints is where it stands; negative = overnight exposure to a base that is still losing) and the next session starts a fresh check. Do not describe that close as "locking in" a result or as the end of the trade; judge only whether the hedge did its job while it was on, and mention the unhedged overnight exposure when the base is still negative (tag unhedged_overnight).
- oppositeAccountHedgesOverlapping: the other account's hedges that overlapped this window (fullyInsideThisWindow tells whether they opened AND closed inside it). oppositeAccountBase = the other account's base (always the OPPOSITE side to this one: when one base loses the other gains). window.oppositeBaseMoveDuringHedgeRupees and window.twoAccountNetDuringHedgeRupees (see twoAccountNetNote) show both accounts together: the two bases roughly cancel, so judge whether the combined position stayed controlled, not just this account.
- peakPnl/troughPnl are the hedge's own observed unrealised extremes; null = data gap.
Grade the HEDGING DECISIONS and rule adherence: A = the hedge did its job (limited the base's loss, opened/closed in a timely way); B = acceptable with some inefficiency; C = a clear problem visible in the facts (late, flip-flopping, closed far too early, costly whipsaw). With thin evidence prefer B and explain.
Field meaning (the JSON keys are fixed): "entry_assessment" = hedge entry timing relative to the base's loss; "trade_behaviour" = how base and hedge behaved together (pair net); "exit_assessment" = hedge exit.
"tags": pick 0-4 that clearly apply from this list only: ${PAIR_TAGS.join(", ")}.
Reply with ONLY this JSON:
{"grade":"A|B|C","entry_assessment":"1-2 sentences","trade_behaviour":"1-2 sentences","exit_assessment":"1-2 sentences","evidence":["fact -> conclusion"],"limitations":["what could not be judged"],"tags":["..."],"takeaway":"one line"}`;

async function reviewPair(hedgeJournal, id, force = false) {
    const g = pairGroups().find(x => x.anchors.includes(hedgeJournal));
    const p = g ? await loadPair(g, hedgeJournal, id) : null;
    if (!p) throw Object.assign(new Error("closed hedge trade not found"), { status: 404 });
    const db = cache(), key = `PAIR:${hedgeJournal}`;
    if (!force) {
        const hit = (await all(db, `SELECT review FROM ai_reviews WHERE journal = ? AND trade_id = ? AND status = 'OK'`, [key, id]))[0];
        if (hit && !isStale(hit.review)) return JSON.parse(hit.review);
    }
    try {
        const dual = g.kind === "DUAL_HEDGE";
        const call = async () => validateReview(await callGemini(p.facts, { systemPrompt: dual ? DUAL_SYSTEM_PROMPT : PAIR_SYSTEM_PROMPT, label: dual ? "Verified dual-account trade facts:" : "Verified hedge-cycle facts:" }), dual ? DUAL_TAGS : PAIR_TAGS);
        let review;
        try { review = await call(); } catch (e) { if (!/validation|valid JSON/.test(e.message)) throw e; review = await call(); }
        await run(db, `INSERT OR REPLACE INTO ai_reviews (journal, trade_id, status, review, model) VALUES (?, ?, 'OK', ?, ?)`, [key, id, JSON.stringify(review), MODEL]);
        return review;
    } catch (e) {
        await run(db, `INSERT OR REPLACE INTO ai_reviews (journal, trade_id, status, error, model) VALUES (?, ?, 'FAILED', ?, ?)`, [key, id, e.message, MODEL]).catch(() => {});
        throw e;
    }
}

module.exports = { listTrades, reviewTrade, listPairs, reviewPair, buildPairFacts, pairGroups, PAIR_TAGS, DUAL_TAGS, buildFacts, validateReview, callGemini, journalFiles, openRo, all, cache, run, TAGS, MODEL };
