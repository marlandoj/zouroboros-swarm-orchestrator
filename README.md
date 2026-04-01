> **⚠️ DEPRECATED** — This repository has been archived. All code has been migrated to the [Zouroboros monorepo](https://github.com/marlandoj/Zouroboros) under `packages/swarm/`. Please open issues and PRs there.

---

# Zouroboros Swarm Orchestrator

> Coordinate multiple AI agents in parallel on [Zo Computer](https://zo.computer). Define tasks, declare dependencies, and let the orchestrator route work to the right agent with automatic memory management, retries, and structured logging.
>
> Part of the [Zouroboros](https://github.com/marlandoj/zouroboros) ecosystem — self-improving AI development tools for Zo Computer.

[![Version](https://img.shields.io/badge/version-4.9.0_Dynamic_OmniRoute_Resolution-blue?style=flat-square)](https://github.com/marlandoj/zouroboros-swarm-orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What This Is

This skill turns a list of tasks into a coordinated multi-agent workflow:

- **DAG Task Dependencies** -- Tasks declare what they depend on. The orchestrator builds a graph and runs tasks as soon as their dependencies complete
- **Local-Only Execution** -- All tasks route through local executor bridges (Claude Code, Hermes, Gemini, Codex) via [zouroboros-swarm-executors](https://github.com/marlandoj/zouroboros-swarm-executors). No API calls, no API credentials needed
- **6-Signal Routing** -- Scores executors on capability, health, complexity fit, past performance, procedural learning, and episodic performance to pick the best agent for each task
- **Auto-Episodes** -- Every swarm run creates a memory episode with outcome, duration, executor list, and task results for querying later
- **Token-Aware Memory** -- Four memory strategies (none, sliding, hierarchical, sequential) prevent context window exhaustion
- **Resilience** -- Exponential backoff, per-persona circuit breakers, retry-with-reroute, and deadlock detection
- **Structured Logging** -- Every event (start, complete, retry, failure) as a parseable NDJSON line

---

## Quick Start

There are two ways to use this skill: through the **Zo chat window** (natural language) or the **terminal** (CLI scripts).

### Option 1: Natural Language via Zo Chat

The fastest way. Open your Zo chat window and describe what you want:

```
Run a swarm to review my e-commerce website at verdant-goods-store.
Have a security engineer audit the code, a frontend developer review the UX,
and a product manager synthesize the findings into a report.
```

Zo will create the task file, set up dependencies, pick the right executors, and run the swarm. You can also say things like:

- *"Run a security audit swarm on my project using Claude Code and Hermes"*
- *"Create a research swarm with 3 analysts to investigate competitor pricing"*
- *"Run the task file at Skills/zo-swarm-orchestrator/examples/sample-tasks.json"*
- *"Check the health of my swarm setup"*
- *"Show me the results from the last swarm run"*
- *"Run a swarm benchmark to compare memory strategies"*

Zo handles task creation, executor routing, and result collection automatically.

### Option 2: Terminal (CLI Scripts)

#### Run a swarm

```bash
cd Skills/zo-swarm-orchestrator/scripts

# Run with hierarchical memory (recommended)
bun orchestrate-v4.ts examples/sample-tasks.json --swarm-id my-project

# Run without memory (cost-optimized)
bun orchestrate-v4.ts examples/sample-tasks.json --strategy none

# Health check
bun orchestrate-v4.ts doctor
```

#### Create a task file

Create a JSON array of tasks. Each task can declare dependencies on other tasks:

```json
[
  {
    "id": "plan",
    "persona": "research-analyst",
    "task": "Create an analysis plan for the target website",
    "priority": "critical"
  },
  {
    "id": "security",
    "persona": "claude-code",
    "task": "Audit the codebase for security vulnerabilities",
    "dependsOn": ["plan"]
  },
  {
    "id": "ux-review",
    "persona": "frontend-developer",
    "task": "Review the site's UX and accessibility",
    "dependsOn": ["plan"]
  },
  {
    "id": "report",
    "persona": "technical-writer",
    "task": "Synthesize all findings into a prioritized report",
    "dependsOn": ["security", "ux-review"]
  }
]
```

This creates a DAG: `plan` runs first, then `security` and `ux-review` run in parallel, then `report` runs after both finish.

---

## How Routing Works

The orchestrator picks which agent handles each task. All tasks route through local executor bridges — every task persona must have a matching executor in the registry.

### Available Executors

| Executor | Speed | Good at |
|----------|-------|---------|
| Claude Code | ~25-120s | Complex multi-file changes, codebase analysis, git operations |
| Hermes | ~15-60s | Web research, security audits, data gathering |
| Gemini | ~2-12s (daemon) | Large-context analysis (1M+ tokens), multimodal tasks |
| Codex | ~3s | Fast code generation, shell commands, rapid prototyping |

### 6-Signal Routing (v4.5)

When multiple executors could handle a task, the orchestrator scores them on six signals:

1. **Capability match** -- Does the executor's expertise match the task keywords?
2. **Health** -- Is the executor responding? What's its error rate?
3. **Complexity fit** -- Simple tasks go to fast executors, deep analysis goes to thorough ones
4. **Execution history** -- How well did this executor handle similar tasks before?
5. **Procedure** -- Learned workflow preference from procedural memory (±0.05)
6. **Temporal** -- Recent episodic performance bonus/penalty (±0.025)

The routing improves with use. After a few runs, tasks flow to whichever executor handles them best.

#### Routing presets

| Preset | Best for |
|--------|----------|
| `balanced` (default) | Equal consideration of all signals |
| `fast` | Speed-optimized, prefer simple executors |
| `reliable` | Maximize uptime, penalize unhealthy executors |
| `explore` | Favor executors with proven track records |

```bash
bun orchestrate-v4.ts tasks.json --routing-strategy reliable
```

---

## Model Routing via OmniRoute

> Powered by [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — a unified AI proxy/router for multi-provider LLM aggregation.

The orchestrator uses **dynamic OmniRoute resolution** via `tier-resolve-v2.ts` to match model cost to task complexity. Instead of sending every task to the same expensive model, it analyzes the prompt with a 9-signal complexity estimator and selects the optimal OmniRoute combo.

### How it works

Every task prompt is analyzed by the tier-resolve engine, which produces a complexity score from 9 calibrated weighted signals:

| Signal | Weight | What it measures |
|--------|--------|-----------------|
| **conceptCount** | 0.20 | Distinct technical concepts referenced |
| **featureListCount** | 0.20 | Enumerated requirements or features |
| **scopeBreadth** | 0.12 | Cross-system or cross-file scope |
| **multiStep** | 0.10 | Sequential instruction chains (then/after/next) |
| **taskVerbComplexity** | 0.10 | Verb sophistication (fix vs. architect vs. redesign) |
| **analysisDepth** | 0.08 | Depth of reasoning required |
| **wordCount** | 0.04 | Raw prompt length |
| **toolUsage** | 0.04 | Tool invocations implied |
| **fileRefs** | 0.02 | File paths or code references |

On top of the base signals, the engine applies:

- **Domain detection** -- 22 tech patterns (react, docker, kubernetes, oauth, jwt, security, etc.) that adjust complexity
- **Heuristic boosters** -- Codebase-wide refactor (+0.25), cross-system audit (+0.20), ML deployment (+0.15), production-ready (+0.10)
- **Task-type complexity floors** -- Security, devops, data_science, and analysis tasks are floored at `moderate`; debugging and planning at `simple`
- **Semantic task classification** -- 11 task types (coding, review, planning, analysis, debugging, documentation, general, data_science, devops, security, content) via keyword/synonym/contextual matching
- **Feedback loop** -- Auto-tuned weights from `data/weights.json` based on past resolution accuracy

The complexity score maps to a tier, which resolves to an OmniRoute combo:

| Complexity | Combo | Models (priority failover) |
|------------|-------|---------------------------|
| **trivial** | `swarm-light` | Gemini Flash → Haiku → DeepSeek → free tier |
| **simple** | `swarm-light` | *(same as above)* |
| **moderate** | `swarm-mid` | Sonnet → Gemini Pro → GPT-4.1 |
| **complex** | `swarm-heavy` | Opus → Sonnet → Gemini Pro → Codex |

If OmniRoute is reachable, `bestComboForTask()` queries available combos and scores them for the specific task type and tier — potentially selecting a combo outside the static mapping if it scores higher. Each combo is a priority failover chain.

### Resolution in bridge scripts

All four executor bridges (Claude Code, Codex, Gemini, Hermes) invoke the tier-resolve engine independently with a 15-second timeout. The resolution chain per bridge:

1. **OmniRoute dynamic** -- `tier-resolve.ts --omniroute "$PROMPT" --json` selects the optimal combo
2. **Environment override** -- `SWARM_RESOLVED_MODEL` (set by orchestrator per task)
3. **Static tier mapping** -- Swarm tier names mapped to executor-native models
4. **CLI default** -- Executor's built-in default model

Per-tier timeouts are applied after resolution:

| Tier | Timeout |
|------|---------|
| trivial / swarm-light | 120s |
| simple / moderate / swarm-mid | 300s |
| complex / swarm-heavy | 600s |

### Per-task model override

Any task can pin itself to a specific combo or model alias, bypassing the automatic tier:

```json
{
  "id": "critical-review",
  "persona": "auto",
  "task": "Deep security audit of the authentication system",
  "priority": "critical",
  "model": "swarm-heavy"
}
```

The `model` field accepts any OmniRoute combo name (`swarm-light`, `swarm-mid`, `swarm-heavy`) or a direct model alias (`cc/claude-sonnet-4-5-20250929`).

### OmniRoute as last-resort fallback

When all local executors fail (circuit breakers open, timeouts, crashes), the orchestrator falls back to OmniRoute's HTTP API as a final attempt before marking the task as failed. The fallback uses the same tier-resolved model — a trivial task won't suddenly burn Opus tokens just because the local bridge crashed.

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SWARM_OMNIROUTE_ENABLED` | Enable OmniRoute integration | `true` |
| `SWARM_OMNIROUTE_URL` | OmniRoute chat completions endpoint | `http://localhost:20128/v1/chat/completions` |
| `SWARM_OMNIROUTE_MODEL` | Global fallback combo (when no tier resolves) | `swarm-failover` |
| `SWARM_OMNIROUTE_API_KEY` | API key for OmniRoute | reads from `OmniRoute/.env` |

---

## Memory Strategies

Each strategy trades token cost against context quality:

| Strategy | Best for |
|----------|----------|
| `none` | Independent tasks, cost-sensitive runs |
| `sliding` | Recent context matters, fixed window |
| `hierarchical` (default) | Complex multi-step workflows |
| `sequential` | Debugging, small swarms only |

**Hierarchical memory** splits context into working memory (2 recent items) and long-term memory (3 retrieved items). Token cleaning (HTML stripping, deduplication) reduces prompt size by 10-15