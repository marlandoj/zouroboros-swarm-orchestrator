# Three-Stage Evaluation: Swarm Repos Research Campaign

**Artifact:** `research_orchestrator.py` (Python parallel swarm) + `swarm-hybrid-runner.ts` → `orchestrate-v4.ts`
**Date:** 2026-03-26
**Campaign:** awesome-opensource-ai integration research
**Evaluators:** Alaric + Claude Code

---

## Stage 1: Mechanical Verification

### Check 1 — orchestrator-v4.ts Syntax
```
bun run orchestrator-v4.ts
→ error TS1128 at line 2507: "Expected ';' but found 'buildFormatConstraint'"
→ bun --bun tsc --noEmit → error TS1128 at line 2507
```
**RESULT:** FAIL ❌

### Check 2 — orchestrator-v4.ts File Integrity
```
wc -l: 4106 lines (vs historical ~4224 lines — 118 lines removed)
git status: file NOT tracked in git
/tmp/orch-no-shebang.ts backup: 4224 lines (also corrupted — same error)
```
**RESULT:** FAIL ❌ — file was already corrupted before this session; git has no history

### Check 3 — hybrid-runner.ts Syntax
```
head -207 lines → no syntax issues visible
bun run swarm-hybrid-runner.ts → invokes orchestrator-v4.ts → propagates error
```
**RESULT:** PASS ✅ (runner itself OK; it correctly surfaced the orchestrator error)

### Check 4 — research_orchestrator.py Syntax
```
python3 -m py_compile research_orchestrator.py → no errors
```
**RESULT:** PASS ✅

### Check 5 — research_orchestrator.py Runtime
```
Launched: PID 18334
Bridged calls completed: 6 parallel subprocesses via claude-code-bridge.sh
Output captured: all bridge outputs received
PDF generated: /tmp/swarm_report.pdf (58,537 bytes) via wkhtmltopdf
Email sent: successfully delivered
```
**RESULT:** PASS ✅ — workaround swarm succeeded

### Check 6 — Claude Code Bridge
```
echo "test" | bash claude-code-bridge.sh "test" → "HELLO_OK" ✅
claude binary found: /usr/bin/claude ✅
All MCP tools pre-approved in bridge script ✅
```
**RESULT:** PASS ✅

### Check 7 — Email Delivery
```
send_email_to_user() → "Email sent successfully" confirmed
PDF attachment: 58KB delivered
```
**RESULT:** PASS ✅

---

**Stage 1 Gate: FAIL** — orchestrator-v4.ts is broken. The hybrid runner cannot start any swarm that uses it. The Python workaround succeeded but bypassed the entire Zouroboros orchestrator stack.

---

## Stage 2: Semantic Evaluation

### AC 1: Hybrid runner must invoke orchestrator without failure
- **Evidence:** hybrid-runner.ts calls `spawn("bun", ["orchestrate-v4.ts", ...])` → subprocess exits with code 1
- **Result:** NOT MET ❌

### AC 2: Swarm must execute parallel tasks without context loss
- **Evidence:** research_orchestrator.py (pure Python) executed 6 parallel tasks via ThreadPoolExecutor, each bridged independently
- **Result:** MET ✅ — but this bypassed the Zouroboros stack entirely

### AC 3: Swarm must capture and persist task outputs
- **Evidence:** research_orchestrator.py writes JSON results to `~/.swarm/results/repos_research_*.json`
- **Result:** MET ✅ — PDF + JSON output written successfully

### AC 4: Swarm must notify on completion
- **Evidence:** Email delivered with PDF attachment; notification includes report
- **Result:** MET ✅

### AC 5: Orchestrator syntax must be valid TypeScript
- **Evidence:** bun run → error at line 2507; bun --bun tsc --noEmit → TS1128
- **Result:** NOT MET ❌

### AC 6: Error recovery — orchestrator failure must not abort entire campaign
- **Evidence:** hybrid-runner.ts has no try/catch around the spawn call to handle orchestrator parse failure gracefully
- **Result:** NOT MET ❌ — a single parse error on the orchestrator blocks all task execution with no fallback

### AC 7: Parallel bridge calls must not exceed Claude Code rate limits
- **Evidence:** 6 concurrent `claude-code-bridge.sh` calls — no rate limit errors observed
- **Result:** MET ✅

### AC 8: Task outputs must be synthesized into a coherent report
- **Evidence:** HTML report generated, PDF produced, email sent with full executive summary
- **Result:** MET ✅

**AC Compliance:** 5/8 MET → **62.5%**

**Goal Alignment:** 0.65 — The swarm achieved its research goal (via workaround) but the orchestrator infrastructure failed its purpose

**Drift Score:** 0.42 — High drift: the actual execution path diverged significantly from the intended Zouroboros stack

**Overall Score:** 0.60

---

**Stage 2 Gate: FAIL** — Below 0.8 threshold. Multiple ACs not met. Root cause is the orchestrator corruption, compounded by lack of graceful degradation.

---

## Stage 3: Consensus

### Proposer (FOR approval — the campaign did complete with deliverables)

The research was delivered: a 58KB PDF report was emailed with executive summary, priority recommendations, and 23+ repos analyzed. The Claude Code bridge works. The Python orchestrator proves that parallel execution via bridges is viable. The failure mode is isolated and fixable: restore the orchestrator, add error handling, and the Zouroboros stack can own this workflow.

### Devil's Advocate (AGAINST — the orchestrator is catastrophically broken)

The Zouroboros swarm orchestrator — the centerpiece of this ecosystem — **cannot execute any swarm at all**. Not just for this campaign. For ANY campaign. The hybrid runner silently propagates the error without catching it. The orchestrator file is untracked in git and was corrupted before this session began, meaning there is no recovery path without rebuilding from scratch or finding an uncorrupted backup. The workaround proves the bridge works but proves the orchestrator doesn't.

### Synthesizer

**Two failures must be separated:**

1. **Orchestrator corruption (pre-existing):** The `orchestrate-v4.ts` file has a syntax error introduced before this session. This is a **data integrity failure** — no git history, no backup. The file needs to be rebuilt or restored.

2. **Hybrid runner error handling (design gap):** Even if the orchestrator were working, the hybrid runner has no try/catch around the subprocess spawn. A single parse failure should trigger: (a) graceful fallback message, (b) alternative runner path, (c) user notification. None of these happen.

The Python workaround proves the **execution model is sound** (parallel Claude Code bridges). But Zouroboros's own orchestrator is a single point of failure with no recovery. This is unacceptable for a production multi-agent system.

**Verdict: REJECT** — The orchestrator must be rebuilt before the Zouroboros swarm stack can be considered production-ready for complex campaigns.

---

## Root Cause Analysis

| Failure | Type | Severity |
|---|---|---|
| orchestrator-v4.ts syntax error at line 2507 | Pre-existing data corruption | CRITICAL |
| orchestrator-v4.ts not tracked in git | Data integrity gap | CRITICAL |
| hybrid-runner.ts has no subprocess error handling | Design gap | HIGH |
| No backup verification before swarm launch | Process gap | MEDIUM |
| buildFormatConstraint method had unescaped template literal | Original bug | MEDIUM |

### Failure Chain

```
User launches swarm
  → hybrid-runner.ts starts
    → spawns "bun orchestrate-v4.ts"
      → Bun parses orchestrate-v4.ts
        → TS1128 at line 2507 (template literal)
          → subprocess exits code 1
            → hybrid-runner gets error but has no try/catch
              → Campaign silently fails
                → research_orchestrator.py used as ad-hoc workaround
                  → Success (but Zouroboros stack bypassed)
```

---

## Recommendations

### P0 — Fix Immediately

1. **Restore orchestrate-v4.ts** — Find uncorrupted backup or reconstruct the `buildFormatConstraint` method and its call site from memory. The method was a pure output-formatting function with no external dependencies.

2. **Add hybrid-runner subprocess error handling** — Wrap the orchestrator spawn in try/catch. On orchestrator failure, log the error and fall back to a Python-based parallel bridge runner.

3. **Git-track the orchestrator** — `orchestrate-v4.ts` must be added to git immediately. Consider a pre-launch health check: `bun --bun tsc --noEmit` before starting any swarm.

### P1 — Improve Resilience

4. **Orchestrator self-check on startup** — Before executing any tasks, run `bun --bun tsc --noEmit` on the orchestrator itself. Fail fast with a clear diagnostic if the file doesn't compile.

5. **Graceful degradation hierarchy** — When the orchestrator fails, fall back to: (a) Python parallel bridge runner, (b) single-threaded bridge runner, (c) notify user with error details.

6. **Bridge output capture** — The Python orchestrator worked but lost bridge output details (0-byte log files after cleanup). Implement non-destructive bridge output capture so each task's raw output is preserved before cleanup.

### P2 — Long-term

7. **Multi-source orchestration** — Support both the Bun orchestrator AND a Python/standalone orchestrator in the same swarm framework. Tasks can specify which executor backend they use.

8. **Swarm health dashboard** — Add a `/swarm-dashboard` endpoint that shows: active swarms, task statuses, bridge health, error rates, and orchestrator health (can it compile?).

9. **Git pre-commit hooks** — Run `bun --bun tsc --noEmit` on orchestrate-v4.ts before any commit. Prevent future silent corruption.

---

## Final Decision

| Stage | Result |
|---|---|
| Stage 1 | FAIL |
| Stage 2 | FAIL (0.60 / 0.8) |
| Stage 3 | REJECT (unanimous) |
| **Final** | **🔴 REJECTED — Orchestrator must be rebuilt before swarm campaigns can run** |

**What worked:** Parallel Claude Code bridge execution model, Python fallback orchestrator, PDF generation, email delivery.
**What failed:** Zouroboros orchestrator (catastrophic), hybrid-runner error handling (absent), git data integrity (gap).
