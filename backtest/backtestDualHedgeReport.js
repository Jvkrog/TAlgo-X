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

// Inline SVG: cumulative realized P&L of one account's closed trades, one step per trade (in exit order).
function tradePnlChart(trades, color) {
    const closed = trades.filter(x => x.status === "CLOSED");
    if (closed.length < 2) return `<div class="meta">not enough closed trades for a chart</div>`;
    const W = 1000, H = 200, padL = 64, padR = 12, padT = 12, padB = 24;
    let run = 0; const pts = [0].concat(closed.map(x => (run += (x.pnl || 0))));
    const lo = Math.min(...pts, 0), hi = Math.max(...pts, 0), span = (hi - lo) || 1;
    const x = i => padL + (i / (pts.length - 1)) * (W - padL - padR);
    const y = v => padT + (1 - (v - lo) / span) * (H - padT - padB);
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:#161a22;border:1px solid #2a2e37;border-radius:8px">
  <line x1="${padL}" x2="${W - padR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#3a3f4b" stroke-dasharray="4 4"/>
  <polyline fill="none" stroke="${color}" stroke-width="1.8" points="${pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>
  <text x="6" y="${padT + 10}" fill="#9aa0ab" font-size="11">${fmtMoney(hi)}</text>
  <text x="6" y="${H - padB}" fill="#9aa0ab" font-size="11">${fmtMoney(lo)}</text>
  <text x="${W - padR - 4}" y="${padT + 10}" fill="${color}" font-size="11" text-anchor="end">cumulative realized P&amp;L (closed trades)</text>
</svg>`;
}

// Inline SVG: one account's MTM equity (realized + unrealized, incl. the open NRML base) from mtm.series.
function acctEquityChart(series, key, color) {
    if (!series || series.length < 2) return "";
    const W = 1000, H = 220, padL = 64, padR = 12, padT = 12, padB = 24;
    const vals = series.map(s => s[key]).concat([0]); const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
    const x = i => padL + (i / (series.length - 1)) * (W - padL - padR), y = v => padT + (1 - (v - lo) / span) * (H - padT - padB);
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:#161a22;border:1px solid #2a2e37;border-radius:8px">
  <line x1="${padL}" x2="${W - padR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#3a3f4b" stroke-dasharray="4 4"/>
  <polyline fill="none" stroke="${color}" stroke-width="1.6" points="${series.map((s, i) => `${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ")}"/>
  <text x="6" y="${padT + 10}" fill="#9aa0ab" font-size="11">${fmtMoney(hi)}</text>
  <text x="6" y="${H - padB}" fill="#9aa0ab" font-size="11">${fmtMoney(lo)}</text>
  <text x="${padL}" y="${H - 6}" fill="#9aa0ab" font-size="11">${esc(String(series[0].t).slice(0, 10))}</text>
  <text x="${W - padR}" y="${H - 6}" fill="#9aa0ab" font-size="11" text-anchor="end">${esc(String(series[series.length - 1].t).slice(0, 10))}</text>
  <text x="${W - padR - 4}" y="${padT + 10}" fill="${color}" font-size="11" text-anchor="end">account equity (realized + unrealized, incl. open base)</text>
</svg>`;
}

function renderDualHedgeHtml(report) {
    let running = 0;
    const isBias = report.params.strategy === "BIAS";
    const isRealize = report.params.strategy === "REALIZE";
    const isPma = report.params.strategy === "PRICE_MA";
    const isPnl = isPma && report.params.hedgeMode === "PNL";
    const isCarry = isPma && report.params.carry === true;
    const hedgeProd = isCarry ? "MIS" : "NRML";
    const rowsFor = list => {
        let running = 0;
        return list
        .filter(t => t.status === "CLOSED")
        .sort((a, b) => (b.role === "BASE") - (a.role === "BASE"))   // held bases first
        .map(t => {
            const pnlClass = (t.pnl || 0) >= 0 ? "pos" : "neg";
            running += (t.pnl || 0);
            const combinedClass = running >= 0 ? "pos" : "neg";
            const sideClass = t.side === "LONG" ? "pos" : "neg";
            const sideArrow = t.side === "LONG" ? "\u25b2" : "\u25bc";
            return `<tr class="${t.leg === "SHORT" ? "short-leg" : ""}">
                <td>${t.leg}</td>${isBias || isPma ? `<td>${esc(t.role || "")}</td>` : ""}
                <td>${fmtIst(t.entry_time)}</td><td class="${sideClass}">${sideArrow} ${t.side}</td><td>${(+t.entry_price).toFixed(2)}</td>
                <td>${fmtIst(t.exit_time)}</td><td>${(+t.exit_price).toFixed(2)}</td>
                <td class="${pnlClass}">${(t.pnl || 0).toFixed(2)}</td>
                <td class="neg">${(t.mae || 0).toFixed(0)}</td>
                <td>${t.flipped ? "yes" : "no"}</td>
                <td class="${combinedClass}">${running.toFixed(2)}</td>
                <td>${t.exit_reason === "BACKTEST_END" ? "HELD \u2192 marked at end" : esc(t.exit_reason)}</td>
            </tr>`;
        })
        .join("");
    };
    const tradeTable = (list, runningLabel) => `<table><thead><tr>
  <th>Acct</th>${isBias || isPma ? "<th>Role</th>" : ""}<th>Entry Time (IST)</th><th>Side</th><th>Entry</th><th>Exit Time (IST)</th><th>Exit</th><th>PnL</th><th>MAE</th><th>Flipped</th><th>${runningLabel}</th><th>Reason</th>
</tr></thead><tbody>${rowsFor(list) || `<tr><td colspan="12">no closed trades in this range</td></tr>`}</tbody></table>`;
    const closedOf = list => list.filter(x => x.status === "CLOSED");
    const longT = report.trades.filter(x => x.leg === "LONG"), shortT = report.trades.filter(x => x.leg === "SHORT");
    const byRole = list => { const c = closedOf(list), n = r => c.filter(x => x.role === r).length, sum = r => c.filter(x => x.role === r).reduce((a, x) => a + (x.pnl || 0), 0);
        return isBias || isPma ? `<div class="meta">${["BASE", "CORE", "HEDGE"].filter(r => n(r)).map(r => `${r} ${n(r)} trades, net ${fmtMoney(sum(r))}`).join(" \u00b7 ")}</div>` : ""; };
    const baseBox = list => {
        const b = closedOf(list).filter(x => x.role === "BASE"); if (!isPma || !b.length) return "";
        return `<h2>Base position (NRML, from entry to the end of the backtest)</h2><table><thead><tr><th>Side</th><th>Entry (IST)</th><th>Entry</th><th>Marked at</th><th>End price</th><th>Base P&amp;L</th><th>Worst (MAE)</th></tr></thead><tbody>${b.map(x => `<tr><td>${x.side}</td><td>${fmtIst(x.entry_time)}</td><td>${(+x.entry_price).toFixed(2)}</td><td>${fmtIst(x.exit_time)}</td><td>${(+x.exit_price).toFixed(2)}</td><td class="${(x.pnl || 0) >= 0 ? "pos" : "neg"}">${fmtMoney(x.pnl || 0)}</td><td class="neg">${(x.mae || 0).toFixed(0)}</td></tr>`).join("")}</tbody></table>`;
    };
    const pane = (id, label, list, m, color, extra) => `<div class="pane" id="pane-${id}">
<h2>${label}</h2>
${extra || ""}${metricsCards(m)}
${byRole(list)}
${baseBox(list)}
${id !== "all" && report.mtm.series ? `<div style="margin-top:12px">${acctEquityChart(report.mtm.series, id, color)}</div>` : ""}
<div style="margin-top:12px">${tradePnlChart(list, color)}</div>
<h2>Trades (${m.trades})${id === "all" ? " \u2014 gold rows are the SHORT account" : ""}${isBias ? "; Role = CORE (daily-bias leg) or HEDGE" : ""}</h2>
${tradeTable(list, id === "all" ? "Combined PnL" : "Running PnL")}
</div>`;
    const wu = report.mtm.worstUnrealized || {};
    const panes = pane("all", "Combined (LONG + SHORT, closed trades)", report.trades, report.metrics.combined, "#3ecf8e")
        + pane("long", "LONG account", longT, report.metrics.long, "#3ecf8e", `<div class="meta">Worst unrealized (MTM): <span class="neg">${fmtMoney(wu.LONG || 0)}</span></div>`)
        + pane("short", "SHORT account", shortT, report.metrics.short, "#c9a86a", `<div class="meta">Worst unrealized (MTM): <span class="neg">${fmtMoney(wu.SHORT || 0)}</span></div>`);
    // CSS-only tabs (radio inputs + :checked): no script, so a Content-Security-Policy that blocks inline JS cannot break them.
    const tabs = `<input type="radio" name="tab" id="tab-all" class="tabr" checked><input type="radio" name="tab" id="tab-long" class="tabr"><input type="radio" name="tab" id="tab-short" class="tabr">
<div class="tabs"><label class="tab" for="tab-all">Combined</label><label class="tab" for="tab-long">LONG account</label><label class="tab" for="tab-short">SHORT account</label></div>`;
    const tabJs = "";
    const p = report.params, s = report.stats;
    const gap = p.gapCapture ? `gap capture ${p.gapCapture.time}\u2192${p.gapCapture.quit}` : "no gap capture";
    const title = isPma
        ? `${isPnl ? "Base-loss Hedge" : "Price-MA Hedge"} \u2014 ${esc(report.symbol)} (${isCarry ? "NRML" : "MIS"} bases + ${isPnl ? `${hedgeProd} hedge against each base's loss` : `1-minute Price MA ${hedgeProd} hedge`})`
        : isRealize
        ? `Dual Hedge \u2014 ${esc(report.symbol)} (realize &amp; re-open, LONG acct / SHORT acct)`
        : isBias
        ? `Dual Hedge \u2014 ${esc(report.symbol)} (${p.coreSignal === "DAILY_DSB" ? "daily DSB (HA)" : "daily HA bias"} core + ${esc(p.bandTimeframe)}${p.bandHa ? " HA" : ""} band hedge)`
        : `Dual Hedge \u2014 ${esc(report.symbol)} (LONG acct / SHORT acct)`;
    const settings = isPnl
        ? `LONG ${isCarry ? "NRML" : "MIS"} + SHORT ${isCarry ? "NRML" : "MIS"} bases at ${esc(p.base)} IST \u00b7 each base is hedged against its OWN loss, checked once a minute: base P&amp;L below -${p.pnlBand} pt opens a ${hedgeProd} hedge (SHORT in the LONG account / LONG in the SHORT account), back above +${p.pnlBand} pt closes it \u00b7 smoothing ${p.pnlSmooth} sample(s) \u00b7 ${isCarry ? `NRML bases HELD overnight (never closed), the MIS hedge is closed at ${esc(p.eod)} IST` : `everything closed at ${esc(p.eod)} IST`} \u00b7 slippage ${p.slippagePoints} pt per order`
        : isPma
        ? `LONG ${isCarry ? "NRML" : "MIS"} + SHORT ${isCarry ? "NRML" : "MIS"} bases at ${esc(p.base)} IST \u00b7 GREEN (MA rising) opens a LONG ${hedgeProd} hedge in the SHORT account, RED a SHORT NRML hedge in the LONG account \u00b7 NEUTRAL keeps the hedge \u00b7 ${isCarry ? `NRML bases HELD overnight (never closed), the MIS hedge is closed at ${esc(p.eod)} IST` : `everything closed at ${esc(p.eod)} IST`} \u00b7 ${p.minSlope ? `min slope ${p.minSlope} \u00b7 ` : "exact-zero slope \u00b7 "}${p.confirmMinutes > 1 ? `${p.confirmMinutes}-minute confirm \u00b7 ` : ""}minute average proxied by ${esc(p.maProxy)} \u00b7 slippage ${p.slippagePoints} pts \u00b7 no brokerage/taxes`
        : isRealize
        ? `every leg opens its own side (NRML carry); when a leg's profit exceeds \u20b9${p.realizeRupees} it is closed and the same side re-opened \u00b7 the losing leg is never closed${p.lossAlertRupees ? ` (alert level \u20b9${p.lossAlertRupees})` : ""} \u00b7 session 09:00\u201323:25 IST \u00b7 slippage ${p.slippagePoints} pts`
        : isBias
        ? `core decided once a day at ${esc(p.entry)} IST from the ${p.coreSignal === "DAILY_DSB" ? "daily Dynamic Step Band on daily Heikin-Ashi candles" : "previous daily HA candle"} ${p.coreAccount && p.coreAccount !== "AUTO" ? `(the ${p.coreAccount} account is always the core and takes the signal's side)` : "(green \u2192 LONG acct, red \u2192 SHORT acct)"} \u00b7 hedge = the OTHER account when the ${esc(p.bandTimeframe)}${p.bandHa ? " HA" : ""} Dynamic Band (step ${p.bandStep}) turns against the core \u00b7 unwind ${esc(p.unwindMode)} \u00b7 ${p.coreEod === "CARRY" ? (p.flipCore ? "core carried overnight (NRML); when the daily signal flips, core + hedge are closed and the core re-opens on the new side" : "core carried overnight (NRML), never closed at EOD") : `both flat at EOD ${esc(p.eod)} IST${p.coreEod === "CLOSE_MIS" ? " (MIS)" : ""}`} \u00b7 slippage ${p.slippagePoints} pts`
        : `take-profit \u20b9${p.takeProfit} \u00b7 stop ${p.slMode === "ATR" ? `${p.atrSlMult}x ATR(${p.atrLen}) on ${esc(p.atrTimeframe)}, from entry (rupee backstop \u20b9${p.maxLoss} until ATR is available)` : `\u20b9${p.maxLoss}`} (armed only after a leg flips) \u00b7 signal ${esc(p.signal)}${p.bandStep ? ` (band step ${p.bandStep}, range ${p.rangeSize})` : ""} \u00b7 ${gap} \u00b7 slippage ${p.slippagePoints} pts`;
    const activity = isPnl
        ? `base entries ${s.baseEntries} \u00b7 hedge entries ${s.hedgeEntries} / exits ${s.hedgeExits} \u00b7 EOD exits ${s.exits.eod}`
        : isPma
        ? `signal minutes ${s.signalMinutes} (GREEN ${s.greenMinutes} / RED ${s.redMinutes} / NEUTRAL ${s.neutralMinutes}) \u00b7 colour flips ${s.colourFlips} \u00b7 base entries ${s.baseEntries} \u00b7 hedge entries ${s.hedgeEntries} / exits ${s.hedgeExits} \u00b7 EOD exits ${s.exits.eod} \u00b7 gap resets ${s.gapResets}`
        : isRealize
        ? `entries LONG ${s.entries.LONG} / SHORT ${s.entries.SHORT} \u00b7 realizes LONG ${s.realizes.LONG} / SHORT ${s.realizes.SHORT} \u00b7 days a leg was past the loss alert: LONG ${s.lossAlertDays.LONG} / SHORT ${s.lossAlertDays.SHORT} \u00b7 backtest-end exits ${s.exits.backtestEnd}`
        : isBias
        ? `core days LONG ${s.coreDays.LONG} / SHORT ${s.coreDays.SHORT} \u00b7 days with no usable daily read ${s.noBiasDays}${p.flipCore ? ` \u00b7 core flips ${s.coreFlips}` : ""} \u00b7 hedge entries ${s.hedgeEntries} \u00b7 band unwinds ${s.hedgeUnwinds} \u00b7 exits: EOD ${s.exits.eod}, band unwind ${s.exits.bandUnwind}${p.flipCore ? `, daily flip ${s.exits.flip}` : ""}, backtest-end ${s.exits.backtestEnd}`
        : `${s.evaluations} evaluations (${s.missedSlotEvals} on a slot with no candle) \u00b7 entries LONG ${s.entries.LONG} / SHORT ${s.entries.SHORT} \u00b7 flips LONG ${s.flips.LONG} / SHORT ${s.flips.SHORT} \u00b7 exits: take-profit ${s.exits.takeProfit}, stop ${s.exits.stopLoss}, gap-realize ${s.exits.gapRealize}, backtest-end ${s.exits.backtestEnd}${p.gapCapture ? ` \u00b7 gap-capture days ${s.gapCaptureDays} (skipped ${s.gapCaptureSkippedDays})` : ""}`;
    const carryNote = isPnl
        ? "The hedge is decided at each minute's open price (the live engine samples the latest tick once a minute). Every cycle of the base's P&L crossing zero costs two hedge orders and can lose on the hedge leg \u2014 judge the hedge entry count against brokerage and taxes, which are not modelled."
        : isPma
        ? "APPROXIMATION: live averages every websocket tick of each minute; history only has minute candles, so the minute average is proxied from the candle and real GREEN/RED flips can differ. Brokerage, taxes and margin are not modelled, and every flip is two orders \u2014 judge the flip count against costs."
        : isRealize
        ? "The losing leg is never closed, so closed-trade P&L only shows the booked profits; the equity curve and MTM drawdown show the open loss you would have to fund."
        : isBias
        ? (report.params.coreEod === "CARRY" ? "The core is carried across days, so closed-trade P&L only shows the hedge and the final mark-to-market; the equity curve shows the open core's swings." : "Flat at EOD every day, so the MTM and closed-trade drawdowns are close; the equity curve still shows the intraday swings the closed trades hide.")
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
.tabs{display:flex;gap:8px;margin-top:24px;border-bottom:1px solid #2a2e37}
.tabr{position:absolute;opacity:0;pointer-events:none}
.tab{background:#161a22;color:#9aa0ab;border:1px solid #2a2e37;border-bottom:none;border-radius:8px 8px 0 0;padding:8px 18px;font-size:14px;cursor:pointer;user-select:none}
#tab-all:checked~.tabs label[for=tab-all],#tab-long:checked~.tabs label[for=tab-long],#tab-short:checked~.tabs label[for=tab-short]{background:#0b0d12;color:#e6e6e6;border-color:#3ecf8e}
.pane{display:none}
#tab-all:checked~#pane-all,#tab-long:checked~#pane-long,#tab-short:checked~#pane-short{display:block}
.pane h2:first-child{margin-top:16px}
.note{color:#9aa0ab;font-size:12px;margin-top:6px}
</style></head><body>
<h1>${title}</h1>
<div class="meta">LONG ${report.longLots} lot \u00b7 SHORT ${report.shortLots} lot \u00b7 ${settings}<br>
${report.range.from} \u2192 ${report.range.to} \u00b7 signal built from ${esc(p.rangeStart)} IST (${esc(p.anchor)}) \u00b7 ${report.meta.candles} 1m candles \u2192 ${report.meta.signalBars} ${esc(report.meta.signalKind)} \u00b7 run ${report.runAt}</div>

<h2>Mark-to-market equity (realized + unrealized) \u2014 the risk number for a strategy that carries overnight</h2>
${mtmCards(report.mtm)}
<div style="margin-top:12px">${equityChart(report.mtm.daily)}</div>
<div class="note">Max MTM drawdown ${fmtMoney(report.mtm.maxDrawdown)}${report.mtm.maxDrawdownAt ? ` (bottomed ${esc(report.mtm.maxDrawdownAt)})` : ""}. ${carryNote}</div>

<h2>Activity</h2>
<div class="meta">${activity}</div>

${tabs}
${panes}
<div class="note">MAE = worst unrealized PnL during the trade. Times are UTC ISO (IST = +5:30). Fills are modeled from 1-minute OHLC \u2014 see backtestDualHedge.js's header for the assumptions.</div>
${tabJs}
</body></html>`;
}

function saveDualHedgeReport(report, outDir = path.join(__dirname, "..", "backtests")) {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    const stamp = report.runAt.replace(/[:.]/g, "-");
    const base  = `DUAL_HEDGE_${String(report.symbol).replace(/[^A-Za-z0-9_-]+/g, "_")}_${stamp}`;   // symbol may be "LONGSYM / SHORTSYM" (split contracts)
    const jsonPath = path.join(outDir, `${base}.json`);
    const htmlPath = path.join(outDir, `${base}.html`);

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(htmlPath, renderDualHedgeHtml(report));

    return { jsonPath, htmlPath };
}

module.exports = { buildDualHedgeReport, renderDualHedgeHtml, saveDualHedgeReport };
