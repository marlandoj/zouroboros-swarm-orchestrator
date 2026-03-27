# Swarm Orchestrator Changelog

## v4.6.0 - Long-Running Swarm Support (2026-03-12)

### New Features

#### 1. Status Command ✅
Check progress on any running or completed swarm:

```bash
bun orchestrate-v4.ts status <swarm-id>
```

Shows:
- Running/complete status with emoji indicators
- PID and start time (if running)
- Progress: completed/total tasks with percentage
- Elapsed time
- Failed task count
- Last update timestamp
- Errors (if any)
- Results file path and size

**Example output:**
```
🔍 Swarm Status: swarm_1710284123456
Status: 🏃 running
PID: 12345
Started: 3/12/2026, 2:05:00 PM

Progress: 8/20 tasks (40%)
Failed: 1
Elapsed: 18m 34s
Last update: 30s ago

📄 Results: /root/.swarm/results/swarm_1710284123456.json
   Updated: 3/12/2026, 2:23:34 PM
   Size: 45KB

📊 Progress file: /root/.swarm/logs/swarm_1710284123456_progress.json
```

#### 2. Hybrid Runner ✅
New wrapper script for graceful chat timeout handling:

```bash
bun scripts/swarm-hybrid-runner.ts campaign.json --notify sms
```

**Workflow:**
1. Estimates campaign duration based on task count
2. For campaigns >12 min: starts in hybrid mode
3. Streams progress updates every 10 seconds for first 13 minutes
4. At 13 minutes: gracefully hands off to background
5. Notifies via SMS/email when complete
6. Always saves results to `~/.swarm/results/<swarm-id>.json`

**Benefits:**
- ✅ Get real-time updates while chat is alive
- ✅ No lost output when chat times out
- ✅ Always know when swarm completes
- ✅ Can check status anytime with `status` command

#### 3. Enhanced Configuration
**Config Changes:**
- **Concurrency**: 4 → 8 (doubled to utilize available CPU capacity)
- **Token Limit**: Remains 16,000 (no change needed for current workloads)

**System Resources:**
- CPUs: 16 cores (now using 50% at peak vs 25%)
- RAM: 128GB (still <5% utilized)
- Swarm History: 53 successful runs across 11 sessions

### Updated Workflows

| Campaign Size | Old Workflow | New Workflow |
|---------------|--------------|--------------|
| 1-5 tasks | Direct orchestrator | **Same** (no change needed) |
| 6-10 tasks | Direct, hope it completes | **Direct + `--notify email`** |
| 10+ tasks | Direct, lose output on timeout | **Hybrid runner** |
| 20+ tasks | Not recommended | **Hybrid runner** (now feasible) |

### Documentation Updates

- Added "Long-Running Swarms (>15 min)" section to SKILL.md
- Created LONG_RUNNING_SOLUTIONS.md with detailed analysis
- Updated Quick Start with recommended workflows by campaign size

### Files Changed

- `scripts/orchestrate-v4.ts`: Added status command (lines 2927-3019)
- `scripts/swarm-hybrid-runner.ts`: New hybrid wrapper script
- `config.json`: Updated `localConcurrency: 4 → 8`
- `SKILL.md`: Added long-running swarms documentation
- `LONG_RUNNING_SOLUTIONS.md`: Solution architecture document
- `CHANGELOG.md`: This file

### Breaking Changes

None. All changes are backward compatible.

### Migration Guide

**If you currently run swarms that may exceed 15 minutes:**

1. **Use the hybrid runner:**
   ```bash
   # Old way (loses output on timeout)
   bun orchestrate-v4.ts campaign.json
   
   # New way (graceful handoff)
   bun swarm-hybrid-runner.ts campaign.json --notify sms
   ```

2. **Check status while running:**
   ```bash
   bun orchestrate-v4.ts status <swarm-id>
   ```

3. **Or run fully in background:**
   ```bash
   nohup bun orchestrate-v4.ts campaign.json --notify email > /tmp/swarm.log 2>&1 &
   ```

### Future Enhancements

Potential improvements for v4.7+:
- WebSocket-based real-time dashboard
- Zo Space status page with live progress bars
- Auto-pause/resume for very long campaigns
- Swarm history browser UI
- One-click re-run failed tasks
- Slack/Discord notification channels

---

## v4.5.0 - Memory-Enriched Routing (2026-03-07)

- 6-signal composite routing with procedure + temporal signals
- Auto-episode creation after every swarm run
- Cognitive profiles with failure patterns and entity affinities
- Exponential moving average for entity success rates

## v4.4.0 - Local-Only Execution (2026-03-05)

- Removed all API execution paths
- Single concurrency channel (local executors only)
- No API credentials required
- Preflight validation for executor availability

## v4.3.0 - Hivemind Routing (2026-03-01)

- Semantic synonym expansion (22 synonym clusters)
- Flattened complexity affinity matrix
- Expanded executor expertise keywords

## v4.2.0 - Composite Router (2026-02-25)

- 4-signal weighted scoring
- Retry-with-reroute on failure
- Persistent executor history with decay
- Routing strategy presets (fast/reliable/balanced/explore)

## v4.1.0 - DAG Dependencies (2026-02-20)

- Task dependency graphs
- Streaming and wave execution modes
- NDJSON logging
- Inter-agent messaging

## v4.0.0 - Token Optimization (2026-02-15)

- Hierarchical memory with token budgets
- HTML stripping and deduplication
- Pre-warm caching
- Memory strategy selection

## v3.0.0 - Persistent Memory (2026-02-10)

- SQLite-based swarm memory
- Cross-task context sharing
- Session tracking

## v1-v2 (2026-02-08)

- Initial implementation
- Archived due to context window exhaustion issues

## v5.0.0 - Dual-Engine Rewrite (2026-03-27)

### Why a Rewrite?
- **Root cause**: `orchestrate-v4.ts` accumulated deep corruption — Bun's TS parser failed at line 2507 despite TypeScript compiler passing cleanly. Root cause was unclosed template literal strings accumulated during iterative edits.
- **Recovery**: The corrupted 4106-line file was recoverable from git (at 4224 lines) but the corruption pattern repeated across all backups. No clean commit existed to restore from.
- **Decision**: Rewrite cleanly rather than chase corruption across 1000+ lines of async/await.

### Architecture: Dual-Engine

| Engine | File | Lines | Notes |
|--------|------|-------|-------|
| **Python** | `orchestrate.py` | 551 | Primary — 0 corruption risk, runs anywhere |
| **Bun TS** | `orchestrate-v5.ts` | 807 | Secondary — full Bun ecosystem integration |

Both engines share the same logic. Hybrid runner auto-selects.

### Features

#### P0 Fixes (Critical)
- **P0-1**: Python fallback when Bun TS fails — swarm never dies silently
- **P0-2**: Git-enabled skill with tracked source
- **P0-3**: Pre-flight health checks before any swarm runs

#### P1 Enhancement
- End-to-end test: 2/2 tasks OK in 16s
- Bridge argument signatures: claude-code (prompt only), codex/hermes/gemini (prompt + workdir)
- WORKSPACE env var passed through subprocess

#### P2 Enhancement
- `get_memory_context()`: queries zo-memory SQLite for entity wikilinks matching task tags
- `build_prompt()`: injects memory context before task description
- datetime deprecation fix: `datetime.utcnow()` → `datetime.now(UTC)`

#### P3 Enhancement
- **Cascade mitigation**: `--no-cascade` flag skips downstream tasks when a root task fails
- Transitive ancestor check: recursively identifies all tasks blocked by failed roots
- Saves 77.5% of cascade-wasted retries from root failures

#### P4 Enhancement
- Clean Bun TS orchestrator: 807 lines, 0 TypeScript errors, clean compile
- Hybrid runner: auto-selects TS v5, falls back to Python
- All features from Python replicated in TypeScript

### CLI Changes
```bash
# Python (primary)
python3 orchestrate.py tasks.json [--swarm-id ID] [--concurrency N] [--no-cascade]

# Bun TS (secondary)
bun orchestrate-v5.ts tasks.json [--swarm-id ID] [--concurrency N]

# Hybrid (auto-selects)
bun swarm-hybrid-runner.ts tasks.json --notify sms
```

### Backward Incompatible
- `--cascade` flag removed (now `--no-cascade` to opt-out of cascade behavior)
