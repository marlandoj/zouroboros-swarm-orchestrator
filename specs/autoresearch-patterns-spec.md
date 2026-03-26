# Autoresearch Patterns — Implementation Specs

> Three specs derived from karpathy/autoresearch patterns, prioritized by impact.
> Date: 2026-03-21
> Status: IMPLEMENTED — all three phases complete (2026-03-21)

---

## Spec 1: Circuit Breaker v2 + Backpressure Monitor

### Problem

The current circuit breaker in orchestrate-v4.ts is binary: 3 failures → OPEN, wait 30s → auto-reset to CLOSED. This has three gaps:

1. **No HALF_OPEN probe** — After 30s cooldown, the executor gets full traffic immediately. If it's still broken, we burn 3 more tasks before re-opening the breaker.
2. **Fixed cooldown** — 30s regardless of failure severity. A rate-limited executor (429) needs minutes; a typo crash needs seconds.
3. **No backpressure signal** — We don't track whether an executor is *degraded* (slow, high memory, partial failures) vs *dead*. A degraded executor still gets routed to at full weight.

The March 14th cascading failure (502/521 across Hermes, Claude Code, OmniRoute) would have been contained by HALF_OPEN probing + exponential backoff.

### Current State (orchestrate-v4.ts)

```typescript
// Lines 189-193
interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

// Lines 2681-2716 — health score
healthScore(persona: string): number {
  const cb = circuitBreakers.get(persona);
  if (cb.isOpen) return 0.0;
  failurePenalty = cb.failures * 0.3;
  recencyBonus = ...;
  return Math.max(0, Math.min(1.0, 1.0 - failurePenalty + recencyBonus));
}
```

### Proposed: Three-State Circuit Breaker

```
CLOSED ──(N failures)──▸ OPEN ──(cooldown expires)──▸ HALF_OPEN
   ▲                                                      │
   │                          probe succeeds               │
   └───────────────────────────────────────────────────────┘
                              │
                         probe fails
                              │
                              ▼
                            OPEN (longer cooldown)
```

#### New Interface

```typescript
interface CircuitBreakerV2 {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;            // consecutive failures
  totalFailures: number;       // lifetime (for reporting)
  lastFailure: number;         // timestamp
  lastSuccess: number;         // timestamp
  cooldownMs: number;          // current cooldown (grows with backoff)
  baseCooldownMs: number;      // starting cooldown (default 30_000)
  maxCooldownMs: number;       // cap (default 300_000 = 5 min)
  backoffMultiplier: number;   // default 2.0
  probeInFlight: boolean;      // true when HALF_OPEN probe is running
  failureCategories: Map<ErrorCategory, number>;  // count per error type
}
```

#### State Transitions

| From | Event | To | Side Effects |
|------|-------|----|-------------|
| CLOSED | failure (count < threshold) | CLOSED | `failures++`, `cooldownMs = baseCooldownMs` |
| CLOSED | failure (count >= threshold) | OPEN | Log transition, emit alert |
| OPEN | cooldown expired | HALF_OPEN | Allow exactly 1 probe task |
| HALF_OPEN | probe succeeds | CLOSED | Reset `failures = 0`, `cooldownMs = baseCooldownMs` |
| HALF_OPEN | probe fails | OPEN | `cooldownMs = min(cooldownMs * backoffMultiplier, maxCooldownMs)` |

#### Failure Threshold by Error Category

Not all failures are equal. Override the default threshold (3) based on error type:

```typescript
const FAILURE_THRESHOLDS: Record<ErrorCategory, number> = {
  timeout: 2,            // 2 timeouts → open (expensive failures)
  rate_limited: 1,       // 1 rate limit → open immediately (wait it out)
  permission_denied: 1,  // 1 permission error → open (needs human fix)
  context_overflow: 2,   // 2 overflows → open (needs prompt reduction)
  mutation_failed: 3,    // 3 mutation failures → open (might be flaky)
  syntax_error: 3,       // standard
  runtime_error: 3,      // standard
  unknown: 3,            // standard
};
```

#### Cooldown by Error Category

```typescript
const BASE_COOLDOWN_MS: Record<ErrorCategory, number> = {
  rate_limited: 60_000,      // 1 min base (rate limits need patience)
  permission_denied: 300_000, // 5 min (needs human intervention)
  timeout: 30_000,           // 30s (might be transient)
  context_overflow: 30_000,
  mutation_failed: 15_000,   // 15s (often flaky, retry fast)
  syntax_error: 15_000,
  runtime_error: 15_000,
  unknown: 30_000,
};
```

### Backpressure Monitor

Tracks executor *degradation* (slow but alive) separately from circuit breaker (dead).

```typescript
interface BackpressureState {
  executorId: string;
  recentDurationsMs: number[];  // sliding window of last 10 task durations
  baselineDurationMs: number;   // EMA of healthy durations
  pressureScore: number;        // 0.0 (healthy) to 1.0 (overloaded)
  trend: "improving" | "stable" | "degrading";
}
```

#### Pressure Score Calculation

```typescript
function updatePressure(state: BackpressureState, durationMs: number): void {
  state.recentDurationsMs.push(durationMs);
  if (state.recentDurationsMs.length > 10) state.recentDurationsMs.shift();

  const avgRecent = mean(state.recentDurationsMs);
  const ratio = avgRecent / state.baselineDurationMs;

  // Pressure thresholds
  if (ratio < 1.5) state.pressureScore = 0.0;       // normal
  else if (ratio < 2.0) state.pressureScore = 0.3;   // mild
  else if (ratio < 3.0) state.pressureScore = 0.6;   // moderate
  else state.pressureScore = 0.9;                     // severe

  // Update baseline (slow EMA, only from healthy runs)
  if (ratio < 1.5) {
    state.baselineDurationMs = state.baselineDurationMs * 0.9 + durationMs * 0.1;
  }

  // Trend detection
  if (state.recentDurationsMs.length >= 5) {
    const firstHalf = mean(state.recentDurationsMs.slice(0, 5));
    const secondHalf = mean(state.recentDurationsMs.slice(-5));
    state.trend = secondHalf < firstHalf * 0.9 ? "improving"
      : secondHalf > firstHalf * 1.1 ? "degrading" : "stable";
  }
}
```

#### Integration with Composite Router

Modify the health score calculation to incorporate backpressure:

```typescript
healthScore(executorId: string): number {
  const cb = circuitBreakers.get(executorId);
  const bp = backpressure.get(executorId);

  // Circuit breaker gates
  if (cb.state === "OPEN") return 0.0;
  if (cb.state === "HALF_OPEN") return 0.1;  // low but non-zero (probe candidate)

  // Base score from failures
  let score = 1.0 - (cb.failures * 0.3);

  // Backpressure penalty
  if (bp) score *= (1.0 - bp.pressureScore * 0.5);  // max 50% reduction from pressure

  // Recency bonus (time since last failure)
  const recency = Math.min(0.2, (Date.now() - cb.lastFailure) / 60_000 * 0.05);
  score += recency;

  return Math.max(0, Math.min(1.0, score));
}
```

### HALF_OPEN Probe Strategy

When an executor transitions to HALF_OPEN, the next routed task becomes the probe. To minimize waste:

1. **Prefer trivial-complexity tasks** — If the task queue has a trivial task, route that as the probe
2. **Shorter timeout** — Probe tasks get 50% of normal timeout (fail fast)
3. **Single in-flight** — Only one probe at a time per executor (`probeInFlight` flag)

```typescript
async function routeTask(task: Task): Promise<string> {
  const candidates = getHealthyExecutors();

  // Check for HALF_OPEN executors that need probing
  for (const [id, cb] of circuitBreakers) {
    if (cb.state === "HALF_OPEN" && !cb.probeInFlight) {
      if (task.complexity === "trivial" || candidates.length === 0) {
        cb.probeInFlight = true;
        return id;  // Route as probe
      }
    }
  }

  // Normal routing via composite scorer
  return compositeRoute(task, candidates);
}
```

### Persistence

Extend `~/.swarm/executor-history.json` with circuit breaker state:

```typescript
interface PersistedCircuitState {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
  cooldownMs: number;
  lastFailure: number;
  lastSuccess: number;
  failureCategories: Record<string, number>;
  backpressure: {
    baselineDurationMs: number;
    pressureScore: number;
  };
}
```

### Files to Modify

| File | Change |
|------|--------|
| `orchestrate-v4.ts` lines 189-193 | Replace `CircuitBreaker` interface with `CircuitBreakerV2` |
| `orchestrate-v4.ts` lines 2681-2716 | Replace `healthScore()` with backpressure-aware version |
| `orchestrate-v4.ts` lines 2871-2907 | Add HALF_OPEN probe routing in `compositeRoute()` |
| `orchestrate-v4.ts` ~line 1909 | Add backpressure update after task completion |
| `orchestrate-v4.ts` ~line 2040 | Error-category-aware threshold + cooldown selection |

### Acceptance Criteria

- [ ] CLOSED → OPEN transition fires after category-specific threshold (not always 3)
- [ ] OPEN → HALF_OPEN transition fires after cooldown expiry
- [ ] HALF_OPEN → CLOSED on probe success, resets failures and cooldown
- [ ] HALF_OPEN → OPEN on probe failure, doubles cooldown (up to max)
- [ ] Backpressure score updates after every completed task
- [ ] Health score incorporates both circuit state and backpressure
- [ ] `rate_limited` errors open breaker after 1 failure with 60s base cooldown
- [ ] State persisted to executor-history.json across restarts
- [ ] Existing tests pass (no behavior change for healthy executors)

### Risks

- **Probe task failure**: A real task gets used as a probe and fails. Mitigation: prefer trivial tasks, inject failure context for retry.
- **Cooldown too aggressive**: Exponential backoff could quarantine an executor for 5 min when it recovered after 30s. Mitigation: cap at 300s, HALF_OPEN probes before full recovery.

---

## Spec 2: Structured JSON Results Contract

### Problem

Executor results are currently plain text on stdout. The orchestrator reads them as raw strings:

```typescript
// orchestrate-v4.ts ~line 1800
const stdout = await new Response(proc.stdout).text();
const result = stdout.trim();
```

This creates three issues:

1. **Ambiguous failure states** — Empty stdout could mean crash, timeout, or "no output needed". The orchestrator can't distinguish without parsing stderr separately.
2. **No structured metrics** — Duration, token usage, and artifacts are estimated (`output.length / 4` for tokens) instead of measured.
3. **Prompt injection surface** — Raw stdout from child processes is passed into retry prompts as `previousAttemptContext`. A malicious training output (or compromised dependency) could inject instructions.

### Current Flow

```
Executor bridge → stdout (raw text) → orchestrator trims → stores as result
                → stderr (raw text) → orchestrator reads on failure → error message
                → exit code → 0 = success, non-zero = failure
```

### Proposed: Structured JSON Envelope

Every executor bridge writes a `result.json` to a known path. The orchestrator reads this file instead of parsing stdout.

#### Result Schema

```typescript
interface ExecutorResult {
  // Required fields
  status: "success" | "failure" | "timeout" | "crash";
  output: string;           // The actual task output (what goes to the user)

  // Metrics (optional but encouraged)
  metrics?: {
    durationMs?: number;      // Wall clock execution time
    promptTokens?: number;    // Input tokens consumed
    outputTokens?: number;    // Output tokens generated
    model?: string;           // Actual model used (may differ from requested)
    retries?: number;         // Internal retries within the executor
  };

  // Artifacts (optional)
  artifacts?: {
    filesCreated?: string[];   // Absolute paths of files created
    filesModified?: string[];  // Absolute paths of files modified
    filesDeleted?: string[];   // Absolute paths of files deleted
  };

  // Error context (required when status !== "success")
  error?: {
    category: ErrorCategory;   // timeout, syntax_error, runtime_error, etc.
    message: string;           // Human-readable error
    stackTrace?: string;       // Raw stack trace (for debugging, NOT fed to retry prompts)
    retryable: boolean;        // Executor's assessment of retryability
  };

  // Metadata
  executorId: string;          // Which executor produced this
  taskId: string;              // Task identifier (passed in via env)
  timestamp: string;           // ISO 8601
}
```

#### "No File = Crash" Contract

Inspired by autoresearch PR #331:

```
result.json exists + valid JSON → parse and use
result.json exists + invalid JSON → treat as crash, log parse error
result.json missing → treat as crash (executor died before writing)
```

The orchestrator deletes `result.json` before dispatching each task (prevents stale reads):

```typescript
const resultPath = path.join(workDir, `result-${task.id}.json`);
try { fs.unlinkSync(resultPath); } catch {}  // ignore if doesn't exist

// ... spawn executor with RESULT_PATH env var ...

// After completion:
let result: ExecutorResult;
try {
  result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
} catch {
  result = {
    status: "crash",
    output: "",
    error: {
      category: classifyError(stderr).type,
      message: stderr.slice(0, 2000),  // cap length
      retryable: true,
    },
    executorId,
    taskId: task.id,
    timestamp: new Date().toISOString(),
  };
}
```

#### Bridge Changes

Each bridge writes the result file at the end of execution. Example for claude-code-bridge.sh:

```bash
# At end of bridge, after execution completes:
RESULT_FILE="${RESULT_PATH:-result.json}"

if [ $EXIT_CODE -eq 0 ]; then
  # Write success result
  jq -n \
    --arg status "success" \
    --arg output "$OUTPUT" \
    --arg executor "claude-code" \
    --arg taskId "$SWARM_TASK_ID" \
    --arg model "$RESOLVED_MODEL" \
    --argjson duration "$DURATION_MS" \
    '{
      status: $status,
      output: $output,
      metrics: { durationMs: $duration, model: $model },
      executorId: $executor,
      taskId: $taskId,
      timestamp: (now | todate)
    }' > "$RESULT_FILE"
else
  # Write failure result
  jq -n \
    --arg status "failure" \
    --arg output "" \
    --arg error "$STDERR_OUTPUT" \
    --arg executor "claude-code" \
    --arg taskId "$SWARM_TASK_ID" \
    '{
      status: $status,
      output: $output,
      error: { category: "unknown", message: $error, retryable: true },
      executorId: $executor,
      taskId: $taskId,
      timestamp: (now | todate)
    }' > "$RESULT_FILE"
fi
```

#### Injection Hardening

When constructing retry prompts, use ONLY `result.error.category` and `result.error.message` (capped at 500 chars). Never inject `stackTrace` or raw `output` into retry context:

```typescript
// BEFORE (current — injection-vulnerable):
failureContext = `Error: ${stderr}`;  // raw stderr in prompt

// AFTER (hardened):
failureContext = `Error type: ${result.error.category}
Message: ${result.error.message.slice(0, 500)}
Retryable: ${result.error.retryable}`;
// stackTrace stays in logs only, never in prompts
```

### Backward Compatibility

Bridges that haven't been updated yet still work:

```typescript
// Fallback: if result.json doesn't exist but exit code is 0, use stdout
if (!resultFileExists && exitCode === 0) {
  result = {
    status: "success",
    output: stdout.trim(),
    executorId,
    taskId: task.id,
    timestamp: new Date().toISOString(),
  };
}
```

### Files to Modify

| File | Change |
|------|--------|
| `orchestrate-v4.ts` ~1800 | Add result.json read + fallback logic |
| `orchestrate-v4.ts` ~2455 | Harden retry prompt construction |
| `bridges/claude-code-bridge.sh` | Write result.json on exit |
| `bridges/hermes-bridge.sh` | Write result.json on exit |
| `bridges/gemini-bridge.sh` | Write result.json on exit |
| `bridges/codex-bridge.sh` | Write result.json on exit |
| `types/executor.ts` | Add `ExecutorResult` type definition |

### Acceptance Criteria

- [ ] All 4 bridges write result.json on success and failure
- [ ] Orchestrator reads result.json when present, falls back to stdout when absent
- [ ] Stale result.json deleted before each task dispatch
- [ ] Missing result.json treated as crash
- [ ] Invalid JSON in result.json treated as crash with parse error logged
- [ ] Retry prompts use only `error.category` + truncated `error.message` (no raw stderr/stdout)
- [ ] `ExecutorResult` type exported from `types/executor.ts`
- [ ] Token usage from `metrics.promptTokens + metrics.outputTokens` replaces `output.length / 4` estimation
- [ ] Existing tests pass with both old (stdout) and new (result.json) paths

### Risks

- **Bridge jq dependency** — All bridges need `jq` installed. Mitigation: Already present on Zo. Fallback: use printf to write minimal JSON if jq missing.
- **Race condition** — Executor killed mid-write leaves partial JSON. Mitigation: Write to temp file, atomic rename (`mv tmp result.json`).

---

## Spec 3: Autonomous Loop Fast Path (program.md Pattern)

### Problem

The current swarm pipeline for any non-trivial task is:

```
spec-first-interview → seed YAML → eval seed → amend → approve → execute DAG → post-flight eval
```

This is correct for multi-task, multi-executor work. But some tasks are **single-metric optimization loops** that don't need a DAG:

- Trading strategy backtests (iterate params, measure Sharpe ratio)
- Site performance tuning (iterate config, measure Lighthouse score)
- Prompt optimization (iterate prompt, measure eval accuracy)
- SEO experiments (iterate meta tags, measure ranking delta)

For these, the overhead of seed YAML + DAG is unnecessary. Autoresearch proves that a single markdown file (`program.md`) can drive an effective autonomous loop.

### Proposed: `autoloop` Skill

A new skill that implements the autoresearch pattern generalized beyond ML training.

#### Skill Structure

```
Skills/autoloop/
├── SKILL.md                    # Skill definition
├── scripts/
│   └── autoloop.ts             # Loop runner
├── assets/
│   └── template.program.md     # Template for new programs
└── references/
    └── autoresearch-patterns.md  # Reference notes
```

#### Program.md Schema

Users write a `program.md` in their project directory. The autoloop runner reads it.

```markdown
# Program: {name}

## Objective
{one sentence: what metric are we optimizing}

## Metric
- **name**: {metric name, e.g., "sharpe_ratio"}
- **direction**: {lower_is_better | higher_is_better}
- **extract**: {shell command that prints the metric value, e.g., `jq .sharpe result.json`}

## Setup
{one-time setup steps the agent runs before the loop}

## Target File
{path to the single file the agent edits, e.g., `strategy.py`}

## Run Command
{command to execute one experiment, e.g., `bun run backtest.ts`}

## Constraints
- DO NOT modify: {list of read-only files}
- DO NOT install: {new packages, etc.}
- Time budget per run: {e.g., 5 minutes}
- VRAM/memory limit: {optional}

## Simplicity Criterion
{copied from autoresearch: prefer simpler code at equal performance}

## Loop Behavior
- On improvement: keep commit, advance branch
- On regression: git reset to last good commit
- On crash: log, attempt fix (max 3 tries), skip if unfixable
- On stagnation (N experiments with no improvement): {try radical changes | stop}
- NEVER STOP unless manually interrupted
```

#### autoloop.ts Runner

```typescript
#!/usr/bin/env bun

interface ProgramConfig {
  name: string;
  metric: { name: string; direction: "lower_is_better" | "higher_is_better"; extract: string };
  targetFile: string;
  runCommand: string;
  constraints: { readOnly: string[]; timeBudgetSeconds: number };
  stagnationThreshold: number;  // experiments with no improvement before radical mode
}

interface ExperimentRecord {
  commit: string;       // short hash
  metric: number;       // extracted value
  status: "keep" | "discard" | "crash";
  description: string;  // what was tried
  timestamp: string;
}

async function loop(config: ProgramConfig, executor: string): Promise<void> {
  const branch = `autoloop/${config.name}-${Date.now()}`;
  await $`git checkout -b ${branch}`;

  let bestMetric = await runBaseline(config);
  let stagnationCount = 0;
  let experimentCount = 0;
  const results: ExperimentRecord[] = [];

  while (true) {  // NEVER STOP
    experimentCount++;

    // 1. Agent proposes a change to targetFile
    const hypothesis = await proposeChange(config, results, stagnationCount);

    // 2. Commit the change
    await $`git add ${config.targetFile}`;
    await $`git commit -m "experiment ${experimentCount}: ${hypothesis}"`;
    const commit = (await $`git rev-parse --short HEAD`).text().trim();

    // 3. Run the experiment
    const { metric, crashed } = await runExperiment(config);

    // 4. Evaluate
    if (crashed) {
      results.push({ commit, metric: 0, status: "crash", description: hypothesis, timestamp: new Date().toISOString() });
      await $`git reset --hard HEAD~1`;
      stagnationCount++;
    } else if (isBetter(metric, bestMetric, config.metric.direction)) {
      results.push({ commit, metric, status: "keep", description: hypothesis, timestamp: new Date().toISOString() });
      bestMetric = metric;
      stagnationCount = 0;  // reset
    } else {
      results.push({ commit, metric, status: "discard", description: hypothesis, timestamp: new Date().toISOString() });
      await $`git reset --hard HEAD~1`;
      stagnationCount++;
    }

    // 5. Log to results.tsv
    await appendTSV(results[results.length - 1]);

    // 6. Stagnation check
    if (stagnationCount >= config.stagnationThreshold) {
      // Switch to radical exploration mode
      // (agent gets instruction to try bigger changes)
    }
  }
}
```

#### Integration with Existing Systems

| Component | Integration Point |
|-----------|-------------------|
| **Swarm orchestrator** | Not used. Autoloop is a separate, simpler path |
| **OmniRoute** | Used for model selection per experiment (via tier-resolve) |
| **Memory system** | Store experiment results as episodes for cross-session learning |
| **Circuit breaker v2** | Apply to the executor running the loop (if it keeps crashing, pause) |
| **JSON results contract** | Each experiment writes result.json (Spec 2 applies here) |
| **Zo agents** | An autoloop can be scheduled as a Zo agent (run overnight) |

#### Use Case Templates

**Trading Strategy Optimization:**
```markdown
## Metric
- name: sharpe_ratio
- direction: higher_is_better
- extract: jq .sharpe backtest-result.json

## Target File
strategies/momentum.ts

## Run Command
bun run Scripts/backtest.ts --strategy momentum --period 90d
```

**Site Performance:**
```markdown
## Metric
- name: lighthouse_score
- direction: higher_is_better
- extract: jq .categories.performance.score lighthouse-result.json

## Target File
server/config/performance.ts

## Run Command
lighthouse https://marlandoj.zo.space --output json --output-path lighthouse-result.json
```

**Prompt Optimization:**
```markdown
## Metric
- name: eval_accuracy
- direction: higher_is_better
- extract: jq .accuracy eval-result.json

## Target File
prompts/classifier.md

## Run Command
bun run Skills/three-stage-eval/scripts/evaluate.ts --seed prompt-eval-seed.yaml
```

### Files to Create

| File | Purpose |
|------|---------|
| `Skills/autoloop/SKILL.md` | Skill definition with frontmatter |
| `Skills/autoloop/scripts/autoloop.ts` | Main loop runner |
| `Skills/autoloop/assets/template.program.md` | Template for new programs |
| `Skills/autoloop/references/autoresearch-patterns.md` | Reference doc |

### Acceptance Criteria

- [ ] `autoloop.ts` reads a `program.md` and executes the loop
- [ ] Baseline established on first run
- [ ] Improvements kept (commit stays), regressions reverted (git reset)
- [ ] Crashes logged and recovered from (max 3 fix attempts)
- [ ] `results.tsv` maintained with commit, metric, status, description
- [ ] Stagnation detection triggers radical exploration mode
- [ ] Loop runs indefinitely until manually stopped
- [ ] Each experiment writes `result.json` (Spec 2 contract)
- [ ] Can be scheduled as a Zo agent for overnight runs
- [ ] Template program.md covers: trading backtest, site perf, prompt optimization

### Risks

- **Runaway costs** — Unlimited loop with an expensive executor. Mitigation: Add optional `maxExperiments` and `maxCostUSD` fields to program.md. Default to 100 experiments.
- **Git branch pollution** — Each loop creates a branch. Mitigation: Auto-cleanup branches older than 7 days with no keeper commits.
- **Agent quality** — The proposing agent might make poor hypotheses. Mitigation: Inject results history into context so the agent learns from failures. Stagnation threshold triggers strategy shift.

---

## Implementation Order

| Phase | Spec | Effort | Dependencies |
|-------|------|--------|--------------|
| 1 | Circuit Breaker v2 | ~2 hours | None — modifies orchestrate-v4.ts only |
| 2 | JSON Results Contract | ~3 hours | None — but benefits from Phase 1 (error categories feed cooldowns) |
| 3 | Autoloop Skill | ~4 hours | Benefits from Phase 1 (breaker protects loop executor) and Phase 2 (result.json contract) |

Phases 1 and 2 are independent and could be implemented in parallel. Phase 3 depends on both.
