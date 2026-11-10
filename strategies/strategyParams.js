// strategyParams.js — one generic parameter mechanism for strategies that have their own settings (the TREND_DONCHIAN_VT /
// MEANREV_ZSCORE / pair family), instead of a hand-written env var + CLI prompt + WebDash field per setting.
//
//   spec    : STRATEGY_PARAM_SPEC[strategyKey] = [{ key, label, type: "int"|"float"|"enum"|"time", default, min, max, choices, help }]
//   storage : the process record keeps p.strategyParams = { key: value }   (CLI processes file / WebDash store)
//   env     : ONE variable, STRATEGY_PARAMS_OVERRIDE = JSON — written on EVERY deploy/restart ("" when nothing is set), because
//             pm2 restart merges env: an omitted key would silently keep the previous run's value (the write-asymmetry bug class).
//   engine  : engine.js -> resolveParams(strategy, JSON.parse(env)) -> context.strategyParams (validated, defaults filled).
"use strict";

const STRATEGY_PARAM_SPEC = {
    TREND_DONCHIAN_VT: [
        { key: "entryN",       label: "Entry channel (days)",            type: "int",   default: 20,    min: 5,   max: 200, help: "breakout of the N-day high/low on the last completed daily bar (55 = slower alternative)" },
        { key: "exitN",        label: "Exit channel (days)",             type: "int",   default: 10,    min: 2,   max: 100, help: "exit when the close breaks the opposite N-day extreme" },
        { key: "atrLen",       label: "ATR length (days)",               type: "int",   default: 20,    min: 5,   max: 100, help: "daily ATR used for the stop and for sizing" },
        { key: "stopAtrMult",  label: "Hard stop (x daily ATR)",         type: "float", default: 2,     min: 0.5, max: 10,  help: "fixed stop distance from the entry price" },
        { key: "reentry",      label: "Re-entry after an exit",          type: "enum",  default: "fresh", choices: ["fresh", "any"], help: "fresh = only on a NEW breakout bar; any = whenever the close is beyond the channel" },
        { key: "entryTime",    label: "Daily decision time (IST HH:MM)", type: "time",  default: "10:00", help: "one decision per day, on the last completed daily bar (like DAILY_HA_BIAS)" },
        { key: "equity",       label: "Account equity for sizing (Rs)",  type: "float", default: 0,     min: 0,   max: 1e9, help: "0 = vol-targeting off, trade the deployment's fixed lots" },
        { key: "riskPct",      label: "Risk per trade (% of equity)",    type: "float", default: 0.5,   min: 0.05, max: 5,  help: "lots = floor(equity x risk% / (stop distance x lot multiplier))" },
        { key: "maxLots",      label: "Max lots",                        type: "int",   default: 3,     min: 1,   max: 50,  help: "hard cap on the vol-targeted size" },
        { key: "minLotOvershoot", label: "Allow 1 lot up to (x budget)", type: "float", default: 1.5,   min: 1,   max: 5,   help: "if even 1 lot risks more than budget x this, the trade is SKIPPED (with an alert)" },
    ],
    MACD: [
        { key: "fast",        label: "Fast EMA length",              type: "int",   default: 12,  min: 2,  max: 200, help: "must be smaller than the slow length" },
        { key: "slow",        label: "Slow EMA length",              type: "int",   default: 26,  min: 3,  max: 400, help: "must be larger than the fast length" },
        { key: "signal",      label: "Signal EMA length",            type: "int",   default: 9,   min: 2,  max: 100, help: "EMA of the MACD line" },
        { key: "mode",        label: "Signal mode",                  type: "enum",  default: "cross", choices: ["cross", "zero"], help: "cross = MACD line vs signal line (histogram sign); zero = MACD line vs zero" },
        { key: "histBuffer",  label: "Flip buffer (x ATR14)",        type: "float", default: 0,   min: 0,  max: 5,  help: "histogram (or MACD in zero mode) must exceed this fraction of ATR before a side counts — anti flip-flop, 0 = off" },
        { key: "confirmBars", label: "Confirm bars",                 type: "int",   default: 1,   min: 1,  max: 20, help: "the side must hold for N consecutive candles before it is acted on" },
        { key: "zeroFilter",  label: "Zero-line entry filter",       type: "enum",  default: "off", choices: ["off", "on"], help: "on = LONG entries need MACD > 0, SHORT entries MACD < 0 (the opposite signal still exits)" },
        { key: "stopAtrMult", label: "Stop-loss (x ATR14, 0 = none)", type: "float", default: 0,  min: 0,  max: 20, help: "fixed stop from entry; 0 = the opposite MACD signal is the only exit" },
    ],
    HOURLY_HA_SCALP: [
        { key: "candleType",   label: "Previous-hour candle",            type: "enum",  default: "ha",     choices: ["ha", "normal"], help: "ha = Heikin-Ashi colour (chained over the 1h history); normal = plain open vs close" },
        { key: "direction",    label: "Trade direction",                 type: "enum",  default: "follow", choices: ["follow", "fade"], help: "follow = green -> LONG, red -> SHORT; fade = the opposite" },
        { key: "unit",         label: "Target / SL unit",                type: "enum",  default: "pct",    choices: ["pct", "points", "atr"], help: "pct = % of entry price; points = price points; atr = multiples of the 1h ATR" },
        { key: "targetVal",    label: "Target distance",                 type: "float", default: 0.3,      min: 0.01, max: 100000, help: "in the chosen unit — placeholder default, tune per instrument with the backtest" },
        { key: "slVal",        label: "Stop-loss distance",              type: "float", default: 0.3,      min: 0.01, max: 100000, help: "in the chosen unit — placeholder default, tune per instrument with the backtest" },
        { key: "atrLen",       label: "ATR length (1h bars)",            type: "int",   default: 14,       min: 2,   max: 100, help: "only used when unit = atr" },
        { key: "firstEntryTime", label: "First entry at/after (IST)",    type: "time",  default: "10:00",  help: "hourly entries are taken at each 1h candle close; none before this time" },
        { key: "lastEntryTime",  label: "Last entry at/before (IST)",    type: "time",  default: "22:00",  help: "a trade is closed at the next hour end, so this must leave a full hour before the session ends (MCX 23:30/23:55)" },
    ],
};

function coerce(spec, raw) {
    if (raw === undefined || raw === null || raw === "") return { ok: true, value: spec.default, defaulted: true };
    if (spec.type === "int" || spec.type === "float") {
        const n = Number(raw);
        if (!Number.isFinite(n) || (spec.type === "int" && !Number.isInteger(n))) return { ok: false, why: `${spec.label}: "${raw}" is not ${spec.type === "int" ? "a whole number" : "a number"}` };
        if (n < spec.min || n > spec.max) return { ok: false, why: `${spec.label}: ${n} outside ${spec.min}..${spec.max}` };
        return { ok: true, value: n };
    }
    if (spec.type === "enum") {
        const v = String(raw).trim().toLowerCase();
        const hit = spec.choices.find(x => String(x).toLowerCase() === v);
        return hit !== undefined ? { ok: true, value: hit } : { ok: false, why: `${spec.label}: "${raw}" must be one of ${spec.choices.join(", ")}` };
    }
    if (spec.type === "time") {
        const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})$/);
        return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? { ok: true, value: `${m[1].padStart(2, "0")}:${m[2]}` } : { ok: false, why: `${spec.label}: "${raw}" is not HH:MM` };
    }
    return { ok: false, why: `unknown param type ${spec.type}` };
}

// Returns { values, warnings, errors } — values always holds a usable value for EVERY spec key (invalid input falls back to the
// default and is reported). Unknown keys are dropped with a warning.
// Cross-field rules (checked after each field is valid on its own): { strategy: values -> error text | null }
const CROSS_CHECKS = { MACD: v => v.fast < v.slow ? null : `fast EMA length (${v.fast}) must be smaller than slow EMA length (${v.slow})` };

function resolveParams(strategyKey, raw) {
    const specs = STRATEGY_PARAM_SPEC[strategyKey] || [];
    const input = raw && typeof raw === "object" ? raw : {};
    const values = {}, warnings = [], errors = [];
    for (const s of specs) {
        const r = coerce(s, input[s.key]);
        if (r.ok) values[s.key] = r.value; else { values[s.key] = s.default; errors.push(r.why + ` — using default ${s.default}`); }
    }
    for (const k of Object.keys(input)) if (!specs.some(s => s.key === k)) warnings.push(`unknown parameter "${k}" ignored`);
    const bad = CROSS_CHECKS[strategyKey] && CROSS_CHECKS[strategyKey](values);
    if (bad) { for (const s of specs) values[s.key] = s.default; errors.push(bad + " — all defaults used"); }
    return { values, warnings, errors };
}

// Strict variant for CLI / WebDash input validation: { ok, params (only explicitly-set keys), errors }
function validateParams(strategyKey, raw, { skipCross = false } = {}) {
    const specs = STRATEGY_PARAM_SPEC[strategyKey] || [], input = raw && typeof raw === "object" ? raw : {}, params = {}, errors = [];
    for (const s of specs) {
        if (input[s.key] === undefined || input[s.key] === null || input[s.key] === "") continue;
        const r = coerce(s, input[s.key]);
        if (r.ok) params[s.key] = r.value; else errors.push(r.why);
    }
    for (const k of Object.keys(input)) if (!specs.some(s => s.key === k)) errors.push(`unknown parameter "${k}"`);
    if (!errors.length && !skipCross && CROSS_CHECKS[strategyKey]) { const merged = {}; for (const s of specs) merged[s.key] = params[s.key] !== undefined ? params[s.key] : s.default; const bad = CROSS_CHECKS[strategyKey](merged); if (bad) errors.push(bad); }
    return { ok: errors.length === 0, params, errors };
}

// The env value a deploy/restart must write: "" when the strategy has no params or none are set (always written).
function paramsToEnv(strategyKey, params) {
    if (!STRATEGY_PARAM_SPEC[strategyKey] || !params || !Object.keys(params).length) return "";
    return JSON.stringify(validateParams(strategyKey, params).params);
}

function paramsFromEnv(strategyKey, envValue) {
    let raw = {};
    if (envValue) { try { raw = JSON.parse(envValue); } catch { return { ...resolveParams(strategyKey, {}), errors: ["STRATEGY_PARAMS_OVERRIDE is not valid JSON — all defaults used"] }; } }
    return resolveParams(strategyKey, raw);
}

module.exports = { STRATEGY_PARAM_SPEC, resolveParams, validateParams, paramsToEnv, paramsFromEnv };
