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
function resolveParams(strategyKey, raw) {
    const specs = STRATEGY_PARAM_SPEC[strategyKey] || [];
    const input = raw && typeof raw === "object" ? raw : {};
    const values = {}, warnings = [], errors = [];
    for (const s of specs) {
        const r = coerce(s, input[s.key]);
        if (r.ok) values[s.key] = r.value; else { values[s.key] = s.default; errors.push(r.why + ` — using default ${s.default}`); }
    }
    for (const k of Object.keys(input)) if (!specs.some(s => s.key === k)) warnings.push(`unknown parameter "${k}" ignored`);
    return { values, warnings, errors };
}

// Strict variant for CLI / WebDash input validation: { ok, params (only explicitly-set keys), errors }
function validateParams(strategyKey, raw) {
    const specs = STRATEGY_PARAM_SPEC[strategyKey] || [], input = raw && typeof raw === "object" ? raw : {}, params = {}, errors = [];
    for (const s of specs) {
        if (input[s.key] === undefined || input[s.key] === null || input[s.key] === "") continue;
        const r = coerce(s, input[s.key]);
        if (r.ok) params[s.key] = r.value; else errors.push(r.why);
    }
    for (const k of Object.keys(input)) if (!specs.some(s => s.key === k)) errors.push(`unknown parameter "${k}"`);
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
