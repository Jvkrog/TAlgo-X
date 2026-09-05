// engine.js — boot sequence.
//
// CHANGED: instrument selection is now a broker underlying name (UNDERLYING
// env var), not a pre-registered key. getDefinition() supplies sensible
// defaults for anything not explicitly overridden in context.js, and the
// Contract Resolver fills in the actual token/symbol/expiry/lotSize from
// the broker's live instrument dump. No file edit needed to run a new
// instrument — see toolbox.js's "Add instrument" flow.
"use strict";

const { getDefinition, buildContext, defaultEodFor } = require("./context");
const { createCsvRepository }         = require("./csvRepository");
const { createInstrumentSource }      = require("./instrumentSource");
const { createContractPinStore }      = require("./contractPins");
const { resolveCurrent }              = require("./instrumentResolution");
const engineConfig                    = require("./engineConfig");
const c                               = require("./c");
const fs                              = require("fs");
const { KiteConnect, KiteTicker }     = require("kiteconnect");

const { createTelegram }     = require("./telegram");
const { createState }        = require("./state");
const { createCandleBuffer } = require("./candleBuilder");
const { createCandleDeltaBuffer } = require("./candleDeltaBuffer");
const { createMarketDataHealth } = require("./marketDataHealth");
const { createSLStore }      = require("./sl");
const { createTargetStore }  = require("./target");
const { createDb }           = require("./db");
const { createOrders }       = require("./orders");
const positions               = require("./positions");
const { createPreload }      = require("./preload");
const { createCandlePoll }   = require("./candlePoll");
const { createLifecycle }    = require("./lifecycle");
const { createSignals }      = require("./signals");
const { STRATEGY_TIMEFRAME, STRATEGY_INFO } = require("./strategies");
const { TIMEFRAME_TO_INTERVAL } = require("./historicalFetch");
const { istParts } = require("./istTime");

async function main() {
    // ─── SELECT INSTRUMENT — set by PM2 (toolbox.js), defaults to NATGASMINI
    // so `node engine.js` with no env still works.
    const underlying = process.env.UNDERLYING || "NATGASMINI";
    const def = getDefinition(underlying, process.env.EXCHANGE_OVERRIDE);

    const ACCESS_TOKEN = fs.readFileSync(engineConfig.ACCESS_TOKEN_FILE, "utf8").trim();

    // ─── RESOLVE CONTRACT — CSV Repository load + Contract Resolver pick.
    console.log(c.dim(`[${def.tgPrefix}] loading instrument dump...`));
    const kcForDump = new KiteConnect({ api_key: engineConfig.API_KEY });
    kcForDump.setAccessToken(ACCESS_TOKEN);

    // CSV path is per-exchange (see engineConfig.js's NSE_INSTRUMENT_CSV_PATH
    // comment) — toolbox.js's Add Instrument flow already branches on this;
    // this was still always using the MCX path regardless of def.exchange,
    // so an NSE boot would try to load MCX's local CSV (or silently fall
    // through to a live API fetch scoped to the wrong assumption) instead
    // of the NSE-specific file.
    const csvFilePath = def.exchange === "NSE"
        ? engineConfig.NSE_INSTRUMENT_CSV_PATH
        : engineConfig.INSTRUMENT_CSV_PATH;

    const csvRepo = createCsvRepository({
        fetchRows: createInstrumentSource({
            filePath: csvFilePath,
            kc:       kcForDump,
            exchange: def.exchange,
        }).fetchRows,
    });
    await csvRepo.load();

    const pinStore = createContractPinStore();
    const { contract: resolvedContract, source } = resolveCurrent(def.underlying, def, csvRepo, pinStore);

    const context = buildContext(def, resolvedContract);
    const expiryStr = context.expiry ? context.expiry.toISOString().split("T")[0] : (def.noRoll ? "n/a (equity, no roll)" : "unknown (manual pin)");
    console.log(c.dim(`[${context.tgPrefix}] resolved contract (${source}): ${context.symbol} (token ${context.token}, expiry ${expiryStr}, lotMult ${context.lotMult})`));

    // Optional position-size / PnL-multiplier overrides — the toolbox's
    // prompts set these rather than editing context.js by hand.
    if (process.env.LOTS_OVERRIDE) {
        const override = Number(process.env.LOTS_OVERRIDE);
        if (Number.isFinite(override) && override > 0) context.lots = override;
    }
    if (process.env.LOTMULT_OVERRIDE) {
        const override = Number(process.env.LOTMULT_OVERRIDE);
        if (Number.isFinite(override) && override > 0) context.lotMult = override;
    }
    // Which strategy runs this instrument — set by the toolbox's Add
    // Instrument picker. No validation against the STRATEGIES registry here:
    // signals.js's createSignals() already throws loudly on an unknown key,
    // so an invalid value fails fast at signal-creation time below rather
    // than silently falling back to something the person didn't pick.
    if (process.env.STRATEGY_OVERRIDE) {
        context.strategy = process.env.STRATEGY_OVERRIDE;
        // buildContext() already set context.timeframe from context.js's
        // static default strategy — this override happened after, so it has
        // to recompute timeframe too, or an ALMA_BAND pick from the toolbox
        // would silently keep polling at whatever the static default's
        // cadence was (15m) instead of ALMA_BAND's required 1h. Unknown-key
        // case intentionally left undefined here too — same reasoning as
        // above, surfaces via createSignals()'s throw rather than a silent
        // 15m fallback.
        context.timeframe = STRATEGY_TIMEFRAME[context.strategy];
    }
    // Explicit timeframe override — set by the toolbox's Add Instrument
    // picker, independent of whichever strategy is running. Applied LAST,
    // after the strategy-override block above, so it always wins over
    // whatever timeframe the strategy's own default would have set.
    // Validated against the known timeframe set (unlike STRATEGY_OVERRIDE
    // above) because an unknown value here has nowhere else to fail loud —
    // candlePoll.js would just silently fall back to the global 15m
    // default instead of throwing, which is exactly the kind of
    // silent-wrong-value bug the lotMult guard below exists to prevent.
    if (process.env.TIMEFRAME_OVERRIDE) {
        if (!TIMEFRAME_TO_INTERVAL[process.env.TIMEFRAME_OVERRIDE]) {
            console.error(c.red(`[${context.tgPrefix}] TIMEFRAME_OVERRIDE "${process.env.TIMEFRAME_OVERRIDE}" is not a known timeframe (${Object.keys(TIMEFRAME_TO_INTERVAL).join(", ")}) — refusing to boot.`));
            process.exit(1);
        }
        // EOD force-close time depends on candle granularity (see
        // context.js's defaultEodFor) — if this instrument is still on
        // whatever the strategy's OWN default timeframe would have implied
        // for EOD (i.e. eodHour/eodMinute weren't hand-overridden in
        // overrides.js), recompute it for the timeframe actually being run
        // here instead of silently keeping the old default's value.
        const preOverrideDefault = defaultEodFor(context.timeframe, context.exchange);
        const eodWasDefault = context.eodHour === preOverrideDefault.eodHour && context.eodMinute === preOverrideDefault.eodMinute;

        context.timeframe = process.env.TIMEFRAME_OVERRIDE;

        if (eodWasDefault) {
            const newDefault  = defaultEodFor(context.timeframe, context.exchange);
            context.eodHour   = newDefault.eodHour;
            context.eodMinute = newDefault.eodMinute;
        }
    }
    // Fail loud, not silently wrong: there is deliberately no fallback to the
    // broker's lot_size field anymore (it's a contract count, not a price
    // multiplier — already caused a real PnL bug once). If lotMult is still
    // unset here, refuse to boot rather than trade with a guessed number.
    if (!context.lotMult) {
        console.error(c.red(`[${context.tgPrefix}] lotMult is not set — refusing to boot.`));
        console.error(c.red(`  Fix: add a lotMult override for "${def.underlying}" in context.js's overrides,`));
        console.error(c.red(`  or set LOTMULT_OVERRIDE when starting this process (the toolbox does this for you).`));
        process.exit(1);
    }
    // Fail loud, not silently wrong (same reasoning as lotMult above): the
    // 27 Jul ZINCMINI incident traced back to orders.js rounding order
    // prices with .toFixed(2) instead of the instrument's tick size —
    // that's fixed now (see price.js's normalizePrice), but it only works
    // if context.tickSize is actually populated. A manual contract pin
    // (contractPins.js) can leave tickSize null — catch that here at boot
    // instead of discovering it via an exchange rejection mid-session.
    if (!context.tickSize) {
        console.error(c.red(`[${context.tgPrefix}] tickSize is not set — refusing to boot.`));
        console.error(c.red(`  Fix: the resolved contract for "${def.underlying}" has no tickSize —`));
        console.error(c.red(`  if this is a manual pin (contractPins.js), add tickSize to it.`));
        process.exit(1);
    }
    // Live/paper mode — set per-process by the toolbox, since a single static
    // engineConfig.LIVE_ORDERS would force every instrument into the same
    // mode. Safe to mutate here: each PM2 process is its own OS process with
    // its own require() cache, so this never leaks across instruments.
    if (process.env.LIVE_ORDERS_OVERRIDE !== undefined) {
        engineConfig.LIVE_ORDERS = process.env.LIVE_ORDERS_OVERRIDE === "true";
    }
    console.log(c.bold(engineConfig.LIVE_ORDERS ? c.red(`[${context.tgPrefix}] LIVE — real orders will be placed`)
                                                  : c.cyan(`[${context.tgPrefix}] PAPER — shadow mode, no real orders`)));

    // Carry-overnight — set per-process by the toolbox's live/paper prompt,
    // same pattern as LIVE_ORDERS_OVERRIDE above. Drives three things: the
    // order product type (NRML vs MIS, orders.js), whether EOD force-closes
    // or logs-and-holds (lifecycle.js), and whether a restored position on a
    // later calendar day is honored or wiped (strategies.js initSignals).
    if (process.env.CARRY_OVERNIGHT_OVERRIDE !== undefined) {
        context.carryOvernight = process.env.CARRY_OVERNIGHT_OVERRIDE === "true";
    }
    console.log(c.dim(`[${context.tgPrefix}] carry overnight: ${context.carryOvernight ? c.yellow("ON — NRML, EOD will not force-close") : "off — MIS, EOD force-closes as usual"}`));

    // Target points — set per-process by the toolbox's strategy-selection
    // prompt, same override pattern as above. A blank/unset env means no
    // fixed take-profit (strategy's own exits are the only way out, today's
    // default). Applies uniformly to every strategy — see context.js and
    // candlePoll.js's checkTarget() for how it's actually armed/monitored.
    if (process.env.TARGET_POINTS_OVERRIDE !== undefined && process.env.TARGET_POINTS_OVERRIDE !== "") {
        const parsedTarget = Number(process.env.TARGET_POINTS_OVERRIDE);
        context.targetPoints = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : null;
    }
    // Target mode — "adaptive" only means anything once targetPoints itself
    // is unset (adaptive picks its own points per-position, see
    // adaptiveTarget.js); an explicit TARGET_POINTS_OVERRIDE still wins as
    // a fixed target regardless of mode, same as it always has.
    if (process.env.TARGET_MODE_OVERRIDE === "adaptive") {
        context.targetMode = "adaptive";
    }
    const targetDesc = context.targetPoints
        ? `+${context.targetPoints} points from entry (tick-monitored, FIXED)`
        : context.targetMode === "adaptive"
            ? "ADAPTIVE — sized from CHOP/DPI efficiency at entry, frozen per-position"
            : "off — no fixed take-profit";
    console.log(c.dim(`[${context.tgPrefix}] target: ${context.targetPoints || context.targetMode === "adaptive" ? c.yellow(targetDesc) : targetDesc}`));

    // Band step — only meaningful for DYNAMIC_BAND, read unconditionally
    // same as everything else here. Left null (not defaulted here) when no
    // override is set — createDynamicBandStrategy falls back to
    // engineConfig.BAND_STEP_DEFAULT itself, same pattern as targetPoints,
    // so a backtest tuning BAND_STEP_DEFAULT via STRATEGY_PARAMS actually
    // takes effect instead of being shadowed by a value fixed here.
    if (process.env.BAND_STEP_OVERRIDE !== undefined && process.env.BAND_STEP_OVERRIDE !== "") {
        const parsedStep = Number(process.env.BAND_STEP_OVERRIDE);
        context.bandStep = Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : null;
    }
    if (context.strategy === "DYNAMIC_BAND" || context.strategy === "DYNAMIC_MID_COLOR" || context.strategy === "DYNAMIC_MID_COLOR_HL") {
        console.log(c.dim(`[${context.tgPrefix}] band step: ${context.bandStep ?? `default (${engineConfig.BAND_STEP_DEFAULT})`}`));
    }

    // Grey-exit toggle — only meaningful for ALMA_TRI_BAND, left null
    // (not defaulted here) when unset, same "let the strategy fall back to
    // its own engineConfig default" reasoning as bandStep above.
    if (process.env.GREY_EXIT_OVERRIDE !== undefined && process.env.GREY_EXIT_OVERRIDE !== "") {
        context.greyExitEnabled = process.env.GREY_EXIT_OVERRIDE === "true";
    }
    if (context.strategy === "ALMA_TRI_BAND") {
        const greyExitResolved = context.greyExitEnabled ?? engineConfig.GREY_EXIT_DEFAULT;
        console.log(c.dim(`[${context.tgPrefix}] grey state: ${greyExitResolved ? "exits flat" : "holds through it"}`));
    }

    // ALMA band gate toggle — only meaningful for ALMA_PRO_FAST. Defaults
    // true (context.js), so ALMA_BAND_OVERRIDE only ever gets WRITTEN by
    // the toolbox when explicitly turning it off — reading it unconditionally
    // here is still safe either way.
    if (process.env.ALMA_BAND_OVERRIDE !== undefined && process.env.ALMA_BAND_OVERRIDE !== "") {
        context.almaBandEnabled = process.env.ALMA_BAND_OVERRIDE === "true";
    }
    if (context.strategy === "ALMA_PRO_FAST") {
        console.log(c.dim(`[${context.tgPrefix}] ALMA band gate: ${context.almaBandEnabled ? "ON" : c.yellow("off — trading on slope alone, no band/breakout check")}`));
    }

    // ALMA fast/band length overrides — only meaningful for ALMA_PRO_FAST,
    // read unconditionally same as everything else here. null (unset) when
    // no override is given — createAlmaProFastStrategy falls back to
    // engineConfig.ALMA_PRO_FAST_LEN / ALMA_PRO_BAND_LEN itself.
    if (process.env.ALMA_FAST_LEN_OVERRIDE !== undefined && process.env.ALMA_FAST_LEN_OVERRIDE !== "") {
        const parsedFastLen = Number(process.env.ALMA_FAST_LEN_OVERRIDE);
        context.almaFastLen = Number.isFinite(parsedFastLen) && parsedFastLen > 0 ? parsedFastLen : null;
    }
    if (process.env.ALMA_BAND_LEN_OVERRIDE !== undefined && process.env.ALMA_BAND_LEN_OVERRIDE !== "") {
        const parsedBandLen = Number(process.env.ALMA_BAND_LEN_OVERRIDE);
        context.almaBandLen = Number.isFinite(parsedBandLen) && parsedBandLen > 0 ? parsedBandLen : null;
    }
    if (context.strategy === "ALMA_PRO_FAST" && (context.almaFastLen || context.almaBandLen)) {
        console.log(c.dim(`[${context.tgPrefix}] ALMA config: fast=${context.almaFastLen ?? engineConfig.ALMA_PRO_FAST_LEN}  band=${context.almaBandLen ?? engineConfig.ALMA_PRO_BAND_LEN}`));
    }

    // Chop filter toggle — only meaningful for ALMA_PRO_FAST/ALMA_PRO_SLOW,
    // read unconditionally same as everything else here. null (unset) when
    // no override is given — both strategies fall back to their own
    // engineConfig USE_ALMA_PRO_*_CHOP_FILTER default (true) themselves.
    if (process.env.ALMA_CHOP_FILTER_OVERRIDE !== undefined && process.env.ALMA_CHOP_FILTER_OVERRIDE !== "") {
        context.almaChopFilterEnabled = process.env.ALMA_CHOP_FILTER_OVERRIDE === "true";
    }
    if (context.strategy === "ALMA_PRO_FAST" || context.strategy === "ALMA_PRO_SLOW") {
        const chopResolved = context.almaChopFilterEnabled ?? (context.strategy === "ALMA_PRO_FAST" ? engineConfig.USE_ALMA_PRO_FAST_CHOP_FILTER : engineConfig.USE_ALMA_PRO_SLOW_CHOP_FILTER);
        console.log(c.dim(`[${context.tgPrefix}] chop filter: ${chopResolved ? "ON" : c.yellow("off — no chop gate on entries")}`));
    }

    // Max daily loss circuit breaker — every strategy, not strategy-gated
    // like the ALMA-specific overrides above. null/unset = disabled, no
    // floor (today's original behavior).
    if (process.env.MAX_DAILY_LOSS_OVERRIDE !== undefined && process.env.MAX_DAILY_LOSS_OVERRIDE !== "") {
        const parsedLoss = Number(process.env.MAX_DAILY_LOSS_OVERRIDE);
        context.maxDailyLoss = Number.isFinite(parsedLoss) && parsedLoss > 0 ? parsedLoss : null;
    }
    console.log(c.dim(`[${context.tgPrefix}] max daily loss: ${context.maxDailyLoss ? c.yellow(`-₹${context.maxDailyLoss} — quits for the day if breached`) : "off — no floor"}`));

    // Session-level profit target — the alternative to a per-trade
    // targetPoints/targetMode target (mutually exclusive at setup time,
    // see toolbox.js's target-type picker). null/unset = disabled.
    if (process.env.SESSION_TARGET_OVERRIDE !== undefined && process.env.SESSION_TARGET_OVERRIDE !== "") {
        const parsedTarget = Number(process.env.SESSION_TARGET_OVERRIDE);
        context.sessionTargetRupees = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : null;
    }
    console.log(c.dim(`[${context.tgPrefix}] session target: ${context.sessionTargetRupees ? c.yellow(`+₹${context.sessionTargetRupees} — quits for the day once reached (session total, irrespective of interim losses)`) : "off"}`));

    // Choppiness Index entry filter — VOLUME_DELTA_CVD only (see
    // context.js). null stays null here if the override isn't set; the
    // strategy itself applies its own default when it sees null, not this
    // block — same "context carries the override, the strategy carries
    // the default" split every other per-instrument knob here uses.
    if (process.env.CHOP_FILTER_OVERRIDE !== undefined && process.env.CHOP_FILTER_OVERRIDE !== "") {
        context.chopFilterEnabled = process.env.CHOP_FILTER_OVERRIDE === "true";
    }
    if (process.env.CHOP_PERIOD_OVERRIDE !== undefined && process.env.CHOP_PERIOD_OVERRIDE !== "") {
        const parsedPeriod = Number(process.env.CHOP_PERIOD_OVERRIDE);
        context.chopPeriod = Number.isFinite(parsedPeriod) && parsedPeriod > 0 ? parsedPeriod : null;
    }
    if (process.env.CHOP_MAX_OVERRIDE !== undefined && process.env.CHOP_MAX_OVERRIDE !== "") {
        const parsedMax = Number(process.env.CHOP_MAX_OVERRIDE);
        context.chopMax = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null;
    }

    // Double-order gate — every strategy, opt-in, false/unset = disabled
    // (today's original behavior: unlimited re-entries per session, each
    // strategy's own gates decide). See doubleOrderGate.js and
    // context.disableDoubleOrders.
    if (process.env.DISABLE_DOUBLE_ORDERS_OVERRIDE !== undefined && process.env.DISABLE_DOUBLE_ORDERS_OVERRIDE !== "") {
        context.disableDoubleOrders = process.env.DISABLE_DOUBLE_ORDERS_OVERRIDE === "true";
    }
    console.log(c.dim(`[${context.tgPrefix}] double orders: ${context.disableDoubleOrders ? c.yellow("disabled — only 1 entry allowed per session") : "allowed (default) — 2nd+ entry forces a Choppiness Index check regardless of the chop filter setting"}`));

    // PURE_HA anti-whipsaw filter — consecutive opposite-color candles
    // required before an open position actually flips. Harmless/unread by
    // every other strategy. See context.flipConfirmCandles.
    if (process.env.FLIP_CONFIRM_CANDLES_OVERRIDE !== undefined && process.env.FLIP_CONFIRM_CANDLES_OVERRIDE !== "") {
        const parsedConfirm = Number(process.env.FLIP_CONFIRM_CANDLES_OVERRIDE);
        context.flipConfirmCandles = Number.isFinite(parsedConfirm) && parsedConfirm >= 1 ? parsedConfirm : null;
    }

    // Per-instrument ATR stop-loss multiplier override — every
    // computeTrail() falls back to the global engineConfig.ATR_SL_MULT
    // when this is unset. See context.atrSlMult.
    if (process.env.ATR_SL_MULT_OVERRIDE !== undefined && process.env.ATR_SL_MULT_OVERRIDE !== "") {
        const parsedAtrMult = Number(process.env.ATR_SL_MULT_OVERRIDE);
        context.atrSlMult = Number.isFinite(parsedAtrMult) && parsedAtrMult > 0 ? parsedAtrMult : null;
    }
    console.log(c.dim(`[${context.tgPrefix}] ATR SL multiplier: ${context.atrSlMult ?? `${engineConfig.ATR_SL_MULT} (default)`}${context.strategy === "PURE_HA" ? `  |  flip confirm: ${context.flipConfirmCandles ?? 1} candle(s)` : ""}`));

    const strategyLabel = (STRATEGY_INFO[context.strategy] || { label: context.strategy }).label;
    console.log(c.bold(`[${context.tgPrefix}] Strategy: ${strategyLabel} (${context.strategy})  Timeframe: ${context.timeframe}`));

    console.log();
    console.log();
    console.log(c.bold(`--- ${context.name.padEnd(12)} ${new Date().toLocaleString("en-IN", { hour12: false })} ---`));

    // ─── INSTANTIATE — one of each, scoped to `context` ────────────────────────
    const { tg }   = createTelegram(context, engineConfig);
    const state    = createState();
    const candles  = createCandleBuffer();
    const deltaBuffer = createCandleDeltaBuffer();
    const marketDataHealth = createMarketDataHealth({ tg });
    const slStore  = createSLStore();
    const targetStore = createTargetStore();
    const db       = createDb(context);
    const orders   = createOrders(context, tg);

    db.initDB();

    const positionsClose      = (price, reason) => positions.close(context, state, db, tg, price, reason);
    const positionsUnrealised = (price)          => positions.unrealised(context, state, price);

    const preloadInstance   = createPreload({ context, engineConfig, candles, tg });
    const lifecycleInstance = createLifecycle({ context, engineConfig, state, db, candles, slStore, targetStore, orders, positionsClose, tg });
    const signalsInstance   = await createSignals({
        context, engineConfig, state, db, candles, slStore, targetStore, orders,
        positionsClose, positionsUnrealised, lifecycle: lifecycleInstance, tg, deltaBuffer,
    });
    const candlePollInstance = createCandlePoll({
        context, engineConfig, state, candles, slStore, targetStore, orders,
        positionsClose, processCandle: signalsInstance.processCandle, db, tg, deltaBuffer,
    });

    // ─── BOOT — WebSocket ticker ────────────────────────────────────────────
    const ticker = new KiteTicker({ api_key: engineConfig.API_KEY, access_token: ACCESS_TOKEN });

    ticker.connect();

    ticker.on("connect", async () => {
        marketDataHealth.onConnect();
        ticker.subscribe([context.token]);
        marketDataHealth.onSubscribe();
        // CHANGED: LTP -> Full. LTP mode only ever sent instrument_token +
        // last_price — no volume_traded field at all, which
        // createVolumeDeltaCvdStrategy's tick delta estimator needs (see
        // tickVolumeDelta.js). Full mode is a strict superset for every
        // OTHER strategy too (they only ever read tick.last_price /
        // tick.instrument_token, same as before) — this is additive, not a
        // behavior change for anything already running, just a larger tick
        // payload every strategy now receives but only this one uses.
        ticker.setMode(ticker.modeFull, [context.token]);

        await signalsInstance.initSignals();

        await new Promise(resolve => {
            const now    = new Date();
            const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 45, 0);
            if (now >= target) { resolve(); return; }
            setTimeout(resolve, target - now);
        });

        await preloadInstance.preload();

        const bufLen = candles.getRawCandles().length;
        const info   = state.position ? `${state.position}@${state.entryPrice}` : "-";

        if (bufLen < 35) {
            console.error(c.red(`preload returned only ${bufLen} candles — cannot start`));
            tg(`⚠ Preload failed: only ${bufLen} candles. Restart required.`);
            process.exit(1);
        }

        const now2 = new Date();
        const tradeTarget = new Date(now2.getFullYear(), now2.getMonth(), now2.getDate(),
            engineConfig.TRADE_START_HOUR, engineConfig.TRADE_START_MINUTE, 0);
        const minsLeft = Math.round((tradeTarget - now2) / 60000);
        if (minsLeft > 0) {
            const hh = String(engineConfig.TRADE_START_HOUR).padStart(2, "0");
            const mm = String(engineConfig.TRADE_START_MINUTE).padStart(2, "0");
            console.log(c.dim(`waiting  ${minsLeft}m until ${hh}:${mm}`));
            const heartbeat = setInterval(() => {
                const n = new Date();
                const { hours: nHour, minutes: nMinute } = istParts(n);
                const entryOpen = nHour > engineConfig.TRADE_START_HOUR ||
                    (nHour === engineConfig.TRADE_START_HOUR && nMinute >= engineConfig.TRADE_START_MINUTE);
                if (entryOpen) { clearInterval(heartbeat); return; }
                const mins = Math.round((tradeTarget - n) / 60000);
                console.log(c.dim(`waiting  ${mins}m until ${hh}:${mm}`));
            }, 15 * 60 * 1000);
        }

        tg(`${strategyLabel} started  ${info}`);

        candlePollInstance.startPoll();
        lifecycleInstance.startLifecycle();

        // Section 17 diagnostic — throttled inside marketDataHealth itself
        // (won't spam Telegram every 10s during a prolonged outage, just
        // once per throttleMs while the condition persists). 10s poll is
        // cheap and independent of candle/tick cadence.
        setInterval(() => marketDataHealth.checkStale(), 10 * 1000);
    });

    ticker.on("ticks", async (ticks) => {
        if (!ticks.length) return;
        for (const tick of ticks) {
            if (tick.instrument_token === context.token && tick.last_price) {
                candles.onTick(tick.last_price);
                deltaBuffer.onTick(tick.last_price, tick.volume_traded);
                marketDataHealth.onTick(tick);
                await candlePollInstance.checkSL(tick.last_price);
                await candlePollInstance.checkTarget(tick.last_price);
                await candlePollInstance.checkDailyLoss(tick.last_price);
                await candlePollInstance.checkSessionTarget(tick.last_price);
            }
        }
    });

    ticker.on("error",       err => {
        if (err.message?.includes("403")) console.log(c.dim("WS  market closed"));
        else console.error(c.red("WS ERROR " + (err.message || err)));
    });
    ticker.on("close",       ()  => { console.log(c.dim("WS  closed")); marketDataHealth.onClose(); });
    ticker.on("reconnect",   n   => { console.log(c.dim(`WS  reconnect #${n}`)); deltaBuffer.resync(); });
    ticker.on("noreconnect", ()  => { console.error(c.red("WS  max reconnects")); process.exit(1); });
}

main().catch(err => {
    console.error("BOOT FAILED", err);
    process.exit(1);
});

process.on("uncaughtException",  err => console.error("UNCAUGHT",  err));
process.on("unhandledRejection", err => console.error("UNHANDLED", err));
