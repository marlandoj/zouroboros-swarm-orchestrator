---
name: zo-swarm-orchestrator
description: Spawn parallel agent teams, delegate tasks across multiple personas, and synthesize results. Enables any persona to utilize a multi-agent swarm for complex analysis, research, and decision-making tasks.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  created: 2026-02-08
  version: 3.0.0
---
# Swarm Orchestrator Skill

A reusable skill that enables **any persona** to spawn parallel agent teams, delegate tasks across specialized personas, and synthesize results into coherent output.

## Version 2 - Resilient Orchestration

### What We Learned from Failures

During production use (Feb 2026), we identified several critical issues with the v1 orchestrator:

| Issue | Root Cause | Impact |
| --- | --- | --- |
| API timeouts | 120s timeout insufficient for complex analysis | Agents failed mid-task |
| Rate limiting | Concurrent API calls from same session | 429 errors, dropped tasks |
| No retry logic | Single point of failure | Complete swarm failure on one agent error |
| Memory pressure | 5 concurrent agents × 256k context | Context window exhaustion |
| No circuit breaker | Cascading failures | All agents fail if API degrades |

### Key Improvements in v2

```markdown
v1 Architecture                    v2 Architecture
─────────────────                  ─────────────────
Parallel (5 agents)    →          Chunked (2 agents)
120s timeout           →          300s timeout  
No retry               →          3 retries with backoff
No circuit breaker     →          Per-persona circuit breaker
Unlimited context      →          Concise prompt engineering
Fire-and-forget        →          Progress tracking + logging
```

**New Features:**

- **Sequential chunked processing** - Process 2 agents at a time to control resource usage
- **Exponential backoff retry** - Automatic retry with 2s, 4s, 8s delays
- **Circuit breaker pattern** - Skip failing personas after 2 consecutive failures
- **Priority-based execution** - Critical tasks run first
- **Detailed logging** - Track duration, retries, and failure reasons
- **JSON task files** - Structured input validation

### When to Use v1 vs v2

| Scenario | Recommended Version |
| --- | --- |
| Quick 2-3 agent analysis | v1 (faster) |
| Production critical tasks | v2 (reliable) |
| 5+ agents | v2 (chunked) |
| Complex multi-step reasoning | v2 (timeout + retry) |
| Development/testing | v1 (simpler) |

### Quick Migration Guide

**v1 command:**

```bash
bun orchestrate.ts "Analyze website" \
  --personas "frontend,backend,security"
```

**v2 equivalent:**

```bash
# Create task file
cat > tasks.json << 'EOF'
[
  {"id": "frontend", "persona": "frontend-developer", "task": "Analyze website UI/UX", "priority": "high"},
  {"id": "backend", "persona": "backend-architect", "task": "Review API design", "priority": "high"},
  {"id": "security", "persona": "security-engineer", "task": "Security audit", "priority": "critical"}
]
EOF

# Run v2 orchestrator
bun orchestrate-v2.ts tasks.json
```

---

## Version 3 - Persistent Swarm Memory

Building on v2's reliability, v3 introduces **persistent cross-session memory** that enables swarms to learn and build upon previous analyses.

### Key Capabilities

| Feature | Description | Use Case |
|---------|-------------|----------|
| **Context Persistence** | SQLite-backed storage of swarm outputs | Resume analysis days later |
| **Cross-Agent Memory** | Agents read context from previous agents | Build cumulative knowledge |
| **Session Resumption** | Reconnect to active or completed swarms | Continue interrupted work |
| **Selective Context** | Query by tags, categories, or time | Inject only relevant history |
| **Memory Lifecycle** | Read, write, append modes per task | Control information flow |

### v2 vs v3 Comparison

```markdown
v2 (Stateless)                     v3 (Persistent)
─────────────────                  ─────────────────
Each swarm isolated    →          Context shared across sessions
No memory between runs →          SQLite-backed persistence
Full context in prompt →          Query relevant history only
Restart from scratch   →          Resume and build upon prior work
```

### Memory Modes

| Mode | Description | When to Use |
|------|-------------|-------------|
| `none` | No memory access | Independent analysis |
| `read` | Injects relevant prior context | Build on previous findings |
| `write` | Saves output for future use | Create reusable knowledge |
| `append` | Extends existing context | Progressive refinement |

### Persona Memory Bridge (Zo Persona Memory System)

v3 can also integrate with Zo’s **persona memory system** (file-based persona briefs + shared SQLite facts) so that swarm tasks automatically inherit durable preferences/constraints, and swarms can optionally “promote” stable conclusions into long-term memory.

#### What gets injected into each agent prompt

When enabled (default), the orchestrator prepends a **Persona Memory Brief** before the usual swarm context:

1) **Persona memory file excerpt** (first ~30 lines)
- Path: `.zo/memory/personas/<persona-slug>.md`
- The persona name is slugified (lowercase, spaces → hyphens) to find the right file.

2) **Shared persona memory facts (SQLite)**
- Source: `.zo/memory/shared-facts.db`
- The orchestrator runs a small keyword-based search over the task text and injects 1–2 top matches.

This keeps prompts grounded in *who the persona is* and *how you prefer work to be done*, while swarm context remains focused on *project/session artifacts*.

#### Promoting swarm output into persona memory (optional)

Two optional task fields enable promotion:

- `promoteToPersonaMemory` (boolean)
- `promotionMetadata` (object)
  - `entity` (string, default: `decision`)
  - `category` (string, default: `decision`)
  - `decay` (string, default: `stable`)

If `promoteToPersonaMemory: true` **and** `outputToMemory: true`, the agent is instructed to include a section in its output:

```markdown
PROMOTABLE FACTS
- <bullet 1>
- <bullet 2>
- <bullet 3>
```

The orchestrator parses the bullet list and stores each bullet into Zo persona memory via:

```bash
bun .zo/memory/scripts/memory.ts store \
  --persona shared \
  --entity <entity> \
  --value "<bullet>" \
  --category <category> \
  --decay <decay> \
  --source swarm-promoted
```

**Failure-safe behavior:** if persona memory files are missing, or the DB write fails, orchestration continues (promotion is best-effort).

#### Recommended workflow (using both memory systems)

- Use **persona memory** for durable constraints (brand voice, compliance rules, user preferences, business policies).
- Use **swarm memory** for project artifacts (research notes, intermediate conclusions, QA results).
- Enable promotion only for conclusions you want to become durable “rules of thumb”.
- Periodically prune/decay persona memory (handled by your scheduled maintenance agent).

```bash
bun orchestrate-v3.ts examples/v3-persona-memory-bridge.json --swarm-id persona-bridge-demo
```

### Example: Multi-Session Research

**Session 1 - Initial Research:**
```bash
bun orchestrate-v3.ts examples/v3-memory-tasks.json --swarm-id ai-market-analysis
```

**Session 2 - Follow-up (days later):**
```bash
bun orchestrate-v3.ts examples/v3-follow-up-tasks.json --swarm-id ai-market-analysis
```

The second session automatically retrieves and builds upon findings from the first session.

---

## Quick Start

### Option 1: v2 Command Line (Recommended)

```bash
cd Skills/zo-swarm-orchestrator/scripts

# Run with task file
bun orchestrate-v2.ts examples/sample-tasks.json

# Run with custom output directory
bun orchestrate-v2.ts my-tasks.json ./results
```

### Option 2: v1 Command Line (Simple cases)

```bash
cd Skills/zo-swarm-orchestrator/scripts

# Single-query swarm
bun orchestrate.ts "Research AI investment opportunities" financial-advisor,research-analyst
```

### Option 3: From Any Persona Conversation

> "Use the swarm to analyze this from multiple angles: financial, market, and risk"

---

## Core Capabilities

### 1. Parallel Task Execution (v1)

Spawn multiple agents simultaneously:

```bash
bun orchestrate.ts "Tesla stock analysis" \
  --personas "financial-advisor,technical-analyst,news-monitor"
```

### 2. Resilient Chunked Execution (v2)

Process agents in controlled chunks with full reliability:

```bash
bun orchestrate-v2.ts tasks.json
```

**Benefits:**

- No timeout failures
- Automatic retry on transient errors
- Circuit breaker prevents cascading failures
- Detailed execution logs

### 3. Inter-Agent Communication (v1)

Enable real-time collaboration between swarm agents:

```bash
bun orchestrate-with-comms.ts "Tesla analysis" \
  --personas "financial,research,risk" \
  --collaboration-rounds 3
```

---

## Troubleshooting

### Common Failure Modes & Solutions

| Symptom | Likely Cause | Solution |
| --- | --- | --- |
| `Read timed out` | Task too complex for 120s | Use v2 with 300s timeout |
| `429 Too Many Requests` | Rate limiting | Use v2 chunked processing (max 2 concurrent) |
| Agent returns empty | Context window exceeded | Use v2 with concise prompts |
| All agents fail | API degradation | v2 circuit breaker skips to working agents |
| Partial results | No retry logic | v2 auto-retries failed agents |
| `EADDRINUSE` | Port conflict | Wait 5s between restarts |

### Debugging Tips

**1. Check individual agent health:**

```bash
# Test single agent
python3 -c "
import requests, os
url = 'https://api.zo.computer/zo/ask'
resp = requests.post(url, headers={'authorization': os.environ['ZO_CLIENT_IDENTITY_TOKEN']}, 
  json={'input': 'Hello'}, timeout=30)
print(resp.status_code)
"
```

**2. Validate task file:**

```bash
# Ensure valid JSON and required fields
python3 -c "import json; json.load(open('tasks.json'))"
```

**3. Check resource usage:**

```bash
# Monitor concurrent processes
ps aux | grep -c "zo/ask"
```

---

## Files Reference

| File | Purpose | Version |
| --- | --- | --- |
|  | Original v1 orchestrator | v1 |
|  | Resilient v2 orchestrator | v2 (recommended) |
|  | Inter-agent communication | v1 |
|  | Example task definitions | v2 |
| `scripts/swarm` | CLI wrapper | v2 |
| `scripts/swarm-memory.ts` | Persistent memory module | v3 |
| `scripts/orchestrate-v3.ts` | Memory-aware orchestrator | v3 |
| `examples/v3-memory-tasks.json` | Memory-enabled task example | v3 |
| `examples/v3-persona-memory-bridge.json` | Persona memory bridge example | v3 |

---

## Configuration

### Environment Variables

| Variable | Description | Default | Version |
| --- | --- | --- | --- |
| `SWARM_MAX_CONCURRENCY` | Max parallel agents | 2 (v2), 5 (v1) | both |
| `SWARM_TIMEOUT_SECONDS` | Timeout per agent | 300 (v2), 120 (v1) | both |
| `SWARM_MAX_RETRIES` | Retry attempts | 3 | v2 only |
| `ZO_CLIENT_IDENTITY_TOKEN` | Required API auth | \- | both |
| `SWARM_MEMORY_PATH` | SQLite database path | `~/.swarm/swarm-memory.db` | v3 |

### Task File Format (v2)

```json
[
  {
    "id": "unique-task-id",
    "persona": "persona-name",
    "task": "Detailed task description",
    "priority": "critical|high|medium|low"
  }
]
```

### v3 Task File Format (with Memory)

```json
[
  {
    "id": "task-id",
    "persona": "persona-name",
    "task": "Detailed task description",
    "priority": "critical|high|medium|low",
    "contextAccess": "read|write|append|none",
    "contextQuery": {
      "category": "research",
      "tags": ["ai", "market"],
      "limit": 5
    },
    "contextTags": ["investment-opportunities"],
    "outputToMemory": true,
    "memoryMetadata": {
      "category": "analysis",
      "priority": "high",
      "tags": ["financial", "q1-2026"]
    },
    "promoteToPersonaMemory": true,
    "promotionMetadata": {
      "entity": "decision",
      "category": "decision",
      "decay": "stable"
    }
  }
]
```

---

## Best Practices

### ✅ Do

- **Use v2 for production** - Reliability over speed
- **Start with 2-3 agents** - Test before scaling
- **Set appropriate priorities** - Critical tasks first
- **Validate task files** - Check JSON before running
- **Monitor circuit breakers** - Investigate failing personas

### ⚠️ Avoid

- **Don't use v1 for &gt;3 agents** - Timeout risk increases
- **Don't skip validation** - Invalid JSON wastes API calls
- **Don't ignore circuit breakers** - Indicates systemic issues
- **Don't retry immediately** - Use exponential backoff

---

## Future Enhancements

- [x] **Resilient orchestration (v2)** - ✅ Implemented

- [x] **Circuit breaker pattern** - ✅ Implemented

- [x] **Retry with backoff** - ✅ Implemented

- [x] **Persistent swarm memory** - ✅ Implemented in v3.0.0

- [ ] **Visual swarm dashboard** - Real-time progress monitoring

- [ ] **Cost tracking** - Per-swarm cost analysis

- [ ] **A/B testing** - Compare v1 vs v2 performance

---

## Support

For issues or enhancements:

1. Check logs: `ls -la /tmp/swarm-results/`
2. Review analysis: `file /home/.z/workspaces/con_S8zYiOhjCgjFbcpi/swarm-analysis/SWARM_FAILURE_ANALYSIS.md`
3. Test with v2: `bun orchestrate-v2.ts examples/sample-tasks.json`

---

## Quick Reference Card

```markdown
SWARM ORCHESTRATOR v2 - QUICK REFERENCE

Create task file:
  swarm template my-tasks

Validate tasks:
  swarm validate my-tasks.json

Run v2 (recommended):
  bun orchestrate-v2.ts my-tasks.json

Run v1 (simple):
  bun orchestrate.ts "query" -p "p1,p2"

Environment:
  SWARM_MAX_CONCURRENCY=2
  SWARM_TIMEOUT_SECONDS=300

Run v3 (with memory):
  bun orchestrate-v3.ts my-tasks.json --swarm-id my-project

Memory management:
  bun swarm-memory.ts stats
  bun swarm-memory.ts list-sessions
  bun swarm-memory.ts list-contexts <swarm-id>
```
