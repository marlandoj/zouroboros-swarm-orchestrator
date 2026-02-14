# Swarm Orchestrator - Agent Memory

## Lessons Learned from Production Failures

### February 2026 Incident Analysis

**Context:** Attempted to use swarm orchestrator for Fauna & Flora website review with 5 agents simultaneously.

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
- `/zo/ask` API has implicit rate limits per session
- Complex analysis requires >120s timeout
- No backoff strategy caused thundering herd
- Missing circuit breaker allowed cascading failures

## Implemented Solutions (v2)

### Architecture Changes

```
BEFORE (v1)                    AFTER (v2)
─────────────                  ─────────────
5 parallel agents              2 chunked agents
120s timeout                   300s timeout
No retry                       3 retries with exponential backoff
No circuit breaker             Per-persona circuit breaker
Unbounded context              Concise prompts (300-500 words)
Fire-and-forget                Progress tracking + detailed logging
```

### Key Improvements

| Feature | Implementation | Benefit |
|---------|---------------|---------|
| Chunked Processing | `chunkArray(tasks, 2)` | Controls concurrency, prevents rate limits |
| Exponential Backoff | `delay * retryCount` | Graceful degradation |
| Circuit Breaker | `failures >= 2` | Prevents cascading failures |
| Priority Queue | Sort by critical/high/medium/low | Important tasks complete first |
| Structured Logging | JSON output with timing | Debuggability |
| Task Validation | JSON schema check | Fail fast on invalid input |

## Configuration Presets

### Safe Default (Recommended)
```bash
MAX_CONCURRENCY=2
TIMEOUT_SECONDS=300
MAX_RETRIES=3
CHUNK_SIZE=2
```

### Aggressive (Development Only)
```bash
MAX_CONCURRENCY=3
TIMEOUT_SECONDS=180
MAX_RETRIES=2
CHUNK_SIZE=3
```

### Conservative (Critical Production)
```bash
MAX_CONCURRENCY=1
TIMEOUT_SECONDS=600
MAX_RETRIES=5
CHUNK_SIZE=1
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

### API Constraints
- Maximum 2 concurrent requests per session recommended
- 256k token context window per agent
- ~5 req/min implicit rate limit observed
- 60s minimum recommended between swarm invocations

### Workarounds
- Use chunked processing (v2) for >2 agents
- Add delays between manual API calls
- Break complex tasks into smaller subtasks
- Use higher-cost models for complex analysis

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
- Analysis: `/home/.z/workspaces/*/swarm-analysis/`

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

- Failure Analysis: `file /home/.z/workspaces/con_S8zYiOhjCgjFbcpi/swarm-analysis/SWARM_FAILURE_ANALYSIS.md`
- v2 Implementation: `file /home/workspace/Skills/zo-swarm-orchestrator/scripts/orchestrate-v2.ts`
- Task Examples: `file /home/workspace/Skills/zo-swarm-orchestrator/examples/sample-tasks.json`
- Full Documentation: `file /home/workspace/Skills/zo-swarm-orchestrator/SKILL.md`
