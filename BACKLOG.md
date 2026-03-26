# Swarm Orchestrator Backlog

## Low Priority

### Heartbeat Token Limit for Bridge Executors
- **Added**: 2026-03-23
- **Priority**: Low
- **Status**: Backlogged — no active incidents justify implementation

**Description**: Add a bridge-level watchdog that emits periodic "alive + N tokens so far" signals to a shared file (e.g., `/dev/shm/{taskId}-heartbeat.json`). This would let the orchestrator detect hung bridges before the full timeout expires and kill runaway tasks exceeding a per-task token budget mid-execution.

**Evidence Review (2026-03-23)**:
Analyzed 62 swarm runs, 80 total task failures:
- **Runaway output**: Zero incidents. Max observed was 20K tokens — well within bounds.
- **Hung/silent tasks**: 1 notable case — `plan` task at 10x duration outlier (483s wasted, single run).
- **Timeout hits**: 9 total across 62 runs, mostly Zo API-level, not executor-level.
- **Circuit breaker trips**: None — health scores hardcoded to 1.0.

**Trigger to revisit**:
- Swarm tasks begin exceeding 50K tokens per task
- Executor hangs become frequent (>3 per week)
- OmniRoute budget overruns from undetected runaway output

**Related higher-priority item**:
- Dependency cascade mitigation — a single root failure cascaded to kill 62 of 80 total failures (77.5%). Partial DAG recovery instead of full abort on root failure would have greater impact.
