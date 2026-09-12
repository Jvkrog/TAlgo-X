// backtestHedgePairReport.js — same JSON+HTML report shape backtestReport.js
// produces for a single-instrument strategy, adapted for two legs: every
// trade row is tagged with which leg (CORE/HEDGE) it belongs to, and
// metrics are reported per-leg AND combined (core+hedge PnL together is
// the number that actually matters — the whole point of the hedge is
// what it does to the COMBINED curve, not either leg in isolation).
//
// Deliberately a separate file rather than extending backtestReport.js's
// renderHtml()/buildReport() with an optional two-leg mode — every other
// strategy's report has exactly one instrument, one metrics block; adding
// leg-awareness there for a single caller would complicate the common
// case for no benefit to it.
"use strict";

const fs   = require("fs");
const path = require("path");
const { fmtDuration } = require("./backtestMetrics");

function fmtMoney(n) { return (n < 0 ? "-\u20b9" : "\u20b9") + Math.abs(n).toFixed(2); }

function buildHedgePairReport({ core, hedge, unwindMode, range, runAt, metrics, trades }) {
    return {
        strategy: "HEDGE_PAIR",
        core,    // { underlying, symbol, lots, lotMult }
        hedge,   // { underlying, symbol, lots, lotMult }
        unwindMode,
        range: {
            from: range.from instanceof Date ? range.from.toISOString().split("T")[0] : String(range.from),
            to:   range.to   instanceof Date ? range.to.toISOString().split("T")[0]   : String(range.to),
        },
        runAt: runAt.toISOString(),
        metrics,  // { core: {...}, hedge: {...}, combined: {...} } — each shaped like backtestMetrics.computeMetrics()'s output
        trades,   // merged CORE+HEDGE trades, sorted by exit_time, each with a `leg` field
    };
}

function metricsCards(m) {
    const pf = m.profitFactor === null ? "-" : m.profitFactor === Infinity ? "\u221e" : m.profitFactor.toFixed(2);
    return `<div class="grid">
  <div class="card"><div class="label">Trades</div><div class="value">${m.trades}</div></div>
  <div class="card"><div class="label">Win Rate</div><div class="value">${(m.winRate * 100).toFixed(1)}%</div></div>
  <div class="card"><div class="label">Profit Factor</div><div class="value">${pf}</div></div>
  <div class="card"><div class="label">Net PnL</div><div class="value ${m.netPnL >= 0 ? "pos" : "neg"}">${fmtMoney(m.netPnL)}</div></div>
  <div class="card"><div class="label">Max Drawdown</div><div class="value neg">${fmtMoney(m.maxDrawdown)}</div></div>
  <div class="card"><div class="label">Largest Win</div><div class="value pos">${fmtMoney(m.largestWin)}</div></div>
  <div class="card"><div class="label">Largest Loss</div><div class="value neg">${fmtMoney(m.largestLoss)}</div></div>
  <div class="card"><div class="label">Avg Trade</div><div class="value">${fmtMoney(m.avgTrade)}</div></div>
  <div class="card"><div class="label">Avg Hold Time</div><div class="value">${fmtDuration(m.avgHoldTimeMs)}</div></div>
</div>`;
}

function renderHedgePairHtml(report) {
    // Running COMBINED session PnL — same chronological-running-sum
    // reasoning as backtestReport.js's own version, just over the merged
    // core+hedge trade list instead of one instrument's.
    let runningCombined = 0;
    const rows = report.trades
        .filter(t => t.status === "CLOSED")
        .map(t => {
            const pnlClass = (t.pnl || 0) >= 0 ? "pos" : "neg";
            runningCombined += (t.pnl || 0);
            const combinedClass = runningCombined >= 0 ? "pos" : "neg";
            const sideClass = t.side === "LONG" ? "pos" : "neg";
            const sideArrow = t.side === "LONG" ? "\u25b2" : "\u25bc";
            const legClass  = t.leg === "CORE" ? "" : "hedge-leg";
            return `<tr class="${legClass}">
                <td>${t.leg}</td>
                <td>${t.entry_time}</td><td class="${sideClass}">${sideArrow} ${t.side}</td><td>${t.entry_price}</td>
                <td>${t.exit_time}</td><td>${t.exit_price}</td>
                <td class="${pnlClass}">${(t.pnl || 0).toFixed(2)}</td>
                <td class="${combinedClass}">${runningCombined.toFixed(2)}</td>
                <td>${t.exit_reason}</td>
            </tr>`;
        })
        .join("");

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Hedge Pair \u2014 ${report.core.symbol} / ${report.hedge.symbol} backtest</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e6e6e6;padding:24px;max-width:1100px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px} .meta{color:#9aa0ab;font-size:13px;margin-bottom:20px}
h2{font-size:15px;color:#9aa0ab;margin-top:28px;border-bottom:1px solid #2a2e37;padding-bottom:6px}
table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px}
th,td{border:1px solid #2a2e37;padding:6px 10px;text-align:right}
th{background:#161a22} td:first-child,th:first-child{text-align:left}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-top:8px}
.card{background:#161a22;border:1px solid #2a2e37;border-radius:8px;padding:12px}
.card .label{font-size:11px;color:#9aa0ab} .card .value{font-size:20px;margin-top:4px;font-weight:600}
.pos{color:#3ecf8e}.neg{color:#f0616d}
.hedge-leg td{color:#c9a86a}
</style></head><body>
<h1>Hedge Pair \u2014 ${report.core.symbol} (core) / ${report.hedge.symbol} (hedge)</h1>
<div class="meta">core ${report.core.lots} lot NRML \u00b7 hedge ${report.hedge.lots} lots \u00b7 unwind:${report.unwindMode} \u00b7 ${report.range.from} \u2192 ${report.range.to} \u00b7 run ${report.runAt}</div>

<h2>Combined (core + hedge)</h2>
${metricsCards(report.metrics.combined)}

<h2>Core leg only \u2014 ${report.core.symbol}</h2>
${metricsCards(report.metrics.core)}

<h2>Hedge leg only \u2014 ${report.hedge.symbol}</h2>
${metricsCards(report.metrics.hedge)}

<h2>Trades (${report.metrics.combined.trades}) \u2014 gold rows are the hedge leg</h2>
<table><thead><tr>
  <th>Leg</th><th>Entry Time</th><th>Side</th><th>Entry</th><th>Exit Time</th><th>Exit</th><th>PnL</th><th>Combined PnL</th><th>Reason</th>
</tr></thead><tbody>${rows || `<tr><td colspan="9">no closed trades in this range</td></tr>`}</tbody></table>
</body></html>`;
}

function saveHedgePairReport(report, outDir = path.join(__dirname, "backtests")) {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    const stamp = report.runAt.replace(/[:.]/g, "-");
    const base  = `HEDGE_PAIR_${report.core.symbol}_${report.hedge.symbol}_${stamp}`;
    const jsonPath = path.join(outDir, `${base}.json`);
    const htmlPath = path.join(outDir, `${base}.html`);

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(htmlPath, renderHedgePairHtml(report));

    return { jsonPath, htmlPath };
}

module.exports = { buildHedgePairReport, renderHedgePairHtml, saveHedgePairReport };
