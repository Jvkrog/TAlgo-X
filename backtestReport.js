// backtestReport.js — builds and saves Step 10's report.json/report.html.
//
// Output lives in a single flat `backtests/` directory (one mkdir, no
// per-strategy/per-instrument/per-run subfolders) — file names carry the
// strategy, instrument, and run timestamp instead:
//   backtests/<STRATEGY>_<INSTRUMENT>_<runTimestamp>.json
//   backtests/<STRATEGY>_<INSTRUMENT>_<runTimestamp>.html
"use strict";

const fs   = require("fs");
const path = require("path");
const { fmtDuration } = require("./backtestMetrics");

function buildReport({ strategyKey, strategyLabel, underlying, timeframe, from, to, params, metrics, trades, runAt }) {
    return {
        strategy:      strategyKey,
        strategyLabel: strategyLabel || strategyKey,
        instrument:    underlying,
        timeframe,
        range: {
            from: from instanceof Date ? from.toISOString().split("T")[0] : String(from),
            to:   to   instanceof Date ? to.toISOString().split("T")[0]   : String(to),
        },
        params,
        runAt: runAt.toISOString(),
        metrics,
        trades,
    };
}

function fmtMoney(n) { return (n < 0 ? "-₹" : "₹") + Math.abs(n).toFixed(2); }

function renderHtml(report) {
    const m = report.metrics;
    const pf = m.profitFactor === null ? "-" : m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);

    const rows = report.trades
        .filter(t => t.status === "CLOSED")
        .map(t => {
            const pnlClass = (t.pnl || 0) >= 0 ? "pos" : "neg";
            return `<tr>
                <td>${t.entry_time}</td><td>${t.side}</td><td>${t.entry_price}</td>
                <td>${t.exit_time}</td><td>${t.exit_price}</td>
                <td class="${pnlClass}">${(t.pnl || 0).toFixed(2)}</td><td>${t.exit_reason}</td>
            </tr>`;
        })
        .join("");

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${report.strategyLabel} — ${report.instrument} backtest</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e6e6e6;padding:24px;max-width:1000px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px} .meta{color:#9aa0ab;font-size:13px;margin-bottom:20px}
h2{font-size:15px;color:#9aa0ab;margin-top:28px;border-bottom:1px solid #2a2e37;padding-bottom:6px}
table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px}
th,td{border:1px solid #2a2e37;padding:6px 10px;text-align:right}
th{background:#161a22} td:first-child,th:first-child{text-align:left}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-top:8px}
.card{background:#161a22;border:1px solid #2a2e37;border-radius:8px;padding:12px}
.card .label{font-size:11px;color:#9aa0ab} .card .value{font-size:20px;margin-top:4px;font-weight:600}
.pos{color:#3ecf8e}.neg{color:#f0616d}
</style></head><body>
<h1>${report.strategyLabel} — ${report.instrument}</h1>
<div class="meta">${report.timeframe} · ${report.range.from} → ${report.range.to} · run ${report.runAt}</div>
<div class="grid">
  <div class="card"><div class="label">Trades</div><div class="value">${m.trades}</div></div>
  <div class="card"><div class="label">Win Rate</div><div class="value">${(m.winRate * 100).toFixed(1)}%</div></div>
  <div class="card"><div class="label">Profit Factor</div><div class="value">${pf}</div></div>
  <div class="card"><div class="label">Net Points</div><div class="value ${m.netPoints >= 0 ? "pos" : "neg"}">${m.netPoints.toFixed(2)}</div></div>
  <div class="card"><div class="label">Net PnL</div><div class="value ${m.netPnL >= 0 ? "pos" : "neg"}">${fmtMoney(m.netPnL)}</div></div>
  <div class="card"><div class="label">Max Drawdown</div><div class="value neg">${fmtMoney(m.maxDrawdown)}</div></div>
  <div class="card"><div class="label">Largest Win</div><div class="value pos">${fmtMoney(m.largestWin)}</div></div>
  <div class="card"><div class="label">Largest Loss</div><div class="value neg">${fmtMoney(m.largestLoss)}</div></div>
  <div class="card"><div class="label">Avg Trade</div><div class="value">${fmtMoney(m.avgTrade)}</div></div>
  <div class="card"><div class="label">Avg Hold Time</div><div class="value">${fmtDuration(m.avgHoldTimeMs)}</div></div>
</div>
<h2>Trades (${m.trades})</h2>
<table><thead><tr>
  <th>Entry Time</th><th>Side</th><th>Entry</th><th>Exit Time</th><th>Exit</th><th>PnL</th><th>Reason</th>
</tr></thead><tbody>${rows || `<tr><td colspan="7">no closed trades in this range</td></tr>`}</tbody></table>
</body></html>`;
}

function saveReport(report, outDir = path.join(__dirname, "backtests")) {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    const stamp = report.runAt.replace(/[:.]/g, "-");
    const base  = `${report.strategy}_${report.instrument}_${stamp}`;
    const jsonPath = path.join(outDir, `${base}.json`);
    const htmlPath = path.join(outDir, `${base}.html`);

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(htmlPath, renderHtml(report));

    return { jsonPath, htmlPath };
}

module.exports = { buildReport, renderHtml, saveReport };
