````markdown
# TAlgo-X — Autonomous Trading Execution Platform

> Production-grade deterministic trading infrastructure for deploying, operating, and monitoring autonomous trading engines through unified CLI and Web interfaces.


# Setup

TAlgo-X is designed to run on a local PC, VPS, or cloud VM. The execution environment is not tied to a specific cloud provider.

A local computer, VPS, or cloud instance can act as a TAlgo-X execution machine.

## Prerequisites

Install the following before setting up TAlgo-X:

- Node.js
- npm
- Git
- PM2
- Broker/API account for live execution

For development and paper trading, a live broker account may not be required depending on the configured execution mode.


````
## 1. Clone the repository

```bash
git clone <repository-url>
````

---

## 2. Enter the project directory

```bash
cd TAlgo-X
```

---

## 3. Install dependencies

```bash
npm install
```

---

## 4. Install PM2

PM2 is used to manage long-running TAlgo-X execution processes.

```bash
npm install -g pm2
```

Verify the installation:

```bash
pm2 --version
```

---

## 5. Setup the TAlgo-X CLI

TAlgo-X exposes its operational toolbox through the `talgox` command.

The package provides the CLI through the `bin` mapping:

```json
"bin": {
  "talgox": "./toolbox.js"
}
```

For local development, link the package:

```bash
npm link
```

Verify:

```bash
talgox
```

The CLI provides access to:

* Engine deployment
* Instrument management
* Backtesting
* Runtime control
* Configuration management
* Paper execution
* Live execution
* Credentials management
* System diagnostics

---

# Broker Integration

TAlgo-X currently supports **Kite Connect** as its broker integration.

The broker integration is responsible for communicating with the broker's REST and WebSocket APIs.

```text
TAlgo-X
   │
   ▼
Kite Connect
   │
   ├── REST API
   │
   └── WebSocket API
```

Additional broker integrations may be added in the future.

---

# Configure Credentials

TAlgo-X provides credential management through both operator interfaces:

* **CLI Toolbox**
* **Web Dashboard**

At present, the credential system is designed for **Kite Connect**.

```text
                 TAlgo-X
                    │
          ┌─────────┴─────────┐
          │                   │
     CLI Toolbox        Web Dashboard
          │                   │
          └─────────┬─────────┘
                    │
              Kite Connect
                    │
          ┌─────────┴─────────┐
          │                   │
       API Key          Access Token
```

## API Key

Configure the Kite Connect API key through the **Credentials** option in either the CLI Toolbox or Web Dashboard.

The API key should never be:

* Hardcoded into source code
* Committed to Git
* Exposed in logs
* Stored in publicly accessible files

---

## Access Token

Kite Connect also requires an access token for authenticated API operations.

The access token is **temporary and expires daily**.

Therefore, TAlgo-X allows the access token to be updated through either:

* CLI Toolbox
* Web Dashboard

When the existing access token expires:

1. Generate a new Kite Connect access token.
2. Open the TAlgo-X Credentials interface.
3. Update the access token through the CLI or Web Dashboard.
4. Restart the affected engine if required by the current runtime configuration.

```text
Kite Connect Login
        │
        ▼
New Access Token
        │
        ▼
TAlgo-X Credentials
        │
   ┌────┴────┐
   │         │
 CLI       WebDash
   │         │
   └────┬────┘
        │
        ▼
Running Engine
```

> **Important:** API keys and access tokens are sensitive credentials. Never commit them to the repository.

---

# Runtime Configuration

After configuring broker credentials, configure the execution environment.

Configuration may include:

* Instrument
* Strategy
* Execution mode
* Risk parameters
* Target configuration
* Runtime settings
* Notifications
* Dashboard settings

The recommended development sequence is:

```text
Credentials
    ↓
Instrument Configuration
    ↓
Strategy Configuration
    ↓
Risk Configuration
    ↓
Paper Execution
```

---

# Start with Paper Trading

Always validate a new installation in paper mode before enabling live execution.

Recommended workflow:

```text
Install
   ↓
Configure Credentials
   ↓
Configure Runtime
   ↓
Backtest
   ↓
Paper Trading
   ↓
Validate
   ↓
Live Execution
```

Paper trading allows runtime, strategy, target, recovery and execution behavior to be tested without placing live orders.

---

## Verify PM2

List running processes:

```bash
pm2 list
```

View logs:

```bash
pm2 logs
```

Restart an engine:

```bash
pm2 restart <process>
```

Stop an engine:

```bash
pm2 stop <process>
```

Delete an engine:

```bash
pm2 delete <process>
```

---

# Overview

TAlgo-X is the deployment and execution platform of the TAlgo ecosystem.

Rather than building separate trading bots for each instrument, TAlgo-X separates trading intelligence from runtime orchestration, allowing a single deterministic execution brain to operate multiple instruments through isolated runtime contexts.

The platform provides two operator interfaces:

* **CLI Toolbox** — deployment, configuration, backtesting and runtime management
* **Web Dashboard** — real-time monitoring, observability and engine control

TAlgo-X is designed around a machine-agnostic execution model. The same platform can operate on a development PC, VPS, or cloud VM.

---

# Platform Architecture

```text
                         TAlgo-X
                            │
             ┌──────────────┴──────────────┐
             │                             │
        CLI Toolbox                  Web Dashboard
             │                             │
             └──────────────┬──────────────┘
                            │
                    Runtime Orchestrator
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
       NatGas             Zinc             USDINR
       Context            Context           Context
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │
                    Deterministic Brain
                            │
               Market → Strategy → Risk → Orders
```

---

# Execution Pipeline

```text
Market Data
      │
      ▼
Authoritative Candle Polling
      │
      ▼
Market State Engine
      │
      ▼
Strategy Selection
      │
      ▼
Signal Validation
      │
      ▼
Risk Management
      │
      ▼
Order Execution
      │
      ▼
SQLite Persistence
      │
      ▼
Runtime Observability
```

TAlgo-X uses deterministic candle-driven execution for strategy decisions while real-time WebSocket data can be used for execution monitoring and target/exit handling.

---

# One Brain, Multiple Contexts

TAlgo-X follows a **One Brain, Multiple Contexts** architecture.

```text
                  Deterministic Brain
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
   NatGas Context    Zinc Context     USDINR Context
       │                 │                 │
   State/Position    State/Position   State/Position
   Config/Runtime    Config/Runtime   Config/Runtime
```

The execution brain remains shared while instrument-specific state, configuration, position information and runtime context remain isolated.

This allows additional instruments to be introduced without creating completely independent trading applications.

---

# Operator Interfaces

## CLI Toolbox

The CLI is the operational control center of TAlgo-X.

Primary command:

```bash
talgox
```

Capabilities include:

* Engine deployment
* Instrument onboarding
* Backtesting
* Runtime lifecycle management
* Configuration management
* Credentials management
* PM2 integration
* Paper execution
* Live execution
* System diagnostics

---

## Web Dashboard

The Web Dashboard provides browser-based visibility and control over running engines.

Features include:

* Engine lifecycle management
* Runtime telemetry
* Position and PnL monitoring
* Live execution logs
* Broker connectivity status
* Market state visualization
* Multi-engine monitoring
* Credentials management
* Browser-based operator console

The Web Dashboard is an operator interface and does not replace the deterministic execution engine.

---

# Runtime

The runtime coordinates live execution processes.

Responsibilities include:

* Deterministic candle synchronization
* Execution scheduling
* Order routing
* Position lifecycle management
* Restart recovery
* SQLite persistence
* Telegram notifications
* Dashboard synchronization
* Runtime health monitoring

Each instrument runs inside an isolated runtime context while sharing the same execution architecture.

---

# Trading Architecture

Execution decisions are separated into independent layers:

```text
Market
   │
   ▼
Market State
   │
   ▼
Strategy Selection
   │
   ▼
Signal Validation
   │
   ▼
Risk Management
   │
   ▼
Order Execution
```

This modular architecture allows strategies to evolve without requiring changes to the underlying execution infrastructure.

---

# Persistence & Recovery

SQLite provides lightweight runtime persistence.

It is used for:

* Active position storage
* Execution state persistence
* Runtime recovery
* Crash recovery
* Restart continuity
* Position/state reconstruction

The runtime is designed to recover persisted state after a process restart rather than treating every restart as a completely new execution session.

---

# Observability

TAlgo-X includes a built-in observability layer.

Features include:

* Live execution logs
* Telegram notifications
* Runtime telemetry
* Dashboard monitoring
* Position tracking
* PnL tracking
* Execution history
* Engine health monitoring
* Broker connectivity visibility

Execution decisions are logged so runtime behavior can be inspected and explained.

---

# Broker Architecture

TAlgo-X currently uses **Kite Connect** for broker communication.

```text
                  TAlgo-X
                     │
                     ▼
               Broker Layer
                     │
                     ▼
                Kite Connect
                     │
          ┌──────────┴──────────┐
          │                     │
       REST API            WebSocket API
          │                     │
          └──────────┬──────────┘
                     │
                     ▼
                  Broker
```

The broker layer keeps broker-specific communication separate from the core execution architecture.

This allows future broker integrations to be added without redesigning the deterministic execution engine.

---

# Machine-Agnostic Deployment

TAlgo-X is not architecturally tied to AWS.

The execution environment can be:

```text
                 TAlgo-X
                    │
        ┌───────────┼───────────┐
        │           │           │
     Local PC      VPS       Cloud VM
        │           │           │
      Runtime     Runtime     Runtime
        │           │           │
        └───────────┼───────────┘
                    │
                Broker API
```

Examples include:

* Windows development PC
* Linux workstation
* VPS
* AWS EC2
* Other cloud virtual machines

The machine simply provides the environment in which the TAlgo-X runtime operates.

---

# Process Management

PM2 manages long-running TAlgo-X processes.

Common commands:

```bash
pm2 list
```

```bash
pm2 logs
```

```bash
pm2 restart <process>
```

```bash
pm2 stop <process>
```

```bash
pm2 delete <process>
```

PM2 provides process lifecycle management while TAlgo-X handles application-level state persistence and recovery.

---

# Paper Trading

Paper trading should be used before enabling live execution.

The recommended workflow is:

```text
Backtesting
    ↓
Paper Trading
    ↓
Runtime Testing
    ↓
Recovery Testing
    ↓
Broker Connectivity Testing
    ↓
Live Execution
```

Paper mode allows changes to:

* Strategy logic
* Target logic
* Risk management
* Runtime behavior
* Recovery mechanisms
* Broker integration

to be tested without placing live orders.

---

# Live Execution

Live execution requires valid broker/API authentication and appropriate account configuration.

Before enabling live execution, verify:

* Instrument configuration
* Broker connectivity
* Strategy configuration
* Risk parameters
* Position state
* Target/exit behavior
* Restart recovery
* Paper-trading behavior

TAlgo-X should maintain consistency between persisted runtime state and broker-side position state.

---

# Security

TAlgo-X interacts with infrastructure that can potentially access financial accounts.

Therefore:

* Never commit API keys.
* Never commit access tokens.
* Never commit broker passwords.
* Never expose credentials in logs.
* Never hardcode production credentials into source files.
* Keep deployment-specific secrets outside Git.
* Restrict access to the Web Dashboard.
* Do not expose broker credentials to browser-side code.
* Use appropriate separation between paper and live credentials.

---

# Development Philosophy

TAlgo-X is built around several principles.

### One Brain

A shared deterministic execution architecture instead of completely independent trading applications for every instrument.

### Deterministic Execution

The same market input should produce predictable execution behavior.

### Isolated Contexts

Each instrument maintains its own runtime and trading state.

### Explainable Execution

Execution decisions should be inspectable through structured logs and runtime state.

### Failure Recovery

A process failure should not automatically destroy knowledge of an existing position.

### Operational Simplicity

Deployment, monitoring and control should be accessible through unified operator interfaces.

### Machine Independence

The execution platform should not depend on a specific cloud provider or infrastructure vendor.

---

# TAlgo vs TAlgo-X

| TAlgo                   | TAlgo-X                 |
| ----------------------- | ----------------------- |
| Strategy research       | Execution platform      |
| Experimental algorithms | Production deployment   |
| Indicator development   | Runtime orchestration   |
| Strategy evolution      | Multi-engine management |
| Research environment    | Operator platform       |
| Signal experimentation  | Paper/live execution    |

---

# Current Development

Current work focuses on:

* One Brain architecture
* Multi-instrument execution
* CLI and Web operator interfaces
* Market-state-driven execution
* Runtime reliability
* Deployment tooling
* Explainable execution
* Failure recovery
* Adaptive execution logic
* AI-assisted observability

---

# Project Structure

A simplified conceptual structure:

```text
TAlgo-X/
│
├── toolbox.js
├── engine.js
├── package.json
│
├── strategies/
│
├── runtime/
│
├── state/
│
├── webdash/
│
├── backtest/
│
├── config/
│
└── README.md
```

The exact directory structure may evolve as development continues.

---

# Recommended Development Workflow

```text
                    Development
                         │
                         ▼
                    Backtesting
                         │
                         ▼
                   Paper Trading
                         │
                         ▼
                  Runtime Testing
                         │
                         ▼
                  Recovery Testing
                         │
                         ▼
                 Broker Validation
                         │
                         ▼
                  Live Execution
```

Changes to execution logic should be validated in paper mode before being deployed to a live trading environment.

---

# Future Roadmap

* Portfolio-level execution
* Distributed runtime orchestration
* Cloud deployment platform
* User-managed VPS deployment
* AI-assisted operational insights
* Multi-broker support
* Plugin-based strategy framework
* Multi-user SaaS execution infrastructure

---

# Disclaimer

TAlgo-X is a research and educational project focused on autonomous trading infrastructure, deterministic execution systems, and backend engineering.

Live deployment credentials, proprietary configurations, and sensitive operational data are intentionally excluded from the repository.

Trading involves financial risk. TAlgo-X does not guarantee profitability or successful execution.

```
