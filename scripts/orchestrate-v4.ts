#!/usr/bin/env bun
/**
 * Swarm Orchestrator v4.0.0 - Enhanced Token Optimizer
 * 
 * Building on v3's persistent memory, v4 adds:
 * - Token optimization (HTML stripping, normalization, deduplication)
 * - Hierarchical memory (working + LTM)
 * - Sliding window memory option
 * - Token budget management
 * - Multiple memory strategies
 * 
 * Inspired by:
 * - prompt-refiner: Schema/Response compression
 * - Agent-Memory-Playground: 9 memory strategies
 */

import { SwarmMemory, getSwarmMemory, ContextAccessMode, MemoryQuery } from "./swarm-memory";
import { HierarchicalMemory, SlidingWindowMemory, MemoryItem, MemoryStrategy } from "./token-optimizer";
import { setInterval, clearInterval } from "timers";
import { join } from "path";
import { existsSync, readFileSync, mkdirSync } from "fs";

// ============================================================================
// TYPES
// ============================================================================

type PriorityQueue = "critical" | "high" | "medium" | "low";

interface Task {
  id: string;
  persona: string;
  task: string;
  priority: PriorityQueue;

  // DAG dependencies — task IDs that must complete before this task runs
  dependsOn?: string[];

  // Memory configuration
  memoryStrategy?: "hierarchical" | "sliding" | "none";
  contextAccess?: ContextAccessMode;
  contextQuery?: MemoryQuery;
  contextTags?: string[];
  outputToMemory?: boolean;

  // Metadata
  memoryMetadata?: {
    category?: string;
    priority?: PriorityQueue;
    tags?: string[];
  };
}

interface TaskResult {
  task: Task;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  retries: number;
  tokensUsed?: number;
}

interface OrchestratorConfig {
  maxConcurrency: number;
  localConcurrency: number;  // Separate concurrency cap for local executors (claude-code, hermes)
  timeoutSeconds: number;
  maxRetries: number;
  enableMemory: boolean;
  defaultMemoryStrategy: MemoryStrategy;
  maxContextTokens: number;
  crossTaskContextWindow: number;
  dagMode: "streaming" | "waves";
  memoryDbPath?: string;
  modelName?: string;
}

interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxConcurrency: parseInt(process.env.SWARM_MAX_CONCURRENCY || "2"),
  localConcurrency: parseInt(process.env.SWARM_LOCAL_CONCURRENCY || "4"),
  timeoutSeconds: parseInt(process.env.SWARM_TIMEOUT_SECONDS || "300"),
  maxRetries: parseInt(process.env.SWARM_MAX_RETRIES || "3"),
  enableMemory: true,
  defaultMemoryStrategy: {
    workingMemorySize: 2,
    longTermMemorySize: 3,
    enableDeduplication: true,
    enableHTMLStripping: true,
    maxTokens: 8000,
  },
  maxContextTokens: 8000,
  crossTaskContextWindow: 3,
  dagMode: "streaming",
  modelName: process.env.SWARM_MODEL_NAME || undefined,
};

// ============================================================================
// CONFIGURATION LOADING
// ============================================================================

interface RuntimeConfig {
  maxConcurrency: number;
  localConcurrency: number;
  timeoutSeconds: number;
  maxRetries: number;
  crossTaskContextWindow: number;
  modelName?: string;
  memory: {
    enable: boolean;
    workingMemorySize: number;
    longTermMemorySize: number;
    enableDeduplication: boolean;
    enableHTMLStripping: boolean;
    maxTokens: number;
  };
}

function loadConfig(): RuntimeConfig {
  const defaults = {
    maxConcurrency: parseInt(process.env.SWARM_MAX_CONCURRENCY || "2"),
    localConcurrency: parseInt(process.env.SWARM_LOCAL_CONCURRENCY || "4"),
    timeoutSeconds: parseInt(process.env.SWARM_TIMEOUT_SECONDS || "300"),
    maxRetries: parseInt(process.env.SWARM_MAX_RETRIES || "3"),
    crossTaskContextWindow: 3,
    modelName: process.env.SWARM_MODEL_NAME || undefined,
    memory: {
      enable: true,
      workingMemorySize: 2,
      longTermMemorySize: 3,
      enableDeduplication: true,
      enableHTMLStripping: true,
      maxTokens: 8000,
    },
  };

  // Try to load config.json from skill root (parent of scripts/)
  try {
    const configPath = join(__dirname, "..", "config.json");
    if (existsSync(configPath)) {
      const fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      return {
        maxConcurrency: fileConfig.maxConcurrency ?? defaults.maxConcurrency,
        localConcurrency: fileConfig.localConcurrency ?? defaults.localConcurrency,
        timeoutSeconds: fileConfig.timeoutSeconds ?? defaults.timeoutSeconds,
        maxRetries: fileConfig.maxRetries ?? defaults.maxRetries,
        crossTaskContextWindow: fileConfig.crossTaskContextWindow ?? defaults.crossTaskContextWindow,
        modelName: fileConfig.modelName ?? defaults.modelName,
        memory: {
          enable: fileConfig.memory?.enable ?? defaults.memory.enable,
          workingMemorySize: fileConfig.memory?.workingMemorySize ?? defaults.memory.workingMemorySize,
          longTermMemorySize: fileConfig.memory?.longTermMemorySize ?? defaults.memory.longTermMemorySize,
          enableDeduplication: fileConfig.memory?.enableDeduplication ?? defaults.memory.enableDeduplication,
          enableHTMLStripping: fileConfig.memory?.enableHTMLStripping ?? defaults.memory.enableHTMLStripping,
          maxTokens: fileConfig.memory?.maxTokens ?? defaults.memory.maxTokens,
        },
      };
    }
  } catch (error) {
    // Config file doesn't exist or is invalid, use defaults
  }

  return defaults;
}

// ============================================================================
// PATH RESOLUTION
// ============================================================================

/** Root of the zo-swarm-orchestrator repo (parent of scripts/) */
const REPO_ROOT = join(__dirname, "..");

/**
 * Workspace root for deployment-specific resources (IDENTITY/, .zo/, SOUL.md).
 * Override with SWARM_WORKSPACE env var; defaults to /home/workspace (Zo Computer root).
 */
const WORKSPACE = process.env.SWARM_WORKSPACE || "/home/workspace";

const PATHS = {
  identityDir: process.env.SWARM_IDENTITY_DIR || join(WORKSPACE, "IDENTITY"),
  soulFile: process.env.SWARM_SOUL_FILE || join(WORKSPACE, "SOUL.md"),
  personaMemoryDir: process.env.SWARM_PERSONA_MEMORY_DIR || join(WORKSPACE, ".zo", "memory", "personas"),
  memoryScript: process.env.SWARM_MEMORY_SCRIPT || join(WORKSPACE, ".zo", "memory", "scripts", "memory.ts"),
  memoryDb: process.env.ZO_MEMORY_DB || join(WORKSPACE, ".zo", "memory", "shared-facts.db"),
  agentPersonasRegistry: process.env.SWARM_AGENT_REGISTRY || join(WORKSPACE, "agency-agents-personas.json"),
} as const;

// ============================================================================
// MEMORY INTEGRATION MODULE
// ============================================================================

class MemoryManager {
  private swarmMemory: SwarmMemory | null = null;
  private hierarchicalMemory: HierarchicalMemory | SlidingWindowMemory | null = null;
  private preWarmCache: Map<string, { items: any[], timestamp: number }> = new Map();
  private cacheDir = "/dev/shm/swarm-prewarm-cache";

  constructor(
    private swarmId: string,
    private config: OrchestratorConfig,
    memoryDbPath?: string
  ) {
    if (config.enableMemory) {
      this.swarmMemory = getSwarmMemory(memoryDbPath);
      // Default to hierarchical memory
      this.hierarchicalMemory = new HierarchicalMemory(config.defaultMemoryStrategy);
    }
  }

  /**
   * O3: Pre-warm memory with caching. Avoids re-searching memory database
   * on every run. Caches results for 1 hour.
   */
  async preWarm(domain: string): Promise<number> {
    if (!this.hierarchicalMemory) return 0;

    const cacheKey = `domain:${domain}`;
    const cacheTimeout = 3600000; // 1 hour

    // Check in-memory cache first
    const cached = this.preWarmCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheTimeout) {
      console.log(`  [pre-warm] Cache hit for domain "${domain}" (${cached.items.length} items)`);
      for (const item of cached.items) {
        this.hierarchicalMemory.add(item);
      }
      return cached.items.length;
    }

    // Check disk cache
    try {
      const cacheFile = join(this.cacheDir, `${cacheKey}.json`);
      if (existsSync(cacheFile)) {
        const diskCached = JSON.parse(readFileSync(cacheFile, "utf-8"));
        if (Date.now() - diskCached.timestamp < cacheTimeout) {
          console.log(`  [pre-warm] Disk cache hit for domain "${domain}" (${diskCached.items.length} items)`);
          for (const item of diskCached.items) {
            this.hierarchicalMemory.add(item);
          }
          this.preWarmCache.set(cacheKey, diskCached);
          return diskCached.items.length;
        }
      }
    } catch {}

    // Fresh search if no valid cache
    const memoryScript = PATHS.memoryScript;
    let seeded = 0;
    const items: any[] = [];

    try {
      const proc = Bun.spawn(["bun", memoryScript, "search", domain, "--limit", "10"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      });

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        console.log(`  [pre-warm] Memory search failed, skipping`);
        return 0;
      }

      // Parse facts from stdout (memory.ts outputs JSON or text lines)
      const lines = stdout.trim().split("\n").filter(l => l.trim());
      for (const line of lines) {
        try {
          // Try JSON parse first (hybrid search returns JSON objects)
          const fact = JSON.parse(line);
          if (fact.text || fact.value) {
            const item = {
              content: fact.text || fact.value,
              metadata: {
                sourceAgent: fact.persona || "memory-prewarm",
                category: fact.category || "reference",
                priority: "low",
              },
            };
            this.hierarchicalMemory.add(item);
            items.push(item);
            seeded++;
          }
        } catch {
          // Plain text line — seed directly if non-trivial
          if (line.length > 20 && !line.startsWith("[") && !line.startsWith("Found")) {
            const item = {
              content: line,
              metadata: {
                sourceAgent: "memory-prewarm",
                category: "reference",
                priority: "low",
              },
            };
            this.hierarchicalMemory.add(item);
            items.push(item);
            seeded++;
          }
        }
      }
    } catch (err) {
      console.log(`  [pre-warm] Memory pre-warming failed: ${err}`);
      return 0;
    }

    // Cache the result
    try {
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true });
      }
      const cacheFile = join(this.cacheDir, `${cacheKey}.json`);
      const cacheData = { items, timestamp: Date.now() };
      Bun.write(cacheFile, JSON.stringify(cacheData, null, 2));
      this.preWarmCache.set(cacheKey, cacheData);
    } catch (err) {
      console.log(`  [pre-warm] Failed to save cache: ${err}`);
    }

    return seeded;
  }

  addAgentOutput(persona: string, content: string, metadata: any): void {
    if (!this.hierarchicalMemory) return;

    const item = {
      content,
      metadata: {
        sourceAgent: persona,
        category: metadata.category || "general",
        priority: metadata.priority || "medium",
      },
    };

    this.hierarchicalMemory.add(item);

    // Also save to persistent swarm memory
    if (this.swarmMemory && metadata.outputToMemory) {
      this.swarmMemory.writeContext(this.swarmId, content, {
        sourceAgent: persona,
        category: metadata.category,
        priority: metadata.priority,
        tags: metadata.tags,
      });
    }
  }

  getContext(task: Task): string {
    const strategy = task.memoryStrategy || "hierarchical";

    if (strategy === "none" || !this.hierarchicalMemory) {
      return "";
    }

    let memoryString = "";
    
    if (strategy === "hierarchical") {
      memoryString = this.hierarchicalMemory.getContextString();
    } else if (strategy === "sliding") {
      if (this.hierarchicalMemory instanceof SlidingWindowMemory) {
        memoryString = this.hierarchicalMemory.getContextString();
      } else {
        // Fallback: switch to sliding window mode
        const items = this.hierarchicalMemory.getContext();
        const sliding = new SlidingWindowMemory(4);
        for (const item of items) {
          sliding.add(item);
        }
        memoryString = sliding.getContextString();
      }
    }

    return memoryString;
  }

  getStats() {
    if (!this.hierarchicalMemory) return null;

    const stats = this.hierarchicalMemory.getStats();
    const swarmStats = this.swarmMemory?.getStats();

    return {
      memory: stats,
      swarm: swarmStats,
    };
  }
}

// ============================================================================
// ORCHESTRATOR CLASS
// ============================================================================

// ============================================================================
// NDJSON LOGGER
// ============================================================================

class NdjsonLogger {
  private logPath: string | null = null;
  private lines: string[] = [];

  constructor(swarmId: string) {
    try {
      const logDir = join(process.env.HOME || "/tmp", ".swarm", "logs");
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      this.logPath = join(logDir, `${swarmId}_${Date.now()}.ndjson`);
    } catch { /* logging is best-effort */ }
  }

  log(event: string, data: Record<string, unknown> = {}): void {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    });
    this.lines.push(entry);
  }

  async flush(): Promise<string | null> {
    if (!this.logPath || this.lines.length === 0) return null;
    try {
      await Bun.write(this.logPath, this.lines.join("\n") + "\n");
      return this.logPath;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// ORCHESTRATOR CLASS
// ============================================================================

// Local executor configuration loaded from persona-registry.json
interface LocalExecutor {
  id: string;
  bridge: string;
  name: string;
}

class TokenOptimizedOrchestrator {
  private config: OrchestratorConfig;
  private memoryManager: MemoryManager | null = null;
  private swarmId: string;
  private sessionId: string;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private results: TaskResult[] = [];
  private completedOutputs: Array<{ persona: string; category: string; summary: string }> = [];
  private logger: NdjsonLogger;
  private personaMappings: Map<string, string> = new Map();
  private localExecutors: Map<string, LocalExecutor> = new Map();
  private progressFile: string | null = null;
  private runStartTime: number = 0;
  private totalTaskCount: number = 0;

  constructor(swarmId: string, config: Partial<OrchestratorConfig> = {}) {
    this.swarmId = swarmId;
    this.sessionId = `${swarmId}_${Date.now()}`;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new NdjsonLogger(swarmId);
    this.progressFile = `/dev/shm/${swarmId}-progress.json`;

    if (this.config.enableMemory) {
      this.memoryManager = new MemoryManager(
        swarmId,
        this.config,
        config.memoryDbPath
      );
    }

    // Load local executors from persona registry
    this.loadLocalExecutors();
  }

  private loadLocalExecutors(): void {
    try {
      const registryPath = join(__dirname, "..", "assets", "persona-registry.json");
      if (existsSync(registryPath)) {
        const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
        const personas = registry.personas || [];
        for (const p of personas) {
          if (p.executor === "local" && p.bridge) {
            const bridgePath = p.bridge.startsWith("/") ? p.bridge : join(WORKSPACE, p.bridge);
            this.localExecutors.set(p.id, {
              id: p.id,
              bridge: bridgePath,
              name: p.name || p.id,
            });
          }
        }
        if (this.localExecutors.size > 0) {
          console.log(`   Local executors: ${[...this.localExecutors.keys()].join(", ")}`);
        }
      }
    } catch {
      // Registry loading is best-effort
    }
  }

  private writeProgress(extra: Record<string, unknown> = {}): void {
    if (!this.progressFile) return;
    try {
      const successful = this.results.filter(r => r.success).length;
      const failed = this.results.filter(r => !r.success).length;
      const progress = {
        ts: new Date().toISOString(),
        swarmId: this.swarmId,
        totalTasks: this.totalTaskCount,
        completed: successful,
        failed,
        percentComplete: this.totalTaskCount > 0 ? Math.round(((successful + failed) / this.totalTaskCount) * 100) : 0,
        elapsedMs: Date.now() - this.runStartTime,
        personaMappings: Object.fromEntries(this.personaMappings),
        ...extra,
      };
      Bun.write(this.progressFile, JSON.stringify(progress, null, 2));
    } catch {}
  }

  // --------------------------------------------------------------------------
  // MAIN EXECUTION
  // --------------------------------------------------------------------------

  async run(tasks: Task[]): Promise<TaskResult[]> {
    const startTime = Date.now();
    this.runStartTime = startTime;
    this.totalTaskCount = tasks.length;

    console.log(`\n🐝 Swarm Orchestrator v4.0.0 - Token Optimizer`);
    console.log(`   Swarm ID: ${this.swarmId}`);
    console.log(`   Session: ${this.sessionId}`);
    console.log(`   Tasks: ${tasks.length}`);
    const apiBackend = process.env.ANTHROPIC_API_KEY ? "Anthropic Direct" : (process.env.ZO_CLIENT_IDENTITY_TOKEN ? "Zo API" : "NONE");
    console.log(`   API Backend: ${apiBackend}`);
    console.log(`   API Concurrency: ${this.config.maxConcurrency}`);
    console.log(`   Local Concurrency: ${this.config.localConcurrency}`);
    console.log(`   Max Context Tokens: ${this.config.maxContextTokens}`);
    console.log(`   Memory Strategy: ${this.config.defaultMemoryStrategy.enableDeduplication ? "Hierarchical (optimized)" : "Basic"}`);
    if (this.localExecutors.size > 0) {
      console.log(`   Local Executors: ${[...this.localExecutors.keys()].join(", ")}`);
    }
    console.log();

    this.logger.log("run_start", {
      swarmId: this.swarmId,
      sessionId: this.sessionId,
      taskCount: tasks.length,
      concurrency: this.config.maxConcurrency,
      localConcurrency: this.config.localConcurrency,
    });

    // Write initial progress
    this.writeProgress({ status: "started" });

    // Validate personas
    this.validatePersonas(tasks);

    // R3: Pre-warm memory with domain-relevant facts
    if (this.memoryManager) {
      const domain = this.swarmId.replace(/^swarm_\d+$/, "")
        || tasks[0]?.memoryMetadata?.tags?.[0]
        || tasks[0]?.task.split(" ").slice(0, 3).join(" ")
        || "general";
      const preWarmStart = Date.now();
      const seeded = await this.memoryManager.preWarm(domain);
      const preWarmMs = Date.now() - preWarmStart;
      if (seeded > 0) {
        console.log(`   Pre-warmed ${seeded} facts in ${preWarmMs}ms`);
        this.logger.log("prewarm_complete", { domain, seeded, durationMs: preWarmMs });
      }
    }

    // Check if any tasks have dependencies (DAG mode)
    const hasDeps = tasks.some(t => t.dependsOn && t.dependsOn.length > 0);

    if (hasDeps) {
      // DAG-based execution — streaming (default) or waves
      if (this.config.dagMode === "waves") {
        await this.runDAGWaves(tasks);
      } else {
        await this.runDAG(tasks);
      }
    } else {
      // Legacy chunk-based execution (priority-sorted)
      const sortedTasks = this.sortByPriority(tasks);
      const chunks = this.createChunks(sortedTasks, this.config.maxConcurrency);

      for (let i = 0; i < chunks.length; i++) {
        console.log(`\n📦 Chunk ${i + 1}/${chunks.length} (${chunks[i].length} tasks)`);
        this.logger.log("chunk_start", { chunk: i + 1, total: chunks.length, size: chunks[i].length });
        await this.processChunk(chunks[i]);
      }
    }

    // Write final progress before summary
    this.writeProgress({ status: "complete" });

    // Final summary
    await this.printSummary(Date.now() - startTime);

    this.logger.log("run_complete", {
      totalTasks: this.results.length,
      successful: this.results.filter(r => r.success).length,
      failed: this.results.filter(r => !r.success).length,
      durationMs: Date.now() - startTime,
    });
    const logPath = await this.logger.flush();
    if (logPath) console.log(`📋 Logs saved to: ${logPath}`);

    return this.results;
  }

  // --------------------------------------------------------------------------
  // CHUNK PROCESSING
  // --------------------------------------------------------------------------

  /**
   * O2: DAG Streaming - Start tasks immediately when dependencies resolve.
   * Instead of waiting for an entire "wave" to complete, uses Promise.race
   * to detect the first completed task and immediately schedules newly-ready tasks.
   */
/**
   * O2: DAG Streaming - Start tasks immediately when dependencies resolve.
   * Instead of waiting for an entire "wave" to complete, uses Promise.race
   * to detect the first completed task and immediately schedules newly-ready tasks.
   */
  private async runDAG(tasks: Task[]): Promise<void> {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const completed = new Set<string>();
    const failed = new Set<string>();
    const pending = new Set(tasks.map(t => t.id));
    const executing = new Map<string, Promise<{ taskId: string; result: TaskResult }>>();

    // Track concurrency per execution channel: Zo API vs local executors
    let apiActive = 0;
    let localActive = 0;
    const executingChannel = new Map<string, "api" | "local">();
    const totalConcurrency = this.config.maxConcurrency + this.config.localConcurrency;

    console.log(`\n🌊 DAG Streaming Execution`);
    console.log(`   Zo API concurrency: ${this.config.maxConcurrency}`);
    console.log(`   Local executor concurrency: ${this.config.localConcurrency}`);
    console.log(`   Effective max concurrency: ${totalConcurrency}`);
    this.logger.log("dag_streaming_start", {
      taskCount: tasks.length,
      maxConcurrency: this.config.maxConcurrency,
      localConcurrency: this.config.localConcurrency,
      totalConcurrency,
    });

    const launchReady = () => {
      // Skip failed dependencies first
      for (const id of [...pending]) {
        const task = taskMap.get(id)!;
        const deps = task.dependsOn || [];
        if (deps.some(d => failed.has(d))) {
          pending.delete(id);
          failed.add(id);
          this.results.push({
            task,
            success: false,
            error: `Dependency failed: ${deps.filter(d => failed.has(d)).join(", ")}`,
            durationMs: 0,
            retries: 0,
          });
          this.logger.log("task_dep_failed", { taskId: id, failedDeps: deps.filter(d => failed.has(d)) });
          console.log(`  ⏭️  [${id}] Skipped — dependency failed`);
        }
      }

      // Launch tasks whose dependencies are all satisfied
      for (const id of [...pending]) {
        if (executing.size >= totalConcurrency) break;
        if (executing.has(id)) continue;

        const task = taskMap.get(id)!;
        const deps = task.dependsOn || [];
        if (!deps.every(d => completed.has(d))) continue;

        // Check per-channel concurrency limit
        const isLocal = this.localExecutors.has(task.persona);
        if (isLocal && localActive >= this.config.localConcurrency) continue;
        if (!isLocal && apiActive >= this.config.maxConcurrency) continue;

        // All deps met and channel has capacity — launch immediately
        pending.delete(id);
        const channel = isLocal ? "local" : "api";
        if (isLocal) localActive++;
        else apiActive++;
        executingChannel.set(id, channel);

        const execution = this.executeTaskWithResilience(task).then(result => {
          return { taskId: id, result };
        });
        executing.set(id, execution);

        const channelLabel = isLocal ? "🖥️  local" : "☁️  api";
        console.log(`  ✨ [${id}] Streaming start → ${task.persona} [${channelLabel}] (api:${apiActive}/${this.config.maxConcurrency} local:${localActive}/${this.config.localConcurrency})`);
        this.logger.log("task_streaming_start", { taskId: id, persona: task.persona, channel, apiActive, localActive, activeWorkers: executing.size });
      }
    };

    // Initial launch
    launchReady();

    // Main loop — wait for completions and launch newly-ready tasks
    while (executing.size > 0 || pending.size > 0) {
      if (executing.size === 0 && pending.size > 0) {
        // Deadlock — remaining tasks have unresolvable dependencies
        console.log(`\n⚠️  Deadlock: ${pending.size} tasks have unresolvable dependencies`);
        this.logger.log("dag_deadlock", { remaining: [...pending] });
        for (const id of pending) {
          const task = taskMap.get(id)!;
          this.results.push({ task, success: false, error: "Unresolvable dependency (cycle?)", durationMs: 0, retries: 0 });
        }
        break;
      }

      // Wait for the first task to complete
      const { taskId, result } = await Promise.race(executing.values());
      executing.delete(taskId);
      this.results.push(result);

      // Decrement the correct channel counter
      const completedChannel = executingChannel.get(taskId);
      if (completedChannel === "local") localActive--;
      else apiActive--;
      executingChannel.delete(taskId);

      if (result.success) {
        completed.add(taskId);
        console.log(`  ✅ [${taskId}] Complete (${(result.durationMs / 1000).toFixed(1)}s) — checking for newly ready tasks`);
      } else {
        failed.add(taskId);
        console.log(`  ❌ [${taskId}] Failed: ${result.error}`);
      }
      this.logger.log("task_streaming_complete", { taskId, success: result.success, durationMs: result.durationMs, channel: completedChannel, apiActive, localActive, activeWorkers: executing.size });

      // Immediately check if new tasks can start
      launchReady();
    }

    console.log(`\n✅ DAG Streaming complete — ${completed.size} succeeded, ${failed.size} failed`);
    this.logger.log("dag_streaming_complete", { completed: completed.size, failed: failed.size });
  }

  /**
   * Legacy wave-based DAG execution (kept as fallback, use --dag-mode=waves).
   */
  private async runDAGWaves(tasks: Task[]): Promise<void> {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const completed = new Set<string>();
    const failed = new Set<string>();
    const remaining = new Set(tasks.map(t => t.id));
    let wave = 0;

    while (remaining.size > 0) {
      wave++;
      const ready: Task[] = [];
      for (const id of remaining) {
        const task = taskMap.get(id)!;
        const deps = task.dependsOn || [];
        const depsComplete = deps.every(d => completed.has(d));
        const depsFailed = deps.some(d => failed.has(d));

        if (depsFailed) {
          remaining.delete(id);
          failed.add(id);
          this.results.push({
            task,
            success: false,
            error: `Dependency failed: ${deps.filter(d => failed.has(d)).join(", ")}`,
            durationMs: 0,
            retries: 0,
          });
          this.logger.log("task_dep_failed", { taskId: id, failedDeps: deps.filter(d => failed.has(d)) });
          console.log(`  ⏭️  [${id}] Skipped — dependency failed`);
        } else if (depsComplete) {
          ready.push(task);
        }
      }

      if (ready.length === 0 && remaining.size > 0) {
        console.log(`\n⚠️  Deadlock: ${remaining.size} tasks have unresolvable dependencies`);
        this.logger.log("dag_deadlock", { remaining: [...remaining] });
        for (const id of remaining) {
          const task = taskMap.get(id)!;
          this.results.push({ task, success: false, error: "Unresolvable dependency (cycle?)", durationMs: 0, retries: 0 });
        }
        break;
      }

      const sortedReady = this.sortByPriority(ready);
      const chunks = this.createChunks(sortedReady, this.config.maxConcurrency);

      console.log(`\n🌊 Wave ${wave}: ${ready.length} tasks ready`);
      this.logger.log("dag_wave", { wave, readyCount: ready.length });

      for (const chunk of chunks) {
        await this.processChunk(chunk);
      }

      for (const task of ready) {
        remaining.delete(task.id);
        const result = this.results.find(r => r.task.id === task.id);
        if (result?.success) {
          completed.add(task.id);
        } else {
          failed.add(task.id);
        }
      }
    }
  }

  private async processChunk(tasks: Task[]): Promise<void> {
    const promises = tasks.map(task => this.executeTaskWithResilience(task));
    const chunkResults = await Promise.all(promises);
    this.results.push(...chunkResults);
  }

  private async executeTaskWithResilience(task: Task): Promise<TaskResult> {
    const startTime = Date.now();
    let retries = 0;

    // Check circuit breaker
    if (this.isCircuitOpen(task.persona)) {
      console.log(`  ⚠️  [${task.id}] Circuit open for ${task.persona}, skipping`);
      return {
        task,
        success: false,
        error: "Circuit breaker open",
        durationMs: 0,
        retries,
      };
    }

    // Build optimized prompt
    const prompt = await this.buildOptimizedPrompt(task);
    const promptTokens = this.estimateTokens(prompt);

    while (retries <= this.config.maxRetries) {
      try {
        console.log(`  🚀 [${task.id}] ${task.persona} (attempt ${retries + 1}) ~${promptTokens} tokens`);
        this.logger.log("task_start", { taskId: task.id, persona: task.persona, attempt: retries + 1, promptTokens });

        const output = await this.callAgent(task.persona, prompt);
        const outputTokens = this.estimateTokens(output);

        // Record success
        this.recordSuccess(task.persona);
        this.logger.log("task_success", { taskId: task.id, persona: task.persona, durationMs: Date.now() - startTime, outputTokens });

        // Save to memory with token optimization
        if (this.memoryManager) {
          this.memoryManager.addAgentOutput(
            task.persona,
            output,
            {
              ...task.memoryMetadata,
              outputToMemory: task.outputToMemory,
            }
          );
        }

        // R2: Track completed output for cross-task sliding window context
        this.completedOutputs.push({
          persona: task.persona,
          category: task.memoryMetadata?.category || "general",
          summary: output.slice(0, 200),
        });

        return {
          task,
          success: true,
          output,
          durationMs: Date.now() - startTime,
          retries,
          tokensUsed: promptTokens + outputTokens,
        };

      } catch (error) {
        retries++;
        console.log(`  ⚠️  [${task.id}] Error: ${error}`);
        this.logger.log("task_error", { taskId: task.id, persona: task.persona, attempt: retries, error: String(error) });

        if (retries <= this.config.maxRetries) {
          // O6: Faster first retry, then exponential backoff
          const delay = Math.pow(2, Math.max(retries - 1, 0)) * 500;
          console.log(`  ⏳ [${task.id}] Retrying in ${delay}ms...`);
          await this.sleep(delay);
        } else {
          // Record failure
          this.recordFailure(task.persona);
          
          return {
            task,
            success: false,
            error: String(error),
            durationMs: Date.now() - startTime,
            retries: retries - 1,
          };
        }
      }
    }

    return {
      task,
      success: false,
      error: "Max retries exceeded",
      durationMs: Date.now() - startTime,
      retries,
    };
  }

  // --------------------------------------------------------------------------
  // PROMPT BUILDING WITH TOKEN OPTIMIZATION
  // --------------------------------------------------------------------------

  private buildFormatConstraint(task: Task): string {
    const category = task.memoryMetadata?.category || "";

    if (["architecture", "design", "accessibility"].includes(category)) {
      return `
# OUTPUT FORMAT - YOU MUST RESPOND WITH ONLY THIS JSON

\`\`\`json
{
  "summary": "1-2 sentence executive summary (under 50 words)",
  "findings": [
    {
      "id": "F001",
      "severity": "P0",
      "category": "Architecture",
      "title": "Concise finding title",
      "description": "1-2 sentences explaining the issue",
      "recommendation": "Specific actionable fix",
      "evidence": "URL or CSS selector to verify"
    }
  ],
  "quick_wins": ["Easy win #1", "Easy win #2"]
}
\`\`\`

CRITICAL RULES:
1. Respond ONLY with JSON, no markdown headers or preamble
2. Keep summary under 100 tokens
3. Each finding description: max 100 tokens
4. No code blocks, HTML examples, or verbose explanations
5. No meta-commentary about findings
`;
    } else if (category === "seo" || category === "performance") {
      return `
# OUTPUT FORMAT - YOU MUST RESPOND WITH ONLY THIS JSON

\`\`\`json
{
  "summary": "1-2 sentence executive summary (under 50 words)",
  "findings": [
    {
      "id": "F001",
      "severity": "P0",
      "metric": "Core Web Vitals|SEO Score|Cache Hit|Other",
      "current_state": "What it is now",
      "target_state": "What it should be",
      "impact": "User impact explanation",
      "fix": "Specific actionable fix"
    }
  ],
  "quick_wins": ["Easy win #1"]
}
\`\`\`

CRITICAL RULES:
1. Respond ONLY with JSON
2. Each finding: max 100 tokens total
3. No verbose explanations
`;
    } else if (category === "security" || category === "compliance") {
      return `
# OUTPUT FORMAT - YOU MUST RESPOND WITH ONLY THIS JSON

\`\`\`json
{
  "summary": "1-2 sentence executive summary (under 50 words)",
  "findings": [
    {
      "id": "F001",
      "severity": "P0",
      "control": "HTTPS|Headers|Forms|Cookies|Privacy|Other",
      "issue": "What's wrong",
      "risk": "Business/user impact",
      "remediation": "Specific fix"
    }
  ],
  "remediation_priority": ["P0 issue #1", "P1 issue #2"]
}
\`\`\`

CRITICAL RULES:
1. Respond ONLY with JSON
2. Each finding: max 80 tokens
3. No verbose explanations
`;
    } else if (category === "qa") {
      return `
# OUTPUT FORMAT - YOU MUST RESPOND WITH ONLY THIS JSON

\`\`\`json
{
  "summary": "Cross-validation summary (under 100 words)",
  "qa_matrix": [
    {
      "category": "Architecture",
      "status": "PASS|FAIL",
      "evidence_count": 5,
      "contradictions": ["Brief contradiction if any"],
      "severity": "P0|P1|P2"
    }
  ],
  "evidence_needed": ["Exact URL or selector for claim #1"]
}
\`\`\`

CRITICAL RULES:
1. Respond ONLY with JSON
2. Evidence needed: list exact resources
3. No verbose explanations
`;
    }

    return "";
  }

  private async buildOptimizedPrompt(task: Task): Promise<string> {
    const basePrompt = task.task;

    // Get memory context from hierarchical/swarm memory
    const memoryContext = this.memoryManager?.getContext(task) || "";

    // Build cross-task context from completed specialist outputs (R2: sliding window)
    let crossTaskContext = "";
    if (this.completedOutputs.length > 0) {
      const isSynthesis = task.memoryMetadata?.category === "synthesis"
        || task.id.toLowerCase().includes("synthesis")
        || task.persona.toLowerCase().includes("manager")
        || task.persona.toLowerCase().includes("pm");

      // Synthesis tasks get ALL prior context; others get last N (crossTaskContextWindow)
      const window = isSynthesis
        ? this.completedOutputs
        : this.completedOutputs.slice(-this.config.crossTaskContextWindow);

      const entries = window.map(
        o => `### ${o.persona} (${o.category}):\n${o.summary}`
      ).join("\n\n");

      crossTaskContext = `## Prior Specialist Findings (${window.length} of ${this.completedOutputs.length})\n` +
        `Reference these to avoid duplication and provide cross-domain insights.\n\n${entries}`;
    }

    // Assemble prompt: memory context + cross-task context + base task
    let fullPrompt = "";

    if (memoryContext) {
      fullPrompt += memoryContext + "\n\n";
    }

    if (crossTaskContext) {
      fullPrompt += crossTaskContext + "\n\n";
    }

    // Add format constraint if applicable (O4)
    const formatConstraint = this.buildFormatConstraint(task);
    if (formatConstraint) {
      fullPrompt += formatConstraint + "\n\n";
    }

    fullPrompt += `## Your Task\n\n${basePrompt}`;

    // Check token budget
    const estimatedTokens = this.estimateTokens(fullPrompt);

    if (estimatedTokens > this.config.maxContextTokens * 0.9) {
      console.log(`  [${task.id}] Prompt exceeds token budget (${estimatedTokens} > ${this.config.maxContextTokens}), truncating...`);

      // Truncation priority: trim cross-task context first, then memory context
      if (crossTaskContext && estimatedTokens > this.config.maxContextTokens) {
        // Reduce cross-task window by 1 until within budget
        const reduced = this.completedOutputs.slice(-Math.max(1, this.config.crossTaskContextWindow - 1));
        crossTaskContext = `## Prior Specialist Findings (${reduced.length}, trimmed)\n` +
          reduced.map(o => `### ${o.persona} (${o.category}):\n${o.summary}`).join("\n\n");
        fullPrompt = (memoryContext ? memoryContext + "\n\n" : "") + crossTaskContext + `\n\n## Your Task\n\n${basePrompt}`;
      }

      // Still too long? Trim memory context
      const stillOver = this.estimateTokens(fullPrompt);
      if (stillOver > this.config.maxContextTokens * 0.9 && memoryContext) {
        const budgetExcess = stillOver - (this.config.maxContextTokens * 0.8);
        const truncatedMemory = this.truncateToBudget(memoryContext, memoryContext.length - Math.ceil(budgetExcess * 4));
        fullPrompt = truncatedMemory + "\n\n" + (crossTaskContext ? crossTaskContext + "\n\n" : "") + `## Your Task\n\n${basePrompt}`;
      }
    }

    return fullPrompt;
  }

  // --------------------------------------------------------------------------
  // AGENT COMMUNICATION
  // --------------------------------------------------------------------------

  private async callAgent(persona: string, prompt: string): Promise<string> {
    // Priority 1: Local executor (claude-code, hermes)
    const localExec = this.localExecutors.get(persona);
    if (localExec) {
      return this.callLocalAgent(localExec, prompt);
    }

    // Priority 2: Direct Anthropic API (bypasses Zo entirely)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      return this.callAnthropicDirect(persona, prompt, anthropicKey);
    }

    // Priority 3: Zo API (legacy fallback)
    const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
    if (!token) {
      throw new Error("No API key found. Set ANTHROPIC_API_KEY (preferred) or ZO_CLIENT_IDENTITY_TOKEN");
    }

    return this.callZoApi(persona, prompt, token);
  }

  private async callAnthropicDirect(persona: string, prompt: string, apiKey: string): Promise<string> {
    const timeoutMs = this.config.timeoutSeconds * 1000;
    const model = process.env.SWARM_ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

    // Load persona identity for system prompt
    const systemPrompt = this.loadPersonaSystemPrompt(persona);

    console.log(`  🔷 [${persona}] Direct Anthropic API → ${model}`);
    this.logger.log("anthropic_direct_start", { persona, model });

    const fetchPromise = fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
    }).then(async (response) => {
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${err.slice(0, 300)}`);
      }
      const data = await response.json() as { content: Array<{ type: string; text: string }> };
      return data.content?.map(b => b.text).join("\n") || "";
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Anthropic API timeout after ${this.config.timeoutSeconds}s`)), timeoutMs);
    });

    const result = await Promise.race([fetchPromise, timeoutPromise]);
    this.logger.log("anthropic_direct_complete", { persona, outputLength: result.length });
    return result;
  }

  private loadPersonaSystemPrompt(persona: string): string {
    // Try loading persona identity file
    const identityPath = join(PATHS.identityDir, `${persona}.md`);
    let identity = "";
    try {
      if (existsSync(identityPath)) {
        identity = readFileSync(identityPath, "utf-8");
      }
    } catch {}

    // Try loading persona memory
    const memoryPath = join(PATHS.personaMemoryDir, `${persona}.md`);
    let memory = "";
    try {
      if (existsSync(memoryPath)) {
        memory = readFileSync(memoryPath, "utf-8");
      }
    } catch {}

    // Try loading SOUL.md constitution
    let soul = "";
    try {
      const soulPath = PATHS.soulFile;
      if (existsSync(soulPath)) {
        soul = readFileSync(soulPath, "utf-8");
      }
    } catch {}

    const parts: string[] = [];
    if (soul) parts.push(soul);
    if (identity) parts.push(identity);
    if (memory) parts.push(`## Persona Memory\n\n${memory}`);
    if (parts.length === 0) {
      parts.push(`You are a ${persona} specialist. Respond with expertise in your domain.`);
    }

    return parts.join("\n\n---\n\n");
  }

  private async callZoApi(persona: string, prompt: string, token: string): Promise<string> {
    const timeoutMs = this.config.timeoutSeconds * 1000;

    console.log(`  ☁️  [${persona}] Zo API fallback`);

    const body: Record<string, any> = {
      input: `[Persona: ${persona}]\n\n${prompt}`,
    };
    if (this.config.modelName) {
      body.model_name = this.config.modelName;
    }

    const fetchPromise = fetch("https://api.zo.computer/zo/ask", {
      method: "POST",
      headers: {
        "authorization": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Zo API error: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      return data.output || "";
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Zo API timeout after ${this.config.timeoutSeconds}s`)), timeoutMs);
    });

    return Promise.race([fetchPromise, timeoutPromise]);
  }

  private async callLocalAgent(executor: LocalExecutor, prompt: string): Promise<string> {
    const timeoutMs = this.config.timeoutSeconds * 1000;

    if (!existsSync(executor.bridge)) {
      throw new Error(`Local executor bridge not found: ${executor.bridge}`);
    }

    console.log(`  🖥️  [${executor.id}] Routing to local executor: ${executor.name}`);
    this.logger.log("local_executor_start", { executor: executor.id, bridge: executor.bridge });

    const proc = Bun.spawn(["bash", executor.bridge, prompt], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const execPromise = (async () => {
      // Read stdout and stderr concurrently to avoid deadlock
      const [output, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`Local executor ${executor.id} exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
      }
      return output.trim();
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Local executor ${executor.id} timed out after ${this.config.timeoutSeconds}s`));
      }, timeoutMs);
    });

    const result = await Promise.race([execPromise, timeoutPromise]);
    this.logger.log("local_executor_complete", { executor: executor.id, outputLength: result.length });
    return result;
  }

  // --------------------------------------------------------------------------
  // CIRCUIT BREAKER
  // --------------------------------------------------------------------------

  private isCircuitOpen(persona: string): boolean {
    const cb = this.circuitBreakers.get(persona);
    if (!cb) return false;

    if (cb.isOpen) {
      // O6: Reduce reset window from 60s to 30s for faster recovery
      if (Date.now() - cb.lastFailure > 30000) {
        cb.isOpen = false;
        cb.failures = 0;
        console.log(`  🟢 Circuit breaker reset for ${persona}`);
        return false;
      }
      return true;
    }
    return false;
  }

  private recordSuccess(persona: string): void {
    this.circuitBreakers.set(persona, {
      failures: 0,
      lastFailure: 0,
      isOpen: false,
    });
  }

  private recordFailure(persona: string): void {
    const cb = this.circuitBreakers.get(persona) || { failures: 0, lastFailure: 0, isOpen: false };
    cb.failures++;
    cb.lastFailure = Date.now();

    // O6: Increase threshold from 2 to 3 failures to avoid false positives
    if (cb.failures >= 3) {
      cb.isOpen = true;
      console.log(`  🔴 Circuit breaker opened for ${persona} (${cb.failures} failures)`);
    }

    this.circuitBreakers.set(persona, cb);
  }

  // --------------------------------------------------------------------------
  // UTILITY METHODS
  // --------------------------------------------------------------------------

  private validatePersonas(tasks: Task[]): void {
    const knownPersonas = new Set<string>();
    const knownList: string[] = [];
    const identityDir = PATHS.identityDir;
    const registryPath = PATHS.agentPersonasRegistry;

    try {
      if (existsSync(identityDir)) {
        const { readdirSync } = require("fs");
        for (const file of readdirSync(identityDir) as string[]) {
          if (file.endsWith(".md")) {
            const name = file.replace(".md", "");
            knownPersonas.add(name);
            knownList.push(name);
          }
        }
      }
    } catch {}

    try {
      if (existsSync(registryPath)) {
        const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
        if (Array.isArray(registry)) {
          for (const p of registry) {
            if (p.slug) { knownPersonas.add(p.slug); knownList.push(p.slug); }
            if (p.name) { knownPersonas.add(p.name); knownList.push(p.name); }
          }
        } else if (typeof registry === "object") {
          for (const category of Object.values(registry)) {
            if (Array.isArray(category)) {
              for (const p of category as any[]) {
                if (p.slug) { knownPersonas.add(p.slug); knownList.push(p.slug); }
                if (p.name) { knownPersonas.add(p.name); knownList.push(p.name); }
              }
            }
          }
        }
      }
    } catch {}

    if (knownPersonas.size === 0) return;

    const uniqueKnown = [...new Set(knownList)];

    for (const task of tasks) {
      // Skip fuzzy matching for local executor personas — they're invoked by exact ID
      if (this.localExecutors.has(task.persona)) continue;

      if (!knownPersonas.has(task.persona)) {
        const match = this.fuzzyMatchPersona(task.persona, uniqueKnown);
        if (match) {
          const original = task.persona;
          task.persona = match.name;
          this.personaMappings.set(original, match.name);
          console.log(`  🔄 Mapped "${original}" → "${match.name}" (score: ${match.score.toFixed(2)})`);
          this.logger.log("persona_mapped", { original, matched: match.name, score: match.score });
        } else {
          console.log(`  ⚠️  No match found for "${task.persona}" — will produce generic response`);
        }
      }
    }

    if (this.personaMappings.size > 0) {
      console.log(`   Resolved ${this.personaMappings.size} persona(s) via fuzzy matching. Known personas: ${knownPersonas.size}\n`);
    }
  }

  private fuzzyMatchPersona(unknown: string, known: string[]): { name: string; score: number } | null {
    const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]+/g, " ").trim();
    const toKeywords = (s: string) => normalize(s).split(" ").filter(w => w.length > 2);

    const unknownNorm = normalize(unknown);
    const unknownKeywords = toKeywords(unknown);

    let bestMatch: { name: string; score: number } | null = null;

    for (const candidate of known) {
      const candidateNorm = normalize(candidate);
      const candidateKeywords = toKeywords(candidate);

      // Score 1: Levenshtein similarity (0-1)
      const levDist = this.levenshtein(unknownNorm, candidateNorm);
      const maxLen = Math.max(unknownNorm.length, candidateNorm.length);
      const levScore = maxLen > 0 ? 1 - levDist / maxLen : 0;

      // Score 2: Keyword overlap (0-1)
      let keywordOverlap = 0;
      if (unknownKeywords.length > 0 && candidateKeywords.length > 0) {
        const matches = unknownKeywords.filter(uk =>
          candidateKeywords.some(ck => ck.includes(uk) || uk.includes(ck))
        );
        keywordOverlap = matches.length / Math.max(unknownKeywords.length, candidateKeywords.length);
      }

      // Score 3: Substring containment bonus
      let substringBonus = 0;
      if (candidateNorm.includes(unknownNorm) || unknownNorm.includes(candidateNorm)) {
        substringBonus = 0.3;
      }

      // Combined score (weighted)
      const score = levScore * 0.4 + keywordOverlap * 0.4 + substringBonus * 0.2;

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { name: candidate, score };
      }
    }

    // Minimum threshold to accept a match
    return bestMatch && bestMatch.score >= 0.25 ? bestMatch : null;
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  private sortByPriority(tasks: Task[]): Task[] {
    const priorityOrder: Record<PriorityQueue, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return [...tasks].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  private createChunks<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private estimateTokens(text: string): number {
    // ~3.5 chars per token for Claude/GPT models + 20% overhead for system tokens
    return Math.ceil((text.length / 3.5) * 1.2);
  }

  private truncateToBudget(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    
    // Try to truncate at a sensible boundary
    const truncated = text.substring(0, maxLength);
    const lastComplete = truncated.lastIndexOf('\n\n');
    const lastSentence = truncated.lastIndexOf('. ');
    
    if (lastComplete > maxLength * 0.5) {
      return truncated.substring(0, lastComplete) + '\n\n[...context truncated due to token budget...]\n';
    }
    if (lastSentence > maxLength * 0.5) {
      return truncated.substring(0, lastSentence + 1) + '\n[...context truncated due to token budget...]\n';
    }
    
    return truncated + '[...]';
  }

  // --------------------------------------------------------------------------
  // RESULT PERSISTENCE
  // --------------------------------------------------------------------------

  private async saveResults(totalDurationMs: number): Promise<string | null> {
    try {
      const resultsDir = join(process.env.HOME || "/tmp", ".swarm", "results");
      if (!existsSync(resultsDir)) {
        mkdirSync(resultsDir, { recursive: true });
      }

      const successful = this.results.filter(r => r.success);
      const failed = this.results.filter(r => !r.success);
      const totalTokens = successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);

      const outputPath = join(resultsDir, `${this.swarmId}_${Date.now()}.json`);
      const report = {
        swarmId: this.swarmId,
        sessionId: this.sessionId,
        config: {
          maxConcurrency: this.config.maxConcurrency,
          timeoutSeconds: this.config.timeoutSeconds,
          maxRetries: this.config.maxRetries,
          enableMemory: this.config.enableMemory,
          maxContextTokens: this.config.maxContextTokens,
        },
        summary: {
          total: this.results.length,
          successful: successful.length,
          failed: failed.length,
          totalDurationMs,
          totalTokensEstimated: totalTokens,
        },
        results: this.results.map(r => ({
          taskId: r.task.id,
          persona: r.task.persona,
          priority: r.task.priority,
          success: r.success,
          durationMs: r.durationMs,
          retries: r.retries,
          tokensUsed: r.tokensUsed,
          error: r.error,
          outputLength: r.output?.length,
        })),
        timestamp: new Date().toISOString(),
      };

      await Bun.write(outputPath, JSON.stringify(report, null, 2));
      return outputPath;
    } catch (err) {
      console.warn(`Failed to save results: ${err}`);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------

  private async printSummary(totalDurationMs: number): Promise<void> {
    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);
    const avgDuration = successful.reduce((sum, r) => sum + r.durationMs, 0) / successful.length || 0;
    const totalTokens = successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);

    console.log(`\n📊 Execution Summary`);
    console.log(`   Total tasks: ${this.results.length}`);
    console.log(`   Successful: ${successful.length}`);
    console.log(`   Failed: ${failed.length}`);
    console.log(`   Total duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
    console.log(`   Avg duration per task: ${Math.round(avgDuration)}ms`);
    console.log(`   Total tokens used: ~${totalTokens.toLocaleString()}`);

    // Memory stats
    if (this.memoryManager) {
      const stats = this.memoryManager.getStats();
      if (stats?.memory) {
        console.log(`   Memory items: ${stats.memory.totalContextSize}`);
        console.log(`   Memory tokens: ~${stats.memory.estimatedTokens.toLocaleString()}`);
        if (stats.memory.tokenBudget) {
          console.log(`   Budget utilization: ${(stats.memory.budgetUtilization * 100).toFixed(1)}%`);
        }
      }
    }

    if (failed.length > 0) {
      console.log(`\n❌ Failed tasks:`);
      for (const result of failed) {
        console.log(`   - ${result.task.id}: ${result.error}`);
      }
    }

    // Save results to disk
    const outputPath = await this.saveResults(totalDurationMs);
    if (outputPath) {
      console.log(`\n💾 Results saved to: ${outputPath}`);
    }
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  const showUsage = () => {
    console.log("Swarm Orchestrator v4.0.0 - Token Optimizer");
    console.log("\nUsage: bun orchestrate-v4.ts <tasks.json> [options]");
    console.log("\nOptions:");
    console.log("  --help, -h            Show this help message");
    console.log("  --swarm-id <id>       Specify swarm ID");
    console.log("  --no-memory           Disable persistent memory");
    console.log("  --strategy <type>     Memory strategy: hierarchical|sliding|none (default: hierarchical)");
    console.log("  --max-tokens <n>      Max context tokens (default: 8000)");
    console.log("  --concurrency <n>     Max concurrent tasks (default: 2)");
    console.log("  --timeout <seconds>   Task timeout in seconds (default: 300)");
    console.log("  --dag-mode <mode>     DAG execution mode: streaming|waves (default: streaming)");
    console.log("  --model <name>        Model name for API calls (default: from env)");
  };

  if (args.length < 1 || args[0] === "--help" || args[0] === "-h") {
    showUsage();
    process.exit(args.length < 1 ? 1 : 0);
  }

  // Doctor command — system health check
  if (args[0] === "doctor") {
    console.log("🩺 Swarm Orchestrator Doctor\n");

    // 1. Config check
    const cfg = loadConfig();
    console.log("Config:");
    console.log(`  maxConcurrency: ${cfg.maxConcurrency} ${cfg.maxConcurrency > 2 ? "⚠️  (>2 risks rate limiting)" : "✓"}`);
    console.log(`  timeoutSeconds: ${cfg.timeoutSeconds} ${cfg.timeoutSeconds > 600 ? "⚠️  (very long)" : "✓"}`);
    console.log(`  maxRetries: ${cfg.maxRetries} ✓`);
    console.log(`  memory.enable: ${cfg.memory.enable} ✓`);

    // 2. API token check
    const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
    console.log(`\nAPI Token: ${token ? "present ✓" : "MISSING ✗"}`);

    // 3. Swarm memory DB check
    const swarmDbPath = join(process.env.HOME || "/tmp", ".swarm", "swarm-memory.db");
    console.log(`\nSwarm Memory DB: ${existsSync(swarmDbPath) ? `exists ✓ (${swarmDbPath})` : "not found (will be created on first run)"}`);
    if (existsSync(swarmDbPath)) {
      try {
        const { SwarmMemory } = await import("./swarm-memory");
        const mem = new SwarmMemory(swarmDbPath);
        const stats = mem.getStats();
        console.log(`  Contexts: ${stats.contexts}`);
        console.log(`  Sessions: ${stats.sessions}`);
        mem.close();
      } catch (e) {
        console.log(`  Error reading DB: ${e}`);
      }
    }

    // 4. Results directory check
    const resultsDir = join(process.env.HOME || "/tmp", ".swarm", "results");
    if (existsSync(resultsDir)) {
      const { readdirSync, statSync } = require("fs");
      const files = (readdirSync(resultsDir) as string[]).filter((f: string) => f.endsWith(".json"));
      console.log(`\nResults Directory: ${resultsDir}`);
      console.log(`  Saved runs: ${files.length}`);
      if (files.length > 0) {
        const latest = files.sort().reverse()[0];
        const stat = statSync(join(resultsDir, latest));
        console.log(`  Latest: ${latest} (${new Date(stat.mtime).toLocaleString()})`);
      }
    } else {
      console.log(`\nResults Directory: not yet created`);
    }

    // 5. Logs directory check
    const logsDir = join(process.env.HOME || "/tmp", ".swarm", "logs");
    if (existsSync(logsDir)) {
      const { readdirSync } = require("fs");
      const logFiles = (readdirSync(logsDir) as string[]).filter((f: string) => f.endsWith(".ndjson"));
      console.log(`\nLogs Directory: ${logsDir}`);
      console.log(`  Log files: ${logFiles.length}`);
    } else {
      console.log(`\nLogs Directory: not yet created`);
    }

    // 6. Persona registry check
    const identityDir = PATHS.identityDir;
    if (existsSync(identityDir)) {
      const { readdirSync } = require("fs");
      const personas = (readdirSync(identityDir) as string[]).filter((f: string) => f.endsWith(".md"));
      console.log(`\nPersona Registry: ${identityDir}`);
      console.log(`  Available personas: ${personas.length}`);
    }

    console.log("\n✅ Doctor check complete");
    process.exit(0);
  }

  const taskFile = args[0];

  // Load config.json as base defaults, then let CLI args override
  const fileConfig = loadConfig();

  // Parse options (CLI args override config.json values)
  let swarmId = `swarm_${Date.now()}`;
  let enableMemory = fileConfig.memory.enable;
  let strategy: MemoryStrategy = {
    workingMemorySize: fileConfig.memory.workingMemorySize,
    longTermMemorySize: fileConfig.memory.longTermMemorySize,
    enableDeduplication: fileConfig.memory.enableDeduplication,
    enableHTMLStripping: fileConfig.memory.enableHTMLStripping,
    maxTokens: fileConfig.memory.maxTokens,
  };
  let maxTokens = fileConfig.memory.maxTokens;
  let concurrency = fileConfig.maxConcurrency;
  let localConcurrency = fileConfig.localConcurrency;
  let timeoutSeconds = fileConfig.timeoutSeconds;
  let dagMode: "streaming" | "waves" = "streaming";

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--swarm-id":
        swarmId = args[++i];
        break;
      case "--no-memory":
        enableMemory = false;
        break;
      case "--strategy":
        const strat = args[++i];
        if (strat === "sliding") {
          strategy.workingMemorySize = 4;
          strategy.longTermMemorySize = 0;
        } else if (strat === "none") {
          enableMemory = false;
        }
        break;
      case "--max-tokens":
        maxTokens = parseInt(args[++i]);
        break;
      case "--concurrency":
        concurrency = parseInt(args[++i]);
        break;
      case "--local-concurrency":
        localConcurrency = parseInt(args[++i]);
        break;
      case "--timeout":
        timeoutSeconds = parseInt(args[++i]);
        break;
      case "--dag-mode":
        dagMode = args[++i] as "streaming" | "waves";
        break;
      case "--model":
        fileConfig.modelName = args[++i];
        break;
    }
  }

  // Update config
  strategy.maxTokens = maxTokens;

  // Load tasks
  let tasks: Task[];
  try {
    const file = await Bun.file(taskFile).json();
    tasks = Array.isArray(file) ? file : [file];
  } catch (error) {
    console.error(`Error loading task file: ${error}`);
    process.exit(1);
  }

  // Run orchestrator
  const orchestrator = new TokenOptimizedOrchestrator(swarmId, {
    enableMemory,
    defaultMemoryStrategy: strategy,
    maxContextTokens: maxTokens,
    maxConcurrency: concurrency,
    localConcurrency,
    timeoutSeconds,
    maxRetries: fileConfig.maxRetries,
    dagMode,
    modelName: fileConfig.modelName,
  });

  try {
    await orchestrator.run(tasks);
  } catch (error) {
    console.error(`Orchestration failed: ${error}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

export { TokenOptimizedOrchestrator, Task, TaskResult, OrchestratorConfig, MemoryManager };
