<p align="center">
  <img src="https://img.shields.io/badge/version-4.1.0-blue?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat-square&logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/platform-Zo_Computer-black?style=flat-square" alt="Zo Computer" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

# zo-swarm-orchestrator

**Multi-agent orchestration engine for [Zo Computer](https://zo.computer](https://zo.computer?referrer=faunaflora)) — spawn parallel agent teams with token-optimized memory, DAG task dependencies, and resilient execution.**

Turn a single prompt into a coordinated swarm of specialized AI agents that plan, execute, and synthesize work in parallel — with automatic memory management, circuit breakers, and structured observability.

---

## Why

Running multiple AI agents in parallel sounds simple until you hit reality:

- **Context window exhaustion** — 5 agents × 256K tokens = system failure
- **Cascading failures** — one timeout kills the entire swarm
- **Unbounded memory growth** — sequential context balloons with every task
- **No visibility** — agents run in a black box with no structured logging

This orchestrator solves all of these. It was battle-tested through [production failures](#lessons-from-production) and iterated across four major versions to become a reliable, token-aware, observable multi-agent execution engine.

---

## Features

| Category | Feature | Details |
|----------|---------|---------|
| **Execution** | DAG task dependencies | Tasks declare `dependsOn` — the engine resolves the graph and streams execution as dependencies clear |
| | Streaming & wave modes | `streaming` (default) launches tasks immediately; `waves` waits for full dependency levels |
| | Configurable concurrency | Tune parallel agents (default: 3) to match API rate limits |
| **Memory** | 4 memory strategies | `none`, `sliding`, `hierarchical`, `sequential` — choose per-task or globally |
| | Token budget management | Hard caps on context size with automatic truncation and budget utilization tracking |
| | Pre-warm caching (O3) | Domain-specific facts cached for 1 hour — 3-8% latency savings |
| | Cross-task context window | Configurable sliding window of prior task results injected as context |
| **Resilience** | Exponential backoff | 500ms × 2^attempt with jitter on transient failures |
| | Per-persona circuit breaker | 3 failures = circuit open, auto-reset after cooldown |
| | Chunked processing | Tasks grouped into safe batches to prevent thundering herd |
| | Priority queue | `critical` → `high` → `medium` → `low` execution order |
| **Observability** | NDJSON structured logging | Every event (task start, complete, retry, failure) as a parseable JSON line |
| | Result persistence | Swarm results saved to `results/<swarm-id>.json` |
| | Doctor command | `bun orchestrate-v4.ts doctor` — health check for API, memory DB, config |
| **Personas** | Fuzzy persona matching | Levenshtein distance matching for unknown persona names (0.25 threshold) |
| | Persona memory bridge | Queries the shared Zo memory system for persona-specific facts |
| | Inter-agent messaging | Agents can send/receive messages through SQLite-backed channels |
| **Patterns** | Pre-built swarm patterns | 6 ready-to-use analysis patterns (investment, portfolio, market outlook, etc.) |
| | Persona registry | 8 specialized personas with defined expertise and tool access |

---

## Quick Start

```bash
cd Skills/zo-swarm-orchestrator/scripts

# Run a swarm with hierarchical memory (recommended)
bun orchestrate-v4.ts tasks.json --swarm-id my-project

# Cost-optimized — no memory overhead
bun orchestrate-v4.ts tasks.json --strategy none

# Health check
bun orchestrate-v4.ts doctor
```

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Orchestrator                    │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │   DAG    │  │  Token   │  │   Circuit    │  │
│  │ Resolver │  │ Budgets  │  │   Breaker    │  │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       │              │               │           │
│  ┌────▼──────────────▼───────────────▼───────┐  │
│  │           Execution Engine                │  │
│  │  (streaming DAG / wave-based / chunked)   │  │
│  └────────────────┬──────────────────────────┘  │
│                   │                              │
│  ┌────────────────▼──────────────────────────┐  │
│  │          Memory Layer                     │  │
│  │  hierarchical │ sliding │ sequential │ none│  │
│  └────────────────┬──────────────────────────┘  │
│                   │                              │
│  ┌────────────────▼──────────────────────────┐  │
│  │   Zo /zo/ask API  ×  N concurrent agents  │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  NDJSON  │  │  Result  │  │  Pre-warm    │  │
│  │  Logger  │  │  Store   │  │  Cache       │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## Memory Strategies

The core innovation. Each strategy trades off token efficiency against context quality:

| Strategy | Tokens | Context Quality | When to Use |
|----------|--------|-----------------|-------------|
| `none` | ★★★★★ | ★☆☆☆☆ | Independent tasks, cost-sensitive runs |
| `sliding` | ★★★★☆ | ★★★☆☆ | Recent context matters, bounded growth |
| `hierarchical` | ★★★★☆ | ★★★★★ | **Complex multi-step workflows (recommended)** |
| `sequential` | ★☆☆☆☆ | ★★★★★ | Debugging only, small swarms |

**Hierarchical memory** splits context into working memory (2 most recent items) and long-term memory (3 retrieved items), giving agents both recency and relevance without unbounded growth.

### Benchmark Results

```
Strategy       Avg Tokens    Memory Items    Savings vs Sequential
─────────────────────────────────────────────────────────────────
none                26              0                    -93%
sliding            356              3                     -8%
hierarchical       416              4                     -8%
sequential         386              5              (baseline)
```

---

## Task File Format

Tasks are defined as a JSON array. Each task can declare DAG dependencies, a memory strategy, and metadata:

```json
[
  {
    "id": "plan",
    "persona": "research-analyst",
    "task": "Create analysis plan for the target company",
    "priority": "critical"
  },
  {
    "id": "fundamentals",
    "persona": "financial-advisor",
    "task": "Analyze financial statements and valuation metrics",
    "priority": "high",
    "dependsOn": ["plan"],
    "memoryStrategy": "hierarchical",
    "outputToMemory": true,
    "memoryMetadata": {
      "category": "financial-analysis",
      "tags": ["valuation", "fundamentals"]
    }
  },
  {
    "id": "risks",
    "persona": "risk-analyst",
    "task": "Assess downside scenarios and key risk factors",
    "priority": "high",
    "dependsOn": ["plan"],
    "contextAccess": "read"
  },
  {
    "id": "synthesis",
    "persona": "financial-advisor",
    "task": "Synthesize all findings into a final recommendation",
    "priority": "critical",
    "dependsOn": ["fundamentals", "risks"]
  }
]
```

This creates a DAG: `plan` → `[fundamentals, risks]` (parallel) → `synthesis`.

---

## CLI Reference

```bash
bun orchestrate-v4.ts <tasks.json> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--swarm-id <id>` | Unique identifier for this swarm run | auto-generated |
| `--strategy <type>` | Memory strategy: `none`, `sliding`, `hierarchical`, `sequential` | `hierarchical` |
| `--max-tokens <n>` | Token budget for context injection | `8000` |
| `--concurrency <n>` | Max parallel agents | `3` |
| `--dag-mode <mode>` | `streaming` (immediate) or `waves` (level-by-level) | `streaming` |
| `--no-memory` | Disable all memory systems | `false` |
| `doctor` | Run health checks (API, memory DB, config) | — |

---

## Configuration

Three layers of configuration with clear precedence:

**CLI flags** > **config.json** > **Environment variables** > **Defaults**

### config.json

```json
{
  "maxConcurrency": 3,
  "timeoutSeconds": 605,
  "maxRetries": 3,
  "crossTaskContextWindow": 3,
  "memory": {
    "enable": true,
    "workingMemorySize": 2,
    "longTermMemorySize": 3,
    "enableDeduplication": true,
    "enableHTMLStripping": true,
    "maxTokens": 8000
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SWARM_MAX_CONCURRENCY` | Max parallel agents | `2` |
| `SWARM_TIMEOUT_SECONDS` | Per-agent timeout | `300` |
| `SWARM_MAX_RETRIES` | Retry attempts | `3` |
| `ZO_CLIENT_IDENTITY_TOKEN` | Zo API authentication | Required |

---

## Pre-built Swarm Patterns

Six ready-to-use analysis patterns in `assets/swarm-patterns.json`:

| Pattern | Personas | Purpose |
|---------|----------|---------|
| `investment-decision` | financial-advisor, research-analyst, risk-analyst | Multi-angle investment thesis |
| `portfolio-review` | financial-advisor, risk-analyst, tax-advisor | Comprehensive portfolio health check |
| `market-outlook` | macro-economist, technical-analyst, news-monitor | Macro + technical + sentiment synthesis |
| `stock-deep-dive` | financial-advisor, research-analyst, technical-analyst, risk-analyst | Full single-stock analysis |
| `sector-analysis` | research-analyst, macro-economist, esg-analyst | Industry-level assessment |
| `validation-swarm` | financial-advisor, risk-analyst, research-analyst | Consensus validation (0.7 threshold) |

---

## Persona Registry

Eight specialized personas in `assets/persona-registry.json`:

| Persona | Expertise |
|---------|-----------|
| `financial-advisor` | Valuation, portfolio management, investment strategy |
| `research-analyst` | Data gathering, competitive analysis, trend synthesis |
| `risk-analyst` | Risk assessment, stress testing, downside scenarios |
| `technical-analyst` | Chart patterns, indicators, momentum analysis |
| `news-monitor` | News sentiment, event impact, market-moving catalysts |
| `tax-advisor` | Tax optimization, harvesting, efficiency planning |
| `macro-economist` | Economic indicators, policy analysis, rate forecasting |
| `esg-analyst` | ESG ratings, sustainability metrics, governance review |

---

## Utility Scripts

```bash
# Benchmark memory strategies
bun benchmark.ts

# View memory database stats
bun swarm-memory.ts stats

# List active sessions
bun swarm-memory.ts list-sessions

# Clean up old contexts (older than N days)
bun swarm-memory.ts cleanup 30

# Configuration management
bun swarm-config.ts --show
bun swarm-config.ts --set-max-concurrency 5
bun swarm-config.ts --list-personas

# A/B testing
bun ab-test.ts

# Integration tests
bun integration-test-runner.ts

# FFB performance workload
bun ffb-performance-test.ts
```

---

## Version History

| Version | Codename | Key Innovation | Status |
|---------|----------|----------------|--------|
| **v4.1** | — | DAG dependencies, NDJSON logging, doctor command, result persistence, inter-agent messaging | ✅ Current |
| **v4.0** | Token-Optimized | Hierarchical memory, token budgets, pre-warm caching, format constraints | ✅ Current |
| **v3** | Persistent Memory | SQLite-backed cross-session memory, persona memory bridge | 🔄 Fallback |
| **v2** | Resilient Execution | Exponential backoff, circuit breaker, chunked processing, priority queue | 🔄 Fallback |
| **v1** | Basic Parallel | Simple `Promise.all` parallel execution | ❌ Deprecated |

### Fallback Strategy

All versions share the same task file format. If v4 has issues, drop back instantly:

```bash
# v3 fallback (persistent memory, no token optimization)
bun orchestrate-v3.ts tasks.json --swarm-id my-project

# v2 fallback (resilient, no memory)
bun orchestrate-v2.ts tasks.json
```

---

## Lessons from Production

This orchestrator was born from real production failures in February 2026:

| Problem | Root Cause | Solution (Current) |
|---------|------------|---------------------|
| All 5 agents timed out simultaneously | 120s timeout + no backoff | 605s timeout + exponential backoff with jitter |
| Cascading failures across agents | No isolation between agent failures | Per-persona circuit breaker (3 failures = open) |
| Context window exhaustion | Unbounded sequential memory | Hierarchical memory with token budgets |
| Thundering herd on API | All agents fired simultaneously | Chunked processing with configurable concurrency |
| No debugging capability | Fire-and-forget execution | NDJSON structured logging + result persistence |

The full incident analysis is documented in [`AGENTS.md`](./AGENTS.md).

---

## Project Structure

```
zo-swarm-orchestrator/
├── SKILL.md                          # Skill manifest and documentation
├── config.json                       # Runtime configuration
├── MODEL_GUIDE.md                    # AI model selection reference
├── AGENTS.md                         # Production lessons and patterns
├── CLAUDE.md                         # Development guide
├── scripts/
│   ├── orchestrate-v4.ts             # ✅ Current orchestrator
│   ├── orchestrate-v3.ts             # 🔄 Fallback (persistent memory)
│   ├── orchestrate-v2.ts             # 🔄 Fallback (resilient execution)
│   ├── orchestrate.ts                # ❌ Deprecated (v1)
│   ├── token-optimizer.ts            # Token cleaning + hierarchical memory
│   ├── swarm-memory.ts               # SQLite persistence + inter-agent messaging
│   ├── swarm-config.ts               # Configuration management CLI
│   ├── swarm-status.ts               # Health/status checking
│   ├── benchmark.ts                  # Memory strategy benchmarking
│   ├── ab-test.ts                    # A/B testing framework
│   ├── inter-agent-comms.ts          # Agent messaging demo
│   ├── orchestrate-with-comms.ts     # Orchestrator + messaging demo
│   ├── ffb-performance-test.ts       # FFB workload performance test
│   ├── integration-test-runner.ts    # Integration test suite
│   └── integration-test-v2.ts        # Integration test v2
├── assets/
│   ├── persona-registry.json         # 8 specialized personas
│   └── swarm-patterns.json           # 6 pre-built analysis patterns
└── examples/
    └── test-v4-simple.json           # Example task file
```

---

## Requirements

- **Runtime:** [Bun](https://bun.sh) v1.2+
- **Platform:** [Zo Computer](https://zo.computer)
- **Auth:** `ZO_CLIENT_IDENTITY_TOKEN` (automatically available on Zo)

---

## License

MIT
