// test-ai.js — end-to-end check of entry snapshots, day context, limiter events, summary and (stubbed) narration.
// Run: node test-ai.js
process.env.TALGO_DB_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "talgo-ai-"));
const assert = require("assert");
const { createDb } = require("./db");
const { snapshot } = require("./entrySnapshot");
(async () => {
  const context = { name: "ZNC", strategy: "DYNAMIC_BAND", candleType: "HA", tgPrefix: "ZNC", symbol: "ZNC", token: 1, lots: 1, lotMult: 1, timeframe: "1h", chopPeriod: 14 };
  const db = createDb(context); await db.initDB();
  const bars = Array.from({ length: 30 }, (_, i) => ({ open: 100 + i % 3, high: 102 + i % 4, low: 99 - i % 2, close: 101 + (i % 5) - 2 }));
  const candles = { getRawCandles: () => bars };
  const state = { pnl: -500, trades: 1, bandHigh: 105, bandMid: 102, bandLow: 99 };
  const mk = async (side, px, exitPx, reason) => {
    const id = await db.insertOpenTrade("ZNC", "ZNC", side, 1, px);
    await db.setEntryContext(id, snapshot({ context, engineConfig: { CHOP_LEN: 14 }, state, candles, side, price: px }));
    await db.closeTrade(id, exitPx, (exitPx - px) * (side === "LONG" ? 1 : -1), reason, { peakPnl: 50, troughPnl: -300, ctx: { strategy: "DYNAMIC_BAND", timeframe: "1h", candleType: "HA" } });
    return id;
  };
  await mk("LONG", 106, 103, "LONG REVERSAL"); await mk("SHORT", 103, 106, "SHORT REVERSAL"); await mk("LONG", 106, 108, "EOD_FORCE");
  await db.logRiskEvent("ZNC", new Date(Date.now() + 5.5*3600000).toISOString().slice(0,10), "LOSING_REVERSALS_LIMIT", { count: 2, max: 1 });
  const ai = require("./aiReview"), sum = require("./aiSummary");
  const list = await ai.listTrades(10);
  assert.strictEqual(list.length, 3);
  const last = list[0].facts; console.log(JSON.stringify(last.entryContext), JSON.stringify(last.dayContext));
  assert.ok(last.entryContext.priceVsBand && last.entryContext.chop !== undefined);
  assert.strictEqual(last.dayContext.tradeNumberToday, 3); assert.strictEqual(last.dayContext.consecutiveLossesBefore, 2);
  const s = await sum.buildSummary(7);
  console.log(JSON.stringify({ trades: s.trades, net: s.netPnl, streak: s.worstLosingStreakInADay, limiter: s.limiterDays, exc: s.excursion }));
  assert.strictEqual(s.trades, 3); assert.strictEqual(s.limiterDays.length, 1); assert.strictEqual(s.worstLosingStreakInADay.length, 2);
  // narration with stubbed Gemini
  ai.callGemini = async () => JSON.stringify({ headline: "h", patterns: [{ finding: "f", evidence: "e" }], limiter_assessment: "l", suggestions: ["s"], limitations: ["x"] });
  console.log(await sum.narrate(s, true));
  // backtest facts + narration (stubbed Gemini)
  const rep = { instrument: "ZNC", strategy: "DYNAMIC_BAND", timeframe: "1h", range: { from: "2026-09-10", to: "2026-09-11" }, settings: [["Candles", "HA"]], params: {},
    metrics: { trades: 3, winRate: 0, profitFactor: 0, netPnL: -4162.5, netPoints: -4.16, maxDrawdown: 4162.5, largestWin: 0, largestLoss: -1712.5, avgTrade: -1387.5, avgHoldTimeMs: 9600000 },
    trades: [
      { status: "CLOSED", side: "SHORT", entry_time: "2026-09-11T04:30:00Z", exit_time: "2026-09-11T05:30:00Z", pnl: -1700, exit_reason: "COLOR FLIP EXIT" },
      { status: "CLOSED", side: "LONG", entry_time: "2026-09-11T05:30:00Z", exit_time: "2026-09-11T08:30:00Z", pnl: -1712.5, exit_reason: "COLOR FLIP EXIT" },
      { status: "CLOSED", side: "SHORT", entry_time: "2026-09-11T08:30:00Z", exit_time: "2026-09-11T12:30:00Z", pnl: -750, exit_reason: "COLOR FLIP EXIT" }],
    losingSwitch: { max: 1, losingReversals: 2, blockedReversals: 1, daysExhausted: 1 } };
  const bf = sum.backtestFacts(rep);
  assert.strictEqual(bf.longestLosingStreak.trades, 3); assert.strictEqual(bf.metrics.winRatePct, 0); assert.strictEqual(bf.limiter.max, 1);
  assert.strictEqual(bf.byEntryHourIst[0].key, "10:00");
  console.log((await sum.narrateBacktest(rep, true)).headline);
  console.log("OK"); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
