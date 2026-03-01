<p align="center">
  <img src="https://img.shields.io/badge/version-4.1.0-blue?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat-square&logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/platform-Zo_Computer-black?style=flat-square" alt="Zo Computer" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

# zo-swarm-orchestrator

**Multi-agent orchestration engine for [Zo Computer](https://zo.computer?referrer=faunaflora) — spawn parallel agent teams with token-optimized memory, DAG task dependencies, and resilient execution.**

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
| | Split concurrency | Separate limits for API agents (default: 5) and local executors (default: 4) |
| | Local executors | Route tasks to Claude Code or Hermes via bridge scripts — no API needed |
| | Multi-backend API | Anthropic direct, Zo API, or local-only — automatic fallback chain |
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
| **Patterns** | Pre-built swarm patterns | 6 ready-to-use analysis patterns (website review, codebase review, product launch, etc.) |
| | Persona registry | 10 personas including 2 local executors (Claude Code, Hermes) |

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
┌──────────────────────────────────────────────────────┐
│                    Orchestrator                      │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐        │
│  │   DAG    │  │  Token   │  │   Circuit    │        │
│  │ Resolver │  │ Budgets  │  │   Breaker    │        │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘        │
│       │             │               │                │
│  ┌────▼─────────────▼───────────────▼───────────┐    │
│  │             Execution Engine                 │    │
│  │    (streaming DAG / wave-based / chunked)    │    │
│  └──────┬────────────────────────────┬──────────┘    │
│         │                            │               │
│  ┌──────▼──────────────┐  ┌──────────▼───────────┐   │
│  │   Memory Layer      │  │   Agent Router       │   │
│  │ hierarchical/sliding│  │ local → API fallback │   │
│  │ sequential/none     │  └──┬──────────┬────────┘   │
│  └─────────────────────┘     │          │            │
│                         ┌────▼────┐ ┌───▼──────────┐ │
│                         │ Local   │ │  API Backends│ │
│                         │ Claude  │ │  Anthropic   │ │
│                         │ Hermes  │ │  Zo API      │ │
│                         └─────────┘ └──────────────┘ │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐        │
│  │  NDJSON  │  │  Result  │  │  Pre-warm    │        │
│  │  Logger  │  │  Store   │  │  Cache       │        │
│  └──────────┘  └──────────┘  └──────────────┘        │
└──────────────────────────────────────────────────────┘
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
    "task": "Create analysis plan for the target system",
    "priority": "critical"
  },
  {
    "id": "analysis",
    "persona": "backend-architect",
    "task": "Analyze system architecture and identify improvement areas",
    "priority": "high",
    "dependsOn": ["plan"],
    "memoryStrategy": "hierarchical",
    "outputToMemory": true,
    "memoryMetadata": {
      "category": "architecture-review",
      "tags": ["architecture", "analysis"]
    }
  },
  {
    "id": "risks",
    "persona": "security-engineer",
    "task": "Assess security risks and vulnerability exposure",
    "priority": "high",
    "dependsOn": ["plan"],
    "contextAccess": "read"
  },
  {
    "id": "synthesis",
    "persona": "product-manager",
    "task": "Synthesize all findings into a prioritized action plan",
    "priority": "critical",
    "dependsOn": ["analysis", "risks"]
  }
]
```

This creates a DAG: `plan` → `[analysis, risks]` (parallel) → `synthesis`.

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
| `--concurrency <n>` | Max parallel API agents | `5` |
| `--local-concurrency <n>` | Max parallel local executors | `4` |
| `--timeout <seconds>` | Per-task timeout | `300` |
| `--model <name>` | Model name for API calls | from env |
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
  "maxConcurrency": 5,
  "localConcurrency": 4,
  "timeoutSeconds": 300,
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
| `ANTHROPIC_API_KEY` | Anthropic API key (preferred backend) | — |
| `ZO_CLIENT_IDENTITY_TOKEN` | Zo API authentication (fallback) | — |
| `SWARM_WORKSPACE` | Root for deployment resources (IDENTITY, SOUL.md, memory) | `cwd()` |
| `SWARM_MAX_CONCURRENCY` | Max parallel API agents | `2` |
| `SWARM_LOCAL_CONCURRENCY` | Max parallel local executors | `4` |
| `SWARM_TIMEOUT_SECONDS` | Per-task timeout | `300` |
| `SWARM_MAX_RETRIES` | Retry attempts | `3` |
| `SWARM_IDENTITY_DIR` | Persona identity files directory | `$SWARM_WORKSPACE/IDENTITY` |
| `SWARM_SOUL_FILE` | Path to constitution file | `$SWARM_WORKSPACE/SOUL.md` |
| `SWARM_MEMORY_SCRIPT` | Memory search script path | `$SWARM_WORKSPACE/.zo/memory/scripts/memory.ts` |
| `ZO_MEMORY_DB` | Persona memory SQLite DB | `$SWARM_WORKSPACE/.zo/memory/shared-facts.db` |

---

## Pre-built Swarm Patterns

Six ready-to-use analysis patterns in `assets/swarm-patterns.json`:

| Pattern | Personas | Purpose |
|---------|----------|---------|
| `website-review` | frontend-developer, security-engineer, backend-architect | Multi-angle website audit |
| `codebase-review` | backend-architect, security-engineer, devops-engineer | Code quality and architecture review |
| `product-launch` | product-manager, frontend-developer, technical-writer | Pre-launch readiness assessment |
| `deep-research` | research-analyst, data-scientist, product-manager, technical-writer | Multi-perspective research and analysis |
| `incident-postmortem` | devops-engineer, security-engineer, backend-architect | Post-incident root cause analysis |
| `validation-swarm` | research-analyst, data-scientist, backend-architect | Consensus validation (0.7 threshold) |

---

## Persona Registry

Ten personas in `assets/persona-registry.json`, including 2 local executors:

| Persona | Expertise | Executor |
|---------|-----------|----------|
| `research-analyst` | Data gathering, competitive analysis, trend synthesis | API |
| `frontend-developer` | UI/UX, accessibility, responsive design, performance | API |
| `backend-architect` | System design, API design, scalability, databases | API |
| `security-engineer` | Security auditing, threat modeling, vulnerability assessment | API |
| `product-manager` | Product strategy, user stories, roadmap, stakeholder management | API |
| `data-scientist` | Data analysis, statistical modeling, ML pipelines | API |
| `devops-engineer` | CI/CD, infrastructure, monitoring, containerization | API |
| `technical-writer` | Documentation, API docs, user guides, content strategy | API |
| `claude-code` | Software engineering, code implementation, testing, code review | Local |
| `hermes` | Autonomous research, web scraping, multi-tool investigation | Local |

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

# Performance test (baseline vs memory-enhanced)
bun performance-test.ts --url https://example.com
```

---

## Version History

| Version | Key Innovation | Status |
|---------|----------------|--------|
| **v4.2** | Local executors (Claude Code, Hermes), split concurrency, Anthropic direct API, configurable paths | ✅ Current |
| **v4.1** | DAG dependencies, NDJSON logging, doctor command, result persistence, inter-agent messaging | ✅ Current |
| **v4.0** | Hierarchical memory, token budgets, pre-warm caching, format constraints | ✅ Current |
| v3 | SQLite-backed cross-session memory, persona memory bridge | Archived |
| v2 | Exponential backoff, circuit breaker, chunked processing, priority queue | Archived |
| v1 | Basic `Promise.all` parallel execution | Archived |

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
├── AGENTS.md                         # Production lessons and patterns
├── CLAUDE.md                         # Development guide
├── scripts/
│   ├── orchestrate-v4.ts             # Main orchestrator
│   ├── token-optimizer.ts            # Token cleaning + hierarchical memory
│   ├── swarm-memory.ts               # SQLite persistence + inter-agent messaging
│   ├── swarm-config.ts               # Configuration management CLI
│   ├── swarm-status.ts               # Health/status checking
│   ├── benchmark.ts                  # Memory strategy benchmarking
│   ├── inter-agent-comms.ts          # Agent messaging demo
│   ├── performance-test.ts           # Baseline vs enhanced performance test
│   └── test-orchestrator.ts          # Test suite
├── assets/
│   ├── persona-registry.json         # 10 personas (8 API + 2 local executors)
│   └── swarm-patterns.json           # 6 pre-built analysis patterns
└── examples/
    ├── sample-tasks.json             # Simple example
    ├── test-v4-simple.json           # Basic v4 test
    ├── test-5-agents-stress.json     # 5-agent stress test
    ├── test-10-agents-stress.json    # 10-agent stress test
    ├── test-20-agents-stress.json    # 20-agent stress test
    └── ...                           # More analysis and workflow examples
```

---

## Requirements

- **Runtime:** [Bun](https://bun.sh) v1.2+
- **API backend (one of):**
  - `ANTHROPIC_API_KEY` — direct Anthropic API (preferred)
  - `ZO_CLIENT_IDENTITY_TOKEN` — Zo API (automatically available on [Zo Computer](https://zo.computer))
  - Local executors only — no API key needed if all tasks use `claude-code` or `hermes` personas

---

## License

MIT
