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
function choice(input, choices, def, label) {
    const k = input.trim().toUpperCase();
    if (k === "") return def;
    if (!(k in choices)) throw new Error(`invalid ${label} "${input}" (${Object.keys(choices).join(" / ")})`);
    return choices[k];
}
function tf(input, tfs, def, label) {
    const v = input.trim().toLowerCase();
    if (v === "") return def;
    if (!tfs.includes(v)) throw new Error(`invalid ${label} "${input}" (${tfs.join("/")})`);
    return v;
}

async function main() {
    console.log(c.bold("Dual Hedge Backtest"));
    console.log(c.dim("one instrument, LONG-only account + SHORT-only account"));
    console.log(c.dim("  D = Dual: each account trades its own side off ONE signal (range-bar band or HA); carries overnight; exits arm after a flip"));
    console.log(c.dim("  B = Bias hedge: previous daily HA candle sets the core account (green = LONG acct, red = SHORT acct); the OTHER account hedges"));
    console.log(c.dim("      when the Dynamic Band (default 15m) turns against the core; both flat at EOD (hedge-pair style)"));
    console.log();

    const underlying = (await ask("  underlying (e.g. NATGASMINI, ZINCMINI): ")).trim().toUpperCase();
    const exchange   = (await ask("  exchange [MCX]: ")).trim().toUpperCase() || "MCX";
    const lots       = num((await ask("  lots per leg [1]: ")).trim(), 1, "lots");
    const lmIn       = (await ask(`  lotMult (blank = context.js's override for ${underlying}, if any): `)).trim();
    const lotMultOverride = lmIn ? num(lmIn, null, "lotMult") : null;
    const strategy   = choice(await ask("  strategy [D/B, default D]: "), { D: "DUAL", B: "BIAS" }, "DUAL", "strategy");

    const opts = { strategy };
    if (strategy === "BIAS") {
        opts.unwindMode    = choice(await ask("  unwind: B = band back in the core's favour closes the hedge, E = hold to EOD [B]: "), { B: "BAND_FLIP", E: "EOD_ONLY" }, "BAND_FLIP", "unwind");
        opts.bandTimeframe = tf(await ask("  Dynamic Band timeframe (5m/15m/30m/1h) [15m]: "), ["5m", "15m", "30m", "1h"], "15m", "band timeframe");
        const bsIn = (await ask("  band step override (blank = engine default): ")).trim();
        opts.bandStepOverride = bsIn ? num(bsIn, null, "band step") : null;
        const t = parseTime((await ask("  core entry time IST, decided once a day [10:00]: ")).trim(), 10, 0);
        opts.entryHour = t.hour; opts.entryMinute = t.minute;
    } else {
        opts.slMode = choice(await ask("  stop-loss: R = rupees, A = ATR multiple from entry [R]: "), { R: "RUPEES", A: "ATR" }, "RUPEES", "stop-loss mode");
        if (opts.slMode === "ATR") {
            const mIn = (await ask(`  ATR stop multiplier (blank = default ${engineConfig.ATR_SL_MULT}): `)).trim();
            opts.atrSlMult = mIn ? num(mIn, null, "ATR multiplier") : null;
            opts.atrTimeframe = tf(await ask("  ATR timeframe (5m/15m/30m/1h) [15m]: "), ["5m", "15m", "30m", "1h"], "15m", "ATR timeframe");
            opts.maxLoss = num((await ask("  rupee backstop while ATR isn't available yet ₹ [3000]: ")).trim(), 3000, "max loss");
        } else {
            opts.maxLoss = num((await ask("  stop: exit a flipped leg when loss exceeds ₹ [3000]: ")).trim(), 3000, "max loss");
        }
        opts.takeProfit = num((await ask("  take profit: exit a flipped leg when profit exceeds ₹ [3000]: ")).trim(), 3000, "take profit");
        opts.signalSource = choice(await ask("  signal source: R = range bars + Dynamic Step Band (live engine), H = Heikin-Ashi from Kite's own bars [R]: "), { R: "RANGE", H: "HA" }, "RANGE", "signal source");
        if (opts.signalSource === "HA") {
            opts.haTimeframe = tf(await ask("  HA timeframe (5m/15m/30m/1h/1d) [1h]: "), ["5m", "15m", "30m", "1h", "1d"], "1h", "HA timeframe");
        } else {
            const bsIn = (await ask("  band step override (blank = engine default): ")).trim();
            const rsIn = (await ask("  range bar size (blank = same as band step): ")).trim();
            opts.bandStepOverride  = bsIn ? num(bsIn, null, "band step") : null;
            opts.rangeSizeOverride = rsIn ? num(rsIn, null, "range size") : null;
        }
        if ((await ask("  model gap capture? [Y/N, default N]: ")).trim().toUpperCase() === "Y") {
            opts.gapCapture = true;
            const g = parseTime((await ask("  gap capture time IST [23:20]: ")).trim(), 23, 20);
            const q = parseTime((await ask("  quit time IST [23:25]: ")).trim(), 23, 25);
            opts.gcHour = g.hour; opts.gcMinute = g.minute; opts.gcQuitHour = q.hour; opts.gcQuitMinute = q.minute;
        }
    }
    const slippagePoints = num((await ask("  slippage per order, in price points [0]: ")).trim(), 0, "slippage", { positive: false });
    const from = parseDate(await ask("  from (YYYY-MM-DD): "), "from");
    const to   = parseDate(await ask("  to   (YYYY-MM-DD): "), "to");
    rl.close();

    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(engineConfig.getAccessToken());

    console.log();
    console.log(c.dim("  fetching history + running replay..."));
    const { report, paths } = await runDualHedgeBacktest({
        underlying, exchange, lots, lotMultOverride, slippagePoints, from, to, kc, ...opts,
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
