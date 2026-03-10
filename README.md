# Zo Swarm Orchestrator

> Coordinate multiple AI agents in parallel on [Zo Computer](https://zo.computer). Define tasks, declare dependencies, and let the orchestrator route work to the right agent with automatic memory management, retries, and structured logging.

[![Version](https://img.shields.io/badge/version-4.7.0_Tiered_Model_Routing-blue?style=flat-square)](https://github.com/marlandoj/zo-swarm-orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What This Is

This skill turns a list of tasks into a coordinated multi-agent workflow:

- **DAG Task Dependencies** -- Tasks declare what they depend on. The orchestrator builds a graph and runs tasks as soon as their dependencies complete
- **Local-Only Execution** -- All tasks route through local executor bridges (Claude Code, Hermes, Gemini, Codex) via [zo-swarm-executors](https://github.com/marlandoj/zo-swarm-executors). No API calls, no API credentials needed
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

The orchestrator uses **tiered OmniRoute combos** to match model cost to task complexity. Instead of sending every task to the same expensive model, it auto-selects a budget-appropriate combo based on the task's complexity score.

### How it works

Each task is scored on 5 signals (word count, file references, multi-step instructions, tool usage, analysis keywords) to produce a complexity tier. The tier maps to an OmniRoute combo:

| Complexity | Combo | Models (priority failover) |
|------------|-------|---------------------------|
| **trivial** | `swarm-light` | Gemini Flash → Haiku → DeepSeek → free tier |
| **simple** | `swarm-light` | *(same as above)* |
| **moderate** | `swarm-mid` | Sonnet → Gemini Pro → GPT-4.1 |
| **complex** | `swarm-heavy` | Opus → Sonnet → Gemini Pro → Codex |

Each combo is a priority failover chain — if the first provider is down or rate-limited, OmniRoute automatically tries the next one.

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

**Hierarchical memory** splits context into working memory (2 recent items) and long-term memory (3 retrieved items). Token cleaning (HTML stripping, deduplication) reduces prompt size by 10-15%.

```bash
# Use hierarchical memory with 8K token budget
bun orchestrate-v4.ts tasks.json --strategy hierarchical --max-tokens 8000

# No memory overhead
bun orchestrate-v4.ts tasks.json --strategy none
```

Or via Zo chat:

```
Run my swarm tasks with no memory to minimize costs.
Run my swarm tasks with hierarchical memory and an 8000 token budget.
```

---

## Pre-built Swarm Patterns

Six ready-to-use analysis patterns:

| Pattern | Personas | Purpose |
|---------|----------|---------|
| website-review | frontend, security, backend | Multi-angle website audit |
| codebase-review | backend, security, devops | Code quality and architecture |
| product-launch | product, frontend, writer | Pre-launch readiness check |
| deep-research | analyst, data scientist, PM, writer | Multi-perspective research |
| incident-postmortem | devops, security, backend | Root cause analysis |
| validation-swarm | analyst, data scientist, backend | Consensus validation |

Use them via Zo chat:

```
Run a website-review swarm pattern against my verdant-goods-store project.
Run an incident-postmortem for the outage we had yesterday.
```

Or from the terminal:

```bash
bun orchestrate-v4.ts assets/swarm-patterns.json --pattern website-review --swarm-id my-review
```

---

## Implementation Examples

### Example 1: Quick site audit (Zo chat)

```
Review the Fauna & Flora website. Have a security engineer check the code,
a frontend developer review accessibility, and a writer create a summary report.
Save the report to Reports/vgc-audit.md.
```

### Example 2: Research team (Zo chat)

```
I need competitive research on AI agent platforms.
Set up a swarm with a research analyst, a data scientist, and a product manager.
The analyst gathers data, the data scientist validates claims, and the PM writes the brief.
```

### Example 3: Code review with local executors (terminal)

```bash
# Create task file
cat > tasks/code-review.json << 'EOF'
[
  {"id": "security", "persona": "claude-code", "task": "Security audit of src/"},
  {"id": "architecture", "persona": "gemini", "task": "Architecture review of the codebase"},
  {"id": "report", "persona": "codex", "task": "Generate a summary of findings", "dependsOn": ["security", "architecture"]}
]
EOF

# Run it
cd Skills/zo-swarm-orchestrator/scripts
bun orchestrate-v4.ts ../tasks/code-review.json --swarm-id code-review
```

### Example 4: Full DAG with memory (terminal)

```bash
bun orchestrate-v4.ts tasks/full-review.json \
  --swarm-id vgc-sprint-4 \
  --strategy hierarchical \
  --max-tokens 8000 \
  --routing-strategy reliable \
  --dag-mode streaming
```

---

## CLI Reference

```bash
bun orchestrate-v4.ts <tasks.json> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--swarm-id <id>` | Unique identifier for this run | auto-generated |
| `--strategy <type>` | Memory: none, sliding, hierarchical, sequential | hierarchical |
| `--max-tokens <n>` | Token budget for context | 8000 |
| `--concurrency <n>` | Max parallel local executors | 4 |
| `--timeout <seconds>` | Per-task timeout | 300 |
| `--dag-mode <mode>` | streaming (immediate) or waves (level-by-level) | streaming |
| `--routing-strategy <s>` | fast, reliable, balanced, explore | balanced |
| `--no-memory` | Disable all memory | false |
| `--notify <channel>` | Send completion notification: sms or email | none (file always written) |
| `doctor` | Health check (memory DB, config, executors) | -- |

---

## Configuration

Three layers with clear precedence: **CLI flags** > **config.json** > **Environment variables** > **Defaults**

### config.json

```json
{
  "localConcurrency": 4,
  "timeoutSeconds": 300,
  "maxRetries": 3,
  "memory": {
    "enable": true,
    "workingMemorySize": 2,
    "longTermMemorySize": 3,
    "maxTokens": 8000
  }
}
```

### Key Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SWARM_LOCAL_CONCURRENCY` | Max concurrent local executors | `4` |
| `SWARM_WORKSPACE` | Root for IDENTITY, SOUL.md, memory | `/home/workspace` |
| `SWARM_EXECUTOR_REGISTRY` | Path to executor registry | `Skills/zo-swarm-executors/registry/executor-registry.json` |

Full list in [`SKILL.md`](SKILL.md).

---

## Repository Structure

```
zo-swarm-orchestrator/
├── SKILL.md                          # Full documentation (v4.5)
├── README.md                         # This file
├── config.json                       # Runtime configuration
├── AGENTS.md                         # Production lessons and patterns
├── scripts/
│   ├── orchestrate-v4.ts             # Main orchestrator (v4.5, 6-signal routing)
│   ├── token-optimizer.ts            # Token cleaning + hierarchical memory
│   ├── swarm-memory.ts               # SQLite persistence + inter-agent messaging
│   ├── swarm-config.ts               # Configuration management CLI
│   ├── inter-agent-comms.ts          # Inter-agent communication system
│   ├── benchmark.ts                  # Memory strategy benchmarking
│   ├── performance-test.ts           # Baseline vs enhanced performance test
│   └── test-orchestrator.ts          # Test suite
├── assets/
│   ├── persona-registry.json         # Persona metadata
│   └── swarm-patterns.json           # 6 pre-built analysis patterns
└── examples/
    ├── sample-tasks.json             # Simple example
    ├── test-v4-simple.json           # Basic v4 test
    └── ...                           # Stress tests and workflow examples
```

---

## Related Skills

- [zo-swarm-executors](https://github.com/marlandoj/zo-swarm-executors) -- Bridge scripts and registry for local executors
- [zo-memory-system](https://github.com/marlandoj/zo-memory-system) -- Shared memory that all personas read and write
- [zo-persona-creator](https://github.com/marlandoj/zo-persona-creator) -- Create new personas to add to your swarm

---

## Requirements

- **Runtime:** [Bun](https://bun.sh) v1.2+
- **Local executors:** [zo-swarm-executors](https://github.com/marlandoj/zo-swarm-executors) — all tasks route through local executor bridges

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-improvement`)
3. Commit your changes
4. Push to the branch (`git push origin feature/my-improvement`)
5. Open a Pull Request

---

## License

MIT License -- Use freely, commercially or personally.
