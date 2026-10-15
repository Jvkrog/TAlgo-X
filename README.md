# TAlgo-X — Trading Execution & Research Workstation

TAlgo-X is a Node.js trading platform for strategy execution, market-data handling, risk controls, persistence/recovery, backtesting, and operator tooling. It evolved from the TAlgo strategy experiments into a multi-instrument runtime with a CLI toolbox and a browser-based WebDash.

> **Important:** This is a research and engineering project, not financial advice. Trading can result in losses. Backtests and historical results do not guarantee future performance. Live execution depends on broker availability, network conditions, liquidity, and order handling.

## What it includes

### Execution runtime
- Instrument-specific runtime contexts with configurable strategy, candle type/timeframe, lot sizing, risk settings, and execution mode.
- Strategy and signal processing separated from broker order placement and position lifecycle handling.
- Kite Connect integration for REST operations and WebSocket market data.
- SQLite-backed positions, trades, risk events, and restart recovery.
- PM2 process management and per-engine logs.
- Telegram notifications and runtime observability.
- Configurable entry gates and risk controls, depending on strategy/context: choppiness, volume, long-candle, higher-timeframe, daily Heikin-Ashi, stop-loss/target, daily-loss, and losing-trade/switch limits.

### CLI Toolbox
The `talgox` command provides operator workflows for engine/instrument management, strategy and runtime configuration, credentials, backtesting, paper/live modes, PM2 controls, and diagnostics.

### WebDash
The WebDash is an operator interface for monitoring and controlling running engines. It includes engine cards, position/P&L visibility, logs streamed from the runtime, configuration and credential workflows, market-state/watchlist views, hedge-pair and dual-hedge controls, backtesting screens, and AI trade-review tools.

The runtime-to-dashboard event bridge is deliberately best-effort: dashboard connectivity is for observability and must not be required for strategy execution or order placement.

### Chart panel and order book
The standalone chart page (`webdash/public/chart.html`) can be opened in a separate tab/window for a second-monitor workflow. It displays historical candles alongside live price updates and supports:
- Raw candles, Heikin-Ashi, and Range Bars.
- Instrument-specific chart overlays where supported by the strategy.
- A configurable Range Bar size.
- A market-depth/order-book panel with bid/ask prices and quantities, spread, displayed depth totals, volume, and open interest where provided by the feed.
- Live order-book updates streamed through the dashboard WebSocket; REST is used as a fallback when the stream is unavailable/stale.
- Historical chart data for context; Range Bars are rebuilt using the shared `rangeBars.js` builder so the chart and engine can use the same range-bar logic.

The order book represents displayed liquidity, not guaranteed support/resistance or a standalone buy/sell signal. Historical candles and live market depth are different data types; the current implementation should not be interpreted as historical order-book replay.

### Market State Engine
A separate scanner/profiling path builds a market profile containing trend, volatility, participation, structure, and confidence fields. It maintains a watchlist independently of which instruments currently have engines running. Profiles and structure-state transitions are stored in a separate SQLite database; the client returns an UNKNOWN/unavailable profile when data is missing, stale, or errors, rather than treating stale data as current. This is a contextual/observability layer, not a replacement for the execution engine.

### Hedge workflows
- **Hedge pairs:** paired core/hedge processes with WebDash controls and backtesting support.
- **Dual hedge:** a dedicated process for two separately configured Kite accounts, with one LONG-only leg and one SHORT-only leg driven by a shared Dynamic Step Band signal. Per-leg order placement uses that leg's own broker client. Optional gap-capture behavior is configured separately. Review the relevant engine/context files and runtime configuration before using this workflow live.

These workflows have different lifecycle and risk semantics from a single strategy engine; do not assume their settings or exits are interchangeable.

### Backtesting
The backtesting tools fetch historical broker candles and replay supported strategy/candle configurations. Reports include trade and performance metrics and can be inspected from the CLI/WebDash. Results depend on the data window, assumptions, costs/slippage settings, and whether the simulation accurately represents live execution. Validate changes in backtests and paper mode before considering live deployment.

### AI-assisted trade review (TAlgo-AI)
- Reviews closed trades using facts computed deterministically from SQLite trade journals.
- Uses Gemini to interpret trade evidence and produce schema-validated review output.
- Aggregates trade history into summaries by instrument, exit reason, side, entry time, and other available metrics; can narrate aggregate summaries and saved backtest reports.
- Caches reviews/summaries to avoid repeatedly requesting the same analysis.
- The AI review and narration modules are **observer-only**: the trading engines do not import them, and AI output does not place, modify, or close orders.
- Configure `GEMINI_API_KEY` through the supported WebDash credentials/settings flow or environment configuration. `GEMINI_MODEL` can override the default model.

AI commentary can be wrong or incomplete. Treat it as a research aid, not an execution instruction or proof of a strategy's edge.

## Architecture overview

```text
                    CLI Toolbox / WebDash
                              |
                              v
                       Runtime controls
                              |
             +----------------+----------------+
             |                |                |
          Engine A         Engine B        Hedge runtimes
        (instrument)     (instrument)      (where enabled)
             |                |                |
             +----------------+----------------+
                              |
                   Strategy / signal logic
                              |
                   Risk & position lifecycle
                              |
                       Broker orders
                              |
                       Kite Connect

Kite REST/history --------------------> Backtests and chart history
Kite market-data WebSocket -----------> Runtime / order-book stream
Runtime event bridge -----------------> WebDash live telemetry
SQLite journals ----------------------> Recovery, trade history, AI review
Market scanner -----------------------> Separate market-profile database
```

The diagram is conceptual: the chart, scanner, hedge runtimes, and regular engine have distinct data and lifecycle paths. The dashboard is not the authority for placing orders; execution remains in the runtime.

## Repository map

The repository is intentionally split by responsibility. The exact tree evolves, but the main entry points and modules include:

| Path | Responsibility |
|---|---|
| `toolbox.js` | Interactive CLI toolbox and runtime/operator workflows |
| `engine.js` | Main instrument execution process and runtime wiring |
| `strategies.js` | Strategy implementations and signal/risk orchestration |
| `context.js`, `engineConfig.js` | Instrument/runtime definitions and configuration |
| `orders.js`, `positions.js` | Broker order handling and position lifecycle helpers |
| `db.js`, `state.js`, `dbDir.js` | Persistence, runtime state, and database paths |
| `candlePoll.js`, `candleBuilder.js`, `rangeFeed.js`, `rangeBars.js` | Candle/history handling and Range Bar construction |
| `historicalFetch.js`, `backtestRun.js`, `backtestFlow.js` | Historical data and backtesting |
| `eventBridge.js` | Best-effort runtime-to-WebDash event stream |
| `marketProfiler.js`, `marketStateClient.js`, `marketStateStore.js`, `marketWatchlist.js` | Market profiling, state persistence, and watchlist |
| `hedgePairEngine.js`, `dualHedgeEngine.js` and related context/backtest modules | Separate hedge workflows |
| `aiReview.js`, `aiSummary.js` | Observer-only AI review and aggregate narration |
| `webdash/server.js` | HTTP/WebSocket server, API routes, authentication, chart/depth data and operator APIs |
| `webdash/public/app.js` | Main WebDash frontend |
| `webdash/public/chart.html`, `chart.js`, `chartpage.js` | Standalone chart page, rendering, and chart-page socket |
| `package.json` | Dependencies and CLI/WebDash entry points |

## Requirements

- Node.js 18 or later
- npm
- Git
- PM2 (installed as a project dependency)
- Kite Connect credentials for broker-backed data and live execution
- Optional Gemini API key for AI review/narration
- Telegram bot configuration if Telegram alerts are wanted

## Installation

```bash
git clone https://github.com/Jvkrog/TAlgo-X.git
cd TAlgo-X
npm install
npm link
```

Verify the CLI:

```bash
talgox
```

Start the WebDash from the repository:

```bash
npm run webdash
```

The default WebDash port is `4790`; open `http://localhost:4790` on the same machine. The server also supports a `WEBDASH_PORT` environment override.

## Credentials and security

Configure credentials through the supported CLI/WebDash credential workflows or environment configuration. Secrets and runtime tokens must remain outside version control.

- Do not commit `.env`, Kite API secrets/access tokens, Gemini API keys, or account credentials.
- WebDash uses a server-side PIN/session lock when `WEBDASH_PIN` is configured. On startup, it can prompt to set a PIN if one is missing; choosing a blank PIN explicitly leaves authentication disabled.
- **Set a WebDash PIN before exposing the dashboard to any network.** A PIN is an operator-access safeguard, not a substitute for network isolation.
- Keep the dashboard bound/reachable only where intended. Restrict cloud firewall/security-group rules; prefer localhost, an SSH tunnel, or a properly secured private network over direct public exposure.
- Never expose broker credentials to browser-side JavaScript or logs.
- Keep live and paper configuration clearly separated and verify the selected mode before starting an engine.

## Safe development workflow

1. Review the instrument, strategy, candle type, timeframe, and risk configuration.
2. Run the relevant backtest over more than one market regime; include realistic costs/slippage where available.
3. Validate in paper mode.
4. Exercise failure paths: WebSocket disconnect/reconnect, process restart, stale/missing data, rejected orders, and position recovery.
5. Inspect logs and compare persisted state with broker-side positions.
6. Enable live execution only after verifying the exact configuration and account.

Do not use a chart display, market-state profile, or AI narration as the sole basis for a live order. Changes to strategy, risk, order handling, or recovery should be tested independently of UI changes.

## Operational notes

- Use `pm2 list` to inspect managed processes, `pm2 logs` to view logs, and the CLI/WebDash controls to manage engines.
- Each engine's trade/position journal is separate from the Market State Engine's database; this is an intentional failure boundary.
- The WebDash event bridge is optional for engine operation. A dashboard outage should not be interpreted as proof that an engine stopped; inspect PM2 and broker state.
- Kite access tokens expire and need to be refreshed according to Kite Connect's authentication lifecycle.
- Current support is centered on Kite Connect; do not assume another broker is supported without a separate adapter.

## Development principles

- **Deterministic execution:** trading decisions should be reproducible from the relevant market inputs, strategy configuration, and state.
- **Isolated runtime context:** instruments and hedge legs retain their own configuration/state.
- **Explicit risk handling:** entries, exits, limits, and recovery are runtime concerns, not dashboard presentation logic.
- **Observable behavior:** logs and persisted events should make decisions and failures inspectable.
- **Failure boundaries:** optional analytics, market profiling, and the dashboard should not become dependencies of order execution.
- **AI as an observer:** AI reviews describe evidence; they do not control live trading.

## Disclaimer

TAlgo-X is provided for research and educational purposes. It is not financial advice, does not guarantee profitability, and may contain defects. Live trading involves market, execution, liquidity, connectivity, and operational risks. You are responsible for reviewing code, validating configurations, and understanding the consequences before enabling live orders.
