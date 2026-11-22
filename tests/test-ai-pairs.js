// Hedge-pair AI review: pairing of a closed hedge trade with its base, deterministic window maths, singles exclusion, prompt/tag plumbing (no Gemini call).
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), sqlite3 = require("sqlite3");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aipairs-")); process.env.TALGO_DB_DIR = dir;
const mk = (f, rows) => new Promise(r => { const d = new sqlite3.Database(path.join(dir, f)); d.serialize(() => {
    d.run("CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT,engine TEXT,instrument TEXT,side TEXT,qty INTEGER,entry_price REAL,entry_time TEXT,exit_price REAL,exit_time TEXT,pnl REAL,exit_reason TEXT,status TEXT,trade_date TEXT,ctx TEXT,peak_pnl REAL,trough_pnl REAL,entry_ctx TEXT)");
    for (const x of rows) d.run("INSERT INTO trades(engine,instrument,side,qty,entry_price,entry_time,exit_price,exit_time,pnl,exit_reason,status,trade_date,ctx) VALUES('E',?,?,?,?,?,?,?,?,?,?,?,?)", x);
    d.close(r); }); });
const ctx = JSON.stringify({ strategy: "PRICE_MA_HEDGE", lots: 1, lotMult: 250 });
(async () => {
    // LONG account: carried base long @350 (open since 19 Nov); hedge SHORT 340 -> 330 (+10pts x250 = +2500) on 20 Nov
    await mk("natgasmini_price_ma_hedge_long_base_vamshi_range.db", [["NATGASMINI26DECFUT", "LONG", 1, 350, "2026-11-19T04:00:00.000Z", null, null, null, null, "OPEN", "2026-11-19", null]]);
    await mk("natgasmini_price_ma_hedge_long_hedge_vamshi_range.db", [["NATGASMINI26DECFUT", "SHORT", 1, 340, "2026-11-20T05:00:00.000Z", 330, "2026-11-20T10:00:00.000Z", 2500, "core back in profit", "CLOSED", "2026-11-20", ctx]]);
    await mk("natgasmini_price_ma_hedge_short_base_amulya_range.db", [["NATGASMINI26DECFUT", "SHORT", 1, 350, "2026-11-19T04:00:00.000Z", null, null, null, null, "OPEN", "2026-11-19", null]]);
    await mk("natgasmini_price_ma_hedge_short_hedge_amulya_range.db", [["NATGASMINI26DECFUT", "LONG", 1, 335, "2026-11-20T06:00:00.000Z", 339, "2026-11-20T09:00:00.000Z", 1000, "EOD", "CLOSED", "2026-11-20", ctx]]);
    await mk("zincmini_dpi_trend_meanrev_ha.db", [["ZINCMINI26NOVFUT", "LONG", 1, 100, "2026-11-20T04:00:00.000Z", 101, "2026-11-20T05:00:00.000Z", 10, "EOD", "CLOSED", "2026-11-20", JSON.stringify({ strategy: "DPI_TREND_MEANREV" })]]);
    const dctx = JSON.stringify({ strategy: "DUAL_HEDGE", lots: 1, lotMult: 250 });
    await mk("natgasmini_dual_hedge_long_vamshi_range.db", [["NATGASMINI26DECFUT", "LONG", 1, 340, "2026-11-20T05:00:00.000Z", 345, "2026-11-20T08:00:00.000Z", 1250, "Long Exit", "CLOSED", "2026-11-20", dctx]]);
    await mk("natgasmini_dual_hedge_short_amulya_range.db", [["NATGASMINI26DECFUT", "SHORT", 1, 342, "2026-11-19T04:00:00.000Z", null, null, null, null, "OPEN", "2026-11-19", null]]);
    const ai = require("../ai/aiReview");
    const singles = await ai.listTrades(20);
    assert.deepStrictEqual([...new Set(singles.map(t => t.journal))], ["zincmini_dpi_trend_meanrev_ha.db"], "hedge legs are not reviewed as lone trades");
    assert.strictEqual(ai.pairGroups().length, 3, "two Price-MA accounts + one dual group");
    const pairs = await ai.listPairs(10);
    assert.strictEqual(pairs.length, 3, "2 Price-MA hedge cycles + 1 dual trade");
    const lg = pairs.find(p => p.facts.account.startsWith("LONG") && !p.facts.isDual).facts;
    assert.strictEqual(lg.base.side, "LONG"); assert.strictEqual(lg.base.daysHeldWhenHedgeOpened, 1);
    assert.strictEqual(lg.sameContract, true);
    assert.strictEqual(lg.window.baseP_LAtHedgeOpenPoints, -10, "base 350 -> hedge opened at 340 = -10 pts");
    assert.strictEqual(lg.window.baseP_LAtHedgeClosePoints, -20);
    assert.strictEqual(lg.window.baseMoveDuringHedgeRupees, -2500, "base lost 10 pts x 250 while hedge was on");
    assert.strictEqual(lg.window.pairNetDuringHedgeRupees, 0, "hedge fully froze the loss");
    assert.strictEqual(lg.window.hedgeOffsetOfBaseLossPct, 100);
    assert.strictEqual(lg.oppositeAccountHedgesOverlapping.length, 1, "the other account's hedge overlapped");
    assert.strictEqual(lg.oppositeAccountBase.side, "SHORT", "other account's base is the opposite side");
    assert.strictEqual(lg.window.oppositeBaseMoveDuringHedgeRupees, 2500, "short base gained 10 pts x 250 while this hedge was on");
    assert.strictEqual(lg.window.twoAccountNetDuringHedgeRupees, 3500, "pair net 0 + other base +2500 + the other account's hedge fully inside (+1000)");
    const dl = pairs.find(p => p.facts.isDual);
    assert.ok(dl, "dual hedge trade shows up as a pair");
    assert.strictEqual(dl.facts.opposite.length, 1); assert.strictEqual(dl.facts.opposite[0].statusNow, "OPEN"); assert.strictEqual(dl.facts.opposite[0].coversWholeWindow, true);
    assert.strictEqual(dl.facts.window.oppositeAccountMoveDuringTradeRupees, -1250); assert.strictEqual(dl.facts.window.pairNetDuringHedgeRupees, 0);
    assert.ok(!(await ai.listTrades(20)).some(t => /dual_hedge/.test(t.journal)), "paired dual hedge journals are not lone trades");
    const sg = pairs.find(p => p.facts.account.startsWith("SHORT") && !p.facts.isDual).facts;
    assert.strictEqual(sg.window.baseP_LAtHedgeOpenPoints, 15, "short base 350, hedge opened at 335 = +15 pts (in profit)");
    assert.ok(ai.PAIR_TAGS.includes("hedge_protected_loss"));
    assert.deepStrictEqual(ai.validateReview(JSON.stringify({ grade: "A", entry_assessment: "x", exit_assessment: "y", takeaway: "z", tags: ["clean_cycle", "bogus", "good_entry"] }), ai.PAIR_TAGS).tags, ["clean_cycle"], "only pair tags survive");
    console.log("ai pairs test passed"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
