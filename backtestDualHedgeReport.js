// backtestDualHedgeReport.js — JSON + HTML report for backtestDualHedge.js,
// same shape/style as backtestHedgePairReport.js. Three things differ from
// the hedge-pair report, all because of how this strategy behaves:
//   - the two legs are two ACCOUNTS on one instrument (LONG / SHORT), so trade
//     rows are tagged by account side, not core/hedge;
//   - positions carry overnight with no exit until a leg flips, so closed-trade
//     metrics alone understate risk: the report adds a mark-to-market equity
//     curve (realized + unrealized) with its own max drawdown and the worst
//     unrealized loss each leg ever sat through;
//   - per-trade MAE (worst unrealized during the trade) and whether the trade
//     ever flipped (i.e. ever had an exit rule armed) are shown.
// Handles both strategies of backtestDualHedge.js: "DUAL" and "BIAS" (daily-HA
// bias core + Dynamic Band hedge) — BIAS adds a Role column (CORE/HEDGE) and its
// own settings/activity text; everything else is shared.
// Deliberately a separate file for the same reason backtestHedgePairReport.js is.
"use strict";

// "2026-10-05T04:15:00.000Z" (UTC) -> "2026-10-05 09:45:00" (IST, no T/Z).
function fmtIst(v) {
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    return new Date(d.getTime() + 5.5 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
}


const fs   = require("fs");
const path = require("path");
const { fmtDuration } = require("./backtestMetrics");

function fmtMoney(n) { return (n < 0 ? "-\u20b9" : "\u20b9") + Math.abs(n).toFixed(2); }
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildDualHedgeReport({ underlying, symbol, lotMult, longLots, shortLots, params, range, runAt, metrics, mtm, stats, trades, meta }) {
    return {
        strategy: "DUAL_HEDGE",
        underlying, symbol, lotMult, longLots, shortLots,
        params,   // { strategy: "DUAL"|"BIAS", signal, bandStep, rangeStart, anchor, slippagePoints, + DUAL: takeProfit/maxLoss/rangeSize/gapCapture, + BIAS: bandTimeframe/unwindMode/entry/eod }
        range: {
            from: range.from instanceof Date ? range.from.toISOString().split("T")[0] : String(range.from),
            to:   range.to   instanceof Date ? range.to.toISOString().split("T")[0]   : String(range.to),
        },
        runAt: runAt.toISOString(),
        metrics,  // { long, short, combined } — each shaped like backtestMetrics.computeMetrics()'s output
        mtm,      // { finalEquity, peak, trough, maxDrawdown, maxDrawdownAt, worstUnrealized:{LONG,SHORT}, daily:[...] }
        stats,    // evaluation/entry/flip/exit-reason counters
        meta,     // { candles, signalBars, signalKind }
        trades,   // merged LONG+SHORT trades sorted by exit_time, each with leg/mae/flipped/flip_time
    };
}

function metricsCards(m) {
    const pf = m.profitFactor === null ? "-" : m.profitFactor === Infinity ? "\u221e" : m.profitFactor.toFixed(2);
    return `<div class="grid">
  <div class="card"><div class="label">Trades</div><div class="value">${m.trades}</div></div>
  <div class="card"><div class="label">Win Rate</div><div class="value">${(m.winRate * 100).toFixed(1)}%</div></div>
  <div class="card"><div class="label">Profit Factor</div><div class="value">${pf}</div></div>
  <div class="card"><div class="label">Net PnL</div><div class="value ${m.netPnL >= 0 ? "pos" : "neg"}">${fmtMoney(m.netPnL)}</div></div>
  <div class="card"><div class="label">Max Drawdown (closed)</div><div class="value neg">${fmtMoney(m.maxDrawdown)}</div></div>
  <div class="card"><div class="label">Largest Win</div><div class="value pos">${fmtMoney(m.largestWin)}</div></div>
  <div class="card"><div class="label">Largest Loss</div><div class="value neg">${fmtMoney(m.largestLoss)}</div></div>
  <div class="card"><div class="label">Avg Trade</div><div class="value">${fmtMoney(m.avgTrade)}</div></div>
  <div class="card"><div class="label">Avg Hold Time</div><div class="value">${fmtDuration(m.avgHoldTimeMs)}</div></div>
</div>`;
}

function mtmCards(mtm) {
    return `<div class="grid">
  <div class="card"><div class="label">Final Equity</div><div class="value ${mtm.finalEquity >= 0 ? "pos" : "neg"}">${fmtMoney(mtm.finalEquity)}</div></div>
  <div class="card"><div class="label">Peak Equity</div><div class="value pos">${fmtMoney(mtm.peak)}</div></div>
  <div class="card"><div class="label">Trough Equity</div><div class="value neg">${fmtMoney(mtm.trough)}</div></div>
  <div class="card"><div class="label">Max Drawdown (MTM)</div><div class="value neg">${fmtMoney(mtm.maxDrawdown)}</div></div>
  <div class="card"><div class="label">Worst Unrealized \u2014 LONG</div><div class="value neg">${fmtMoney(mtm.worstUnrealized.LONG)}</div></div>
  <div class="card"><div class="label">Worst Unrealized \u2014 SHORT</div><div class="value neg">${fmtMoney(mtm.worstUnrealized.SHORT)}</div></div>
</div>`;
}

// Inline SVG: MTM equity (solid) vs realized-only (dim) over the daily series.
function equityChart(daily) {
    if (!daily || daily.length < 2) return `<div class="meta">not enough days for a chart</div>`;
    const W = 1000, H = 240, padL = 64, padR = 12, padT = 12, padB = 24;
    const vals = daily.flatMap(d => [d.equity, d.realized]).concat([0]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = (hi - lo) || 1;
    const x = i => padL + (i / (daily.length - 1)) * (W - padL - padR);
    const y = v => padT + (1 - (v - lo) / span) * (H - padT - padB);
    const line = key => daily.map((d, i) => `${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:#161a22;border:1px solid #2a2e37;border-radius:8px">
  <line x1="${padL}" x2="${W - padR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#3a3f4b" stroke-dasharray="4 4"/>
  <polyline fill="none" stroke="#6b7280" stroke-width="1.2" points="${line("realized")}"/>
  <polyline fill="none" stroke="#3ecf8e" stroke-width="1.8" points="${line("equity")}"/>
  <text x="6" y="${padT + 10}" fill="#9aa0ab" font-size="11">${fmtMoney(hi)}</text>
  <text x="6" y="${H - padB}" fill="#9aa0ab" font-size="11">${fmtMoney(lo)}</text>
  <text x="${padL}" y="${H - 6}" fill="#9aa0ab" font-size="11">${esc(daily[0].day)}</text>
  <text x="${W - padR}" y="${H - 6}" fill="#9aa0ab" font-size="11" text-anchor="end">${esc(daily[daily.length - 1].day)}</text>
  <text x="${W - padR - 4}" y="${padT + 10}" fill="#3ecf8e" font-size="11" text-anchor="end">equity (realized + unrealized)</text>
  <text x="${W - padR - 4}" y="${padT + 24}" fill="#6b7280" font-size="11" text-anchor="end">realized only</text>
</svg>`;
}

function renderDualHedgeHtml(report) {
    let running = 0;
    const isBias = report.params.strategy === "BIAS";
    const rows = report.trades
        .filter(t => t.status === "CLOSED")
        .map(t => {
            const pnlClass = (t.pnl || 0) >= 0 ? "pos" : "neg";
            running += (t.pnl || 0);
            const combinedClass = running >= 0 ? "pos" : "neg";
            const sideClass = t.side === "LONG" ? "pos" : "neg";
            const sideArrow = t.side === "LONG" ? "\u25b2" : "\u25bc";
            return `<tr class="${t.leg === "SHORT" ? "short-leg" : ""}">
                <td>${t.leg}</td>${isBias ? `<td>${esc(t.role || "")}</td>` : ""}
                <td>${fmtIst(t.entry_time)}</td><td class="${sideClass}">${sideArrow} ${t.side}</td><td>${(+t.entry_price).toFixed(2)}</td>
                <td>${fmtIst(t.exit_time)}</td><td>${(+t.exit_price).toFixed(2)}</td>
                <td class="${pnlClass}">${(t.pnl || 0).toFixed(2)}</td>
                <td class="neg">${(t.mae || 0).toFixed(0)}</td>
                <td>${t.flipped ? "yes" : "no"}</td>
                <td class="${combinedClass}">${running.toFixed(2)}</td>
                <td>${esc(t.exit_reason)}</td>
            </tr>`;
        })
        .join("");

    const p = report.params, s = report.stats;
    const gap = p.gapCapture ? `gap capture ${p.gapCapture.time}\u2192${p.gapCapture.quit}` : "no gap capture";
    const title = isBias
        ? `Dual Hedge \u2014 ${esc(report.symbol)} (daily HA bias core + ${esc(p.bandTimeframe)} band hedge)`
        : `Dual Hedge \u2014 ${esc(report.symbol)} (LONG acct / SHORT acct)`;
    const settings = isBias
        ? `core decided once a day at ${esc(p.entry)} IST from the previous daily HA candle (green \u2192 LONG acct, red \u2192 SHORT acct) \u00b7 hedge = the OTHER account when the ${esc(p.bandTimeframe)} Dynamic Band (step ${p.bandStep}) turns against the core \u00b7 unwind ${esc(p.unwindMode)} \u00b7 both flat at EOD ${esc(p.eod)} IST \u00b7 slippage ${p.slippagePoints} pts`
        : `take-profit \u20b9${p.takeProfit} \u00b7 stop ${p.slMode === "ATR" ? `${p.atrSlMult}x ATR(${p.atrLen}) on ${esc(p.atrTimeframe)}, from entry (rupee backstop \u20b9${p.maxLoss} until ATR is available)` : `\u20b9${p.maxLoss}`} (armed only after a leg flips) \u00b7 signal ${esc(p.signal)}${p.bandStep ? ` (band step ${p.bandStep}, range ${p.rangeSize})` : ""} \u00b7 ${gap} \u00b7 slippage ${p.slippagePoints} pts`;
    const activity = isBias
        ? `core days LONG ${s.coreDays.LONG} / SHORT ${s.coreDays.SHORT} \u00b7 days with no usable daily read ${s.noBiasDays} \u00b7 hedge entries ${s.hedgeEntries} \u00b7 band unwinds ${s.hedgeUnwinds} \u00b7 exits: EOD ${s.exits.eod}, band unwind ${s.exits.bandUnwind}, backtest-end ${s.exits.backtestEnd}`
        : `${s.evaluations} evaluations (${s.missedSlotEvals} on a slot with no candle) \u00b7 entries LONG ${s.entries.LONG} / SHORT ${s.entries.SHORT} \u00b7 flips LONG ${s.flips.LONG} / SHORT ${s.flips.SHORT} \u00b7 exits: take-profit ${s.exits.takeProfit}, stop ${s.exits.stopLoss}, gap-realize ${s.exits.gapRealize}, backtest-end ${s.exits.backtestEnd}${p.gapCapture ? ` \u00b7 gap-capture days ${s.gapCaptureDays} (skipped ${s.gapCaptureSkippedDays})` : ""}`;
    const carryNote = isBias
        ? "Flat at EOD every day, so the MTM and closed-trade drawdowns are close; the equity curve still shows the intraday swings the closed trades hide."
        : "Closed-trade drawdown below can be far smaller because an unflipped leg has no exit rule while it sits underwater.";
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${title.replace(/&amp;/g, "&")}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e6e6e6;padding:24px;max-width:1200px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px} .meta{color:#9aa0ab;font-size:13px;margin-bottom:20px}
h2{font-size:15px;color:#9aa0ab;margin-top:28px;border-bottom:1px solid #2a2e37;padding-bottom:6px}
table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px}
th,td{border:1px solid #2a2e37;padding:6px 10px;text-align:right}
th{background:#161a22} td:first-child,th:first-child{text-align:left}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-top:8px}
.card{background:#161a22;border:1px solid #2a2e37;border-radius:8px;padding:12px}
.card .label{font-size:11px;color:#9aa0ab} .card .value{font-size:20px;margin-top:4px;font-weight:600}
.pos{color:#3ecf8e}.neg{color:#f0616d}
.short-leg td{color:#c9a86a}
.note{color:#9aa0ab;font-size:12px;margin-top:6px}
</style></head><body>
<h1>${title}</h1>
<div class="meta">LONG ${report.longLots} lot \u00b7 SHORT ${report.shortLots} lot \u00b7 ${settings}<br>
${report.range.from} \u2192 ${report.range.to} \u00b7 signal built from ${esc(p.rangeStart)} IST (${esc(p.anchor)}) \u00b7 ${report.meta.candles} 1m candles \u2192 ${report.meta.signalBars} ${esc(report.meta.signalKind)} \u00b7 run ${report.runAt}</div>

<h2>Mark-to-market equity (realized + unrealized) \u2014 the risk number for a strategy that carries overnight</h2>
${mtmCards(report.mtm)}
<div style="margin-top:12px">${equityChart(report.mtm.daily)}</div>
<div class="note">Max MTM drawdown ${fmtMoney(report.mtm.maxDrawdown)}${report.mtm.maxDrawdownAt ? ` (bottomed ${esc(report.mtm.maxDrawdownAt)})` : ""}. ${carryNote}</div>

<h2>Combined (LONG + SHORT, closed trades)</h2>
${metricsCards(report.metrics.combined)}

<h2>LONG account only</h2>
${metricsCards(report.metrics.long)}

<h2>SHORT account only</h2>
${metricsCards(report.metrics.short)}

<h2>Activity</h2>
<div class="meta">${activity}</div>

<h2>Trades (${report.metrics.combined.trades}) \u2014 gold rows are the SHORT account${isBias ? "; Role = CORE (daily-bias leg) or HEDGE" : ""}</h2>
<table><thead><tr>
  <th>Acct</th>${isBias ? "<th>Role</th>" : ""}<th>Entry Time (IST)</th><th>Side</th><th>Entry</th><th>Exit Time (IST)</th><th>Exit</th><th>PnL</th><th>MAE</th><th>Flipped</th><th>Combined PnL</th><th>Reason</th>
</tr></thead><tbody>${rows || `<tr><td colspan="12">no closed trades in this range</td></tr>`}</tbody></table>
<div class="note">MAE = worst unrealized PnL during the trade. Times are UTC ISO (IST = +5:30). Fills are modeled from 1-minute OHLC \u2014 see backtestDualHedge.js's header for the assumptions.</div>
</body></html>`;
}

function saveDualHedgeReport(report, outDir = path.join(__dirname, "backtests")) {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    const stamp = report.runAt.replace(/[:.]/g, "-");
    const base  = `DUAL_HEDGE_${report.symbol}_${stamp}`;
    const jsonPath = path.join(outDir, `${base}.json`);
    const htmlPath = path.join(outDir, `${base}.html`);

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(htmlPath, renderDualHedgeHtml(report));

    return { jsonPath, htmlPath };
}

module.exports = { buildDualHedgeReport, renderDualHedgeHtml, saveDualHedgeReport };
