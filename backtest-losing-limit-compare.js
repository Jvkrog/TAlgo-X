#!/usr/bin/env node
// backtest-losing-limit-compare.js — runs the same backtest three times through a running WebDash and compares
//   A = no limit   B = max 1 losing reversal/day   C = max 2 losing reversals/day
// Usage:
//   node backtest-losing-limit-compare.js --underlying ZINCMINI26OCTFUT --strategy DYNAMIC_BAND --timeframe 5m \
//        --from 2026-08-15 --to 2026-10-10 [--exchange MCX] [--candleType HA] [--bandStep 1] [--lotMult 100] [--day 2026-09-11]
// Env: WEBDASH_URL (default http://localhost:4790), WEBDASH_PIN (only if the dashboard is PIN-locked).
// Needs live Kite access on the WebDash host (history comes from Kite). P&L is the backtester's gross figure:
// single-instrument backtests have no brokerage/slippage model, so net-of-cost P&L is NOT reported.
"use strict";
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
for (const k of ["underlying", "strategy", "timeframe", "from", "to"]) if (!args[k]) { console.error(`missing --${k}`); process.exit(1); }
const BASE = (process.env.WEBDASH_URL || "http://localhost:4790").replace(/\/$/, "");
const istDay = iso => new Date(new Date(iso).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);

async function main() {
    let cookie = "";
    if (process.env.WEBDASH_PIN) {
        const r = await fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: process.env.WEBDASH_PIN }) });
        if (!r.ok) throw new Error("PIN rejected");
        cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    }
    const hdr = { "Content-Type": "application/json", Cookie: cookie };
    const variants = [["A  no limit", undefined], ["B  max 1/day", 1], ["C  max 2/day", 2]];
    const out = [];
    for (const [label, max] of variants) {
        const body = { underlying: args.underlying, exchange: args.exchange || "MCX", strategy: args.strategy, timeframe: args.timeframe,
            from: args.from, to: args.to, candleType: args.candleType, lotMultOverride: args.lotMult, maxLosingSwitches: max };
        if (args.bandStep) body.params = { BAND_STEP_DEFAULT: Number(args.bandStep) };
        const r = await fetch(`${BASE}/api/toolbox/backtest`, { method: "POST", headers: hdr, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(`${label}: ${j.error || r.status}`);
        const rep = await (await fetch(BASE + j.jsonUrl, { headers: hdr })).json();
        const day = args.day ? rep.trades.filter(t => istDay(t.entry_time) === args.day) : null;
        out.push({ label, s: j.summary, ls: j.losingSwitch, day });
    }
    const f = v => (v === null || v === undefined) ? "-" : (v === Infinity ? "inf" : Number(v).toFixed(2));
    console.log(`\n${args.underlying} ${args.strategy} ${args.timeframe}  ${args.from} -> ${args.to}   (gross P&L, no cost model)\n`);
    console.log("variant        trades  win%   PF     netPnL      maxDD       losingRev  blocked  daysExhausted");
    for (const o of out) {
        console.log([o.label.padEnd(14), String(o.s.trades).padStart(6), (o.s.winRate * 100).toFixed(1).padStart(6), f(o.s.profitFactor).padStart(6),
            f(o.s.netPnL).padStart(11), f(o.s.maxDrawdown).padStart(11), String(o.ls ? o.ls.losingReversals : "n/a").padStart(10),
            String(o.ls ? o.ls.blockedReversals : "n/a").padStart(8), String(o.ls ? o.ls.daysExhausted : "n/a").padStart(14)].join(" "));
    }
    if (args.day) {
        console.log(`\n${args.day} (IST) trades per variant:`);
        for (const o of out) console.log(`  ${o.label}: ${o.day.length} trades, net ${f(o.day.reduce((a, t) => a + (t.pnl || 0), 0))}`);
    }
    console.log("\nNote: trending vs consolidating split is not computed (the backtester has no regime labels).");
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
