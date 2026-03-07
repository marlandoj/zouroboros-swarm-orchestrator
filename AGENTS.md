# Swarm Orchestrator - Agent Memory

## March 2026 Failure Remediation (v4.0.0 → v4.1.0)

**Incident:** Sprint 2 Deferred Remediation campaign (March 4, 2026) — 5 failure categories, ~50% efficiency.

### Phase 1: Quick Wins (Implemented)
| Fix | Addresses | What it does |
|-----|-----------|-------------|
| **R1: Campaign Locking** | F1, F3 | File lock at `/dev/shm/{swarmId}.lock` prevents duplicate concurrent runs. 30-min stale threshold. |
| **R2: Per-Task Timeout** | F2 | `timeoutSeconds` field on each task. Tiers: quickEdit=120s, analysis=300s, heavyIO=900s, buildTest=600s. |
| **R6: Stderr Capture** | F6 | Bridge script falls back to stderr when stdout is empty. Eliminates zero-length output successes. |

### Phase 2: Reliability (Implemented)
| Fix | Addresses | What it does |
|-----|-----------|-------------|
| **R3: Post-Mutation Verification** | F5 | `expectedMutations` array on tasks. After task success, verifies files contain expected strings. Fails task if not. |
| **R4: Startup Preflight** | F1 | `preflight()` validates task structure, duplicate IDs, executor bridges, API creds, DAG deps, cycles, memory. Fails fast with diagnostics. |
| **R7: Prompt Reinforcement** | F5 | Appends "IMPORTANT: This task requires ACTUAL FILE CHANGES" + file list to prompts when `expectedMutations` is set. |

### Phase 3: UX (Implemented)
| Fix | Addresses | What it does |
|-----|-----------|-------------|
| **R5: Async Completion Notification** | F4 | Writes `/dev/shm/{swarmId}-complete.json` on finish (always). Optionally sends SMS or email via `--notify sms` or `--notify email`. User is informed regardless of chat session state. |

### Campaign JSON Example (post-remediation)
```json
{
  "id": "s2-compression-middleware",
  "persona": "claude-code",
  "task": "Add compression middleware to server/index.ts",
  "priority": "high",
  "timeoutSeconds": 120,
  "expectedMutations": [
    { "file": "/home/workspace/fauna-flora-store/server/index.ts", "contains": "compression()" },
    { "file": "/home/workspace/fauna-flora-store/package.json", "contains": "\"compression\"" }
  ]
}
```

## Lessons Learned from Production Failures

### February 2026 Incident Analysis

**Context:** Attempted to use swarm orchestrator for a multi-page website review with 5 agents simultaneously.

**What Failed:**
1. All parallel API calls timed out (120s insufficient)
2. No retry mechanism caused complete failure
3. Rate limiting from concurrent requests
4. Context window pressure with 256k tokens × 5 agents

**What Worked:**
1. Direct sequential API calls succeeded
2. Smaller, focused tasks completed successfully
3. Python subprocess approach was reliable
4. Bun/TypeScript orchestrator script logic was sound

**Root Causes Identified:**
- API calls had implicit rate limits per session (resolved: now local-only)
- Complex analysis requires >120s timeout
- No backoff strategy caused thundering herd
- Missing circuit breaker allowed cascading failures

## Memory Integration (v4.5.0)

As of v4.5.0, the orchestrator integrates with zo-memory-system for learning and adaptive routing:

| Feature | Implementation | Benefit |
|---------|---------------|---------|
| Auto-Episodes | `createSwarmEpisode()` at end of `run()` | Every swarm run becomes a queryable event |
| 6-Signal Routing | `compositeRoute()` adds procedure + temporal | Routes learn from past success/failure |
| Cognitive Profiles | Extended `executor-history.json` | Episode IDs, failure patterns, entity affinities |
| Error Classification | Auto-classify: timeout, mutation_failed, file_not_found | Failure patterns inform routing avoidance |
| Entity Affinities | Exponential moving average per entity per executor | Tracks which executors excel at which domains |

### Composite Router Signals (v4.5)

```
composite = (w.capability * capScore)     # Task-capability matching
           + (w.health * hlth)            # Circuit breaker health
           + (w.complexityFit * cfit)     # Complexity tier affinity
           + (w.history * hist)           # Historical success rate
           + (0.10 * (procScore - 0.5))   # Procedure success bonus (±0.05)
           + (0.05 * (tempScore - 0.5))   # Recent episodic bonus (±0.025)
```

### Querying Swarm History

```bash
# Recent swarm episodes
bun ~/Skills/zo-memory-system/scripts/memory.ts episodes --entity "swarm.ffb" --since "7 days ago"

# Executor cognitive profile
bun ~/Skills/zo-memory-system/scripts/memory.ts profile --executor gemini

# Procedure evolution
bun ~/Skills/zo-memory-system/scripts/memory.ts procedures --evolve "site-review"
```

## Architecture (v4.4.0 — Local Executors Only)

As of v4.4.0, all tasks are executed via local executor bridges (claude-code, hermes, gemini, codex).
No remote API calls (zo/ask, Anthropic Direct) are used. This eliminates API latency as a bottleneck
and removes the need for API credentials.

```
BEFORE (v4.3)                  AFTER (v4.4)
─────────────                  ─────────────
3 execution paths              1 execution path (local bridges)
  - Local executor               - Local executor only
  - Anthropic Direct API
  - Zo API fallback
Dual concurrency channels      Single concurrency channel
  - maxConcurrency (API)          - localConcurrency
  - localConcurrency (local)
API credentials required       No API credentials needed
```

### Key Features

| Feature | Implementation | Benefit |
|---------|---------------|---------|
| Local Executors | Bridge scripts (bash) | No API latency, full local control |
| DAG Streaming | Promise.race loop | Tasks start immediately when deps resolve |
| Circuit Breaker | `failures >= 2` | Prevents cascading failures |
| Priority Queue | Sort by critical/high/medium/low | Important tasks complete first |
| Structured Logging | NDJSON output with timing | Debuggability |
| Task Validation | Preflight checks | Fail fast on invalid input |

## Configuration Presets

### Safe Default (Recommended)
```bash
SWARM_LOCAL_CONCURRENCY=4
TIMEOUT_SECONDS=300
MAX_RETRIES=3
```

### Aggressive (Development Only)
```bash
SWARM_LOCAL_CONCURRENCY=6
TIMEOUT_SECONDS=180
MAX_RETRIES=2
```

### Conservative (Critical Production)
```bash
SWARM_LOCAL_CONCURRENCY=2
TIMEOUT_SECONDS=600
MAX_RETRIES=5
```

## When to Use Which Version

### Use v1 When:
- Quick analysis with 2-3 simple tasks
- Development/testing environment
- Low stakes, fast iteration needed
- Tasks are independent and simple

### Use v2 When:
- Production critical workflows
- 4+ agents needed
- Complex multi-step reasoning required
- Tasks have dependencies or priorities
- Reliability is more important than speed

## Known Limitations

### Local Executor Constraints
- Concurrency limited by machine resources (CPU/memory)
- Each executor bridge runs as a child process
- All tasks must have a registered local executor (no API fallback)

### Workarounds
- Adjust `localConcurrency` based on machine capacity
- Break complex tasks into smaller subtasks
- Use task timeouts to prevent runaway processes

## Success Patterns

### Pattern 1: Sequential Fallback
When swarm fails, fall back to sequential execution:
```typescript
// Try swarm first
const result = await swarm.execute(tasks).catch(() => {
  // Fallback: process sequentially
  return sequentialProcess(tasks);
});
```

### Pattern 2: Task Decomposition
Break complex tasks into smaller chunks:
```json
[
  {"task": "Analyze hero section", "priority": "high"},
  {"task": "Analyze product cards", "priority": "high"},
  {"task": "Analyze footer", "priority": "medium"}
]
```

### Pattern 3: Priority Tiers
Always structure tasks by priority:
1. **Critical** - Security, compliance, broken functionality
2. **High** - SEO, performance, UX issues
3. **Medium** - Accessibility, enhancements
4. **Low** - Nice-to-have improvements

## Monitoring & Alerting

### Metrics to Track
- Swarm success rate (target: >95%)
- Average task duration (target: <60s)
- Retry rate (target: <10%)
- Circuit breaker triggers (alert if >2/persona)

### Log Locations
- Results: `/tmp/swarm-results/*.json`
- Analysis: `$HOME/.swarm/results/`

## Future Improvements

### Short Term
- [ ] Add request caching for identical tasks
- [ ] Implement request queue with deduplication
- [ ] Add cost tracking per swarm invocation

### Long Term
- [ ] Persistent swarm memory across sessions
- [ ] Visual dashboard for real-time monitoring
- [ ] Automatic task decomposition based on complexity
- [ ] A/B testing framework for v1 vs v2

## References

- Task Examples: `examples/sample-tasks.json`
- Full Documentation: `SKILL.md`
