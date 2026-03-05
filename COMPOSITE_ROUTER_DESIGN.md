# Composite Router Design — Swarm Orchestrator v4.2

**Date:** 2026-03-05  
**Status:** Design proposal  
**Author:** Claude Code  
**Scope:** Replace keyword-only `autoRouteTask()` with a multi-signal composite router

---

## Problem Statement

The current `autoRouteTask()` answers: *"Which executor knows about this topic?"* (keyword matching against `expertise`/`best_for`).

It does **not** answer the more important question: *"Which executor will most reliably complete this task right now?"*

That requires combining four signals:

| Signal | Exists Today | Wired into Routing |
|--------|-------------|-------------------|
| 1. Capability match (keyword similarity) | ✅ `autoRouteTask()` | ✅ |
| 2. Executor health (circuit breaker state) | ✅ `isCircuitOpen()` | ❌ (only blocks, doesn't reroute) |
| 3. Task complexity estimate | ❌ | ❌ |
| 4. Historical success rate | ❌ | ❌ |

---

## Design: Composite Scoring Router

### Core Idea

Replace the single keyword score with a **weighted composite score** across all four signals. Each signal produces a 0–1 normalized score. The final routing decision is:

```
score(executor, task) = w1 * capability + w2 * health + w3 * complexity_fit + w4 * history
```

Pick the executor with the highest composite score.

### Signal Definitions

#### Signal 1: Capability Match (existing — refactored)

What exists today in `autoRouteTask()` lines 1678–1773. Keyword + stem matching against `expertise` and `bestFor`.

**Change:** Normalize the raw score to 0–1 by dividing by the max possible score for that executor (sum of all keyword weights).

```typescript
interface CapabilityScore {
  raw: number;          // existing score from autoRouteTask
  normalized: number;   // raw / maxPossible → 0..1
  matches: string[];    // which keywords hit
}
```

#### Signal 2: Health Score (exists — needs wiring)

Currently `isCircuitOpen()` is binary: open or closed. We need a gradient.

```typescript
interface HealthScore {
  normalized: number;  // 0..1
  // Derived from:
  //   failures: number of consecutive failures
  //   lastFailure: how recent
  //   isOpen: circuit breaker state
}

function healthScore(persona: string): number {
  const cb = this.circuitBreakers.get(persona);
  if (!cb) return 1.0;               // No failure history → perfect health
  if (cb.isOpen) return 0.0;         // Circuit open → do not route
  
  // Gradient: degrade score with each failure
  // 0 failures → 1.0, 1 failure → 0.7, 2 failures → 0.4
  const failurePenalty = cb.failures * 0.3;
  
  // Recency bonus: if last failure was >15s ago, recover partially
  const recencyBonus = cb.lastFailure > 0
    ? Math.min(0.2, (Date.now() - cb.lastFailure) / 60000 * 0.2)
    : 0;
  
  return Math.max(0, Math.min(1.0, 1.0 - failurePenalty + recencyBonus));
}
```

**Key change:** Instead of skipping a task when the circuit is open, the router **demotes** the executor and tries alternatives. The circuit breaker becomes an input to routing, not a gate.

#### Signal 3: Complexity Fit (new)

Estimate task complexity from the prompt text, then match it to executor strengths.

```typescript
type ComplexityTier = "trivial" | "simple" | "moderate" | "complex";

interface ComplexityEstimate {
  tier: ComplexityTier;
  signals: {
    wordCount: number;
    fileCount: number;      // how many files referenced in the prompt
    hasMultiStep: boolean;  // "then", "after that", "next", numbered steps
    hasTool: boolean;       // references specific tools/commands
    hasAnalysis: boolean;   // "analyze", "review", "audit", "compare"
  };
}

function estimateComplexity(task: Task): ComplexityEstimate {
  const text = task.task.toLowerCase();
  const words = text.split(/\s+/).length;
  
  // Count file paths referenced
  const fileRefs = (text.match(/\/[\w\-./]+\.\w+/g) || []).length;
  
  // Multi-step indicators
  const hasMultiStep = /\b(then|after that|next|step \d|finally|first|second|third)\b/.test(text)
    || (text.match(/\d+\.\s/g) || []).length >= 2;
  
  // Tool usage indicators
  const hasTool = /\b(git|npm|bun|pip|curl|sed|grep|mkdir|chmod|docker)\b/.test(text);
  
  // Analysis indicators
  const hasAnalysis = /\b(analy[zs]e|review|audit|compare|evaluate|assess|inspect)\b/.test(text);
  
  let tier: ComplexityTier;
  const complexity = (words > 200 ? 1 : 0) + (fileRefs > 3 ? 1 : 0)
    + (hasMultiStep ? 1 : 0) + (hasTool ? 1 : 0) + (hasAnalysis ? 1 : 0);
  
  if (complexity <= 1) tier = "trivial";
  else if (complexity <= 2) tier = "simple";
  else if (complexity <= 3) tier = "moderate";
  else tier = "complex";
  
  return { tier, signals: { wordCount: words, fileCount: fileRefs, hasMultiStep, hasTool, hasAnalysis } };
}
```

**Executor-complexity affinity matrix:**

| Executor | trivial | simple | moderate | complex |
|----------|---------|--------|----------|---------|
| codex | 1.0 | 0.9 | 0.5 | 0.2 |
| gemini | 0.7 | 0.8 | 0.9 | 0.8 |
| hermes | 0.5 | 0.7 | 0.8 | 0.7 |
| claude-code | 0.6 | 0.7 | 0.9 | 1.0 |

Rationale:
- **codex** (~3s/call) is fastest but has no tool access — ideal for trivial/simple, poor for complex
- **gemini** has large context (1M tokens) and multimodal — good all-rounder, great for moderate
- **hermes** has web/tool access — good for research-heavy moderate tasks
- **claude-code** has full filesystem + terminal — best for complex multi-file changes, overkill for trivial

```typescript
const COMPLEXITY_AFFINITY: Record<string, Record<ComplexityTier, number>> = {
  "codex":       { trivial: 1.0, simple: 0.9, moderate: 0.5, complex: 0.2 },
  "gemini":      { trivial: 0.7, simple: 0.8, moderate: 0.9, complex: 0.8 },
  "hermes":      { trivial: 0.5, simple: 0.7, moderate: 0.8, complex: 0.7 },
  "claude-code": { trivial: 0.6, simple: 0.7, moderate: 0.9, complex: 1.0 },
};

function complexityFitScore(executorId: string, complexity: ComplexityTier): number {
  return COMPLEXITY_AFFINITY[executorId]?.[complexity] ?? 0.5;
}
```

#### Signal 4: Historical Success Rate (new — persistent)

Track per-executor, per-category success rates across swarm runs. Stored in a simple JSON file that persists between campaigns.

```typescript
interface ExecutorHistory {
  // Key: `${executorId}:${category}` e.g. "claude-code:architecture"
  [key: string]: {
    attempts: number;
    successes: number;
    avgDurationMs: number;
    lastUpdated: number;
  };
}

// File: ~/.swarm/executor-history.json
const HISTORY_PATH = join(process.env.HOME || "/tmp", ".swarm", "executor-history.json");

function historyScore(executorId: string, category: string): number {
  const history = loadHistory();
  const key = `${executorId}:${category}`;
  const entry = history[key];
  
  if (!entry || entry.attempts < 3) {
    return 0.5; // Insufficient data — neutral score
  }
  
  return entry.successes / entry.attempts; // 0..1 success rate
}

function recordOutcome(executorId: string, category: string, success: boolean, durationMs: number): void {
  const history = loadHistory();
  const key = `${executorId}:${category}`;
  const entry = history[key] || { attempts: 0, successes: 0, avgDurationMs: 0, lastUpdated: 0 };
  
  entry.attempts++;
  if (success) entry.successes++;
  entry.avgDurationMs = (entry.avgDurationMs * (entry.attempts - 1) + durationMs) / entry.attempts;
  entry.lastUpdated = Date.now();
  
  // Cap history at last 50 attempts to avoid stale data dominating
  if (entry.attempts > 50) {
    // Decay: halve the counts to weight recent performance more
    entry.attempts = Math.ceil(entry.attempts / 2);
    entry.successes = Math.ceil(entry.successes / 2);
  }
  
  history[key] = entry;
  saveHistory(history);
}
```

---

### Composite Router Implementation

```typescript
interface RouteDecision {
  executorId: string;
  executorName: string;
  compositeScore: number;
  breakdown: {
    capability: number;
    health: number;
    complexityFit: number;
    history: number;
  };
  method: "composite" | "fallback";
}

// Weights — tunable per campaign or globally
interface RouterWeights {
  capability: number;   // default: 0.30
  health: number;       // default: 0.35  ← highest because broken tools = zero value
  complexityFit: number; // default: 0.20
  history: number;      // default: 0.15
}

const DEFAULT_WEIGHTS: RouterWeights = {
  capability: 0.30,
  health: 0.35,
  complexityFit: 0.20,
  history: 0.15,
};

private compositeRoute(task: Task, weights?: Partial<RouterWeights>): RouteDecision {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const complexity = estimateComplexity(task);
  const category = task.memoryMetadata?.category || "general";
  
  const candidates: RouteDecision[] = [];
  
  for (const [id, cap] of this.executorCapabilities) {
    // 1. Capability score (existing keyword logic, normalized)
    const capScore = this.capabilityScore(task, cap);
    
    // 2. Health score (from circuit breaker state)
    const hlth = this.healthScore(id);
    
    // 3. Complexity fit
    const cfit = complexityFitScore(id, complexity.tier);
    
    // 4. Historical success rate
    const hist = historyScore(id, category);
    
    const composite = (w.capability * capScore.normalized)
                    + (w.health * hlth)
                    + (w.complexityFit * cfit)
                    + (w.history * hist);
    
    candidates.push({
      executorId: id,
      executorName: cap.name,
      compositeScore: composite,
      breakdown: {
        capability: capScore.normalized,
        health: hlth,
        complexityFit: cfit,
        history: hist,
      },
      method: "composite",
    });
  }
  
  // Sort by composite score descending
  candidates.sort((a, b) => b.compositeScore - a.compositeScore);
  
  // Log top 3 for observability
  const top3 = candidates.slice(0, 3);
  console.log(`  🧭 [${task.id}] Route candidates (${complexity.tier}):`);
  for (const c of top3) {
    const b = c.breakdown;
    console.log(`     ${c.executorId}: ${c.compositeScore.toFixed(3)} ` +
      `(cap=${b.capability.toFixed(2)} hlth=${b.health.toFixed(2)} ` +
      `cplx=${b.complexityFit.toFixed(2)} hist=${b.history.toFixed(2)})`);
  }
  
  const winner = candidates[0];
  if (!winner || winner.compositeScore < 0.1) {
    // Everything is broken — hard fallback
    return {
      executorId: "claude-code",
      executorName: "Claude Code",
      compositeScore: 0,
      breakdown: { capability: 0, health: 0, complexityFit: 0, history: 0 },
      method: "fallback",
    };
  }
  
  return winner;
}
```

---

### Retry-with-Reroute (the big unlock)

Currently `executeTaskWithResilience` retries the **same executor** on failure. The composite router enables **retry-with-reroute**: on failure, temporarily penalize the failed executor and re-route to the next-best candidate.

```typescript
private async executeTaskWithResilience(task: Task): Promise<TaskResult> {
  const startTime = Date.now();
  let retries = 0;
  const triedExecutors = new Set<string>();
  const category = task.memoryMetadata?.category || "general";
  
  while (retries <= this.config.maxRetries) {
    // Route (or re-route) the task
    let executorId: string;
    if (task.persona !== "auto" && retries === 0) {
      // Explicit persona specified — honor it on first attempt
      executorId = task.persona;
    } else {
      // Auto-route or reroute after failure
      const decision = this.compositeRoute(task, undefined);
      executorId = decision.executorId;
      
      // If we already tried this executor and it failed, try next-best
      if (triedExecutors.has(executorId)) {
        const alternatives = this.getAllRouteCandidates(task)
          .filter(c => !triedExecutors.has(c.executorId) && c.compositeScore > 0.1);
        if (alternatives.length > 0) {
          executorId = alternatives[0].executorId;
          console.log(`  🔄 [${task.id}] Rerouting away from tried executors → ${executorId}`);
        }
        // else: no alternatives, retry same executor (better than nothing)
      }
    }
    
    triedExecutors.add(executorId);
    
    // Temporarily set task.persona for callAgent dispatch
    const originalPersona = task.persona;
    task.persona = executorId;
    
    try {
      const prompt = await this.buildOptimizedPrompt(task);
      console.log(`  🚀 [${task.id}] ${executorId} (attempt ${retries + 1})`);
      
      const output = await this.callAgent(executorId, prompt, task.timeoutSeconds);
      
      // Verify mutations if applicable
      const { verified, failures } = this.verifyMutations(task);
      if (!verified) {
        throw new Error(`Mutation verification failed: ${failures.join("; ")}`);
      }
      
      // Success — record to history
      this.recordSuccess(executorId);
      recordOutcome(executorId, category, true, Date.now() - startTime);
      
      task.persona = originalPersona;
      return {
        task,
        success: true,
        output,
        durationMs: Date.now() - startTime,
        retries,
      };
      
    } catch (error) {
      retries++;
      this.recordFailure(executorId);
      recordOutcome(executorId, category, false, Date.now() - startTime);
      
      console.log(`  ⚠️ [${task.id}] ${executorId} failed: ${error}`);
      
      if (retries <= this.config.maxRetries) {
        // Reroute on next iteration — the failed executor's health score
        // is now lower, so compositeRoute will naturally prefer alternatives
        const delay = Math.pow(2, Math.max(retries - 1, 0)) * 500;
        console.log(`  ⏳ [${task.id}] Will reroute in ${delay}ms...`);
        await this.sleep(delay);
      } else {
        task.persona = originalPersona;
        return {
          task,
          success: false,
          error: String(error),
          durationMs: Date.now() - startTime,
          retries: retries - 1,
        };
      }
    }
    
    task.persona = originalPersona;
  }
  
  // Unreachable but TypeScript needs it
  return { task, success: false, error: "Max retries exceeded", durationMs: Date.now() - startTime, retries };
}
```

---

### Campaign-Level Strategy Presets

Allow campaigns to declare a routing strategy that shifts the weights:

```json
{
  "swarmId": "ffb-sprint-4",
  "routingStrategy": "reliable",
  "tasks": [...]
}
```

| Strategy | capability | health | complexityFit | history | Use case |
|----------|-----------|--------|---------------|---------|----------|
| `fast` | 0.15 | 0.25 | 0.45 | 0.15 | Dev iteration — prefer codex for speed |
| `reliable` | 0.20 | 0.45 | 0.15 | 0.20 | Production — prefer proven executors |
| `balanced` | 0.30 | 0.35 | 0.20 | 0.15 | Default — good all-rounder |
| `explore` | 0.40 | 0.20 | 0.20 | 0.20 | Try new executors — higher capability weight |

---

### Config Integration

Add to `config.json`:

```json
{
  "routing": {
    "strategy": "balanced",
    "weights": null,
    "complexityAffinity": null,
    "historyFile": "~/.swarm/executor-history.json",
    "historyDecayThreshold": 50,
    "enableReroute": true,
    "logCandidates": 3
  }
}
```

All fields optional — missing values fall back to defaults.

---

## Implementation Plan

### Phase 1: Foundation (2–3 hours)

| Step | What | Lines touched | Risk |
|------|------|--------------|------|
| 1a | Add `ComplexityEstimate` type and `estimateComplexity()` | New function, ~40 lines | None — pure function |
| 1b | Add `COMPLEXITY_AFFINITY` matrix and `complexityFitScore()` | New constant + function, ~15 lines | None — pure function |
| 1c | Refactor `autoRouteTask()` → `capabilityScore()` returning normalized 0–1 | Refactor lines 1678–1773 | Low — same logic, different return type |
| 1d | Add `healthScore()` gradient function | New function, ~15 lines | None — supplements existing circuit breaker |

### Phase 2: Composite Router (2–3 hours)

| Step | What | Lines touched | Risk |
|------|------|--------------|------|
| 2a | Add `ExecutorHistory` type and persistence (load/save JSON) | New module, ~60 lines | Low — file I/O, best-effort |
| 2b | Add `compositeRoute()` method | New method, ~60 lines | Low — replaces `autoRouteTask` for `persona: "auto"` |
| 2c | Wire `compositeRoute` into `validatePersonas()` replacing `autoRouteTask` | Edit lines 1641–1648 | Medium — changes routing path |
| 2d | Add `recordOutcome()` calls to `executeTaskWithResilience` | Edit lines 1030–1155 | Low — additive |

### Phase 3: Retry-with-Reroute (2–3 hours)

| Step | What | Lines touched | Risk |
|------|------|--------------|------|
| 3a | Refactor `executeTaskWithResilience` retry loop | Rewrite lines 1030–1155 | Medium — core execution path |
| 3b | Add strategy presets and config loading | Edit `loadConfig()` | Low — additive config |
| 3c | NDJSON logging for routing decisions | Edit logger calls | Low — observability only |

### Phase 4: Validation (1–2 hours)

| Step | What |
|------|------|
| 4a | Run FFB workload with `"routingStrategy": "balanced"` — compare to baseline |
| 4b | Simulate executor failure (kill bridge mid-run) — verify reroute happens |
| 4c | Run 3 campaigns to seed history, verify history file populates |
| 4d | Compare wall-clock time across strategies: fast vs reliable vs balanced |

---

## Expected Impact

| Scenario | Before (v4.1) | After (v4.2) | Improvement |
|----------|--------------|-------------|-------------|
| Executor bridge fails | Retry same executor 3x → fail | Reroute to alternative → succeed | **Task saved** |
| Trivial task sent to claude-code | 600s timeout, overkill | Routed to codex (3s) | **~200x faster per task** |
| Circuit breaker opens | All tasks for that executor skip | Tasks reroute to next-best | **Zero skipped tasks** |
| New executor added | No tasks routed to it | Capability matching includes it | **Auto-discovery** |

---

## Observability

Every routing decision logged to NDJSON:

```json
{
  "ts": "2026-03-05T14:30:00Z",
  "event": "composite_route",
  "taskId": "analyze-homepage",
  "complexity": "moderate",
  "winner": "gemini",
  "compositeScore": 0.782,
  "breakdown": { "capability": 0.85, "health": 1.0, "complexityFit": 0.9, "history": 0.67 },
  "candidates": [
    { "id": "gemini", "score": 0.782 },
    { "id": "claude-code", "score": 0.745 },
    { "id": "codex", "score": 0.412 }
  ],
  "reroute": false
}
```

---

## Open Questions

1. **Should history decay on a time basis too?** Currently it decays by count (halve at 50 attempts). Could also decay entries older than 7 days.
2. **Should campaign-level strategy override per-task persona?** Currently `persona: "auto"` opts into composite routing; explicit personas skip it. Should `"routingStrategy": "fast"` override even explicit personas?
3. **Should the complexity affinity matrix be configurable per-campaign?** Some users might know that their codex setup handles complex tasks fine.
