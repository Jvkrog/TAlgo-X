// context.js — Instrument identity.
//
// CHANGED (this pass): instruments are no longer pre-registered by a made-up
// key ("natgasMini"). The toolbox now browses the broker's own instrument
// dump (via csvRepository.js) and lets you pick ANY underlying directly —
// so this file no longer needs a new entry added every time you want to
// try a new instrument.
//
// `overrides` is keyed by the broker's own `underlying` name (e.g.
// "NATGASMINI") — used both for genuine preference overrides (custom roll
// policy, Telegram prefix, EOD time) AND, critically, for lotMult: the
// broker's `lot_size` field is a contract COUNT, not a reliable price
// multiplier (confirmed twice now against real MCX instrument dumps — see
// the NATGASMINI entry below, and the same lot_size=1 pattern shows up on
// ALUMINI too). There is deliberately NO fallback to lot_size anymore —
// lotMult stays null if unset, and engine.js refuses to boot rather than
// silently trusting a number that's already caused a real PnL bug once.
"use strict";

const { daysBeforeExpiryPolicy } = require("./rollPolicies");
const { STRATEGY_TIMEFRAME } = require("./strategies");

const DEFAULT_ROLL_POLICY = daysBeforeExpiryPolicy(5);

// ─── OVERRIDES — optional, keyed by underlying name. Add an entry here ONLY
// when you need something non-default for that instrument.
//
// lotMult IMPORTANT: the broker's own `lot_size` field is a CONTRACT COUNT
// ("1 lot = 1 contract"), not the price multiplier you need for PnL math.
// For NATGASMINI, lot_size=1 in the instrument dump but the actual contract
// unit is 250 MMBtu — getDefinition() would silently use 1 without this
// override, understating every PnL calc by 250x. Verify the real multiplier
// against the exchange's contract spec for ANY instrument before trusting
// lot_size alone — don't assume it's safe to omit just because a number is
// present in the CSV.
const overrides = {
    NATGASMINI: {
        lotMult: 250,   // MMBtu per lot — NOT the broker's lot_size field (which is 1)
    },
};

// ─── getDefinition — underlying name -> full definition, override-merged.
// `lotMult: null` here is a signal to buildContext(): "use the broker's own
// lot_size for this contract" rather than a hand-typed number. That trap
// (lot_size as a contract COUNT, not a price multiplier) is a FUTURES
// problem — for cash equities there's no such ambiguity: 1 share always
// means 1 unit of price exposure, so lotMult safely defaults to 1 there
// without needing a manual override every time.
//
// exchangeHint: needed because a freshly-picked NSE stock (or any
// underlying not in `overrides` below) has no other way to tell this
// function it's an equity, not a future — toolbox.js passes it along from
// wherever the person picked the instrument, and engine.js reads it back
// from EXCHANGE_OVERRIDE (set by the toolbox at deploy time, same pattern
// as STRATEGY_OVERRIDE/LOTS_OVERRIDE below).
// EOD force-close time depends on the EXCHANGE first, then candle
// granularity within that exchange's session.
//
// NSE cash/options session ends 15:30 IST — nowhere near MCX's ~23:30.
// Force-close at 15:15 so there's still live tick data to close against
// (same "a few minutes before the exchange actually stops" convention as
// the MCX default below, not the exact close). No candle-granularity split
// on the NSE side yet — 15:15 leaves enough room for a 15m/30m/1h candle to
// still close and get processed before 15:30 for every timeframe this
// strategy set currently runs.
//
// MCX: on 30m/1h bars there's no finer intra-window resolution left between
// 23:00 and session close (~23:30) to catch a clean exit signal — the next
// candle after 23:00 doesn't close until 23:30/00:00, past when MIS
// positions can safely exit. 5m/15m bars have enough resolution left to
// hold to 23:15 instead.
//
// Exported (not just used internally by getDefinition below) because
// timeframe/exchange can diverge from a strategy's own default in two
// places this module doesn't control: engine.js's TIMEFRAME_OVERRIDE env
// var, and backtestFlow.js's own timeframe picker. Both need to recompute
// this the same way once the ACTUAL runtime timeframe/exchange is known,
// not just inherit whatever the strategy's default timeframe would have
// produced.
function defaultEodFor(timeframe, exchange) {
    if (exchange === "NSE") {
        return { eodHour: 15, eodMinute: 15 };
    }
    const isWideTimeframe = timeframe === "30m" || timeframe === "1h";
    return { eodHour: 23, eodMinute: isWideTimeframe ? 0 : 15 };
}

function getDefinition(underlying, exchangeHint) {
    const override = overrides[underlying] || {};
    const exchange = override.exchange ?? exchangeHint ?? "MCX";
    const isEquity = exchange === "NSE";

    // Needed before eodHour/eodMinute below, since their default now
    // depends on it.
    const strategy       = override.strategy ?? "DPI_TREND_MEANREV";
    const timeframe       = STRATEGY_TIMEFRAME[strategy];
    const defaultEod      = defaultEodFor(timeframe, exchange);

    return {
        underlying,
        exchange,
        // Cash equities don't expire and have nothing to roll — the
        // Contract Resolver skips pin/roll-policy logic entirely when this
        // is true (see instrumentResolution.js) and resolves straight to
        // the symbol itself.
        noRoll:     override.noRoll    ?? isEquity,
        lotMult:    override.lotMult   ?? (isEquity ? 1 : null),   // null (futures) = not set — engine.js will require LOTMULT_OVERRIDE or refuse to boot
        lots:       override.lots       ?? 1,
        name:       override.name       ?? underlying,
        tgPrefix:   override.tgPrefix   ?? underlying,
        eodHour:    override.eodHour    ?? defaultEod.eodHour,
        eodMinute:  override.eodMinute  ?? defaultEod.eodMinute,
        // Unused when noRoll is true, but harmless to still set — nothing
        // reads it in that path.
        rollPolicy: override.rollPolicy ?? DEFAULT_ROLL_POLICY,
        // Which strategy from strategies.js runs this instrument. No
        // toolbox picker for this yet — set per-instrument here in
        // overrides until that UI exists.
        strategy,
        // Live/paper candle interval — fixed by whichever strategy is
        // running (see strategies.js's STRATEGY_TIMEFRAME), not something
        // overrides.js sets directly. No fallback silently defaulting an
        // unknown strategy key to "15m" here — that's exactly the kind of
        // silent wrong-assumption bug this codebase avoids elsewhere
        // (see the lotMult refuse-to-boot guard); an unknown key surfaces
        // via signals.js's own throw instead, same failure point either way.
        timeframe,
    };
}

// ─── buildContext — definition (static) + resolvedContract (from Contract
// Resolver) -> the flat context object every other file already expects.
function buildContext(def, resolvedContract) {
    if (!def)              throw new Error("buildContext: definition is required");
    if (!resolvedContract) throw new Error("buildContext: resolvedContract is required");

    return {
        token:     resolvedContract.token,
        symbol:    resolvedContract.symbol,
        expiry:    resolvedContract.expiry,
        exchange:  def.exchange,
        lotMult:   def.lotMult,   // deliberately no fallback to resolvedContract.lotSize — see note above
        lots:      def.lots,
        name:      def.name,
        tgPrefix:  def.tgPrefix,
        eodHour:   def.eodHour,
        eodMinute: def.eodMinute,
        strategy:  def.strategy,
        timeframe: def.timeframe,
        tickSize:  resolvedContract.tickSize,
        lotSize:   resolvedContract.lotSize,
        // Overridden per-process by engine.js from CARRY_OVERNIGHT_OVERRIDE
        // (toolbox prompt) — false unless explicitly opted into. See
        // orders.js (MIS vs NRML product), lifecycle.js (EOD skip), and
        // strategies.js (initSignals' shouldResume gate) for what this drives.
        carryOvernight: false,
        // Overridden per-process by engine.js from TARGET_POINTS_OVERRIDE
        // (toolbox prompt, asked right after strategy selection — see
        // configureAndStartInstrument in toolbox.js). null = no fixed
        // take-profit, strategy's own exits are the only way out (today's
        // default, unchanged behavior). A positive number arms a tick-
        // monitored favorable-exit target at entryPrice ± this many points,
        // the same distance for LONG and SHORT — checked on every WebSocket
        // tick by candlePoll.js's checkTarget(), same mechanism as the SL
        // trail (checkSL), just the opposite direction. Applies uniformly
        // to ALL strategies, not just the MA_SLOPE family that used to have
        // its own bespoke version of this (MA_SLOPE_TARGET_POINTS in
        // engineConfig.js — superseded, see that file).
        targetPoints: null,
        // Overridden per-process by engine.js from TARGET_MODE_OVERRIDE
        // (toolbox prompt, asked alongside targetPoints above — only
        // meaningful when targetPoints is null, since ADAPTIVE mode picks
        // its own points; see adaptiveTarget.js). "fixed" = today's
        // unchanged behavior. "adaptive" = candlePoll.js's checkTarget()
        // sizes the target itself from CHOP + DPI efficiency at arm-time,
        // once per position, frozen for that position's life.
        targetMode: "fixed",
        // Overridden per-process by engine.js from BAND_STEP_OVERRIDE
        // (toolbox prompt, asked only when DYNAMIC_BAND is picked — the
        // toolbox only prompts for strategy-specific overrides when that
        // particular strategy is selected). Fixed
        // PRICE distance between the band's HIGH/MID/LOW — see
        // createDynamicBandStrategy in strategies.js. null (not a literal
        // default) so the strategy's own `context.bandStep ??
        // engineConfig.BAND_STEP_DEFAULT` fallback is the ONLY place the
        // actual default lives — same reasoning as targetPoints above: a
        // backtest tuning BAND_STEP_DEFAULT via STRATEGY_PARAMS needs this
        // to stay unset so it doesn't override the tuned value.
        bandStep: null,
        // Overridden per-process by engine.js from GREY_EXIT_OVERRIDE
        // (toolbox prompt, asked only when ALMA_TRI_BAND is picked). Only
        // controls what happens when strategy #15's state reads GREY while
        // a position is open — exit flat, or hold through it and only ever
        // exit on the opposite decisive color. null (not a literal
        // default) for the same STRATEGY_PARAMS-backtest-tuning reason
        // bandStep above is null — createAlmaTriBandStrategy falls back to
        // engineConfig.GREY_EXIT_DEFAULT itself.
        greyExitEnabled: null,
        // Overridden per-process by engine.js from ALMA_BAND_OVERRIDE
        // (toolbox prompt, asked only when ALMA_PRO_FAST is picked).
        // Defaults true (matches the ported Pine script's own logic — band
        // compression forces sideways, breakout past the band confirms
        // entries). false trades on slope alone (strong_up/strong_down),
        // no band/breakout check involved at all — see
        // createAlmaProFastStrategy in strategies.js for exactly what each
        // mode does. Literal default (not null) since there's no
        // STRATEGY_PARAMS-backtest-tuning concern here the way bandStep/
        // greyExitEnabled above have — nothing else provides a fallback.
        almaBandEnabled: true,
        // Overridden per-process by engine.js from ALMA_FAST_LEN_OVERRIDE /
        // ALMA_BAND_LEN_OVERRIDE (toolbox prompt, asked only when
        // ALMA_PRO_FAST is picked). null (not a literal default) — same
        // STRATEGY_PARAMS-backtest-tuning reason bandStep above is null —
        // createAlmaProFastStrategy falls back to engineConfig.ALMA_PRO_
        // FAST_LEN / ALMA_PRO_BAND_LEN itself when unset. almaBandLen only
        // matters while almaBandEnabled is true.
        almaFastLen: null,
        almaBandLen: null,
        // Overridden per-process by engine.js from ALMA_CHOP_FILTER_OVERRIDE
        // (toolbox prompt, asked only when ALMA_PRO_FAST or ALMA_PRO_SLOW is
        // picked — one shared field since a process only ever runs one of
        // the two). null (not a literal default) — createAlmaProFastStrategy/
        // createAlmaProSlowStrategy fall back to engineConfig.USE_ALMA_PRO_
        // FAST_CHOP_FILTER / USE_ALMA_PRO_SLOW_CHOP_FILTER themselves when
        // unset, same reasoning bandStep/almaFastLen above are null for.
        almaChopFilterEnabled: null,
        // Overridden per-process by engine.js from MAX_DAILY_LOSS_OVERRIDE
        // (toolbox prompt, asked for every strategy — not strategy-specific
        // like almaChopFilterEnabled above). null (default) = disabled, no
        // floor at all — today's original behavior. A positive number is a
        // RUPEE loss amount: once today's cumulative realized P&L
        // (state.pnl) drops to or below -maxDailyLoss, candlePoll.js's
        // checkDailyLoss() force-closes any open position and quits for
        // the day (same PM2 stop_exit_codes:[0] mechanism the target-hit
        // cooldown and EOD shutdown both already use). Independent of
        // target hits — this fires on ANY exit reason (SL, target,
        // strategy-driven reversal) that pushes the day past the floor,
        // not just target hits.
        maxDailyLoss: null,
        // Overridden per-process by engine.js from SESSION_TARGET_OVERRIDE
        // (toolbox prompt — mutually exclusive with targetPoints/targetMode
        // at setup time, see toolbox.js's target-type picker). null
        // (default) = disabled. A positive number is a RUPEE profit
        // ceiling for the WHOLE SESSION (state.pnl realized + the current
        // open position's live unrealised P&L) rather than a per-trade
        // price target — candlePoll.js's checkSessionTarget() force-closes
        // whatever's open the moment that combined total reaches this
        // ceiling, "irrespective of loss" (i.e. it fires on the running
        // total crossing the line, not on any single trade's own P&L —
        // an earlier losing trade doesn't reset or block it, same
        // symmetric relationship maxDailyLoss above has to state.pnl, just
        // a ceiling instead of a floor). Checked every tick, same as
        // checkDailyLoss.
        sessionTargetRupees: null,
        // Choppiness Index entry filter — available for any strategy
        // except ALMA_PRO_FAST/SLOW (their own dedicated, pre-existing
        // toggle — almaChopFilterEnabled/ALMA_PRO_FAST_CHOP_MAX — is
        // unchanged and separate from this). Enforced via chopGate.js's
        // isChopBlocked(), called from every other strategy's own entry
        // site in strategies.js (not a wrapper around orders.enter() —
        // see chopGate.js's header for why that doesn't work in paper
        // mode). null = "strategy decides its own default" — every
        // strategy defaults to OFF unless enabled via Edit Params, so
        // this is opt-in, never a silent behavior change for anything
        // already deployed.
        chopFilterEnabled: null,
        chopPeriod: null,
        chopMax: null,
    };
}

module.exports = { overrides, getDefinition, buildContext, defaultEodFor };
