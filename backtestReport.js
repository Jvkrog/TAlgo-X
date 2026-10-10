// backtestReport.js — builds and saves Step 10's report.json/report.html.
//
// Output lives in a single flat `backtests/` directory (one mkdir, no
// per-strategy/per-instrument/per-run subfolders) — file names carry the
// strategy, instrument, and run timestamp instead:
//   backtests/<STRATEGY>_<INSTRUMENT>_<runTimestamp>.json
//   backtests/<STRATEGY>_<INSTRUMENT>_<runTimestamp>.html
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

// Every setting the run actually used, as [label, value] rows for the report.
function describeSettings(context, engineConfig, extra = {}) {
    const onOff = (v, detail) => (v ? "ON" + (detail ? " \u2014 " + detail : "") : "off");
    const hhmm = (h, m) => `${String(h).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")} IST`;
    const rows = [];
    rows.push(["Candles", extra.candleType ? extra.candleType + (extra.candleType === "RANGE" && extra.rangeSize ? ` (range ${extra.rangeSize})` : "") : "strategy native"]);
    rows.push(["Lots", `${context.lots} (lot multiplier ${context.lotMult})`]);
    rows.push(["Entry time", context.entryTimeHour != null ? hhmm(context.entryTimeHour, context.entryTimeMinute) : "off (trade from the start)"]);
    if (context.dailyBiasEntryHour != null) rows.push(["Daily HA Bias entry time", hhmm(context.dailyBiasEntryHour, context.dailyBiasEntryMinute)]);
    const chopOn = engineConfig.CHOP_GATE_ALWAYS_FORCE !== false;
    rows.push(["Choppiness index", onOff(chopOn, `period ${context.chopPeriod ?? engineConfig.CHOP_LEN}, blocks above ${context.chopMax ?? engineConfig.CHOP_GATE_MAX_DEFAULT}`)]);
    rows.push(["Long-candle block", onOff(context.longCandleFilterEnabled, `ATR period ${context.longCandleAtrPeriod ?? engineConfig.LONG_CANDLE_ATR_PERIOD_DEFAULT}, range \u2265 ${context.longCandleAtrMult ?? engineConfig.LONG_CANDLE_ATR_MULT_DEFAULT}x ATR${context.longCandleUseBodyFilter ? `, body \u2265 ${context.longCandleBodyAtrMult ?? engineConfig.LONG_CANDLE_BODY_ATR_MULT_DEFAULT}x ATR` : ""}, cooldown ${context.longCandleCooldownCandles ?? engineConfig.LONG_CANDLE_COOLDOWN_CANDLES_DEFAULT} candles`)]);
    rows.push(["Volume filter", onOff(context.volumeFilterEnabled, `volume above its SMA(${context.volumeSmaPeriod ?? engineConfig.VOLUME_SMA_LEN_DEFAULT})`)]);
    rows.push(["Higher-timeframe gate", context.htfGateEnabled === false ? "off" : `ON \u2014 ${context.htfTimeframe ?? "default timeframe"}, chop period ${context.htfChopPeriod ?? engineConfig.HTF_CHOP_LEN_DEFAULT}, max ${context.htfChopMax ?? engineConfig.HTF_CHOP_MAX_DEFAULT}${context.htfBandBlockEnabled === false ? ", band block off" : ", band block on"}`]);
    rows.push(["Daily HA gate", context.dailyHaGateEnabled === false ? "off" : "ON"]);
    rows.push(["Double orders", context.disableDoubleOrders ? "reversal re-entries blocked" : "allowed"]);
    rows.push(["Stop-loss", context.hardSlRupees ? `HARD \u20b9${context.hardSlRupees} per position` : `ATR ${context.atrSlMult ?? engineConfig.ATR_SL_MULT}x (ATR length ${engineConfig.ST_ATR_LEN})`]);
    rows.push(["Target", context.targetPoints ? `${context.targetPoints} points` : "off"]);
    if (context.maxDailyLoss) rows.push(["Max daily loss", `\u20b9${context.maxDailyLoss}`]);
    if (context.sessionTargetRupees) rows.push(["Session target", `\u20b9${context.sessionTargetRupees}`]);
    if (context.bandStep != null) rows.push(["Band step", String(context.bandStep)]);
    if (context.carryOvernight) rows.push(["Carry overnight", "yes"]);
    return rows;
}

function buildReport({ strategyKey, strategyLabel, underlying, timeframe, from, to, params, metrics, trades, runAt, settings }) {
    return {
        settings: settings || [],
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

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function settingsHtml(report) {
    const rows = (report.settings || []).map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:left">${esc(v)}</td></tr>`).join("");
    const p = report.params && Object.keys(report.params).length
        ? `<tr><td>Strategy parameters</td><td style="text-align:left">${esc(Object.entries(report.params).map(([k, v]) => `${k}=${v}`).join(", "))}</td></tr>` : "";
    return rows || p ? `<h2>Settings used</h2><table><tbody>${rows}${p}</tbody></table>` : "";
}

function fmtMoney(n) { return (n < 0 ? "-₹" : "₹") + Math.abs(n).toFixed(2); }

function renderHtml(report) {
    const m = report.metrics;
    const pf = m.profitFactor === null ? "-" : m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);

    // Running session PnL — same cumulative total positions.js's close()
    // already prints live (`session: ${pnlStr(state.pnl)}`) alongside each
    // trade's own isolated pnl. The report table previously only showed
    // the per-trade figure, which tells you whether ONE trade won or
    // lost but not how the strategy is actually performing over time —
    // a string of small wins can still be a losing session if one bad
    // trade outweighs them, and that only shows up in the running total.
    // Trades close in chronological order (only one position open at a
    // time for every strategy in this codebase), so a simple running sum
    // over the filtered/closed list reproduces the exact same session
    // value live would have shown at that same point in the sequence.
    let runningSession = 0;
    const rows = report.trades
        .filter(t => t.status === "CLOSED")
        .map(t => {
            const pnlClass = (t.pnl || 0) >= 0 ? "pos" : "neg";
            runningSession += (t.pnl || 0);
            const sessionClass = runningSession >= 0 ? "pos" : "neg";
            // Directional arrow on the side column — green ▲ LONG / red ▼
            // SHORT, same convention as a SuperTrend flip marker. Uses the
            // existing .pos/.neg classes (direction here, not P&L) so no
            // new CSS is needed; applies to every strategy's report, not
            // just DYNAMIC_MID_COLOR.
            const sideClass = t.side === "LONG" ? "pos" : "neg";
            const sideArrow = t.side === "LONG" ? "▲" : "▼";
            return `<tr>
                <td>${fmtIst(t.entry_time)}</td><td class="${sideClass}">${sideArrow} ${t.side}</td><td>${Number(t.entry_price).toFixed(2)}</td>
                <td>${fmtIst(t.exit_time)}</td><td>${Number(t.exit_price).toFixed(2)}</td>
                <td class="${pnlClass}">${(t.pnl || 0).toFixed(2)}</td>
                <td class="${sessionClass}">${runningSession.toFixed(2)}</td>
                <td>${t.exit_reason}</td>
            </tr>`;
        })
        .join("");

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${report.strategyLabel} — ${report.instrument} backtest</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e6e6e6;padding:24px 32px;max-width:2000px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px} .meta{color:#9aa0ab;font-size:13px;margin-bottom:20px}
h2{font-size:15px;color:#9aa0ab;margin-top:28px;border-bottom:1px solid #2a2e37;padding-bottom:6px}
table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px}
th,td{border:1px solid #2a2e37;padding:6px 10px;text-align:right}
th{background:#161a22} td:first-child,th:first-child{text-align:left}
.top{display:grid;grid-template-columns:minmax(380px,1fr) minmax(0,1.6fr);gap:28px;align-items:start}
@media(max-width:1000px){.top{grid-template-columns:1fr}}
.top h2{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:8px}
.card{background:#161a22;border:1px solid #2a2e37;border-radius:8px;padding:12px}
.card .label{font-size:11px;color:#9aa0ab} .card .value{font-size:20px;margin-top:4px;font-weight:600}
.pos{color:#3ecf8e}.neg{color:#f0616d}
</style></head><body>
<h1>${report.strategyLabel} — ${report.instrument}</h1>
<div class="meta">${report.timeframe} · ${report.range.from} → ${report.range.to} · run ${fmtIst(report.runAt)} IST</div>
<div class="top">
<div>${settingsHtml(report)}</div>
<div><h2>Results</h2>
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
</div></div>
</div>
<h2>Trades (${m.trades})</h2>
<table><thead><tr>
  <th>Entry Time (IST)</th><th>Side</th><th>Entry</th><th>Exit Time (IST)</th><th>Exit</th><th>PnL</th><th>Session PnL</th><th>Reason</th>
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

module.exports = { describeSettings, buildReport, renderHtml, saveReport };
