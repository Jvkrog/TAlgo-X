# TAlgo-X — Autonomous Multi-Engine Trading Infrastructure

> Production-grade deterministic trading infrastructure designed for adaptive execution, runtime stability, and instrument-aware autonomous decision systems.

---

## Overview

TAlgo-X is the deployment and execution layer of the TAlgo ecosystem, built to operate multiple trading engines on top of a shared runtime and execution framework.

The architecture separates:

```txt
- strategy logic
- runtime orchestration
- indicator computation
- persistence
- observability
```

This enables scalable multi-market execution without rewriting core infrastructure.

Each engine operates with:

```txt
- shared runtime architecture
- instrument-specific parameter tuning
- independent signal behavior
- adaptive filtering systems
- deterministic candle evaluation
```

![Version](https://img.shields.io/badge/engines-natgas,zn,usdinr-skyblue)
![Strategy](https://img.shields.io/badge/strategy-ST%20%2B%20ALMA%20%2B%20RSI%20%2B%20ADX-white)
![Architecture](https://img.shields.io/badge/runtime-deterministic-darkblue)
![Language](https://img.shields.io/badge/language-Node.js-lightgreen)

---

## System Architecture

```txt
Market Data API
        ↓
Authoritative Candle Polling
        ↓
Heikin Ashi Transformation
        ↓
Indicator Computation Layer
(ST / ALMA / RSI / ADX)
        ↓
Signal Validation Layer
        ↓
Execution & Position Logic
        ↓
Persistence Layer (SQLite)
        ↓
Observability & Alerts
```

---

## Core Execution Philosophy

TAlgo-X is designed around deterministic evaluation instead of tick-driven candle construction.

### Runtime Philosophy

```txt
API candles      → authoritative market state
WebSocket ticks  → asynchronous SL monitoring
Runtime          → execution coordination
Engine           → directional decision logic
```

This architecture improves:

```txt
- execution consistency
- signal reproducibility
- runtime synchronization
- debugging clarity
- operational stability
```

---

## Signal Architecture

The execution stack combines:

```txt
- SuperTrend FAST layer for short-term directional reaction
- ALMA SLOW layer for long-term directional stabilization
- RSI momentum validation
- ADX trend-strength confirmation
```

### Signal Philosophy

```txt
ST FAST   → short-term market reaction
ALMA SLOW → long-term directional bias
RSI       → momentum quality validation
ADX       → trend-strength confirmation
```

This structure helps:

```txt
- reduce false breakouts
- avoid sideways overtrading
- improve trend confirmation
- reduce low-quality entries
- stabilize execution behavior
```

---

## Runtime Architecture

The runtime layer coordinates all live system behavior.

### Runtime Responsibilities

```txt
- candle synchronization
- WebSocket monitoring
- SL enforcement
- lifecycle management
- dashboard telemetry
- execution scheduling
- Telegram alerts
- runtime observability
```

### Runtime Components

```txt
runtime/
├── candlePoll.js
├── candleBuilder.js
├── preload.js
├── lifecycle.js
├── dashboard.js
├── telegram.js
├── executionRouter.js
└── scheduler.js
```

---

## Deterministic Candle System

TAlgo-X uses authoritative API-polled candle closes instead of tick-built candle generation.

### Execution Flow

```txt
API Polling
      ↓
Fetch Last Completed Candle
      ↓
Indicator Evaluation
      ↓
Signal Validation
      ↓
Execution Decision
```

### Benefits

```txt
- deterministic timing
- reduced candle drift
- cleaner state transitions
- reproducible execution
- lower runtime inconsistency
```

WebSockets are used only for:

```txt
- live price monitoring
- SL checks
- emergency handling
- observability updates
```

---

## Active Engines

### Natural Gas Engine (MCX)

```txt
Strategy Stack:
- SuperTrend FAST execution
- ALMA directional regime
- RSI momentum filtering
- ADX trend-strength validation

Behavior:
- Designed for high-volatility environments
- Combines rapid reaction with directional stability
- Reduces unstable and low-conviction entries
```

---

### Zinc Engine (MCX)

```txt
Strategy Stack:
- SuperTrend FAST directional execution
- ALMA stabilization layer
- RSI momentum filter
- ADX trend confirmation

Behavior:
- High-reactivity execution model
- Rapid trend participation
- Reduced noise through adaptive filtering
```

---

### USDINR Engine (Forex)

```txt
Strategy Stack:
- SuperTrend FAST execution
- ALMA trend stabilization
- RSI momentum validation
- ADX trend-strength filtering

Behavior:
- Stable directional participation
- Controlled execution in lower-volatility conditions
- Reduced overtrading through confirmation layers
```

---

## Indicator Layer

Indicators are fully separated from runtime and strategy logic.

### Current Indicator Stack

```txt
indicators/
└── indicators.js
```

Includes:

```txt
- Heikin Ashi
- ALMA
- ATR
- SuperTrend
- RSI
- ADX
```

This separation enables:

```txt
- reusable computation logic
- cleaner architecture
- easier strategy iteration
- deterministic calculations
```

---

## Persistence Layer

SQLite-based persistence ensures runtime continuity across restarts and crashes.

### Database Responsibilities

```txt
- active position storage
- regime persistence
- restart recovery
- execution continuity
```

### Database Structure

```txt
database/
├── db.js
└── talgo.db
```

---

## Observability System

TAlgo-X includes a built-in real-time observability layer.

### Dashboard Features

```txt
- live runtime telemetry
- position tracking
- regime visualization
- indicator monitoring
- execution logs
- WebSocket status
- session PnL tracking
```

### Observability Stack

```txt
dashboard/
└── dashboard.html
```

The observability server runs directly inside the runtime process using Socket.IO and Express.

---

## Repository Structure

```txt
TAlgo-X/
│
├── engine/
│   ├── natgas/
│   ├── zinc/
│   └── usdinr/
│
├── runtime/
│   ├── candlePoll.js
│   ├── candleBuilder.js
│   ├── preload.js
│   ├── lifecycle.js
│   ├── dashboard.js
│   ├── telegram.js
│   └── executionRouter.js
│
├── indicators/
│   └── indicators.js
│
├── database/
│   ├── db.js
│   └── talgo.db
│
├── dashboard/
│   └── dashboard.html
│
├── logs/
├── docs/
├── config/
├── index.js
└── README.md
```

---

## Core Design Principles

```txt
- deterministic execution
- explainable runtime behavior
- adaptive signal filtering
- failure-aware architecture
- runtime observability
- instrument-aware tuning
- modular execution systems
```

---

## TAlgo vs TAlgo-X

| Aspect        | TAlgo               | TAlgo-X                   |
| ------------- | ------------------- | ------------------------- |
| Purpose       | Strategy Research   | Deployment & Execution    |
| Structure     | Version-based       | Engine-based              |
| Focus         | Strategy evolution  | Runtime stability         |
| Environment   | Testing / Iteration | Live deployment           |
| Architecture  | Experimental        | Deterministic             |
| Candle System | Exploratory         | Authoritative API polling |

---

## Why TAlgo-X Exists

TAlgo focuses on:

```txt
- strategy experimentation
- architecture evolution
- signal research
- behavioral iteration
```

TAlgo-X focuses on:

```txt
- deployment
- execution stability
- runtime coordination
- real-market behavior
- autonomous operation
```

This separation enables:

```txt
- cleaner system architecture
- safer deployment
- faster experimentation
- modular engine scaling
- runtime reliability
```

---

## Future Direction

```txt
- multi-engine orchestration
- portfolio-level risk systems
- runtime health diagnostics
- adaptive parameter management
- AI-assisted observability
- distributed execution infrastructure
```

---

## Summary

TAlgo-X transforms trading strategies into deterministic autonomous execution systems.

```txt
Shared runtime
→ Instrument-aware behavior
→ Deterministic execution
→ Persistent state management
→ Real-time observability
```

---

## Disclaimer

This repository is for research and educational purposes only.  
No financial advice is provided.  
Live deployment configurations, credentials, and sensitive runtime data are excluded.

---

The objective is not only trading performance, but building stable, explainable, and resilient execution infrastructure capable of operating reliably under real-world market conditions.
