---
name: zo-swarm-orchestrator
description: Spawn parallel agent teams with token optimization, hierarchical memory, and resilient execution. v4 adds token-aware memory strategies to prevent context window exhaustion.
metadata:
  created: 2026-02-08
  updated: 2026-03-01
  version: 4.3.0
---
# Swarm Orchestrator Skill v4.3.0

A reusable skill that enables **any persona** to spawn parallel agent teams, delegate tasks across specialized personas, and synthesize results into coherent output.

**v4.3 "Hivemind Routing":** Semantic-aware composite routing that distributes work across all executors based on capability matching, health signals, complexity fit, and execution history. The swarm collectively learns which agent is best for each type of task.

---

## ⚡ Quick Start (Use v4)

```bash
cd Skills/zo-swarm-orchestrator/scripts

# Recommended: v4 with hierarchical memory
bun orchestrate-v4.ts examples/test-v4-simple.json --swarm-id my-project

# Cost-optimized: no memory
bun orchestrate-v4.ts tasks.json --strategy none

# Bounded context: sliding window
bun orchestrate-v4.ts tasks.json --strategy sliding --max-tokens 8000

# Health check
bun orchestrate-v4.ts doctor
```

---

## Version Status

| Version | Status | Key Innovation |
|---------|--------|----------------|
| **v4.3** | ✅ **Current** | **Hivemind Routing** — semantic synonym matching, flattened affinity matrix, adaptive executor distribution |
| v4.2 | ✅ Current | Composite router, retry-with-reroute, executor history, routing strategies |
| v4.1 | ✅ Current | DAG dependencies, NDJSON logging, inter-agent messaging |
| v4.0 | ✅ Current | Hierarchical memory, token budgets, pre-warm caching |
| v1–v3 | Archived | Superseded by v4 |

---

## Version 4 - Token-Optimized Hierarchical Memory

Building on v3's persistent memory, **v4 introduces intelligent memory strategies** that automatically manage token budgets to prevent the context window exhaustion that caused v1 failures.

### The Problem v4 Solves

From February 2026 production failures:
- **Context window exhaustion**: 5 agents × 256k tokens = system failure
- **Unbounded memory growth**: Sequential memory grows forever
- **No token budgeting**: No visibility into prompt token usage

### What v4 Adds

| Feature | Implementation | Benefit |
|---------|----------------|---------|
| **Token cleaning** | HTML stripping, deduplication, normalization | ~10-15% token reduction |
| **Hierarchical memory** | Working memory + long-term memory retrieval | Bounded context, relevant history |
| **Sliding window** | Fixed-size recent context window | Predictable token usage |
| **Token budgets** | Configurable max tokens per context | Never exceed context limits |
| **Strategy selection** | Choose memory strategy per task | Optimize for cost vs. context |

---

## Memory Strategies

### Comparison

| Strategy | Token Efficiency | Context Quality | Best For |
|----------|------------------|-----------------|----------|
| `none` | ⭐⭐⭐⭐⭐ | ⭐☆☆☆☆ | Independent tasks, cost-sensitive |
| `sliding` | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | Recent context matters |
| `hierarchical` | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐⭐ | Complex multi-step workflows |
| `sequential` | ⭐☆☆☆☆ | ⭐⭐⭐⭐⭐ | Debugging, small swarms only |

### Benchmark Results

```
Strategy       Avg Prompt    Memory    Token
               Tokens        Items     Savings
───────────────────────────────────────────────
none           26            0         -93%
sliding        356           3         -8%
hierarchical   416           4         -8%
sequential     386           5         0%
```

---

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--swarm-id <id>` | Unique swarm identifier | auto-generated |
| `--strategy <type>` | Memory strategy | hierarchical |
| `--max-tokens <n>` | Token budget for context | 8000 |
| `--concurrency <n>` | Max parallel API agents | 5 |
| `--local-concurrency <n>` | Max parallel local executors | 4 |
| `--timeout <seconds>` | Per-task timeout | 300 |
| `--model <name>` | Model name for API calls | from env |
| `--dag-mode <mode>` | `streaming` or `waves` | streaming |
| `--routing-strategy <s>` | `fast`, `reliable`, `balanced`, or `explore` | balanced |
| `--no-memory` | Disable all memory | false |

---

## Task File Format (v4)

```json
[
  {
    "id": "task-1",
    "persona": "frontend-developer",
    "task": "Analyze UI/UX for accessibility issues",
    "priority": "high",
    "memoryStrategy": "hierarchical",
    "outputToMemory": true,
    "memoryMetadata": {
      "category": "ui-analysis",
      "priority": "high",
      "tags": ["accessibility", "responsive"]
    }
  }
]
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `orchestrate-v4.ts` | Main orchestrator |
| `token-optimizer.ts` | Token cleaning + hierarchical memory |
| `swarm-memory.ts` | SQLite persistence + inter-agent messaging |
| `swarm-config.ts` | Configuration management CLI |
| `benchmark.ts` | Memory strategy benchmarking |
| `test-orchestrator.ts` | Test suite |
| `performance-test.ts` | Baseline vs enhanced performance test |

---

## Local Executors

Tasks assigned to `claude-code`, `hermes`, `gemini`, or `codex` personas are routed to **local executor bridges** instead of the API. The bridge scripts, registry, and tooling live in the companion skill [`zo-swarm-executors`](../zo-swarm-executors/):

| Executor | Bridge | Speed | Strengths |
|----------|--------|-------|-----------|
| `claude-code` | `claude-code-bridge.sh` | ~25-120s | Complex multi-file changes, codebase-aware analysis, git operations |
| `hermes` | `hermes-bridge.sh` | ~15-60s | Web research, security audits, multi-tool investigation, data gathering |
| `gemini` | `gemini-bridge.sh` | ~2-12s (daemon) | Large-context analysis (1M+ tokens), multimodal, cross-validation |
| `codex` | `codex-bridge.sh` | ~3s | Fast code generation, shell commands, rapid prototyping |

```
Skills/zo-swarm-executors/
├── bridges/          # claude-code, hermes, gemini, codex bridge scripts
├── registry/         # executor-registry.json
├── scripts/          # doctor.ts, register.ts, test-harness.ts, gemini-daemon.ts
└── docs/             # BRIDGE_PROTOCOL.md, identity references
```

The orchestrator discovers executors automatically via `persona-registry.json` (entries with `"executor": "local"`). Override the executor registry path with `SWARM_EXECUTOR_REGISTRY`.

See [`zo-swarm-executors/README.md`](../zo-swarm-executors/README.md) for bridge protocol, adding custom executors, and health checks.

---

## Utilities

```bash
# Benchmark all memory strategies
bun benchmark.ts

# Test orchestrator
bun test-orchestrator.ts

# Memory management
bun swarm-memory.ts stats
bun swarm-memory.ts list-sessions
bun swarm-memory.ts cleanup 30
```

---

## Configuration

You can configure the orchestrator using **either** a config file **or** environment variables.

### Option 1: Config File (Recommended)

Create `config.json` in the skill root:

```json
{
  "maxConcurrency": 5,
  "localConcurrency": 4,
  "timeoutSeconds": 300,
  "maxRetries": 3,
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

**Priority:** CLI flags > Config file > Environment variables > Defaults

### Option 2: Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (preferred) | — |
| `ZO_CLIENT_IDENTITY_TOKEN` | Zo API auth (fallback) | — |
| `SWARM_WORKSPACE` | Root for deployment resources | `/home/workspace` |
| `SWARM_MAX_CONCURRENCY` | Max parallel API agents | 2 |
| `SWARM_LOCAL_CONCURRENCY` | Max parallel local executors | 4 |
| `SWARM_TIMEOUT_SECONDS` | Per-task timeout | 300 |
| `SWARM_MAX_RETRIES` | Retry attempts | 3 |
| `SWARM_IDENTITY_DIR` | Persona identity files directory | `$SWARM_WORKSPACE/IDENTITY` |
| `SWARM_SOUL_FILE` | Path to constitution file | `$SWARM_WORKSPACE/SOUL.md` |
| `SWARM_PERSONA_MEMORY_DIR` | Persona-specific memory files | `$SWARM_WORKSPACE/.zo/memory/personas` |
| `SWARM_MEMORY_SCRIPT` | Memory search script path | `$SWARM_WORKSPACE/.zo/memory/scripts/memory.ts` |
| `SWARM_AGENT_REGISTRY` | Persona registry JSON path | `$SWARM_WORKSPACE/agency-agents-personas.json` |
| `SWARM_EXECUTOR_REGISTRY` | Local executor registry JSON path | `Skills/zo-swarm-executors/registry/executor-registry.json` |

---

## Roadmap

Planned optimizations from production profiling (see README.md for full details):

| Phase | Optimizations | Expected Savings |
|-------|--------------|------------------|
| **Phase 1** — Quick Wins | O3: Pre-warm cache TTL, O4: Prompt format constraints, O6: Circuit breaker tuning | 5-13% |
| **Phase 2** — Execution Engine | O2: DAG streaming improvements, O1: Request batching | +13-30% |
| **Phase 3** — Refinements | O5: Early filtering, O7: Output deduplication, O8: Concurrent caching | +2-5% |

---

## References

- Prompt-Refiner: https://github.com/JacobHuang91/prompt-refiner
- Agent-Memory-Playground: https://github.com/AIAnytime/Agent-Memory-Playground
