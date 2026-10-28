// backtestMetrics.js — pure function: closed trades in, Step 9's numbers
// out. No side effects, no dependencies on any other backtest module —
// takes exactly what backtestLedger.getAllTrades() produces.
"use strict";

function emptyMetrics() {
    return {
        trades: 0, winRate: 0, profitFactor: null, netPoints: 0, netPnL: 0,
        maxDrawdown: 0, largestWin: 0, largestLoss: 0, avgTrade: 0, avgHoldTimeMs: 0,
    };
}

function computeMetrics(trades) {
    const closed = trades.filter(t => t.status === "CLOSED");
    if (closed.length === 0) return emptyMetrics();

    let grossProfit = 0, grossLoss = 0, wins = 0, netPnL = 0, netPoints = 0;
    let largestWin = 0, largestLoss = 0, totalHoldMs = 0;
    let equity = 0, peak = 0, maxDrawdown = 0;

    for (const t of closed) {
        const pnl = t.pnl || 0;
        netPnL += pnl;

        const dir = t.side === "LONG" ? 1 : -1;
        netPoints += (t.exit_price - t.entry_price) * dir;

        if (pnl > 0) {
            wins++;
            grossProfit += pnl;
            if (pnl > largestWin) largestWin = pnl;
        } else if (pnl < 0) {
            grossLoss += Math.abs(pnl);
            if (pnl < largestLoss) largestLoss = pnl;
        }

        totalHoldMs += new Date(t.exit_time) - new Date(t.entry_time);

        // Equity curve over the trade sequence (not wall-clock time) — peak
        // to trough drawdown, standard trade-based (not intraday) measure.
        equity += pnl;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    return {
        trades: closed.length,
        winRate: wins / closed.length,
        profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : null) : grossProfit / grossLoss,
        netPoints,
        netPnL,
        maxDrawdown,
        largestWin,
        largestLoss,
        avgTrade: netPnL / closed.length,
        avgHoldTimeMs: totalHoldMs / closed.length,
    };
}

function fmtDuration(ms) {
    if (!ms || ms < 0) return "-";
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

module.exports = { computeMetrics, fmtDuration };
