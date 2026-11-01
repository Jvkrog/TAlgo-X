// riskObserver/calibrate.js — shadow validation / threshold evaluation. OFFLINE and READ-ONLY.
//
// Replays the Risk Observer's own recorded 15m candles and positions through the SAME riskState machine for a set of
// threshold configurations and REPORTS what each would have done. It never changes production defaults, never ranks
// configurations as "best", and says plainly when the sample is too small.
//
// Method and limits (also printed in the report):
//   * Price proxy = the completed 15m CLOSE. The live observer evaluates on ticks, so intra-candle excursions are not
//     reproduced — replayed adverse moves are understated and confirmation counts are counted in candles (stricter than live).
//   * Causal inputs only: ATR, DSB colours (HA + band steppers are causal) and streaks at candle i use candles <= i.
//     Outcomes ("did it get worse afterwards?") look ahead ONLY to score a warning, never to decide it.
//   * Chronological split: positions are ordered by entry time; the earlier 60% and later 40% are reported separately
//     so a configuration's behaviour out-of-sample is visible. Nothing is fitted, so there is no tuning on a holdout.
//   * Positions with PARTIAL metrics or missing candle coverage are excluded unless includePartial is set.
"use strict";

const { newMachine, step } = require("./riskState");
const { dualReplay, relation } = require("./dsbMonitor");
const { atr } = require("../indicators");
const { summarisePosition } = require("./analytics");

const IST_MS = 5.5 * 3600 * 1000, TF = 15 * 60000;
const dayKey = ts => new Date(ts + IST_MS).toISOString().slice(0, 10);
const UNHELPFUL_FURTHER_ATR = 0.5;   // a warning is "unhelpful" when the position never got more than this much (in ATR) worse afterwards

function candlesCover(cs) {   // contiguous within each IST day (weekend/overnight gaps are fine)
    for (let i = 1; i < cs.length; i++) if (cs[i].ts - cs[i - 1].ts > TF && dayKey(cs[i].ts) === dayKey(cs[i - 1].ts)) return false;
    return cs.length >= 3;
}

// Replay one position under one configuration. rows = dualReplay over ALL candles (causal), idx = index of first candle >= entryTs.
function replayPosition({ side, entryPrice, entryTs, endTs }, candles, rows, cfg, { atrLen = 10, evalsPerCandle = 1 } = {}) {
    const long = side === "LONG"; let m = newMachine(); const out = { transitions: [], evaluated: 0, maxAdversePts: 0, atrMissing: 0 };
    let adverseStreak = 0, peakFav = 0, lastCandleTs = null; const perCandle = [];
    for (let i = 0; i < candles.length; i++) {
        const cd = candles[i]; if (cd.ts < entryTs || cd.ts >= endTs) continue;
        const adv = long ? entryPrice - cd.close : cd.close - entryPrice;
        const fav = -adv; if (fav > peakFav) peakFav = fav;
        const against = long ? cd.close < cd.open : cd.close > cd.open; adverseStreak = against ? adverseStreak + 1 : 0;
        const a = i + 1 > atrLen ? atr(candles.slice(0, i + 1), atrLen) : null;
        if (!a || !(a > 0)) { out.atrMissing++; continue; }
        let dis = 0; for (let j = i; j >= 0; j--) { const r = rows[j]; if (r.c1 !== "none" && r.c2 !== "none" && r.c1 !== r.c2) dis++; else break; }
        const rel = relation(side, rows[i].c1, rows[i].c2);
        const inputs = { adverseAtr: Math.max(0, adv) / a, adverseCandles: adverseStreak, disagreeCandles: dis, oppositeAgree: rel === "opposite" };
        out.evaluated++; out.maxAdversePts = Math.max(out.maxAdversePts, adv);
        const adversePts = Math.max(0, adv), giveback = Math.max(0, peakFav - fav);
        for (let k = 0; k < evalsPerCandle; k++) {
            const r = step(m, inputs, cfg); m = r.machine;
            if (r.transition) out.transitions.push({ ts: cd.ts, ...r.transition, adversePts, adverseAtr: inputs.adverseAtr, atr: a, giveback, idx: perCandle.length });
        }
        perCandle.push({ ts: cd.ts, adversePts, atr: a });
        lastCandleTs = cd.ts;
    }
    // outcome scoring for warnings (look-ahead only for scoring)
    for (const t of out.transitions) {
        if (t.to !== "WATCH" && t.to !== "DANGER") continue;
        let worst = t.adversePts; for (let j = t.idx + 1; j < perCandle.length; j++) worst = Math.max(worst, perCandle[j].adversePts);
        t.furtherAdversePts = worst - t.adversePts; t.furtherAdverseAtr = t.furtherAdversePts / t.atr; t.unhelpful = t.furtherAdverseAtr < UNHELPFUL_FURTHER_ATR;
    }
    out.lastCandleTs = lastCandleTs; return out;
}

function aggregate(results) {
    const warnings = [], danger = [];
    let recovered = 0, maxAdverse = 0, evaluatedCandles = 0;
    for (const r of results) {
        evaluatedCandles += r.evaluated; maxAdverse = Math.max(maxAdverse, r.maxAdversePts);
        // a warning episode = the transition INTO WATCH/DANGER from NORMAL/RECOVERY
        for (const t of r.transitions) {
            if ((t.to === "WATCH" || t.to === "DANGER") && (t.from === "NORMAL" || t.from === "RECOVERY")) warnings.push(t);
            if (t.to === "DANGER") danger.push(t);
            if (t.from === "DANGER" && t.to === "RECOVERY") recovered++;
        }
    }
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const meas = warnings.filter(w => w.unhelpful !== undefined);
    return {
        positions: results.length, candlesEvaluated: evaluatedCandles,
        warnings: warnings.length, dangerEvents: danger.length, directDanger: danger.filter(t => t.skippedWatch).length,
        avgAdverseAtWarningPts: avg(warnings.map(w => w.adversePts)), avgAdverseAtWarningAtr: avg(warnings.map(w => w.adverseAtr)),
        maxAdversePts: results.length ? maxAdverse : null, avgGivebackAtWarningPts: avg(warnings.map(w => w.giveback)),
        unhelpfulWarnings: meas.filter(w => w.unhelpful).length, unhelpfulMeasured: meas.length, unhelpfulShare: meas.length ? meas.filter(w => w.unhelpful).length / meas.length : null,
        dangerRecovered: recovered, dangerRecoveryShare: danger.length ? recovered / danger.length : null,
    };
}

function configGrid(base) {
    const defs = [["watchAdverseAtr", 0.75, 1.25], ["watchDisagreeCandles", -1, 1], ["dangerAdverseAtr", 0.75, 1.25], ["dangerAdverseCandles", -1, 1], ["dangerOppositeAtr", 0.75, 1.25], ["dangerDisagreeCandles", -1, 1], ["escalateConfirm", -1, 1], ["clearConfirm", -1, 1], ["normalConfirm", -1, 1], ["clearAdverseAtr", 0.75, 1.25]];
    const list = [{ name: "defaults", cfg: { ...base } }];
    for (const [k, lo, hi] of defs) for (const f of [lo, hi]) {
        const v = Math.abs(f) < 2 && Math.abs(f) !== 0 && Number.isInteger(f) ? Math.max(0, base[k] + f) : +(base[k] * f).toFixed(3);
        if (v !== base[k]) list.push({ name: `${k}=${v}`, cfg: { ...base, [k]: v } });
    }
    return list;
}

// history = { positions, events, candles }; steps = [step1, step2]; base = resolved params (see observer.resolveParams)
function evaluate(history, { steps, base, includePartial = false, nowMs = Date.now(), atrLen = 10, evalsPerCandle = 1, configs = null } = {}) {
    const candles = history.candles.slice().sort((a, b) => a.ts - b.ts);
    const rows = candles.length ? dualReplay(candles.map(c => ({ ...c })), steps[0], steps[1]) : [];
    const usable = [], excluded = [];
    for (const p of history.positions) {
        const sum = summarisePosition(p, history.events, nowMs);
        const endTs = p.closedAt != null ? p.closedAt : (candles.length ? candles[candles.length - 1].ts + TF : nowMs);
        const inWin = candles.filter(c => c.ts >= p.entryTs && c.ts < endTs);
        const reasons = [...sum.partialReasons];
        if (!candlesCover(inWin)) reasons.push(`recorded candles do not cover the position (${inWin.length} candle(s), or gaps)`);
        if (reasons.length && !includePartial) { excluded.push({ id: p.id, side: p.side, reasons }); continue; }
        usable.push({ id: p.id, side: p.side, entryPrice: p.entryPrice, entryTs: p.entryTs, endTs, partial: reasons });
    }
    usable.sort((a, b) => a.entryTs - b.entryTs);
    const cut = Math.ceil(usable.length * 0.6), earlier = usable.slice(0, cut), later = usable.slice(cut);
    const results = (cfgs) => cfgs.map(({ name, cfg }) => {
        const run = list => aggregate(list.map(u => replayPosition(u, candles, rows, cfg, { atrLen, evalsPerCandle })));
        return { name, cfg, all: run(usable), earlier: run(earlier), later: run(later) };
    });
    const out = results(configs || configGrid(base));
    return {
        generatedAt: nowMs, method: { price: "completed 15m close (intra-candle moves not reproduced)", evalsPerCandle, atrLen, unhelpfulRule: `warning followed by < ${UNHELPFUL_FURTHER_ATR} ATR further adverse movement`, split: "chronological 60% earlier / 40% later by entry time; nothing is fitted" },
        sample: { positionsUsed: usable.length, earlier: earlier.length, later: later.length, excluded, candles: candles.length, sufficient: usable.length >= 20 },
        configurations: out,
        limitations: [
            ...(usable.length < 20 ? [`Only ${usable.length} usable position(s). Thresholds are NOT validated by this sample; the output only shows how the machinery behaves.`] : []),
            "Candle-close price proxy understates intra-candle adverse moves; confirmations are counted in candles, stricter than the live 30s evaluations.",
            "No realised P&L is recorded by the observer, so 'unhelpful' is a movement-based proxy, not a profit/loss judgement.",
            "Configurations are one-at-a-time perturbations of the current defaults for comparison; none is recommended and production defaults are never changed by this tool.",
        ],
    };
}

function formatReport(rep) {
    const f = (v, d = 2) => (v === null || v === undefined ? "–" : Number(v).toFixed(d));
    const lines = [`Risk Observer threshold evaluation (offline, read-only) — ${new Date(rep.generatedAt).toISOString()}`, `Positions used: ${rep.sample.positionsUsed} (earlier ${rep.sample.earlier} / later ${rep.sample.later}), excluded: ${rep.sample.excluded.length}, candles: ${rep.sample.candles}`, ""];
    for (const c of rep.configurations) { const a = c.all; lines.push(`${c.name.padEnd(30)} warnings ${a.warnings}  danger ${a.dangerEvents}  adverse@warn ${f(a.avgAdverseAtWarningPts)}pts/${f(a.avgAdverseAtWarningAtr)}ATR  max adverse ${f(a.maxAdversePts)}  giveback@warn ${f(a.avgGivebackAtWarningPts)}  unhelpful ${a.unhelpfulWarnings}/${a.unhelpfulMeasured}  danger-recovered ${a.dangerRecovered}/${a.dangerEvents}  | earlier w${c.earlier.warnings} d${c.earlier.dangerEvents} · later w${c.later.warnings} d${c.later.dangerEvents}`); }
    lines.push("", "Limitations:", ...rep.limitations.map(l => "  - " + l)); return lines.join("\n");
}

module.exports = { evaluate, replayPosition, aggregate, configGrid, formatReport };

if (require.main === module) {
    (async () => {
        const file = process.argv[2]; if (!file) { console.error("usage: node riskObserver/calibrate.js <instrument>_riskobs.db [step1 step2] [--include-partial]"); process.exit(2); }
        const engineConfig = require("../engineConfig"), { resolveParams } = require("./observer"), { loadHistoryReadOnly } = require("./analytics");
        const nums = process.argv.slice(3).filter(a => !a.startsWith("--")).map(Number);
        const steps = [nums[0] || engineConfig.BAND_STEP_DEFAULT, nums[1] || engineConfig.BAND_STEP2_DEFAULT];
        console.log(formatReport(evaluate(await loadHistoryReadOnly(file), { steps, base: resolveParams(engineConfig, {}), includePartial: process.argv.includes("--include-partial") })));
    })().catch(e => { console.error(e.message); process.exit(1); });
}
