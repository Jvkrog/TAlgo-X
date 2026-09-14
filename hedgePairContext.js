// hedgePairContext.js — resolves one leg (core or hedge) of the hedge-pair
// strategy to a full context object: contract resolution (CSV repo +
// Contract Resolver, same path Add Instrument and engine.js both use) +
// buildContext() + the lots/lotMult overrides and refuse-to-boot guard
// hedgePairEngine.js needs live.
//
// Pulled out of hedgePairEngine.js so backtestHedgePair.js can resolve the
// exact same way instead of drifting into its own copy — a backtest that
// resolved a DIFFERENT contract/lotMult than live would run, or resolved
// the SAME lotMult bug live had before it was fixed, would be worse than
// no backtest at all (false confidence). Only contract/context resolution
// lives here — db/orders/telegram/state creation stays in
// hedgePairEngine.js, since a backtest replaces those with
// backtestLedger.js/backtestBroker.js/a no-op tg/createState() instead.
"use strict";

const c = require("./c");
const { getDefinition, buildContext } = require("./context");

// legLabel: "CORE" | "HEDGE" — only used for tgPrefix/name suffixing and
// error messages, not for any logic branch.
function resolveHedgePairLeg({ underlying, legLabel, exchange, csvRepo, pinStore, lots, lotMultOverride }) {
    const { resolveCurrent } = require("./instrumentResolution"); // lazy — avoids a require cycle risk if this file is ever required from instrumentResolution's own dependency chain
    const def = getDefinition(underlying, exchange);
    const { contract, source } = resolveCurrent(def.underlying, def, csvRepo, pinStore);
    const context = buildContext(def, contract);

    context.tgPrefix = `${context.tgPrefix}_${legLabel}`;
    context.name     = `${context.name} (${legLabel})`;
    // Telegram display label ONLY — see telegram.js's tgPrefixFor() header
    // comment for why this doesn't touch context.strategy itself. Written
    // to actually match what each leg's own trigger is (not "DPI Trend",
    // which this engine has never run): CORE decides off the daily HA
    // candle alone (no Dynamic Band involved in that decision at all);
    // HEDGE fires off the hourly HA candle CONFIRMED by the Dynamic Band
    // (see dynamicBandReader.js / hedgePairEngine.js's checkHedge()).
    context.tgLabel = legLabel === "CORE"
        ? "Hedge Pair Core (Daily HA)"
        : "Hedge Pair Hedge (Hourly HA + Dynamic Band)";
    context.lots      = lots;
    if (lotMultOverride) context.lotMult = lotMultOverride;
    // dailyHaGate.js (orders.js's universal gate, wired Sep 2026) blocks
    // any entry whose side disagrees with the previous daily HA candle.
    // The HEDGE leg's entire purpose is to open COUNTER to that same
    // daily-implied direction the moment the hourly read disagrees with
    // the core — leaving this gate on for the hedge leg would silently
    // block it from ever doing its job. The CORE leg deliberately keeps
    // it on (default, untouched here) — its own entry logic already IS
    // the daily HA decision, so the gate can never actually disagree
    // with it there; only the hedge leg needs the exemption.
    if (legLabel === "HEDGE") context.dailyHaGateEnabled = false;
    // See hedgePairEngine.js's header: both legs are force-closed by that
    // file's own EOD block every day, unconditionally — NRML here is
    // about margin treatment (matching the "1 full lot NRML" spec), not
    // about whether the bot bothers to exit.
    context.carryOvernight = true;
    // Fixed at 23:15 IST specifically for this strategy — explicitly
    // requested (15 min later than defaultEodFor("1h","MCX")'s general
    // 23:00 default used by every other strategy). Hardcoded here rather
    // than routed through defaultEodFor() so this doesn't change the EOD
    // time for anything else.
    context.eodHour   = 23;
    context.eodMinute = 15;

    // Same refuse-to-boot guard as engine.js/hedgePairEngine.js — no
    // fallback to the broker's own lot_size field (a contract COUNT, not
    // a price multiplier — see context.js's header comment for the
    // incident this already caused once live).
    if (!context.lotMult) {
        console.error(c.red(`[${context.tgPrefix}] lotMult is not set for ${underlying} — refusing to proceed.`));
        console.error(c.red(`  Fix: add a lotMult override for "${underlying}" in context.js's overrides,`));
        console.error(c.red(`  or pass a lotMult override explicitly (${legLabel === "CORE" ? "CORE_LOTMULT_OVERRIDE" : "HEDGE_LOTMULT_OVERRIDE"} live, or the equivalent backtest prompt).`));
        throw new Error(`resolveHedgePairLeg: lotMult not set for ${underlying}`);
    }

    return { context, source };
}

module.exports = { resolveHedgePairLeg };
