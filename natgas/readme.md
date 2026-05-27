# NatGas Engine — Adaptive Multi-Filter Execution System

> Regime-aware autonomous trading engine combining fast market reaction with slow directional confirmation using SuperTrend, ALMA, RSI, and ADX filtering.

---

## Overview

The NatGas engine is a production-oriented execution system built on the TAlgo-X runtime architecture.

It combines:

```txt
- SuperTrend FAST execution logic
- ALMA SLOW directional bias
- RSI momentum filtering
- ADX trend-strength validation
```

The objective is not just signal generation, but stable behavior under highly volatile natural gas market conditions.

---

## Core Concept

```txt
Same Market Data
        ↓
Multi-Layer Signal Validation
        ↓
FAST Reaction + SLOW Confirmation
        ↓
Filtered Execution
```

This architecture helps:

* react quickly to market movement
* reduce overtrading in sideways conditions
* avoid weak or low-conviction entries
* maintain directional stability

---

## Engine Architecture

```txt
Market Data API
        ↓
Authoritative Candle Polling
        ↓
Heikin Ashi Transformation
        ↓
Indicator Layer
(ST FAST + ALMA SLOW + RSI + ADX)
        ↓
Signal Validation Layer
        ↓
Position & Risk Logic
        ↓
Execution Runtime
        ↓
SQLite + Telegram
```

---

## Data Pipeline

### API-Polled Candle System

The engine uses authoritative API-polled candle closes instead of tick-built candles.

```txt
API Candle Close
        ↓
HA Candle
        ↓
Indicators
        ↓
Signal Evaluation
        ↓
Execution
```

### Why This Architecture

```txt
- deterministic candle timing
- reduced synchronization drift
- cleaner state transitions
- stable runtime behavior
- lower execution inconsistency
```

WebSockets are primarily used for:

```txt
- monitoring
- emergency handling
- runtime alerts
```

---

## Indicator Stack

### SuperTrend FAST Layer

Purpose:

```txt
- short-term reaction
- execution timing
- directional shifts
```

Behavior:

```txt
- reacts quickly to volatility
- handles short-term momentum
- drives immediate execution decisions
```

---

### ALMA SLOW Layer

Purpose:

```txt
- long-term directional bias
- trend stability
- noise reduction
```

Behavior:

```txt
- smooths market structure
- filters unstable reversals
- confirms broader trend direction
```

---

### RSI Filter

Purpose:

```txt
- momentum quality validation
- prevent weak entries
```

Behavior:

```txt
- blocks exhausted moves
- filters low-quality momentum
- reduces unnecessary entries
```

---

### ADX Filter

Purpose:

```txt
- trend-strength confirmation
- sideways market detection
```

Behavior:

```txt
- avoids low-strength trends
- reduces sideways overtrading
- validates directional conviction
```

---

## Signal Philosophy

```txt
ST FAST   → reaction layer
ALMA SLOW → directional bias
RSI       → momentum validation
ADX       → trend-strength confirmation
```

Execution occurs only when filters align with directional conditions.

---

## Execution Logic

### Entry Conditions

```txt
- FAST direction aligns with SLOW bias
- RSI confirms momentum quality
- ADX confirms sufficient trend strength
- Candle closes trigger evaluation
```

This creates:

```txt
- fewer low-quality trades
- reduced noise participation
- cleaner execution behavior
```

---

## Exit Logic

```txt
- opposite directional confirmation
- weakening trend strength
- runtime risk protection
- lifecycle-based force exits
```

Additional protection layers include:

```txt
- session controls
- EOD forced exits
- adaptive runtime protection
```

---

## Position Persistence

The engine uses SQLite-based persistence for runtime continuity.

### Stored State

```txt
- active position
- direction
- entry price
- stop-loss data
- engine state
```

### Why Persistence Matters

```txt
- survives runtime restart
- restores execution continuity
- prevents state loss
- improves operational reliability
```

---

## Runtime Flow

```txt
API Polling
      ↓
Indicator Calculation
      ↓
Signal Validation
      ↓
Execution Decision
      ↓
Position Persistence
      ↓
Telegram Alerts
```

---

## Lifecycle Management

```txt
09:00  → session initialization
23:00  → force-close protection
23:15  → runtime shutdown
```

Includes:

```txt
- session PnL tracking
- controlled shutdown handling
- runtime cleanup
- execution safety controls
```

---

## Runtime Design Principles

```txt
- deterministic execution
- explainable decision flow
- adaptive filtering
- failure-aware runtime behavior
- stable signal confirmation
```

---

## Strengths

```txt
- strong sideways filtering
- adaptive multi-filter validation
- deterministic candle execution
- reduced emotional/noise trading
- runtime persistence and recovery
```

---

## Limitations

```txt
- trend filters can delay entries
- highly volatile spikes may bypass structure
- performance depends on filter calibration
```

---

## System Behavior Summary

```txt
FAST Layer  → reacts
SLOW Layer  → stabilizes
RSI         → validates momentum
ADX         → validates trend strength
SQLite      → preserves state
Lifecycle   → controls runtime risk
```

---

## Final Concept

```txt
Fast reaction
+ Slow confirmation
+ Momentum validation
+ Trend-strength filtering
= Stable adaptive execution
```

The NatGas engine is designed not only to trade, but to maintain controlled and explainable behavior under real-world volatile market conditions.
