# TAlgo-X — Autonomous Multi-Instrument Trading Infrastructure

> Production-grade deterministic trading infrastructure built around a single execution brain operating across multiple market instruments.

---

## Overview

TAlgo-X is the deployment and execution layer of the TAlgo ecosystem.

Instead of maintaining separate bots for every instrument, TAlgo-X separates:

```text
Brain
→ Trading intelligence

Context
→ Instrument configuration

Runtime
→ Execution orchestration

Infrastructure
→ Persistence, monitoring & lifecycle
```

A single deterministic brain executes multiple instruments through isolated runtime contexts.

---

## Architecture

```text
                TAlgo-X Toolbox
                       │
        ┌──────────────┼──────────────┐
        │              │              │
     NatGas         Zinc         USDINR
     Context        Context       Context
        │              │              │
        └──────────────┼──────────────┘
                       │
              Deterministic Brain
                       │
          Signal → Risk → Orders
```

---

## Execution Pipeline

```text
Market Data
      │
Authoritative Candle Polling
      │
Market State Evaluation
      │
Indicator Computation
      │
Signal Validation
      │
Risk Management
      │
Order Execution
      │
SQLite Persistence
      │
Observability
```

---

## Trading Architecture

The execution engine combines multiple decision layers instead of relying on a single indicator.

### Market State

Determines whether the market is:

- Trending
- Neutral
- Low-quality

The detected market state determines which execution model is active.

### Strategy Layers

Current execution combines:

- MA Slope regime detection
- ALMA Band breakout execution
- ALMA Band re-entry exits
- SuperTrend confirmation
- ATR-based risk management

Exit hierarchy:

```text
Stop Loss
      │
ALMA Band Re-entry
      │
MA Slope Color Flip
```

This provides:

- faster reversal response
- momentum-based exits
- deterministic behaviour
- reduced profit give-back

---

## Runtime

The runtime coordinates all live system behaviour.

Responsibilities include:

- candle synchronization
- execution scheduling
- position lifecycle
- order routing
- restart recovery
- Telegram alerts
- dashboard telemetry
- runtime monitoring

---

## Persistence

SQLite persistence provides:

- active position storage
- runtime recovery
- execution continuity
- restart safety

---

## Observability

Built-in monitoring includes:

- live execution logs
- Telegram notifications
- runtime telemetry
- dashboard monitoring
- execution history
- position tracking

Every execution decision is logged and traceable.

---

## Active Engines

### Zinc (MCX)

High-reactivity execution using ALMA Bands and market-state-aware execution.

### Natural Gas (MCX)

Adaptive execution tuned for high volatility with deterministic runtime behaviour.

### USDINR

Stable execution profile optimized for lower-volatility market conditions.

---

## Repository Structure

```text
engine/
runtime/
database/
dashboard/
logs/
docs/
config/
index.js
```

---

## Design Principles

TAlgo-X is built around:

- deterministic execution
- one brain architecture
- context-driven scalability
- explainable decisions
- runtime isolation
- failure recovery
- operational simplicity

---

## TAlgo vs TAlgo-X

| TAlgo | TAlgo-X |
|--------|----------|
| Strategy research | Live execution |
| Experimental | Production-oriented |
| Indicator experimentation | Runtime orchestration |
| Strategy evolution | Deterministic deployment |

---

## Current Focus

Current development focuses on:

- One Brain architecture
- Multi-instrument execution
- Runtime reliability
- Market State Engine
- Explainable execution
- Adaptive strategy selection
- Production stability

---

## Future Work

- Portfolio-level execution
- Cross-instrument orchestration
- AI-assisted observability (TAlgo-AI)
- Distributed execution
- Runtime diagnostics
- Deployment tooling

---

## Disclaimer

TAlgo-X is a research and educational project exploring autonomous trading infrastructure and deterministic execution systems.

Live deployment credentials, proprietary configurations, and sensitive operational data are intentionally excluded.
