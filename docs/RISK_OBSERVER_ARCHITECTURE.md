# Risk Observer — Architecture (Phases 1–6)

Status: implemented on branch `risk-observer-complete-review`, for owner review. **Nothing here is deployed or enabled by default.**
The Risk Observer is an observation-only subsystem. The trading engine is the sole execution authority.

## 1. Component architecture and module responsibilities

| Layer | Module | Responsibility |
|---|---|---|
| Phase 1 | `riskObserver/observer.js` | Per-instrument orchestrator: position tracking/reconciliation, evaluation loop, lifecycle (retryable start, stop), publishes snapshots. |
| | `priceMonitor.js` | Own 15m Kite REST candle feed: freshness, gaps, backfill, session-aware slots, broker-empty diagnostics. |
| | `dsbMonitor.js` | 15m dual-DSB colours/relations; `replayHa` mirrors the 1H strategy's warm-up (no double Heikin Ashi). |
| | `riskState.js` | Pure NORMAL/WATCH/DANGER/RECOVERY machine with hysteresis. |
| | `riskMetrics.js` | MAE/MFE (candle- and live-derived, kept separate), P&L, peak, giveback, reliable-vs-unknown durations. |
| | `coverage.js` | Session-aware candle coverage (MCX 09:00–23:30, NSE 09:15–15:30 IST, Mon–Fri) with evidence-based holiday/broker-empty handling. |
| | `riskStore.js` | Own SQLite file per instrument; versioned additive migrations (schema v2), WAL, instrument guard, no candle overwrite. |
| Phase 2 | `analytics.js` | Read-only history load + per-position/aggregate analytics; clean vs partial split; censored DSB relation time. |
| | `calibrate.js` | Offline candle-close replay through the production state machine; chronological 60/40; no best-config selection. |
| Phase 3 | `intel/marketCondition.js` | Pure market analysis reusing `indicators.js` (ATR/ADX/Choppiness/RSI). |
| | `intel/assess.js` | Explainable assessment: classification, evidence, quality, completeness, explanation. UNKNOWN when data is insufficient/unreliable. |
| | `intel/riskEvents.js` | Event lifecycle OPEN/UPDATE/CLEAR, dedup, hysteresis, cooldown, contained persistence. |
| Phase 4 | `portfolio/aggregate.js` | Exposure (gross/net-per-instrument), concentration, drawdown tracker, correlation (refuses thin/asynchronous data), shared-risk. |
| Phase 5 | `sim/scenarios.js`, `sim/simulate.js` | Deterministic replay and stress scenarios, labelled SIMULATED; structurally isolated (tested). |
| Phase 6 | `alerts.js` | Alert gate: dedup, storm control with summary, contained send failures. |
| | `obsHealth.js` | Structured observer health (liveness, uptime, latency, freshness, DB, reconciliation). |
| API/UI | `webdash/server.js` (`/api/riskobs*`), `webdash/public/app.js` | Read-only GET endpoints and dashboard tab. |

## 2. Data flow

```
Kite REST 15m ─► priceMonitor ─► dsbMonitor ─┐
engine tick (read-only) ─► observer.onTick ──┼─► riskMetrics ─► riskState ─► snapshot ─► engine WS ─► WebDash (cached)
engine state + trade record (read-only) ─────┘        │                          │
                                                       └─► riskStore (own SQLite) └─► alert gate ─► Telegram
riskStore (read-only open) ─► analytics / calibrate / intel / portfolio / sim ─► GET /api/riskobs/* ─► dashboard
```

Phases 3–5 are pure functions over snapshots/history; they are not called from the trading loop.

## 3. Event schema (`obs_events`)
`id, pos_id, ts, kind, from_state, to_state, detail(JSON)`. Kinds: `POSITION_OPEN`, `POSITION_CLOSE`, `STATE`, `DSB`, `HEALTH` (`detail.dim` rest|ltp), `CANDLE_GAP`, `BACKFILL`, `CLOSURE_EVIDENCE`, `CANDLE_CONFLICT`, `RECONCILE` (resumed/closed_offline/identity_mismatch/no_record), `OBSERVER` (started/start_failed/recovered/stopped).
Phase 3 risk events (`VOLATILITY_EXPANSION`, `TREND_DETERIORATION`, `TREND_EXHAUSTION`, `ADVERSE_MOVEMENT`, `PROFIT_GIVEBACK`, `DATA_UNRELIABLE`, `POSITION_RECONCILIATION_WARNING`, `ABNORMAL_MARKET_MOVEMENT`) carry `{lifecycle, severity INFO|WARNING|HIGH, evidence, explanation, informational:true}`. They are produced by the pure engine and may be persisted through the existing `addEvent` (no schema change needed); the live observer does **not** emit them yet (see limitations).

## 4. Database schema
Own file `databases/<instrument>_<strategy>_<candle>_riskobs.db`: `obs_meta`, `obs_positions` (+ `origin`, `entry_ts_source`, `origin_note` from v2), `obs_events`, `obs_candles`; indexes on events (pos,ts,id), (kind,ts) and positions (closed_at, entry_ts). `SCHEMA_VERSION = 2`. Phases 3–6 added **no** schema change. Migrations are additive and transactional; a newer-than-code file is refused; nothing is dropped or rewritten. Rollback: because steps only add, an older build ignores the extra columns/indexes; restoring the file from backup is the only destructive path and is manual. Retention: no automatic deletion (history is the product); size is small (one row per candle/event).

## 5. Risk states
NORMAL → WATCH → DANGER → RECOVERY → NORMAL with explicit confirmations (`escalateConfirm`, `clearConfirm`, `normalConfirm`); direct NORMAL→DANGER recorded as `skippedWatch`. Displayed state is **UNKNOWN** whenever REST, LTP or ATR is unreliable; the last-known state is shown separately and labelled not current. Unreliable time is never credited to a state.

## 6. Health states
REST: HEALTHY | GAPS | STALE | ERROR. LTP: HEALTHY | STALE | NONE | CLOSED. Observer (`obsHealth`): OK | DEGRADED | DOWN | UNKNOWN; liveness LIVE | SILENT. Data labels used everywhere: LIVE, HISTORICAL, PARTIAL, STALE, UNKNOWN, UNRELIABLE, SIMULATED.

## 7. API contracts (all `GET`, read-only SQLite handles, engine name → file name only from the engine's own snapshot)
`/api/riskobs` (cards), `/events/:engine`, `/analytics/:engine`, `/health`, `/portfolio`, `/intel/:engine`, `/sim/:engine`. Every response states its label and limitations; failures return `{available:false, reason}`.

## 8. Failure and recovery model
Observer start is retryable (default 15 s) and contained; evaluation/store/Telegram/dashboard errors are caught and counted; a silent observer is shown STALE/DOWN; restart resumes from persisted position + origin with the offline gap booked as unobserved; `onTick` is synchronous and cannot block the engine. Disabling is a single flag (`RISK_OBSERVER_OVERRIDE`, off by default; DSB_DUAL only).

## 9. Security and execution-isolation model
* The observer receives read-only views (`state`, `candles`, `getEntryMeta` = one SELECT on the engine trade record); it holds **no** handle to orders, positions, SL/target, the Kite order API or engine lifecycle.
* Own Kite client instance for historical data only.
* `test-risk-observer.js` recursively scans every file under `riskObserver/` for trading primitives; `test-risk-sim.js` asserts the simulation modules import only pure analysis code; `test-risk-ops.js`/`test-risk-dashboard.js` assert GET-only routes and no write SQL.
* Phases 3–5 are not imported by `engine.js`. The only live additions are the alert gate and runtime fields in the existing observer.

## 10. Known limitations — see the final report.
