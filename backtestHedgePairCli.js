// backtestHedgePairCli.js — standalone prompt-driven runner for
// backtestHedgePair.js. NOT wired into toolbox.js's own [B] Backtest
// Strategy wizard (backtestFlow.js) — that wizard's whole shape (Step 1
// strategy picker, single underlying, single timeframe) assumes ONE
// instrument, and folding a fundamentally two-instrument flow into it
// would either complicate every other strategy's path through it or
// require a parallel branch for just this one case. This is that
// parallel branch, kept separate, run directly:
//
//   node backtestHedgePairCli.js
//
// Toolbox/webdash menu integration (so this doesn't need to be launched
// by hand) is the separate follow-up already flagged in chat.
"use strict";

const fs = require("fs");
const readline = require("readline");
const { KiteConnect } = require("kiteconnect");
const engineConfig = require("./engineConfig");
const c = require("./c");
const { runHedgePairBacktest } = require("./backtestHedgePair");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(resolve => rl.question(q, resolve)); }

function parseDate(input, label) {
    const d = new Date(input);
    if (isNaN(d.getTime())) throw new Error(`invalid ${label} date: "${input}" (use YYYY-MM-DD)`);
    return d;
}

async function main() {
    console.log(c.bold("Hedge Pair Backtest"));
    console.log(c.dim("core: full-size contract, daily-HA bias, 1 lot NRML, EOD-only exit"));
    console.log(c.dim("hedge: mini contract, opens on adverse 1h HA, 5:1 ratio by default"));
    console.log();

    const coreUnderlying  = (await ask("  core underlying (e.g. NATURALGAS, ZINC): ")).trim().toUpperCase();
    const hedgeUnderlying = (await ask("  hedge underlying (e.g. NATGASMINI, ZINCMINI): ")).trim().toUpperCase();
    const exchange        = (await ask("  exchange [MCX]: ")).trim().toUpperCase() || "MCX";

    const coreLotsIn  = (await ask("  core lots [1]: ")).trim();
    const hedgeLotsIn = (await ask("  hedge lots [5]: ")).trim();
    const coreLots  = coreLotsIn  ? Number(coreLotsIn)  : 1;
    const hedgeLots = hedgeLotsIn ? Number(hedgeLotsIn) : 5;

    console.log(c.dim("  lotMult is the REAL contract multiplier, not the broker's lot_size field —"));
    console.log(c.dim("  e.g. NATURALGAS=1250, NATGASMINI=250, ZINC=5000, ZINCMINI=1000. Verify against"));
    console.log(c.dim("  the current exchange spec before trusting these for anything beyond a backtest."));
    const coreLotMultIn  = (await ask(`  core lotMult (blank = use context.js's override for ${coreUnderlying}, if any): `)).trim();
    const hedgeLotMultIn = (await ask(`  hedge lotMult (blank = use context.js's override for ${hedgeUnderlying}, if any): `)).trim();
    const coreLotMultOverride  = coreLotMultIn  ? Number(coreLotMultIn)  : null;
    const hedgeLotMultOverride = hedgeLotMultIn ? Number(hedgeLotMultIn) : null;

    const unwindModeIn = (await ask("  unwind mode [HA_FLIP / EOD_ONLY] (default HA_FLIP): ")).trim().toUpperCase();
    const unwindMode = unwindModeIn || "HA_FLIP";

    const fromIn = await ask("  from (YYYY-MM-DD): ");
    const toIn   = await ask("  to   (YYYY-MM-DD): ");
    const from = parseDate(fromIn, "from");
    const to   = parseDate(toIn,   "to");

    rl.close();

    const ACCESS_TOKEN = fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim();
    const kc = new KiteConnect({ api_key: engineConfig.API_KEY });
    kc.setAccessToken(ACCESS_TOKEN);

    console.log();
    console.log(c.dim("  fetching historical data + running replay..."));

    const { report, paths } = await runHedgePairBacktest({
        coreUnderlying, hedgeUnderlying, exchange,
        coreLots, hedgeLots, coreLotMultOverride, hedgeLotMultOverride,
        unwindMode, from, to, kc,
        progress: (done, total) => process.stdout.write(`\r  ${done}/${total} core 1h bars...`),
    });

    console.log();
    console.log();
    console.log(c.bold(`Combined: ${report.metrics.combined.trades} trades, ${(report.metrics.combined.winRate * 100).toFixed(1)}% win rate, net ${report.metrics.combined.netPnL.toFixed(2)}`));
    console.log(c.dim(`  core  (${report.core.symbol}):  ${report.metrics.core.trades} trades, net ${report.metrics.core.netPnL.toFixed(2)}`));
    console.log(c.dim(`  hedge (${report.hedge.symbol}): ${report.metrics.hedge.trades} trades, net ${report.metrics.hedge.netPnL.toFixed(2)}`));
    console.log();
    console.log(c.dim(`  report: ${paths.htmlPath}`));
    console.log(c.dim(`  json:   ${paths.jsonPath}`));
}

main().catch(err => {
    console.error(c.red(`BACKTEST FAILED: ${err.message}`));
    rl.close();
    process.exit(1);
});
