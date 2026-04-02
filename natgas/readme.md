# NatGas Engine — Dual ALMA Execution System

> Multi-layer trading engine combining short-term reactivity and long-term stability using dual ALMA logic.

---

## Overview

The NatGas engine is a **dual-layer execution system** built on the TAlgo framework.

It runs two independent but interacting engines:
```
- **FAST Engine → ALMA Fast (reactive, 5 mini lots)**
- **SLOW Engine → ALMA Slow (trend-following, 1 full lot)**
```
Both share the same data pipeline but behave differently.

---

## Core Concept

```

Same Market Data
↓
Two Decision Layers
↓
FAST (react) + SLOW (hold)

```

This creates:
- quick response to momentum (FAST)
- stability and trend capture (SLOW)

---

## Engine Structure

###  FAST Engine (Short-Term Layer)
```
- Instrument: NATGAS MINI  
- Lots: 5 mini  
- Logic: ALMA Fast color + state machine  
- Purpose: capture short-term moves  
```
---

###  SLOW Engine (Long-Term Layer)
```
- Instrument: NATGAS FUT  
- Lots: 1 full  
- Logic: ALMA Slow crossover  
- Purpose: hold directional bias  
```
---

## Data Pipeline

```

Tick → Candle (1H) → HA → ALMA → State → Signal → Execution

```

- Only FAST token builds candles  
- Both engines derive signals from same data  

---

## Indicator System

From code:
```
- ALMA Fast = 20  
- ALMA Slow = 100  
- ATR-based volatility filter  
- ALMA High/Low bands for structure :contentReference[oaicite:0]{index=0}  
```
---

## FAST Engine Behavior

### State Detection

FAST engine classifies market into:

```

GREEN → Strong Uptrend
RED   → Strong Downtrend
GREY  → Sideways / Compression

```

Based on:
```
- ALMA slope
- ATR strength
- Band breakout :contentReference[oaicite:1]{index=1}  
```
---

### Entry Logic
```
- Strong slope → direct entry  
- Weak slope → probation → confirmation  
```
Example from logs:

```

FAST SHORT PROBATION → ENTRY CONFIRMED

````

---

### Exit Logic
```
- Opposite state → exit  
- GREY → exit (sideways protection)  
- SL = based on slow ALMA  
```
---

## SLOW Engine Behavior

### Entry
```
- Triggered on ALMA Slow crossover  
- Only allowed when FAST aligns  
```
``` 
price crosses ALMA slow AND fast supports direction
````

---

### Exit
```
* Max loss protection (hard stop)
* FAST reversal protection
* SL based on ATR
```
From logs:

```
SLOW SHORT EXIT (MAX_LOSS)
SLOW EXIT (FAST_PROTECT)
```

---

### Reset Rule (Important)

After SLOW exit:
```
* No re-entry allowed
* Must wait for GREY state
```
This prevents:
```
* revenge trades
* repeated losses
```
---

## Positioning Model (Core Edge)

```
FAST → 5 mini lots → reactive layer
SLOW → 1 full lot → stable layer
```

Why:
```
* FAST captures quick moves
* SLOW holds conviction trades
* Risk is distributed across layers
```
From config :
```
* FAST_LOTS = 5
* SLOW_LOTS = 1
```
---

## Risk System

### FAST
```
* SL based on SLOW ALMA
* exits quickly in sideways
```
### SLOW
```
* MAX_LOSS limit
* FAST_PROTECT (if fast reverses strongly)
* ATR-based SL
```
---

## Database (Persistence Layer)

The engine uses SQLite to persist positions.

From DB schema :

```
positions:
- engine (FAST / SLOW)
- symbol
- position (LONG / SHORT)
- entry_price
- sl_price
```

---

### Why DB Matters
```
* survives restart
* resumes position after crash
* ensures continuity
```
From lifecycle:

```
Positions saved → resumed next session
```



---

## Execution Flow

```
WebSocket → Tick → Candle → Signal → Position → DB → Telegram
```

From main engine :
```
* WebSocket feeds live data
* Only FAST token drives execution
* Signals processed per candle
```
---

## Lifecycle Control
```
* 9:00 → session start
* 23:00 → force close
* 23:15 → shutdown + summary
```
Includes:
```
* session PnL tracking
* safe exit handling
```
---

## Real Behavior (From Logs)

Example:

```
FAST SHORT ENTRY CONFIRMED @ 274.20
FAST PnL → +1750
EOD FORCE EXIT → secured profit
```

and

```
SLOW ENTRY → loss → MAX_LOSS exit
```

 Insight:
```
* FAST captures momentum
* SLOW can suffer in bad trends
* protection layers prevent blow-up
```
---

## Strengths
```
* Dual-layer execution
* Adaptive to volatility
* Strong sideways protection
* Position persistence (DB)
```
---

## Limitations
```
* SLOW engine vulnerable to false trends
* Depends on ATR tuning
* FAST can overtrade without filters
```
---

## System Behavior Summary

```
FAST → reacts
SLOW → commits
DB   → remembers
Lifecycle → controls risk
```

---

## Final Concept

```
Fast mind + Slow conviction = Balanced execution
```

This engine is designed not just to trade,
but to **behave correctly under real market conditions**.

---

```
