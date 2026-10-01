// backtestDualHedgeCli.js — standalone prompt-driven runner for
// backtestDualHedge.js (same role backtestHedgePairCli.js plays for the
// hedge pair). The same flow is also reachable from toolbox.js's Dual Hedge
// screen (T); this file exists so it can be launched by hand:
//
//   node backtestDualHedgeCli.js
//
// Market data is account-agnostic, so the global account (engineConfig) is
// used — no Dual Hedge users are needed to backtest.
"use strict";

const readline = require("readline");
const { KiteConnect } = require("kiteconnect");
const engineConfig = require("./engineConfig");
const c = require("./c");
const { runDualHedgeBacktest } = require("./backtestDualHedge");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(resolve => rl.question(q, resolve)); }

function parseDate(input, label) {
    const d = new Date(input);
    if (isNaN(d.getTime())) throw new Error(`invalid ${label} date: "${input}" (use YYYY-MM-DD)`);
    return d;
}
function num(input, def, label, { positive = true } = {}) {
    if (input === "") return def;
    const n = Number(input);
    if (!Number.isFinite(n) || (positive ? n <= 0 : n < 0)) throw new Error(`invalid ${label}: "${input}"`);
    return n;
}
function parseTime(input, dh, dm) {
    if (!input) return { hour: dh, minute: dm };
    const m = input.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`invalid time "${input}" (use HH:MM)`);
    return { hour: Number(m[1]), minute: Number(m[2]) };
}

async function main() {
    console.log(c.bold("Dual Hedge Backtest"));
    console.log(c.dim("one instrument, LONG-only account + SHORT-only account, Dynamic Step Band on range bars"));
    console.log(c.dim("positions carry overnight; exits arm only after a leg's own first adverse flip"));
    console.log();

    const underlying = (await ask("  underlying (e.g. NATGASMINI, ZINCMINI): ")).trim().toUpperCase();
    const exchange   = (await ask("  exchange [MCX]: ")).trim().toUpperCase() || "MCX";
    const lots       = num((await ask("  lots per leg [1]: ")).trim(), 1, "lots");
    const lmIn       = (await ask(`  lotMult (blank = context.js's override for ${underlying}, if any): `)).trim();
    const lotMultOverride = lmIn ? num(lmIn, null, "lotMult") : null;
    const maxLoss    = num((await ask("  stop: exit a flipped leg when loss exceeds ₹ [3000]: ")).trim(), 3000, "max loss");
    const takeProfit = num((await ask("  take profit: exit a flipped leg when profit exceeds ₹ [3000]: ")).trim(), 3000, "take profit");
    const bsIn       = (await ask("  band step override (blank = engine default): ")).trim();
    const rsIn       = (await ask("  range bar size (blank = same as band step): ")).trim();
    const bandStepOverride  = bsIn ? num(bsIn, null, "band step") : null;
    const rangeSizeOverride = rsIn ? num(rsIn, null, "range size") : null;
    const slippagePoints = num((await ask("  slippage per order, in price points [0]: ")).trim(), 0, "slippage", { positive: false });

    let gapCapture = false, gcHour = 23, gcMinute = 20, gcQuitHour = 23, gcQuitMinute = 25;
    if ((await ask("  model gap capture? [Y/N, default N]: ")).trim().toUpperCase() === "Y") {
        gapCapture = true;
        ({ hour: gcHour, minute: gcMinute } = parseTime((await ask("  gap capture time IST [23:20]: ")).trim(), 23, 20));
        ({ hour: gcQuitHour, minute: gcQuitMinute } = parseTime((await ask("  quit time IST [23:25]: ")).trim(), 23, 25));
    }

    const from = parseDate(await ask("  from (YYYY-MM-DD): "), "from");
    const to   = parseDate(await ask("  to   (YYYY-MM-DD): "), "to");
    rl.close();

    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(engineConfig.getAccessToken());

    console.log();
    console.log(c.dim("  fetching 1-minute history + running replay..."));
    const { report, paths } = await runDualHedgeBacktest({
        underlying, exchange, lots, lotMultOverride, bandStepOverride, rangeSizeOverride,
        takeProfit, maxLoss, gapCapture, gcHour, gcMinute, gcQuitHour, gcQuitMinute,
        slippagePoints, from, to, kc,
        progress: (a, b) => process.stdout.write(typeof a === "string" ? `\r  ${a}   ` : `\r  ${a}/${b} candles...`),
    });

    const m = report.metrics, t = report.mtm;
    console.log("\n");
    console.log(c.bold(`Combined: ${m.combined.trades} trades, ${(m.combined.winRate * 100).toFixed(1)}% win rate, net ${m.combined.netPnL.toFixed(2)}`));
    console.log(c.dim(`  LONG  acct: ${m.long.trades} trades, net ${m.long.netPnL.toFixed(2)}`));
    console.log(c.dim(`  SHORT acct: ${m.short.trades} trades, net ${m.short.netPnL.toFixed(2)}`));
    console.log(c.bold(`MTM max drawdown: ${t.maxDrawdown.toFixed(2)}   worst unrealized  LONG ${t.worstUnrealized.LONG.toFixed(0)}  SHORT ${t.worstUnrealized.SHORT.toFixed(0)}`));
    console.log();
    console.log(c.dim(`  report: ${paths.htmlPath}`));
    console.log(c.dim(`  json:   ${paths.jsonPath}`));
}

main().catch(err => {
    console.error(c.red(`BACKTEST FAILED: ${err.message}`));
    rl.close();
    process.exit(1);
});
