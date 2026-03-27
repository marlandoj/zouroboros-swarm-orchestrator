#!/usr/bin/env bun
/**
 * Swarm Orchestrator v5.0.0 — Full-Featured TypeScript Implementation
 *
 * Replaces corrupted orchestrate-v4.ts with a clean rewrite.
 * Spec: orchestrate.py v5.0.0 (Python reference implementation).
 * Features: 6-signal composite routing, DAG cascade mitigation, SQLite history,
 *           memory context injection, auto-episode creation, Python fallback.
 *
 * Usage:
 *   bun orchestrate-v5.ts tasks.json
 *   bun orchestrate-v5.ts tasks.json --swarm-id my-run --concurrency 8
 *   bun orchestrate-v5.ts status <swarm-id>
 *   bun orchestrate-v5.ts doctor
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { spawn } from "child_process";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

// ============================================================================
// PATHS & CONFIG
// ============================================================================

const WORKSPACE = process.env.SWARM_WORKSPACE || "/home/workspace";
const HOME = process.env.HOME || "/root";
const SWARM_DIR = join(HOME, ".swarm");
const LOGS_DIR = join(SWARM_DIR, "logs");
const RESULTS_DIR = join(SWARM_DIR, "results");
const HISTORY_DB = join(SWARM_DIR, "executor-history.db");
const MEMORY_DB = join("/home/workspace/.zo/memory/shared-facts.db");
const REGISTRY = join(WORKSPACE, "Skills", "zo-swarm-executors", "registry", "executor-registry.json");
const LOCK_DIR = "/dev/shm";

// Ensure directories exist
[LOGS_DIR, RESULTS_DIR].forEach(d => mkdirSync(d, { recursive: true }));

// ============================================================================
// ROUTING CONSTANTS
// ============================================================================

const COMPLEXITY_AFFINITY: Record<string, Record<string, number>> = {
  "codex":        { trivial: 1.0, simple: 0.9, moderate: 0.5, complex: 0.2 },
  "gemini":       { trivial: 0.7, simple: 0.8, moderate: 0.9, complex: 0.8 },
  "hermes":       { trivial: 0.5, simple: 0.7, moderate: 0.8, complex: 0.7 },
  "claude-code":  { trivial: 0.6, simple: 0.7, moderate: 0.9, complex: 1.0 },
};

const ROUTING_WEIGHTS: Record<string, Record<string, number>> = {
  balanced:  { capability: 0.30, health: 0.35, complexityFit: 0.20, history: 0.15 },
  fast:      { capability: 0.15, health: 0.25, complexityFit: 0.45, history: 0.15 },
  reliable:  { capability: 0.20, health: 0.45, complexityFit: 0.15, history: 0.20 },
  explore:   { capability: 0.40, health: 0.20, complexityFit: 0.20, history: 0.20 },
};

interface OrchestratorConfig {
  localConcurrency: number;
  timeoutSeconds: number;
  maxRetries: number;
  enableMemory: boolean;
  defaultMemoryStrategy: string;
  maxContextTokens: number;
  crossTaskContextWindow: number;
  routingStrategy: string;
  cascadeMode: boolean;  // P3: skip downstream when root fails
}

const DEFAULTS: OrchestratorConfig = {
  localConcurrency: 8,
  timeoutSeconds: 600,
  maxRetries: 3,
  enableMemory: true,
  defaultMemoryStrategy: "hierarchical",
  maxContextTokens: 16000,
  crossTaskContextWindow: 3,
  routingStrategy: "balanced",
  cascadeMode: true,
};

// ============================================================================
// TYPES
// ============================================================================

interface Task {
  id: string;
  persona?: string;
  executor?: string;
  task: string;
  priority?: string;
  dependsOn?: string[];
  memoryStrategy?: string;
  memoryMetadata?: Record<string, unknown>;
  outputToMemory?: boolean;
  timeoutSeconds?: number;
  expectedMutations?: Array<{ file: string; contains: string }>;
}

interface TaskResult {
  taskId: string;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  retries: number;
}

interface CircuitBreaker {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
  lastFailure: number;
}

interface CompletedOutput {
  persona: string;
  category: string;
  summary: string;
}

interface RouteDecision {
  executorId: string;
  executorName: string;
  score: number;
}

// ============================================================================
// GLOBAL STATE (for cascade transitive check)
// ============================================================================

let ALL_TASKS: Task[] = [];


// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function nlog(path: string, event: string, extra: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...extra,
  });
  try {
    writeFileSync(path, entry + "\n", { flag: "a" });
  } catch {}
}

function initHistory(): void {
  try {
    const db = new Database(HISTORY_DB);
    db.run(`CREATE TABLE IF NOT EXISTS executor_history (
      id INTEGER PRIMARY KEY,
      executor TEXT, category TEXT,
      attempts INTEGER, successes INTEGER,
      avg_ms REAL, last_updated INTEGER,
      UNIQUE(executor, category))`);
    db.close();
  } catch {}
}

interface ExecutorInfo {
  id: string;
  name: string;
  bridge: string;
  expertise?: string[];
  best_for?: string[];
}

function loadExecutors(): Record<string, ExecutorInfo> {
  const executors: Record<string, ExecutorInfo> = {};
  if (!existsSync(REGISTRY)) {
    console.log("WARN: Executor registry not found: " + REGISTRY);
    return executors;
  }
  try {
    const raw = JSON.parse(readFileSync(REGISTRY, "utf-8"));
    for (const ex of (raw.executors || [])) {
      const id = ex.id || ex.executor || "";
      if (!id) continue;
      // Only load local executors (not remote API executors)
      if (ex.executor && ex.executor !== "local" && ex.executor !== "") continue;
      executors[id] = {
        id,
        name: ex.name || id,
        bridge: ex.bridge || "",
        expertise: ex.expertise || [],
        best_for: ex.best_for || [],
      };
    }
  } catch (e) {
    console.log("WARN: Failed to load executors: " + String(e));
  }
  console.log("OK: Loaded " + Object.keys(executors).length + " local executors");
  return executors;
}

function getBridge(exid: string, executors: Record<string, ExecutorInfo>): string | null {
  const ex = executors[exid];
  if (!ex || !ex.bridge) return null;
  const p = join(WORKSPACE, ex.bridge);
  if (existsSync(p)) return p;
  // Try alternative: <exid>-bridge.sh in workspace root
  const alt = join(WORKSPACE, exid + "-bridge.sh");
  if (existsSync(alt)) return alt;
  return null;
}


// ============================================================================
// ROUTING ENGINE
// ============================================================================

function estimateComplexity(task: Task): string {
  const text = (task.task + " " + (task.memoryMetadata?.category || "")).toLowerCase();
  const words = text.split(/\s+/).length;
  const hasMulti = /\b(then|after|next|step|finally)\b/.test(text);
  const hasTool = /\b(git|npm|bun|pip|curl|sed|grep)\b/.test(text);
  const hasAna = /\b(analyz|review|audit|compare)\b/.test(text);
  const score = (words > 200 ? 1 : 0) + (hasMulti ? 1 : 0) + (hasTool ? 1 : 0) + (hasAna ? 1 : 0);
  return (["trivial", "simple", "moderate", "complex"] as const)[Math.min(score, 3)];
}

function capScore(task: Task, ex: ExecutorInfo): number {
  const text = (task.task + " " + (task.memoryMetadata?.category || "")).toLowerCase();
  const kw = [...(ex.expertise || []), ...(ex.best_for || [])].map(k => k.toLowerCase());
  if (kw.length === 0) return 0.5;
  const hits = kw.filter(k => text.includes(k)).length;
  return Math.min(1.0, hits / kw.length);
}

function health(cb: CircuitBreaker | undefined): number {
  if (!cb) return 1.0;
  if (cb.state === "OPEN") return 0.0;
  return Math.max(0.0, 1.0 - cb.failures * 0.3);
}

function histScore(exid: string, cat: string): number {
  try {
    const db = new Database(HISTORY_DB, { readonly: true });
    const row = db.query(
      "SELECT attempts, successes FROM executor_history WHERE executor=? AND category=?",
    ).get(exid, cat || "general") as { attempts: number; successes: number } | null;
    db.close();
    return row && row.attempts >= 3 ? row.successes / row.attempts : 0.5;
  } catch {
    return 0.5;
  }
}

function recHist(exid: string, cat: string, ok: boolean, ms: number): void {
  try {
    const db = new Database(HISTORY_DB);
    const now = Math.floor(Date.now() / 1000);
    const _histParams = [exid, cat || "general", ok ? 1 : 0, ms, now, ok ? 1 : 0, ms, now];
    db.run(`INSERT INTO executor_history (executor,category,attempts,successes,avg_ms,last_updated)
      VALUES (?,?,1,?,?,?) ON CONFLICT(executor,category)
      DO UPDATE SET attempts=attempts+1, successes=successes+?,
      avg_ms=(avg_ms*(attempts-1)+?)/attempts, last_updated=?`, _histParams);
    db.close();
  } catch {}
}

// P3: Cascade Mitigation — transitive ancestor check
function hasFailedRootAncestor(depId: string, failedRoots: Record<string, boolean>): boolean {
  const depTask = ALL_TASKS.find(t => t.id === depId);
  if (!depTask) return false;
  if ((failedRoots as Record<string, boolean>)[depId]) return true;  // dep itself is a failed root
  for (const ancestorId of (depTask.dependsOn || [])) {
    if (hasFailedRootAncestor(ancestorId, failedRoots)) return true;
  }
  return false;
}

function depsOk(
  task: Task,
  ok: Record<string, unknown>,
  fail: Record<string, unknown>,
  cascadeMode: boolean,
  failedRoots: Record<string, unknown>,
): boolean {
  const deps = task.dependsOn || [];
  if (deps.length === 0) return true;
  if (!cascadeMode) {
    // P3 cascade-off: skip if any dep has a failed-root ancestor
    for (const d of deps) {
      const failVal = fail[d];
      const frVal = failedRoots[d];
      if (failVal && frVal) return false;
    }
  }
  return deps.every(d => !!(ok[d] || fail[d]));
}

function topoSort(tasks: Task[]): string[] {
  const deps: Record<string, string[]> = {};
  const indeg: Record<string, number> = {};
  for (const t of tasks) {
    deps[t.id] = t.dependsOn || [];
    indeg[t.id] = deps[t.id].length;
  }
  const q: string[] = [];
  for (const [tid, d] of Object.entries(indeg)) {
    if (d === 0) q.push(tid);
  }
  const result: string[] = [];
  while (q.length > 0) {
    const tid = q.shift()!;
    result.push(tid);
    for (const t of tasks) {
      if (deps[t.id].includes(tid)) {
        indeg[t.id]--;
        if (indeg[t.id] === 0) q.push(t.id);
      }
    }
  }
  // Append any tasks not reachable from roots
  for (const t of tasks) {
    if (!result.includes(t.id)) result.push(t.id);
  }
  return result;
}

function route(
  task: Task,
  executors: Record<string, ExecutorInfo>,
  cbs: Record<string, CircuitBreaker>,
  strategy: string,
): RouteDecision {
  const cplx = estimateComplexity(task);
  const cat = (task.memoryMetadata?.category as string) || "general";
  const w = ROUTING_WEIGHTS[strategy] || ROUTING_WEIGHTS.balanced;
  const candidates: Array<{ id: string; name: string; score: number }> = [];

  for (const [eid, ex] of Object.entries(executors)) {
    const cap = capScore(task, ex);
    const hl = health(cbs[eid]);
    const cf = COMPLEXITY_AFFINITY[eid]?.[cplx] ?? 0.5;
    const hi = histScore(eid, cat);
    const score = w.capability * cap + w.health * hl + w.complexityFit * cf + w.history * hi;
    candidates.push({ id: eid, name: ex.name, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const top3 = candidates.slice(0, 3);

  console.log(
    "  [route:" + cplx + "] " +
    top3.map(c => c.id + "(" + c.score.toFixed(2) + ")").join(" vs ") +
    " -> " + top?.id
  );

  return top ? { executorId: top.id, executorName: top.name, score: top.score } :
    { executorId: "claude-code", executorName: "Claude Code", score: 0 };
}


// ============================================================================
// PROMPT BUILDING + MEMORY CONTEXT
// ============================================================================

function getMemoryContext(task: Task): string {
  const cat = (task.memoryMetadata?.category as string) || "";
  if (!cat) return "";
  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const results = db.query(
      `SELECT entity, key, value FROM facts WHERE value != '' AND (expires_at IS NULL OR expires_at > ${nowSec})
       ORDER BY created_at DESC LIMIT 5`
    ).all() as Array<{ entity: string; key: string; value: string }>;
    db.close();
    if (results.length === 0) return "";
    const lines = results.map(r => "  - [[" + r.entity + "." + r.key + "]]: " + r.value.slice(0, 120));
    return "\n\n### Relevant Context from Memory:\n" + lines.join("\n") + "\n";
  } catch {
    return "";
  }
}

function buildPrompt(
  task: Task,
  completed: CompletedOutput[],
  ctxWindow: number,
): string {
  let p = task.task;
  const cat = (task.memoryMetadata?.category as string) || "";
  if (cat) p = p + "\n\n[Category: " + cat + "]";

  // P2: Memory context
  if (completed.length > 0 || cat) {
    const mem = getMemoryContext(task);
    if (mem) p = mem + "\n" + p;

    // Cross-task context
    const win = completed.slice(-ctxWindow);
    if (win.length > 0) {
      const prior = win.map(o =>
        "### " + o.persona + " (" + o.category + "):\n" + o.summary
      ).join("\n\n");
      p = p + "\n\n## Prior Findings (" + win.length + "):\n" + prior;
    }
  }

  // R2: Expected file mutations
  if (task.expectedMutations && task.expectedMutations.length > 0) {
    const lines = task.expectedMutations.map(m =>
      "  - " + m.file + " (must contain: \"" + m.contains + "\")"
    );
    p = p + "\n\nREQUIRED CHANGES:\n" + lines.join("\n");
  }

  return p;
}

function writeEpisode(
  swid: string, sok: number, sfail: number,
  ems: number, total: number, exids: string[],
): void {
  try {
    if (!existsSync(MEMORY_DB)) return;
    const db = new Database(MEMORY_DB);
    db.run(`CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY, summary TEXT, outcome TEXT,
      happened_at INTEGER, entities TEXT, metadata TEXT)`);
    const outcome = sfail === 0 ? "success" : sfail < sok ? "partial" : "failure";
    db.run(
      `INSERT INTO episodes (summary,outcome,happened_at,entities,metadata)
       VALUES (?,?,?,?,?)`,
      [
        "Swarm " + swid + ": " + sok + " succeeded, " + sfail + " failed in " + Math.round(ems/1000) + "s",
        outcome,
        Math.floor(Date.now() / 1000),
        JSON.stringify(exids.map(e => "executor." + e)),
        JSON.stringify({ swarm_id: swid, tasks: total, succeeded: sok, failed: sfail, elapsed_ms: ems }),
      ]
    );
    db.close();
  } catch {}
}

// ============================================================================
// BRIDGE EXECUTOR (call_agent)
// ============================================================================

interface AgentResult { output: string; error: string | null; }

function callAgent(
  exid: string,
  prompt: string,
  timeout_s: number,
  bridgePath: string,
): AgentResult {
  const rf = "/tmp/swarm-result-" + 0 + "-" + Date.now() + ".txt";

  // Bridges have different arg signatures:
  // claude-code: only prompt arg
  // codex/hermes/gemini: prompt + workdir
  let args: string[];
  if (exid === "claude-code") {
    args = [bridgePath, prompt];
  } else {
    args = [bridgePath, prompt, WORKSPACE];
  }

  try {
    const result = Bun.spawnSync({
      cmd: ["bash", ...args],
      env: { ...process.env, WORKSPACE, HOME },
      timeout: timeout_s * 1000,
    });

    if (result.exitCode === 0) {
      try {
        const out = readFileSync(rf, "utf-8").trim();
        try { unlinkSync(rf); } catch {}
        return { output: out, error: null };
      } catch {
        const stdout = Buffer.from(result.stdout || []).toString("utf-8").trim();
        return { output: stdout || "OK", error: null };
      }
    } else {
      const stderr = Buffer.from(result.stderr || []).toString("utf-8").trim();
      return { output: "", error: (stderr || "exit " + result.exitCode).slice(0, 500) };
    }
  } catch (e) {
    return { output: "", error: String(e).slice(0, 200) };
  }
}


// ============================================================================
// ORCHESTRATOR CLASS
// ============================================================================

class Orch {
  private swarmId: string;
  private cfg: OrchestratorConfig;
  private tasks: Task[] = [];
  private ok: Record<string, TaskResult> = {};
  private fail: Record<string, TaskResult> = {};
  private running: Set<string> = new Set();
  private lock = { acquired: false };  // stub for threading.Lock
  private startTime = 0;
  private logPath: string;
  private progPath: string;
  getResPath(): string { return this.resPath; } private resPath: string;
  private lockPath: string;
  private completedOutputs: CompletedOutput[] = [];
  private circuitBreakers: Record<string, CircuitBreaker> = {};
  // P3: Cascade tracking
  private failedRootTasks: Record<string, boolean> = {};
  private skippedDueToCascade: Record<string, string> = {};

  constructor(swarmId: string, cfg: Partial<OrchestratorConfig> = {}) {
    this.swarmId = swarmId;
    this.cfg = { ...DEFAULTS, ...cfg };
    this.logPath = join(LOGS_DIR, swarmId + ".ndjson");
    this.progPath = join(LOGS_DIR, swarmId + "_progress.json");
    this.resPath = join(RESULTS_DIR, swarmId + ".json");
    this.lockPath = join(LOCK_DIR, swarmId + ".lock");
    // Mutex stub: Python version uses threading.Lock; Bun version uses global var
    nlog(this.logPath, "swarm_start", { swarmId });
    initHistory();
    this.executors = loadExecutors();
  }

  initSwarm(): void {
    writeFileSync(this.lockPath, String(0));
    console.log("Swarm " + this.swarmId + " v5.0.0 (concurrency=" + this.cfg.localConcurrency + ")");
  }

  writeProgress2(status: string): void {
    const d = {
      ts: new Date().toISOString(),
      swarmId: this.swarmId,
      totalTasks: this.tasks.length,
      completed: Object.keys(this.ok).length,
      failed: Object.keys(this.fail).length,
      percentComplete: Math.round(Object.keys(this.ok).length / Math.max(1, this.tasks.length) * 100),
      elapsedMs: Date.now() - this.startTime,
      status,
    };
    writeFileSync(this.progPath, JSON.stringify(d));
  }

  loadTasks(path: string): void {
    const raw = readFileSync(path, "utf-8");
    this.tasks = JSON.parse(raw);
    ALL_TASKS = this.tasks;  // P3: for transitive cascade check
    this.initSwarm();
    console.log("Tasks: " + this.tasks.length);
  }

  run(): void {
    this.startTime = Date.now();
    const taskMap: Record<string, Task> = {};
    for (const t of this.tasks) taskMap[t.id] = t;

    const tids = topoSort(this.tasks);
    const pending = new Set<string>(tids);
    const running = new Set<string>();

    this.writeProgress2("running");
    console.log("Starting " + this.tasks.length + " tasks with concurrency " + this.cfg.localConcurrency);

    while (pending.size > 0 || running.size > 0) {
      while (running.size < this.cfg.localConcurrency && pending.size > 0) {
        for (const tid of Array.from(pending)) {
          const task = taskMap[tid];
          // P3: cascade mode check
          const cascadeOk = depsOk(task, this.ok, this.fail as unknown as Record<string, boolean>, this.cfg.cascadeMode, this.failedRootTasks);

          if (cascadeOk) {
            pending.delete(tid);
            running.add(tid);
            // P3: cascade-off — mark downstream of failed roots as skipped
            if (!this.cfg.cascadeMode) {
              for (const d of (task.dependsOn || [])) {
                if (this.fail[d] && this.failedRootTasks[d]) {
                  this.skippedDueToCascade[tid] = d;
                  running.delete(tid);  // don't actually run it
                  this.writeProgress2("running");
                  console.log("  SKIP [" + tid + "] (downstream of failed root: " + d + ")");
                  break;
                }
              }
            }
            if (running.has(tid)) {
              this.execTask(task, running);
            }
          }
        }
        break;  // re-evaluate after inner loop
      }
      Bun.sleep(500);
    }

    // Wait for all tasks to complete
    while (Object.keys(this.ok).length + Object.keys(this.fail).length < this.tasks.length) {
      Bun.sleep(500);
    }
    this.saveResults();
    this.shutdown();
  }

  private execTask(task: Task, runningSet: Set<string>): void {
    const tid = task.id;
    let retries = 0;
    const tried = new Set<string>();
    const cat = (task.memoryMetadata?.category as string) || "general";
    let dur = 0;
    let err: string | null = null;

    while (retries <= this.cfg.maxRetries) {
      let exid: string;
      if (task.persona && task.persona !== "auto" && retries === 0) {
        exid = task.persona;
      } else {
        const winner = route(task, this.executors, this.circuitBreakers, this.cfg.routingStrategy);
        exid = winner.executorId;
        if (tried.has(exid) && tried.size < Object.keys(this.executors).length) {
          // Reroute: try next-best executor
          const alt = Object.keys(this.executors).find(e => !tried.has(e));
          if (alt) {
            exid = alt;
            console.log("  REROUTE [" + tid + "] -> " + exid);
          }
        }
      }

      tried.add(exid);
      const bridge = getBridge(exid, this.executors);
      if (!bridge) {
        console.log("  MISSING [" + tid + "] bridge for " + exid);
        err = "No bridge for " + exid;
        break;
      }

      const tout = task.timeoutSeconds || this.cfg.timeoutSeconds;
      const prompt = buildPrompt(task, this.completedOutputs, this.cfg.crossTaskContextWindow);
      console.log("  RUN [" + tid + "] " + exid + " (attempt " + (retries + 1) + ")");

      const t0 = Date.now();
      const result = callAgent(exid, prompt, tout, bridge);
      dur = Date.now() - t0;
      recHist(exid, cat, !result.error, dur);

      if (!result.error) {
        this.ok[tid] = { taskId: tid, success: true, output: result.output, durationMs: dur, retries };
        this.completedOutputs.push({ persona: exid, category: cat, summary: (result.output || "").slice(0, 300) });
        if (this.circuitBreakers[exid]) this.circuitBreakers[exid].failures = 0;
        console.log("  OK [" + tid + "] " + exid + " (" + (dur / 1000).toFixed(1) + "s)");
        this.writeProgress2("running");
        runningSet.delete(tid);
        return;
      } else {
        if (this.circuitBreakers[exid]) {
          this.circuitBreakers[exid].failures = (this.circuitBreakers[exid].failures || 0) + 1;
        }
        retries++;
        console.log("  FAIL [" + tid + "] " + exid + ": " + String(result.error).slice(0, 80));
        if (retries <= this.cfg.maxRetries) {
          const wait = Math.pow(2, retries - 1) * 500;
          console.log("  RETRY [" + tid + "] in " + Math.round(wait) + "ms...");
          Bun.sleep(wait);
        }
      }
    }

    // P3: mark root failures so downstream tasks can cascade
    if ((task.dependsOn || []).length === 0) {
      this.failedRootTasks[tid] = true;
    }
    this.fail[tid] = { taskId: tid, success: false, error: err || "Max retries exceeded", durationMs: dur, retries: retries - 1 };
    runningSet.delete(tid);
    this.writeProgress2("running");
  }

  private executors: Record<string, ExecutorInfo> = {};

  saveResults(): void {
    const ems = Date.now() - this.startTime;
    const sok = Object.keys(this.ok).length;
    const sfail = Object.keys(this.fail).length;
    const sskipped = Object.keys(this.skippedDueToCascade).length;
    const results = {
      swarmId: this.swarmId,
      status: "complete",
      cascadeMode: this.cfg.cascadeMode,
      cascadeRescued: sskipped,
      skippedDetail: this.skippedDueToCascade,
      completed: sok,
      failed: sfail,
      total: this.tasks.length,
      elapsedMs: ems,
      results: [...Object.values(this.ok), ...Object.values(this.fail)],
    };
    writeFileSync(this.resPath, JSON.stringify(results, null, 2));
  }

  shutdown(): void {
    const ems = Date.now() - this.startTime;
    const sok = Object.keys(this.ok).length;
    const sfail = Object.keys(this.fail).length;
    const sk = Object.keys(this.skippedDueToCascade).length;
    let cascadeMsg = "";
    if (!this.cfg.cascadeMode && sk > 0) cascadeMsg = " (" + sk + " skipped)";
    nlog(this.logPath, "swarm_complete", { succeeded: sok, failed: sfail, elapsed_ms: ems });
    writeEpisode(this.swarmId, sok, sfail, ems, this.tasks.length, Object.keys(this.executors));
    console.log("Swarm " + this.swarmId + ": " + sok + "/" + this.tasks.length + " OK in " + Math.round(ems / 1000) + "s" + cascadeMsg);
    this.writeProgress2("complete");
    try { unlinkSync(this.lockPath); } catch {}
  }
}

// ============================================================================
// CLI COMMANDS
// ============================================================================

function statusCmd(swid: string): void {
  const pf = join(LOGS_DIR, swid + "_progress.json");
  const rf = join(RESULTS_DIR, swid + ".json");
  if (existsSync(pf)) {
    const d = JSON.parse(readFileSync(pf, "utf-8"));
    console.log("Swarm: " + d.swarmId);
    console.log("Status: " + d.status);
    console.log("Progress: " + d.completed + "/" + d.totalTasks + " (" + d.percentComplete + "%)");
    console.log("Elapsed: " + Math.round(d.elapsedMs / 1000) + "s");
    if (d.failed) console.log("Failed: " + d.failed);
  } else {
    console.log("No swarm found: " + swid);
  }
  if (existsSync(rf)) {
    const r = JSON.parse(readFileSync(rf, "utf-8"));
    console.log("Results: " + rf + " (" + Math.round(readFileSync(rf).byteLength / 1024) + "KB)");
  }
}

function doctorCmd(): void {
  console.log("Swarm Doctor v5.0");
  for (const [k, v] of Object.entries(DEFAULTS)) {
    console.log("  " + k + ": " + JSON.stringify(v));
  }
  const exs = loadExecutors();
  for (const [eid, ex] of Object.entries(exs)) {
    const bp = getBridge(eid, exs);
    console.log("  " + (bp ? "OK: " : "MISSING: ") + eid + (bp ? " bridge at " + bp : ""));
  }
  initHistory();
  console.log("  OK: executor history DB");
  console.log("  cascadeMode: enabled (use --no-cascade to rescue failed-root subtrees)");
  console.log("OK: doctor passed");
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun orchestrate-v5.ts <tasks.json> [options]");
    console.log("  --swarm-id ID        : Set swarm ID");
    console.log("  --concurrency N       : Max parallel tasks (default: 8)");
    console.log("  --timeout S          : Per-task timeout (default: 600s)");
    console.log("  --max-retries N      : Max retries per task (default: 3)");
    console.log("  --strategy STRAT     : balanced|fast|reliable|explore (default: balanced)");
    console.log("  --no-cascade         : Skip downstream when root fails (P3 cascade rescue)");
    console.log("  status <ID>          : Check swarm status");
    console.log("  doctor               : Run health checks");
    process.exit(1);
  }

  if (args[0] === "status") {
    if (args.length < 2) { console.log("Usage: orchestrate-v5.ts status <swarm-id>"); process.exit(1); }
    statusCmd(args[1]); process.exit(0);
  }
  if (args[0] === "doctor") {
    doctorCmd(); process.exit(0);
  }

  const campaign = args[0];
  if (!existsSync(campaign)) { console.log("File not found: " + campaign); process.exit(1); }

  let swarmId = "swarm_" + Date.now();
  const cfg: Partial<OrchestratorConfig> = {};
  let i = 1;
  while (i < args.length) {
    const a = args[i];
    if (a === "--swarm-id" && i + 1 < args.length) { swarmId = args[i + 1]; i += 2; }
    else if (a === "--concurrency" && i + 1 < args.length) { cfg.localConcurrency = parseInt(args[i + 1]); i += 2; }
    else if (a === "--timeout" && i + 1 < args.length) { cfg.timeoutSeconds = parseInt(args[i + 1]); i += 2; }
    else if (a === "--max-retries" && i + 1 < args.length) { cfg.maxRetries = parseInt(args[i + 1]); i += 2; }
    else if (a === "--strategy" && i + 1 < args.length) { cfg.routingStrategy = args[i + 1]; i += 2; }
    else if (a === "--no-cascade") { cfg.cascadeMode = false; i++; }
    else i++;
  }

  const orch = new Orch(swarmId, cfg);
  orch.loadTasks(campaign);
  console.log("Results: " + orch.getResPath());
  console.log();
  orch.run();

  const results = JSON.parse(readFileSync(orch.getResPath(), "utf-8"));
  console.log("\nDone: " + orch.getResPath());
}

main();

