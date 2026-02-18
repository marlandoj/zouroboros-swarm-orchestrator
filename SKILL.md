---
name: zo-swarm-orchestrator
description: Spawn parallel agent teams with token optimization, hierarchical memory, and resilient execution. v4 adds token-aware memory strategies to prevent context window exhaustion.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  created: 2026-02-08
  updated: 2026-02-18
  version: 4.0.0
---
# Swarm Orchestrator Skill v4.0.0

A reusable skill that enables **any persona** to spawn parallel agent teams, delegate tasks across specialized personas, and synthesize results into coherent output.

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
```

---

## Version Status

| Version | Status | Use When | Migration Path |
|---------|--------|----------|----------------|
| **v4** | ✅ **Current** | All new work | Use this |
| v3 | 🔄 Legacy (stable) | Fallback if v4 issues | Same CLI, task files compatible |
| v2 | 🔄 Legacy (stable) | Minimal/no memory needed | Same CLI, task files compatible |
| v1 | ❌ Deprecated | - | Upgrade to v2+ |

**Note:** v2 and v3 are kept as stable fallbacks for production safety. They are NOT actively developed but remain functional.

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

## CLI Options (v4)

| Option | Description | Default |
|--------|-------------|---------|
| `--swarm-id <id>` | Unique swarm identifier | auto-generated |
| `--strategy <type>` | Memory strategy | hierarchical |
| `--max-tokens <n>` | Token budget for context | 8000 |
| `--concurrency <n>` | Parallel agents | 2 |
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

## Legacy Versions (v2/v3)

v2 and v3 remain in the repository as **stable fallbacks** for production safety.

### When to Use Fallbacks

| Scenario | Use Version | Reason |
|----------|-------------|--------|
| v4 fails unexpectedly | v3 | Known-working memory system |
| Memory system issues | v2 | No memory dependencies |
| Debugging complex failure | v2 | Simplest execution path |
| Token budget not a concern | v3 | Full persistent memory |

### Fallback Commands

```bash
# v3 fallback (persistent memory, no token optimization)
bun orchestrate-v3.ts tasks.json --swarm-id my-project

# v2 fallback (minimal, no memory)
bun orchestrate-v2.ts tasks.json
```

### Deprecation Timeline

- **Now (v4.0.0):** v4 is current; v2/v3 remain as fallbacks
- **6 months:** If v4 proves stable in production, v2/v3 may be archived
- **12 months:** v2/v3 potentially removed; v4 fully mature

---

## Files Reference

| File | Purpose | Status |
|------|---------|--------|
| `orchestrate-v4.ts` | Token-optimized orchestrator | ✅ **Use this** |
| `orchestrate-v3.ts` | Persistent memory (legacy) | 🔄 Fallback |
| `orchestrate-v2.ts` | Resilient execution (legacy) | 🔄 Fallback |
| `token-optimizer.ts` | Token cleaning pipeline | v4 only |
| `benchmark.ts` | Memory strategy comparison | v4 only |
| `test-orchestrator.ts` | Test suite | All versions |
| `swarm-memory.ts` | SQLite memory module | v3/v4 |

---

## Utilities

```bash
# Benchmark all memory strategies
bun benchmark.ts

# Test all orchestrator versions
bun test-orchestrator.ts

# Memory management
bun swarm-memory.ts stats
bun swarm-memory.ts list-sessions
bun swarm-memory.ts cleanup 30
```

---

## Migration Guide

### From v3 to v4

**No changes required** - existing tasks work unchanged.
To use new features, optionally add:

```json
{
  "memoryStrategy": "hierarchical",
  "outputToMemory": true
}
```

### From v2 to v4

Replace command:
```bash
# Old
bun orchestrate-v2.ts tasks.json

# New
bun orchestrate-v4.ts tasks.json
```

Add memory fields if using context sharing (optional).

---

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SWARM_MAX_CONCURRENCY` | Max parallel agents | 2 |
| `SWARM_TIMEOUT_SECONDS` | Timeout per agent | 300 |
| `SWARM_MAX_RETRIES` | Retry attempts | 3 |
| `ZO_CLIENT_IDENTITY_TOKEN` | Required API auth | - |

---

## References

- Prompt-Refiner: https://github.com/JacobHuang91/prompt-refiner
- Agent-Memory-Playground: https://github.com/AIAnytime/Agent-Memory-Playground
- Failure analysis: `file '/home/.z/workspaces/con_S8zYiOhjCgjFbcpi/swarm-analysis/SWARM_FAILURE_ANALYSIS.md'`

---

*For detailed improvements summary: `file 'Documents/swarm-improvements-summary.md'`*
