
#JVKROG — TAlgo X

Multi-Engine Adaptive Trading System

---

![Version](https://img.shields.io/badge/version-Elite-blue)
![Strategy](https://img.shields.io/badge/strategy-breakout-green)
![Market](https://img.shields.io/badge/market-MCX-orange)
![Language](https://img.shields.io/badge/language-Node.js-yellow)
---

Philosophy

Markets evolve continuously. No trading strategy remains profitable forever.

Instead of searching for a permanent strategy, this system is built around a permanent framework.

Strategies may fail. Market conditions may change.
The framework adapts, protects capital, and evolves.

No strategy is permanent. Only the framework survives.

---

Contents

- Overview
- System Architecture
- Execution Flow
- Design Principles
- Project Structure
- Research Evolution

---

Overview

TAlgo X is a rule-based trading decision system designed to remove emotional bias and enforce structured execution in live markets.

The system focuses on:

- Decision consistency
- Controlled behavior during transitions
- Iterative learning through real execution
- Explainability using structured logs

---

System Architecture

TAlgo X is built as a modular multi-engine system.

Market Data (WebSocket + Candles)
        ↓
Heikin Ashi Transformation
        ↓
Indicators (ALMA + ATR)
        ↓
SLOW Engine → Bias (Direction + Conviction)
        ↓
FAST Engine → Entry / Exit / Protection
        ↓
Execution Layer → Order Handling
        ↓
State Management → PnL / Position Tracking

---

Engine Roles

SLOW Engine

- Defines market direction
- Uses ALMA (21 / 55)
- Provides structural bias

FAST Engine

- Executes trades
- Uses ALMA (9 / 21)
- Protects profits and exits early

---

Execution Flow

1. Fetch real-time data
2. Convert to Heikin Ashi
3. Compute ALMA + ATR
4. Generate SLOW bias

5. If no position:
   → Wait for FAST alignment
   → Enter (1 mini lot)

6. If in position:
   → Track peak profit
   → Detect reversals
   → FAST exits before SLOW damage

---

Core Principle

FAST protects SLOW.

- SLOW = direction
- FAST = execution
- FAST exits before structural breakdown

---

Design Principles

- Modular architecture
- Separation of concerns
- Minimal complexity (initial phase)
- Real execution over simulation
- Capital preservation first

---

Project Structure

core/
│
├── state.js         → Global state (position, pnl, session)
├── x_core.js        → Core engine orchestration
├── x_controller.js  → Decision controller (bias + signals)
├── x_allocator.js   → Lot sizing / allocation logic
├── x_execution.js   → Execution routing logic
├── x_exec.js        → Order placement abstraction
├── x_risk.js        → Risk management layer
│
indicators/
│
└── indicators.js    → ALMA, ATR calculations
│
index.js             → Entry point (WS + main loop)
README.md            → Documentation

---

Module Responsibilities

state.js

- Maintains global trading state
- Position, PnL, exposure

x_core.js

- Central engine loop
- Connects all modules

x_controller.js

- Signal logic
- Bias + entry conditions

x_allocator.js

- Determines lot sizing
- Handles allocation rules

x_execution.js

- Decides how orders are executed
- Bridges logic → broker

x_exec.js

- Actual order placement
- Supports live / paper mode

x_risk.js

- Risk control
- Drawdown, limits, protections

indicators.js

- ALMA calculations
- ATR calculations

---

Version Focus

V1 — Data + Execution Validation

- Single FAST trade (1 mini lot)
- No scaling
- No complex risk states

Goal:

Validate execution behavior and collect real trade data.

---

Research Evolution

Development follows iterative refinement:

Build → Execute → Observe → Refine

Each version is derived from live behavior, not assumptions.

---

No strategy is permanent.
Only the framework evolves.

---

Author
Vamshi Krishna (JVKROG)
Embedded Systems | Trading Systems | Real-Time Systems

Vamshi Krishna (JVKROG)
Embedded Systems | Trading Systems | Real-Time Systems
