# TAlgo-X — Autonomous Trading Execution Platform

> Production-grade deterministic trading infrastructure for deploying, operating, and monitoring autonomous trading engines through unified CLI and Web interfaces.

---

## Overview

TAlgo-X is the deployment and execution platform of the TAlgo ecosystem.

Rather than building separate trading bots for each instrument, TAlgo-X separates trading intelligence from runtime orchestration, allowing a single execution brain to operate multiple instruments through isolated runtime contexts.

The platform provides two operator interfaces:

- **CLI Toolbox** — deployment, configuration, backtesting and runtime management
- **Web Dashboard** — real-time monitoring, observability and engine control

---

## Platform Architecture

```text
                     TAlgo-X
                         │
          ┌──────────────┴──────────────┐
          │                             │
     CLI Toolbox                 Web Dashboard
          │                             │
          └──────────────┬──────────────┘
                         │
                 Runtime Orchestrator
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     NatGas           Zinc           USDINR
     Context          Context         Context
        │                │                │
        └────────────────┼────────────────┘
                         │
                 Deterministic Brain
                         │
        Market → Strategy → Risk → Orders
```

---

## Execution Pipeline

```text
Market Data
      │
Authoritative Candle Polling
      │
Market State Engine
      │
Strategy Selection
      │
Risk Management
      │
Order Execution
      │
SQLite Persistence
      │
Runtime Observability
```

---

## Operator Interfaces

### CLI Toolbox

The CLI serves as the operational control center for TAlgo-X.

Features include:

- Engine deployment
- Instrument onboarding
- Backtesting
- Runtime lifecycle management
- Configuration management
- PM2 integration
- Live execution
- System diagnostics

---

### Web Dashboard

The browser interface provides live visibility into every running engine.

Features include:

- Engine lifecycle management
- Runtime telemetry
- Position & PnL monitoring
- Live execution logs
- Broker connectivity status
- Market state visualization
- Multi-engine dashboard
- Browser-based operator console

---

## Runtime

The runtime coordinates every live execution process.

Responsibilities include:

- deterministic candle synchronization
- execution scheduling
- order routing
- position lifecycle management
- restart recovery
- SQLite persistence
- Telegram notifications
- dashboard synchronization
- runtime health monitoring

---

## Trading Architecture

Execution decisions are separated into independent layers.

```text
Market
      │
Market State
      │
Strategy Selection
      │
Signal Validation
      │
Risk Management
      │
Order Execution
```

This modular architecture allows strategies to evolve without changing the execution infrastructure.

---

## Active Engines

Current runtime contexts include:

- Natural Gas (MCX)
- Zinc (MCX)
- USDINR

Each engine shares the same execution brain while maintaining independent configuration, runtime state and instrument-specific behaviour.

---

## Persistence & Recovery

SQLite persistence provides:

- active position storage
- runtime recovery
- execution continuity
- crash recovery
- restart safety

---

## Observability

TAlgo-X includes a built-in observability layer.

Features include:

- live execution logs
- Telegram notifications
- runtime telemetry
- dashboard monitoring
- position tracking
- execution history
- engine health monitoring

Every execution decision is logged and traceable.

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

## Core Design Principles

TAlgo-X is built around:

- One Brain architecture
- deterministic execution
- context-driven scalability
- runtime orchestration
- explainable execution
- operational simplicity
- failure recovery
- production reliability

---

## TAlgo vs TAlgo-X

| TAlgo | TAlgo-X |
|--------|----------|
| Strategy research | Execution platform |
| Experimental algorithms | Production deployment |
| Indicator development | Runtime orchestration |
| Strategy evolution | Multi-engine management |
| Research environment | Operator platform |

---

## Current Development

Current work focuses on:

- One Brain architecture
- Multi-engine execution
- CLI & Web operator interfaces
- Market-state driven execution
- Runtime reliability
- Deployment tooling
- Explainable execution
- AI-assisted observability

---

## Future Roadmap

- Portfolio-level execution
- Distributed runtime orchestration
- Cloud deployment platform
- User-managed VPS deployment
- AI-assisted operational insights
- Multi-broker support
- Plugin-based strategy framework

---

## Disclaimer

TAlgo-X is a research and educational project focused on autonomous trading infrastructure, deterministic execution systems, and backend engineering.

Live deployment credentials, proprietary configurations, and sensitive operational data are intentionally excluded.
