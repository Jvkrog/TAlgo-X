// engineConfig.js — Brain parameters. Instrument-agnostic.
//
// Model: ST1 gives direction, DPI does entries and exits (see signals.js
// header for the full picture). ST2/USE_ST2_FILTER removed — ST1 alone
// feeds pendingSide, nothing else gates or exits off it anymore.
"use strict";

const path = require("path");

// Anchored to __dirname, not left to dotenv's own default (process.cwd()).
// Before talgox was wired up as a global command (npm link), engineConfig.js
// was always required from a process already running IN the project
// directory, so cwd-relative resolution happened to work by accident. Now
// that `talgox` can be typed from any directory, cwd could be anywhere —
// .env must be found relative to this FILE's location, not wherever the
// person happened to be standing when they ran the command.
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

// Same reasoning for any relative file path below: resolve it against this
// project's own directory, not cwd. path.resolve leaves an already-absolute
// path untouched, so this is a no-op for anyone already using absolute
// paths in their .env — only fixes the relative-path case.
const resolveLocal = p => (p ? path.resolve(__dirname, p) : p);

module.exports = {
    API_KEY:           process.env.API_KEY,
    API_SECRET:        process.env.API_SECRET,       // needed by toolbox.js to exchange request_token -> access_token
    ACCESS_TOKEN_FILE: resolveLocal(process.env.ACCESS_FILE || "access_code.txt"),

    // Instrument source — checked in this order (see instrumentSource.js):
    //   1. local CSV file at this path, if it exists and parses successfully
    //   2. live Kite API fetch, as fallback
    // Set to null (or unset the env var) to always use the live API.
    INSTRUMENT_CSV_PATH: resolveLocal(process.env.INSTRUMENT_CSV_PATH || null),
    // Separate from the MCX path above — instrumentSource.js's local-file
    // lookup is per-exchange (whichever exchange def.exchange resolves to),
    // so an NSE equity boot needs its own path, not a shared/overloaded one.
    NSE_INSTRUMENT_CSV_PATH: resolveLocal(process.env.NSE_INSTRUMENT_CSV_PATH || null),

    // Candle source — 15m HA
    HIST_INTERVAL: "15minute",
    MAX_CANDLES:   600,                  // 200 x 15m = ~3 trading sessions

    // SuperTrend on 15m HA candles — direction only. Feeds pendingSide and
    // sizes the SL trail direction. Does not gate entries or trigger exits
    // by itself anymore — DPI owns both of those.
    ST_ATR_LEN:    10,                   // SuperTrend / ATR lookback
    ST_FACTOR:     2.0,                  // SuperTrend multiplier
    ATR_SL_MULT:   2.0,                  // SL trail width = ATR_SL_MULT x ATR(ST_ATR_LEN)

    // MCX rejects order_type:"MARKET" via the API without market protection —
    // orders.js emulates it with a LIMIT order banded this % around live LTP.
    MARKET_PROTECTION_PCT: 0.5,

    // DPI (Directional Persistence Index) — confirms entries, owns exits.
    // Entry: dpiState must be STRONG_BULL/STRONG_BEAR (matching ST1's
    //   pendingSide), which already requires |dpi| >= threshold AND
    //   efficiency >= DPI_EFF_THRESH.
    // Exit: TWO independent triggers, either one closes the position —
    //   1. giveback-from-peak (USE_DPI_GIVEBACK)
    //   2. efficiency floor breach (always on — DPI_EFF_THRESH, forced exit)
    DPI_LEN:           10,               // lookback window (candles)
    DPI_STREAK_MULT:   0.2,              // per-candle same-direction streak bonus
    DPI_STREAK_CAP:    1.0,              // max streak bonus multiplier
    DPI_BULL_THRESH:   3.0,              // dpi >= this -> bull pressure
    DPI_BEAR_THRESH:  -3.0,              // dpi <= this -> bear pressure
    DPI_EFF_THRESH:    0.6,              // |efficiency| floor for entry/exit AND the regime split
    DPI_BALANCED_BAND: 1.5,              // |dpi| below this -> BALANCED (chop)

    // Giveback exit — closes an open position when its favorable DPI pressure
    // fades from its peak. Runs alongside the efficiency-floor exit, not
    // instead of it — whichever fires first closes the trade.
    USE_DPI_GIVEBACK:   true,
    DPI_GIVEBACK_RATIO: 0.3,             // exit when current favor-DPI < peak x this ratio

    // ── REGIME SPLIT ──────────────────────────────────────────────────────
    // efficiency is signed (net direction), magnitude [0,1] — a strong clean
    // move reads close to ±1 regardless of direction, choppy reads near 0.
    // DPI_EFF_THRESH does double duty as the regime line, not just an
    // entry/exit gate — the split is on MAGNITUDE, not sign:
    //   |efficiency| >= DPI_EFF_THRESH  -> TREND regime (DPI engine, unchanged)
    //   |efficiency| <  DPI_EFF_THRESH  -> MEANREV regime (RSI fade, below)
    // Trend entries already can't fire below this line (STRONG_BULL/BEAR
    // requires |efficiency| >= DPI_EFF_THRESH), so the split falls out
    // naturally — no separate toggle needed to keep the two exclusive.

    // Mean-reversion — fades RSI extremes instead of following them.
    // Entry: RSI >= MEANREV_RSI_SELL -> SHORT (bet on reversion down)
    //        RSI <= MEANREV_RSI_BUY  -> LONG  (bet on reversion up)
    // Exit:  opposite extreme — a SHORT exits at RSI <= MEANREV_RSI_BUY,
    //        a LONG exits at RSI >= MEANREV_RSI_SELL. Same trigger as the
    //        opposite side's entry, so a close and a fresh entry the other
    //        way can land on the same candle — that's intentional, not a bug.
    MEANREV_RSI_SELL: 60,
    MEANREV_RSI_BUY:  40,

    // Observation window
    TRADE_START_HOUR:   9,
    TRADE_START_MINUTE: 15,

    // Engine toggle
    ENGINE_ENABLED: true,

    // Order placement — set true only when ready to go live
    LIVE_ORDERS: false,

    // Resume behaviour — intraday only, no overnight carry.
    RESUME_INTRADAY_ONLY: true,

    // ADX filter — gates new entries only, never exits
    ADX_LEN:        14,
    ADX_MIN:        20,
    USE_ADX_FILTER: false,

    // RSI filter — directional momentum bias gate, entries only
    RSI_LEN:        14,
    RSI_LONG_MIN:   55,
    RSI_SHORT_MAX:  45,
    USE_RSI_FILTER: false,

    // Choppiness Index — filters entries in ranging/choppy markets
    CHOP_LEN:        14,
    CHOP_MAX:        50,               // above this = choppy, block entry
    USE_CHOP_FILTER: false,

    // Hilega-Milega exit — RSI(9) momentum reversal: EMA(3) crosses WMA(21)
    // Exit an open position when fast RSI line crosses slow RSI line against direction.
    // Independent of ST/DPI. Fires on candle close only.
    USE_HM_EXIT: false,

    // SMA9 reversal exit — fast, independent of DPI/giveback/efficiency.
    // Exits a SHORT the moment HA close crosses above SMA9, a LONG the
    // moment HA close crosses below it. Deliberately dumb and fast — its
    // whole job is to catch a reversal before DPI's smoothed math reacts,
    // since DPI can lag a sharp turn by a candle or two.
    SMA_LEN:       9,
    USE_SMA_EXIT:  true,

    // DPI_SMA5_EXIT strategy — separate SMA length from SMA_LEN above
    // (Pine script's own sma5Len input default is 5, not 9) — kept its own
    // key so tuning DPI_TREND_MEANREV's SMA9 exit never touches this one.
    DPI_SMA5_EXIT_LEN: 5,

    // ALMA_DUAL_BAND_SMA5 strategy — two ALMA lines (short=9, long=50) on
    // RAW close, each classified GREEN/RED(/GREY for the short line only —
    // see strategies.js's header comment for exactly why the two lines
    // aren't classified the same way). Own namespace, not shared with
    // ALMA_BAND's ALMA_LEN/OFFSET/SIGMA above — different lengths, and
    // tuning one strategy's ALMA shouldn't silently move the other's.
    // ALMA_DUAL_DIFF_PCT is the short line's own threshold (matches the
    // 0.005 hardcoded in the source Pine script exactly) — the long line's
    // classification is a plain above/below check, no threshold needed.
    ALMA_DUAL_SHORT_LEN: 9,
    ALMA_DUAL_LONG_LEN:  50,
    ALMA_DUAL_OFFSET:    0.85,
    ALMA_DUAL_SIGMA:     6,
    ALMA_DUAL_DIFF_PCT:  0.005,

    // Telegram
    TG_TOKEN:   process.env.TELEGRAM_TOKEN   || "",
    TG_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",

    // ALMA Band strategy — ta.alma(high/low) breakout bands, on RAW candles
    // (not HA). Values match the "ALMA High-Low Band (Algo View)" Pine
    // script exactly. indicators.js's alma() already referenced these as
    // default args — they just didn't exist here yet.
    ALMA_LEN:    20,
    ALMA_OFFSET: 0.85,
    ALMA_SIGMA:  6,

    // ALMA_FAST strategy — single ALMA on HA close, entry on the line's
    // slope flipping direction (not a band breakout). Separate config
    // namespace from ALMA_BAND's ALMA_LEN/OFFSET/SIGMA above so tuning one
    // strategy never silently affects the other, even though today's
    // defaults happen to match the Pine script's fast-ALMA values exactly.
    ALMA_FAST_LEN:    20,
    ALMA_FAST_OFFSET: 0.85,
    ALMA_FAST_SIGMA:  6,

    // ALMA_FAST whipsaw controls — the raw Pine script flips on ANY slope
    // change, even a single-tick wiggle, which is exactly what causes
    // constant flip-flopping in a sideways market.
    //   DEADBAND: slope must exceed this x ATR to count as a real
    //   direction — smaller moves classify as NEUTRAL ("grey"), and grey
    //   neither opens nor closes a position, it just holds whatever's
    //   already there and waits for a real move either way.
    ALMA_FAST_DEADBAND_ATR_MULT: 0.1,
    // CHOP filter: a second, independent brake — blocks NEW entries (not
    // exits) when the Choppiness Index says the market is sideways, same
    // 0-100 scale as the shared CHOP_LEN indicator below. Separate toggle
    // from DPI_TREND_MEANREV's USE_CHOP_FILTER/CHOP_MAX so tuning one
    // strategy's chop sensitivity never touches the other's.
    USE_ALMA_FAST_CHOP_FILTER: true,
    ALMA_FAST_CHOP_MAX:        50,

    // DUAL_ST_CHOP strategy — two independent SuperTrends must agree on
    // direction (ST1 = faster/tighter, ST2 = slower/wider — classic dual-ST
    // spread), gated by the Choppiness Index so entries only fire when the
    // market isn't ranging. Separate namespace (DST_ prefix) from ST_ATR_LEN/
    // ST_FACTOR above (DPI_TREND_MEANREV's own ST1) and from CHOP_LEN/
    // CHOP_MAX (DPI_TREND_MEANREV's own optional filter) — same reasoning as
    // ALMA_FAST's separate namespace above: tuning one strategy should never
    // silently move another.
    DST_ST1_ATR_LEN: 10,
    DST_ST1_FACTOR:  1.0,   // faster/tighter of the two
    DST_ST2_ATR_LEN: 10,
    DST_ST2_FACTOR:  3.0,   // slower/wider of the two
    DST_CHOP_LEN:    14,
    DST_CHOP_MAX:    50,    // above this = choppy, blocks new entries even if ST1/ST2 agree

    // MA_SLOPE strategy — from the "Moving Average Slope [aamonkey]" Pine
    // script. Own namespace (MA_SLOPE_ATR_LEN is NOT the same as ST_ATR_LEN
    // used for this strategy's own SL trail addition) — the script's own
    // atr(14) is part of the angle formula itself, a different thing from
    // the risk-management ATR trail every strategy in this file adds.
    MA_SLOPE_LEN:            56,   // ema(ohlc4, 56) — the script's `ma`
    MA_SLOPE_ATR_LEN:        14,   // atr(14) inside the script's angle() function
    MA_SLOPE_FILTER_TOP:      2,   // ft — angle above this = decisive bull
    MA_SLOPE_FILTER_BOTTOM:  -2,   // fb — angle below this = decisive bear

    // MA_SLOPE_SCALP — same entries/exits as MA_SLOPE, plus a tick-level
    // take-profit: exit the instant price moves this many points in favour,
    // checked on every WebSocket tick (candlePoll.js's checkTarget), not on
    // candle close. The existing ATR SL trail (checkSL) still runs alongside
    // it — this is an ADDITIONAL exit, not a replacement.
    SCALP_TARGET_POINTS:      1,

    // MA_SLOPE 3-bar reversal exit + fixed target — added across all three
    // MA_SLOPE variants (7/8/9). Own namespace (MA_SLOPE_ prefix) since this
    // is unrelated to SCALP_TARGET_POINTS above (that one only ever armed
    // for MA_SLOPE_SCALP's GREY/scalp entries; this fires for every MA_SLOPE
    // entry, all three strategies, both entry modes where a strategy has more
    // than one). Candle-close driven (same cadence as the flip exit), NOT a
    // tick check — see the header comments on each strategy for the exact
    // "lowest/highest of the last N candles" definition.
    // MA_SLOPE 3rd-candle reversal exit — REMOVED (backtest results looked
    // bad, reverted per instruction). MA_SLOPE_TARGET_POINTS below is
    // unaffected/unrelated and stays.
    MA_SLOPE_TARGET_POINTS:     3,   // fixed favorable-exit target, points from entry, tick-checked
    // superseded by context.targetPoints (toolbox prompt) — applies to ALL
    // strategies now, not just the MA_SLOPE family. Left here unread, for
    // reference only.

    // MA_SLOPE_PURE (#9) SMA9 reversal exit — added on top of the existing
    // opposite-color-flip exit. Gated by a STRONGER slope threshold than
    // the +-2 degree GREY/decisive split (MA_SLOPE_FILTER_TOP/BOTTOM) used
    // for entries: only checked once the slope has already confirmed a
    // clearly one-sided move (angle beyond this many degrees, same sign as
    // the open position), not on every decisive-but-marginal candle. Same
    // HA-close-vs-SMA(9) crossover DPI_TREND_MEANREV's own SMA9 exit uses
    // (reuses engineConfig.SMA_LEN), candle-close driven like every other
    // MA_SLOPE_PURE exit — not a tick check.
    MA_SLOPE_PURE_SMA9_EXIT_ANGLE: 4,

    // Market-quality gate (marketQuality.js) — applies to strategies 7/8's
    // ALMA-band-driven entries only (MA_SLOPE_TREND and ALMA_BAND_BREAKOUT),
    // never to exits. Skips an entry when ATR(ST_ATR_LEN) is disproportionately
    // large relative to the current ALMA band width (almaHigh - almaLow) —
    // i.e. ordinary-sized candles are big enough to cross the band
    // repeatedly on their own, which is what produces the flip-flop
    // (breakout -> entry -> band re-entry -> exit -> breakout again) in a
    // compressed/choppy market, even though each individual entry/exit is
    // firing correctly per its own rule.
    // STARTING VALUE, NOT CALIBRATED: 3 means "ATR is more than 3x the
    // entire band width" trips the skip. I have no backtest/live data for
    // ZINCMINI's actual ATR-to-band-width behavior to tune this against —
    // treat this as a first guess to observe and adjust, the same way
    // SCALP_TARGET_POINTS started as a discussion, not a backtested number.
    QUALITY_GATE_ENABLED:          true,
    QUALITY_MAX_ATR_TO_BAND_RATIO: 3,

    // ADAPTIVE_TREND — strategy #11, direct port of the user-supplied Pine
    // v6 script "Adaptive Trend Envelope [BackQuant]". Own namespace, all
    // defaults match the script's own input defaults exactly. See
    // indicators.js's adaptiveTrendEnvelope() header comment for the
    // hysteresis-input-is-dead-code note — HYSTERESIS_FRACTION is
    // deliberately NOT in this list since the script itself never reads it
    // in the actual regime logic.
    ATE_FAST_LEN:      7,    // fast EMA length (script: fastLen)
    ATE_SLOW_LEN:      34,   // slow EMA length (script: slowLen)
    ATE_BLEND_LEN:     30,   // blend-weight + spine smoothing length (script: blendLen)
    ATE_RET_LEN_SHORT: 20,   // short return-volatility window (script: retLenS)
    ATE_RET_LEN_LONG:  80,   // long return-volatility window (script: retLenL)
    ATE_BAND_MULT:     1.9,  // envelope width multiplier (script: bandMult)
    ATE_EWMA_ALPHA:    0.09, // EWMA variance smoothing alpha (script: ewmaAlpha)
    ATE_CONFIRM_BARS:  1,    // bars required outside the band to confirm a regime flip (script: confirmBars)

    // DYNAMIC_BAND — strategy #13. Own namespace, single value: the fixed
    // PRICE distance between HIGH/MID/LOW (NOT ATR-derived, per spec — ATR
    // is only used here for the same optional SL trail every other
    // strategy in this file has). This is the FALLBACK default only —
    // per-instrument value lives on context.bandStep, set via toolbox.js's
    // prompt (only asked when this strategy is picked) / BAND_STEP_OVERRIDE,
    // same override pattern as context.targetPoints.
    BAND_STEP_DEFAULT: 1,

    // ALMA_TRI_BAND — strategy #15. Direct port of the user-provided Pine
    // indicator ("TAlgo — Zinc Optimized v3") — despite the Pine title,
    // kept fully instrument-agnostic here (own namespace, no "ZINC" in any
    // key) since context.js/toolbox.js already let ANY strategy run on ANY
    // instrument; hardcoding the name would be misleading the moment
    // someone runs this on something other than zinc. Values below are the
    // Pine script's own input defaults, unchanged.
    ALMA_TRI_FAST_LEN:          14,   // Pine: fast_len
    ALMA_TRI_BAND_LEN:          30,   // Pine: band_len
    ALMA_TRI_ATR_LEN:           14,   // Pine: atr_len — separate from ST_ATR_LEN/ATR_SL_MULT above, which size this strategy's OWN SL trail (not part of the ported indicator, see strategies.js)
    ALMA_TRI_OFFSET:            0.85, // Pine: offset
    ALMA_TRI_SIGMA:             6.0,  // Pine: sigma
    ALMA_TRI_COMPRESS_MULT:     0.78, // Pine: compress_mult — band_width < atr*this => sideways/grey
    ALMA_TRI_SLOPE_MULT:        0.020,// Pine: slope_mult — |slope| > atr*this => decisive direction
    ALMA_TRI_BIG_CANDLE_MULT:   1.8,  // Pine: big_candle_mult — body > atr*this => force grey
    ALMA_TRI_NEUTRAL_SLOPE_MULT: 0.015, // Pine: the inner 0.015 threshold in the hysteresis fallback branch
    ALMA_TRI_BUFFER_MULT:       0.20, // Pine: buffer = atr*0.20, added past the band before counting as a breach
    // Per-instrument override lives on context.greyExitEnabled — default
    // here matches ALMA_FAST's/MA_SLOPE's existing convention of holding
    // through a neutral/grey reading rather than exiting on it.
    GREY_EXIT_DEFAULT: false,
};
