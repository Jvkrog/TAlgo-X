// backtestLinkedPair.js — backtest of a LINKED HEDGE PAIR (see hedgeLink.js): two ordinary strategy replays (normally DSB_DUAL and
// DAILY_HA_BIAS on mini contracts) run side by side, candle by candle, sharing one rule — while the legs hold OPPOSITE positions
// no stop is held on either; same direction (or the other leg flat) = stops active, re-armed fresh via the strategy's rearmStop().
//
// Each leg is a normal runBacktest() (same strategy code, ledger, broker, SL check). The legs are synchronised by a tiny barrier:
// after each candle's strategy decision (and before its stop check) both legs publish their position and agree on hedged / not.
// That mirrors live, where a 1s watcher flips the stops as soon as the legs' sides change. Both legs MUST see the same candle
// timestamps (same timeframe, same exchange session) — otherwise the run stops with an error rather than guessing.
"use strict";
const { isHedged } = require("./hedgeLink");
const { runBacktest } = require("./backtestRun");
const { computeMetrics } = require("./backtestMetrics");
const { buildReport, saveReport } = require("./backtestReport");

function createPairSync() {
    const legs = { A: mk("A"), B: mk("B") };
    const stats = { candles: 0, hedgedCandles: 0, hedgeEvents: 0, unhedgeEvents: 0, hedgedDays: new Set() };
    const other = r => (r === "A" ? legs.B : legs.A);
    function mk(role) { return { role, sig: null, pos: null, hedged: false, done: false, failed: null, ref: null, wake: [] }; }
    const notify = leg => { const w = leg.wake; leg.wake = []; w.forEach(f => f()); };

    function leg(role) {
        const me = legs[role], peer = other(role);
        return {
            hedged: () => me.hedged,
            attach(ref) { me.ref = ref; },
            async afterSignal(candle) {
                const t = new Date(candle.date).getTime();
                me.pos = me.ref.state.position; me.sig = t; notify(me);
                while (!(peer.done || (peer.sig !== null && peer.sig >= t))) {
                    if (peer.failed) throw new Error("linked pair: the other leg's backtest failed — " + peer.failed);
                    await new Promise(res => peer.wake.push(res));   // woken by the peer's next publish / finish
                }
                if (peer.failed) throw new Error("linked pair: the other leg's backtest failed — " + peer.failed);
                if (!peer.done && peer.sig !== t) throw new Error("linked pair: the two legs' candles do not line up (" + new Date(t).toISOString() + " vs " + new Date(peer.sig).toISOString() + ") — use the same timeframe and exchange session on both legs");
                const peerPos = peer.done ? null : peer.pos;
                const h = isHedged(me.pos, peerPos);
                if (h !== me.hedged) {
                    me.hedged = h;
                    if (role === "A") { if (h) stats.hedgeEvents++; else stats.unhedgeEvents++; }
                    if (h) me.ref.slStore.clearTrail();
                    else if (me.ref.state.position && typeof me.ref.strategy.rearmStop === "function") me.ref.strategy.rearmStop();
                }
                if (role === "A") { stats.candles++; if (me.hedged) { stats.hedgedCandles++; stats.hedgedDays.add(new Date(t + 5.5 * 3600000).toISOString().slice(0, 10)); } }
            },
            finish(err) { me.done = true; if (err) me.failed = String(err.message || err); notify(me); },
        };
    }
    return { leg, stats };
}

// legs: [{ role: "A"|"B", args: <runBacktest args>, label }]  — both args must share from/to/timeframe.
async function runLinkedPairBacktest({ legs, from, to, pairName = "LinkedPair" }) {
    if (!Array.isArray(legs) || legs.length !== 2) throw new Error("runLinkedPairBacktest: exactly two legs required");
    const sync = createPairSync();
    const runs = legs.map(l => {
        const pl = sync.leg(l.role);
        return runBacktest({ ...l.args, pairSync: pl }).then(r => { pl.finish(); return r; }, e => { pl.finish(e); throw e; });
    });
    const results = await Promise.all(runs);
    const tag = (r, l) => r.report.trades.map(t => ({ ...t, leg: l.role, legStrategy: l.args.strategyKey }));
    const trades = results.flatMap((r, i) => tag(r, legs[i])).sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));
    const metrics = computeMetrics(trades);
    const legMetrics = results.map((r, i) => ({ role: legs[i].role, strategy: legs[i].args.strategyKey, label: legs[i].label || legs[i].args.strategyKey, underlying: r.report.instrument, metrics: r.report.metrics }));
    const hedge = { candles: sync.stats.candles, hedgedCandles: sync.stats.hedgedCandles, hedgedPct: sync.stats.candles ? +(100 * sync.stats.hedgedCandles / sync.stats.candles).toFixed(1) : 0,
        hedgeEvents: sync.stats.hedgeEvents, unhedgeEvents: sync.stats.unhedgeEvents, hedgedDays: sync.stats.hedgedDays.size };
    const settings = [
        ["Pair", pairName],
        ...legs.map((l, i) => [`Leg ${l.role}`, `${l.label || l.args.strategyKey} · ${legMetrics[i].underlying} · ${l.args.context.carryOvernight ? "NRML (carried)" : "MIS/closed at EOD"} · ${l.args.context.lots} lot(s) · net ₹${legMetrics[i].metrics.netPnL}`]),
        ["Stop-loss rule", "Removed while the two legs are in opposite directions; active (fresh ATR stop) when same direction or the other leg is flat"],
        ["Hedged", `${hedge.hedgedPct}% of candles (${hedge.hedgeEvents} hedge / ${hedge.unhedgeEvents} unhedge transitions, ${hedge.hedgedDays} day(s))`],
    ];
    const report = buildReport({ strategyKey: "LINKED_HEDGE_PAIR", strategyLabel: "Linked hedge pair", underlying: pairName, timeframe: legs[0].args.timeframe, from, to, params: {}, metrics, trades, runAt: new Date(), settings });
    report.legs = legMetrics; report.hedge = hedge;
    const paths = saveReport(report);
    return { report, paths, legResults: results };
}

module.exports = { runLinkedPairBacktest, createPairSync };
