#!/usr/bin/env bun
/**
 * Swarm Orchestrator v4.5.0 - Memory-Enriched Routing
 *
 * Building on v3's persistent memory, v4 adds:
 * - Token optimization (HTML stripping, normalization, deduplication)
 * - Hierarchical memory (working + LTM)
 * - Sliding window memory option
 * - Token budget management
 * - Multiple memory strategies
 *
 * v4.2 adds:
 * - Composite router (4-signal weighted scoring: capability, health, complexity fit, history)
 * - Retry-with-reroute (on failure, demote executor and try next-best)
 * - Persistent executor history with time/count decay
 * - Routing strategy presets (fast, reliable, balanced, explore)
 *
 * v4.3 "Hivemind Routing" adds:
 * - Semantic synonym expansion in capability matching (22 synonym clusters)
 * - Flattened complexity affinity matrix for fairer executor distribution
 * - Expanded executor expertise keywords for hermes and gemini
 * - All 4 executors now get meaningful routing opportunities
 *
 * v4.5 "Memory-Enriched Routing" adds:
 * - Cognitive profiles (episode linkage, failure patterns, entity affinities)
 * - Episodic memory integration (auto-creates episodes after swarm runs)
 * - Procedure + temporal scoring signals in composite router
 * - 6-signal routing: capability + health + complexity + history + procedure + temporal
 *
 * Inspired by:
 * - prompt-refiner: Schema/Response compression
 * - Agent-Memory-Playground: 9 memory strategies
 */

import { SwarmMemory, getSwarmMemory, ContextAccessMode, MemoryQuery } from "./swarm-memory";
import { HierarchicalMemory, SlidingWindowMemory, MemoryItem, MemoryStrategy } from "./token-optimizer";
import { setInterval, clearInterval } from "timers";
import { join } from "path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

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

  // R2: Per-task timeout override (falls back to config.timeoutSeconds if not set)
  timeoutSeconds?: number;

  // R3: Expected file mutations — verified after task completion
  expectedMutations?: Array<{
    file: string;
    contains: string;
  }>;
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
  localConcurrency: number;
  timeoutSeconds: number;
  maxRetries: number;
  enableMemory: boolean;
  defaultMemoryStrategy: MemoryStrategy;
  maxContextTokens: number;
  crossTaskContextWindow: number;
  dagMode: "streaming" | "waves";
  memoryDbPath?: string;
  modelName?: string;
  // R5: Async completion notification channel (none = file only, sms = SMS, email = email)
  notifyOnComplete?: "none" | "sms" | "email";
  // v4.2: Composite routing strategy
  routingStrategy?: RoutingStrategy;
  // v4.6: OmniRoute API-level failover
  omniRouteEnabled?: boolean;
  omniRouteUrl?: string;
  omniRouteModel?: string;  // combo name, e.g. "swarm-failover"
  omniRouteApiKey?: string;
}

interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

// ============================================================================
// COMPOSITE ROUTER TYPES & HELPERS (v4.2)
// ============================================================================

type ComplexityTier = "trivial" | "simple" | "moderate" | "complex";

interface ComplexityEstimate {
  tier: ComplexityTier;
  signals: {
    wordCount: number;
    fileCount: number;
    hasMultiStep: boolean;
    hasTool: boolean;
    hasAnalysis: boolean;
  };
}

interface CapabilityScore {
  raw: number;
  normalized: number;
  matches: string[];
}

interface RouteDecision {
  executorId: string;
  executorName: string;
  compositeScore: number;
  breakdown: {
    capability: number;
    health: number;
    complexityFit: number;
    history: number;
    procedure?: number;   // v4.5: learned workflow preference
    temporal?: number;    // v4.5: recent episodic performance
  };
  method: "composite" | "fallback";
}

interface RouterWeights {
  capability: number;
  health: number;
  complexityFit: number;
  history: number;
}

type RoutingStrategy = "fast" | "reliable" | "balanced" | "explore";

const STRATEGY_WEIGHTS: Record<RoutingStrategy, RouterWeights> = {
  fast:     { capability: 0.15, health: 0.25, complexityFit: 0.45, history: 0.15 },
  reliable: { capability: 0.20, health: 0.45, complexityFit: 0.15, history: 0.20 },
  balanced: { capability: 0.30, health: 0.35, complexityFit: 0.20, history: 0.15 },
  explore:  { capability: 0.40, health: 0.20, complexityFit: 0.20, history: 0.20 },
};

const COMPLEXITY_AFFINITY: Record<string, Record<ComplexityTier, number>> = {
  "codex":       { trivial: 0.90, simple: 0.85, moderate: 0.55, complex: 0.30 },
  "gemini":      { trivial: 0.75, simple: 0.80, moderate: 0.90, complex: 0.85 },
  "hermes":      { trivial: 0.70, simple: 0.75, moderate: 0.85, complex: 0.80 },
  "claude-code": { trivial: 0.65, simple: 0.75, moderate: 0.90, complex: 1.00 },
};

function estimateComplexity(task: Task): ComplexityEstimate {
  const text = task.task.toLowerCase();
  const words = text.split(/\s+/).length;
  const fileRefs = (text.match(/\/[\w\-./]+\.\w+/g) || []).length;
  const hasMultiStep = /\b(then|after that|next|step \d|finally|first|second|third)\b/.test(text)
    || (text.match(/\d+\.\s/g) || []).length >= 2;
  const hasTool = /\b(git|npm|bun|pip|curl|sed|grep|mkdir|chmod|docker)\b/.test(text);
  const hasAnalysis = /\b(analy[zs]e|review|audit|compare|evaluate|assess|inspect)\b/.test(text);

  const score = (words > 200 ? 1 : 0) + (fileRefs > 3 ? 1 : 0)
    + (hasMultiStep ? 1 : 0) + (hasTool ? 1 : 0) + (hasAnalysis ? 1 : 0);

  let tier: ComplexityTier;
  if (score <= 1) tier = "trivial";
  else if (score <= 2) tier = "simple";
  else if (score <= 3) tier = "moderate";
  else tier = "complex";

  return { tier, signals: { wordCount: words, fileCount: fileRefs, hasMultiStep, hasTool, hasAnalysis } };
}

function complexityFitScore(executorId: string, complexity: ComplexityTier): number {
  return COMPLEXITY_AFFINITY[executorId]?.[complexity] ?? 0.5;
}

// ============================================================================
// EXECUTOR HISTORY PERSISTENCE (v4.2)
// ============================================================================

interface ExecutorHistoryEntry {
  attempts: number;
  successes: number;
  avgDurationMs: number;
  lastUpdated: number;
  // Cognitive profile extensions (v4.5)
  recent_episode_ids?: string[];    // Last 10 episode IDs for context
  failure_patterns?: string[];      // Common error types (for routing avoidance)
  entity_affinities?: Record<string, number>;  // Entity → affinity score (0-1)
}

type ExecutorHistory = Record<string, ExecutorHistoryEntry>;

const HISTORY_DECAY_THRESHOLD = 50;
const HISTORY_TIME_DECAY_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const HISTORY_TIME_ZERO_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

function getHistoryPath(): string {
  return join(process.env.HOME || "/tmp", ".swarm", "executor-history.json");
}

function loadHistory(): ExecutorHistory {
  try {
    const path = getHistoryPath();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw) as [string, ExecutorHistoryEntry][]) {
        if (now - entry.lastUpdated > HISTORY_TIME_ZERO_MS) {
          delete raw[key];
        } else if (now - entry.lastUpdated > HISTORY_TIME_DECAY_MS) {
          entry.attempts = Math.ceil(entry.attempts / 2);
          entry.successes = Math.ceil(entry.successes / 2);
        }
      }
      return raw;
    }
  } catch {}
  return {};
}

function saveHistory(history: ExecutorHistory): void {
  try {
    const path = getHistoryPath();
    const dir = join(process.env.HOME || "/tmp", ".swarm");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(history, null, 2));
  } catch {}
}

function historyScore(executorId: string, category: string): number {
  const history = loadHistory();
  const key = `${executorId}:${category}`;
  const entry = history[key];
  if (!entry || entry.attempts < 3) return 0.5;
  return entry.successes / entry.attempts;
}

function recordOutcome(
  executorId: string,
  category: string,
  success: boolean,
  durationMs: number,
  cognitive?: { episodeId?: string; errorType?: string; entities?: string[] }
): void {
  const history = loadHistory();
  const key = `${executorId}:${category}`;
  const entry = history[key] || { attempts: 0, successes: 0, avgDurationMs: 0, lastUpdated: 0 };

  entry.attempts++;
  if (success) entry.successes++;
  entry.avgDurationMs = (entry.avgDurationMs * (entry.attempts - 1) + durationMs) / entry.attempts;
  entry.lastUpdated = Date.now();

  if (entry.attempts > HISTORY_DECAY_THRESHOLD) {
    entry.attempts = Math.ceil(entry.attempts / 2);
    entry.successes = Math.ceil(entry.successes / 2);
  }

  // Cognitive profile extensions
  if (cognitive?.episodeId) {
    entry.recent_episode_ids = [
      cognitive.episodeId,
      ...(entry.recent_episode_ids || []).slice(0, 9),
    ];
  }

  if (!success && cognitive?.errorType) {
    entry.failure_patterns = [
      cognitive.errorType,
      ...(entry.failure_patterns || []).slice(0, 4),
    ];
  }

  if (cognitive?.entities?.length) {
    const affinities = entry.entity_affinities || {};
    for (const entity of cognitive.entities) {
      const prev = affinities[entity] || 0.5;
      // Exponential moving average: success pushes toward 1.0, failure toward 0.0
      affinities[entity] = prev * 0.7 + (success ? 1.0 : 0.0) * 0.3;
    }
    entry.entity_affinities = affinities;
  }

  history[key] = entry;
  saveHistory(history);
}

/** Get the cognitive profile for an executor:category pair. */
function getCognitiveProfile(executorId: string, category: string): ExecutorHistoryEntry | null {
  const history = loadHistory();
  return history[`${executorId}:${category}`] || null;
}

/** Check if an executor has a known failure pattern (for routing avoidance). */
function hasFailurePattern(executorId: string, category: string, pattern: string): boolean {
  const profile = getCognitiveProfile(executorId, category);
  return profile?.failure_patterns?.includes(pattern) ?? false;
}

// ============================================================================
// EPISODIC MEMORY INTEGRATION (v4.5)
// ============================================================================

const MEMORY_DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

/** Create a swarm episode in the shared memory DB. Returns episode ID or null on error. */
function createSwarmEpisode(opts: {
  swarmId: string;
  summary: string;
  outcome: "success" | "failure" | "resolved" | "ongoing";
  durationMs: number;
  entities: string[];
  metadata?: Record<string, unknown>;
}): string | null {
  try {
    if (!existsSync(MEMORY_DB_PATH)) return null;
    const db = new Database(MEMORY_DB_PATH);

    // Check episodes table exists (pre-migration DBs won't have it)
    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'"
    ).get();
    if (!hasTable) { db.close(); return null; }

    const id = randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);

    db.prepare(`
      INSERT INTO episodes (id, summary, outcome, happened_at, duration_ms, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, opts.summary, opts.outcome, nowSec, opts.durationMs, JSON.stringify(opts.metadata || {}), nowSec);

    for (const entity of opts.entities) {
      db.prepare("INSERT OR IGNORE INTO episode_entities (episode_id, entity) VALUES (?, ?)").run(id, entity);
    }

    db.close();
    return id;
  } catch {
    return null;
  }
}

/** Get recent success rate for an executor from episodic memory. Returns 0.5 as neutral if no data. */
function getRecentSuccessRate(executorId: string, sinceDays: number = 7): number {
  try {
    if (!existsSync(MEMORY_DB_PATH)) return 0.5;
    const db = new Database(MEMORY_DB_PATH);

    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'"
    ).get();
    if (!hasTable) { db.close(); return 0.5; }

    const sinceTs = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN e.outcome = 'success' THEN 1 ELSE 0 END) as successes
      FROM episodes e
      JOIN episode_entities ee ON e.id = ee.episode_id
      WHERE ee.entity = ? AND e.happened_at >= ?
    `).get(executorId, sinceTs) as { total: number; successes: number } | null;

    db.close();
    if (!row || row.total < 2) return 0.5;  // Not enough data — neutral
    return row.successes / row.total;
  } catch {
    return 0.5;
  }
}

/** Get procedure success rate for an executor + category from procedures table. Returns 0.5 if no data. */
function getProcedureSuccessRate(executorId: string, category?: string): number {
  try {
    if (!existsSync(MEMORY_DB_PATH)) return 0.5;
    const db = new Database(MEMORY_DB_PATH);

    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='procedures'"
    ).get();
    if (!hasTable) { db.close(); return 0.5; }

    // Find procedures whose steps include this executor
    const rows = db.prepare(
      "SELECT steps, success_count, failure_count FROM procedures ORDER BY version DESC"
    ).all() as Array<{ steps: string; success_count: number; failure_count: number }>;

    db.close();

    let totalSuccess = 0, totalFailure = 0;
    for (const row of rows) {
      try {
        const steps = JSON.parse(row.steps) as Array<{ executor: string; taskPattern: string }>;
        if (steps.some(s => s.executor === executorId)) {
          totalSuccess += row.success_count;
          totalFailure += row.failure_count;
        }
      } catch {}
    }

    const total = totalSuccess + totalFailure;
    if (total < 2) return 0.5;
    return totalSuccess / total;
  } catch {
    return 0.5;
  }
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG: OrchestratorConfig = {
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
  routingStrategy: (process.env.SWARM_ROUTING_STRATEGY as RoutingStrategy) || "balanced",
  omniRouteEnabled: process.env.SWARM_OMNIROUTE_ENABLED !== "false",
  omniRouteUrl: process.env.SWARM_OMNIROUTE_URL || "http://localhost:20128/v1/chat/completions",
  omniRouteModel: process.env.SWARM_OMNIROUTE_MODEL || "swarm-failover",
  omniRouteApiKey: process.env.SWARM_OMNIROUTE_API_KEY || undefined,
};

// ============================================================================
// CONFIGURATION LOADING
// ============================================================================

interface RuntimeConfig {
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
  executorRegistry: process.env.SWARM_EXECUTOR_REGISTRY || join(WORKSPACE, "Skills", "zo-swarm-executors", "registry", "executor-registry.json"),
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
      writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
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
      await writeFileSync(this.logPath, this.lines.join("\n") + "\n");
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

// Capability profile for auto-routing (loaded from executor-registry.json + persona-registry.json)
interface ExecutorCapability {
  id: string;
  name: string;
  expertise: string[];    // e.g. ["code-generation", "web-research"]
  bestFor: string[];      // e.g. ["Complex multi-file code changes", "Web research"]
  isLocal: boolean;
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
  private executorCapabilities: Map<string, ExecutorCapability> = new Map();
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
          // Register local executor bridge
          if (p.executor === "local" && p.bridge) {
            const bridgePath = p.bridge.startsWith("/") ? p.bridge : join(WORKSPACE, p.bridge);
            this.localExecutors.set(p.id, {
              id: p.id,
              bridge: bridgePath,
              name: p.name || p.id,
            });
          }
          // Register capability profile for all personas (local and API)
          if (p.expertise || p.best_for) {
            this.executorCapabilities.set(p.id, {
              id: p.id,
              name: p.name || p.id,
              expertise: p.expertise || [],
              bestFor: p.best_for || [],
              isLocal: p.executor === "local",
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

    // Enrich capabilities from executor-registry.json (has more detailed expertise/best_for)
    try {
      if (existsSync(PATHS.executorRegistry)) {
        const execRegistry = JSON.parse(readFileSync(PATHS.executorRegistry, "utf-8"));
        const executors = execRegistry.executors || [];
        for (const ex of executors) {
          if (!ex.id) continue;
          const existing = this.executorCapabilities.get(ex.id);
          if (existing) {
            // Merge: executor-registry data supplements persona-registry data
            const mergedExpertise = new Set([...existing.expertise, ...(ex.expertise || [])]);
            const mergedBestFor = new Set([...existing.bestFor, ...(ex.best_for || [])]);
            existing.expertise = [...mergedExpertise];
            existing.bestFor = [...mergedBestFor];
          } else if (ex.expertise || ex.best_for) {
            this.executorCapabilities.set(ex.id, {
              id: ex.id,
              name: ex.name || ex.id,
              expertise: ex.expertise || [],
              bestFor: ex.best_for || [],
              isLocal: ex.executor === "local",
            });
          }
        }
      }
    } catch {
      // Executor registry enrichment is best-effort
    }

    if (this.executorCapabilities.size > 0) {
      console.log(`   Auto-route capable: ${[...this.executorCapabilities.keys()].join(", ")}`);
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
      writeFileSync(this.progressFile, JSON.stringify(progress, null, 2));
    } catch {}
  }

  // --------------------------------------------------------------------------
  // MAIN EXECUTION
  // --------------------------------------------------------------------------

  // R1: Startup Health Check — validate prerequisites before entering DAG loop
  private async preflight(tasks: Task[]): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    // 1. Validate campaign JSON structure
    for (const task of tasks) {
      if (!task.id || !task.persona || !task.task) {
        errors.push(`Invalid task: missing required fields (id=${task.id}, persona=${task.persona})`);
      }
    }

    // 2. Check for duplicate task IDs
    const ids = tasks.map(t => t.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      errors.push(`Duplicate task IDs: ${[...new Set(dupes)].join(", ")}`);
    }

    // 3. Verify local executor bridges exist and are executable
    for (const task of tasks) {
      const executor = this.localExecutors.get(task.persona);
      if (executor) {
        if (!existsSync(executor.bridge)) {
          errors.push(`Local executor bridge not found: ${executor.bridge} (persona: ${task.persona})`);
        }
      } else {
        errors.push(`No local executor found for persona: ${task.persona}. All tasks must have a local executor.`);
      }
    }

    // 5. Verify DAG dependency references are valid
    const taskIds = new Set(tasks.map(t => t.id));
    for (const task of tasks) {
      for (const dep of task.dependsOn || []) {
        if (!taskIds.has(dep)) {
          errors.push(`Task ${task.id} depends on unknown task: ${dep}`);
        }
      }
    }

    // 6. Check for dependency cycles (simple DFS)
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const hasCycle = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      const task = taskMap.get(id);
      for (const dep of task?.dependsOn || []) {
        if (hasCycle(dep)) return true;
      }
      inStack.delete(id);
      return false;
    };
    for (const task of tasks) {
      visited.clear();
      inStack.clear();
      if (hasCycle(task.id)) {
        errors.push(`Dependency cycle detected involving task: ${task.id}`);
        break;
      }
    }

    // 7. Test memory system connectivity (best-effort)
    if (this.config.enableMemory && this.memoryManager) {
      try {
        const stats = this.memoryManager.getStats();
        if (!stats) {
          errors.push("Memory system returned null stats — may not be initialized");
        }
      } catch (e) {
        errors.push(`Memory system error: ${e}`);
      }
    }

    // 8. v4.6: Check OmniRoute availability (best-effort, non-blocking)
    if (this.config.omniRouteEnabled) {
      try {
        const baseUrl = this.config.omniRouteUrl!.replace("/chat/completions", "/models");
        const resp = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data: any = await resp.json();
          const models = data.data?.map((m: any) => m.id) || [];
          const hasCombo = models.includes(this.config.omniRouteModel);
          if (hasCombo) {
            console.log(`  🌐 OmniRoute: ${this.config.omniRouteModel} combo available (${models.length} models)`);
          } else {
            console.log(`  ⚠️  OmniRoute: combo "${this.config.omniRouteModel}" not found. Available: ${models.slice(0, 5).join(", ")}...`);
          }
        } else {
          console.log(`  ⚠️  OmniRoute: health check failed (HTTP ${resp.status}) — failover disabled`);
          this.config.omniRouteEnabled = false;
        }
      } catch {
        console.log("  ⚠️  OmniRoute: not reachable — failover disabled for this run");
        this.config.omniRouteEnabled = false;
      }
    }

    return { ok: errors.length === 0, errors };
  }

    async run(tasks: Task[]): Promise<TaskResult[]> {
    const startTime = Date.now();
    this.runStartTime = startTime;
    this.totalTaskCount = tasks.length;

    // R1: Campaign Locking — prevent duplicate concurrent runs
    const lockPath = `/dev/shm/${this.swarmId}.lock`;
    const STALE_LOCK_MS = 30 * 60 * 1000; // 30 minutes
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        if (Date.now() - lock.ts < STALE_LOCK_MS) {
          const msg = `Campaign ${this.swarmId} already running (PID ${lock.pid}, started ${new Date(lock.ts).toISOString()})`;
          console.error(`\n🔒 ${msg}`);
          this.logger.log("campaign_lock_rejected", { swarmId: this.swarmId, existingPid: lock.pid, existingTs: lock.ts });
          throw new Error(msg);
        }
        console.log(`  🔓 Stale lock found (>${STALE_LOCK_MS / 60000}m old), overriding`);
        this.logger.log("campaign_lock_stale_override", { swarmId: this.swarmId, stalePid: lock.pid });
      } catch (e) {
        if ((e as Error).message?.includes("already running")) throw e;
        // Corrupt lock file — override it
      }
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), swarmId: this.swarmId }));
    this.logger.log("campaign_lock_acquired", { swarmId: this.swarmId, pid: process.pid });

    try {

    console.log(`\n🐝 Swarm Orchestrator v4.4.0 - Local Executors Only`);
    console.log(`   Swarm ID: ${this.swarmId}`);
    console.log(`   Session: ${this.sessionId}`);
    console.log(`   Tasks: ${tasks.length}`);
    console.log(`   Concurrency: ${this.config.localConcurrency}`);
    console.log(`   Max Context Tokens: ${this.config.maxContextTokens}`);
    console.log(`   Memory Strategy: ${this.config.defaultMemoryStrategy.enableDeduplication ? "Hierarchical (optimized)" : "Basic"}`);
    console.log(`   Executors: ${[...this.localExecutors.keys()].join(", ")}`);
    console.log();

    this.logger.log("run_start", {
      swarmId: this.swarmId,
      sessionId: this.sessionId,
      taskCount: tasks.length,
      concurrency: this.config.localConcurrency,
    });

    // Write initial progress
    this.writeProgress({ status: "started" });

    // Persist swarm session to swarm-memory.db
    if (this.memoryManager && (this.memoryManager as any).swarmMemory) {
      try {
        (this.memoryManager as any).swarmMemory.createSession(this.swarmId, this.sessionId, {
          taskCount: tasks.length,
          concurrency: this.config.localConcurrency,
          dagMode: this.config.dagMode,
        });
      } catch (err) {
        console.log(`  [swarm-memory] Failed to create session: ${err}`);
      }
    }

    // Validate personas
    this.validatePersonas(tasks);

    // R4: Startup health check — validate prerequisites before DAG execution
    const preflight = await this.preflight(tasks);
    if (!preflight.ok) {
      console.error(`\n❌ Preflight check failed:`);
      for (const err of preflight.errors) {
        console.error(`   • ${err}`);
      }
      this.logger.log("preflight_failed", { errors: preflight.errors });
      this.writeProgress({ status: "preflight_failed", errors: preflight.errors });
      throw new Error(`Preflight failed: ${preflight.errors.length} error(s) — ${preflight.errors[0]}`);
    }
    console.log(`   ✓ Preflight passed (${tasks.length} tasks validated)`);
    this.logger.log("preflight_passed", { taskCount: tasks.length });

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
      const chunks = this.createChunks(sortedTasks, this.config.localConcurrency);

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

    // R5: Async completion notification
    this.writeCompletionFile(Date.now() - startTime);
    await this.sendCompletionNotification(Date.now() - startTime);

    this.logger.log("run_complete", {
      totalTasks: this.results.length,
      successful: this.results.filter(r => r.success).length,
      failed: this.results.filter(r => !r.success).length,
      durationMs: Date.now() - startTime,
    });
    const logPath = await this.logger.flush();
    if (logPath) console.log(`📋 Logs saved to: ${logPath}`);

    // v4.5: Create episodic memory entry for this swarm run
    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);
    const overallOutcome = failed.length === 0 ? "success" as const
      : successful.length === 0 ? "failure" as const
      : "resolved" as const;  // partial success
    const executorsUsed = [...new Set(this.results.map(r => r.task.persona))];
    const episodeId = createSwarmEpisode({
      swarmId: this.swarmId,
      summary: `Swarm "${this.swarmId}": ${successful.length}/${this.results.length} tasks passed in ${((Date.now() - startTime) / 1000).toFixed(1)}s` +
        (failed.length > 0 ? `. Failed: ${failed.map(r => r.task.id).join(", ")}` : ""),
      outcome: overallOutcome,
      durationMs: Date.now() - startTime,
      entities: [
        `swarm.${this.swarmId}`,
        ...executorsUsed,
        ...(tasks.flatMap(t => t.memoryMetadata?.tags || [])),
      ],
      metadata: {
        totalTasks: this.results.length,
        successful: successful.length,
        failed: failed.length,
        executors: executorsUsed,
      },
    });
    if (episodeId) {
      console.log(`🧠 Episode saved: ${episodeId}`);
      // Link episode to executor history cognitive profiles
      for (const result of this.results) {
        const cat = result.task.memoryMetadata?.category || "general";
        recordOutcome(result.task.persona, cat, result.success, result.durationMs, {
          episodeId,
          entities: [cat, ...(result.task.memoryMetadata?.tags || [])],
        });
      }
    }

    // Update swarm session status in swarm-memory.db
    if (this.memoryManager && (this.memoryManager as any).swarmMemory) {
      try {
        (this.memoryManager as any).swarmMemory.updateSessionStatus(this.swarmId,
          overallOutcome === "success" ? "completed" : "failed"
        );
      } catch (err) {
        console.log(`  [swarm-memory] Failed to update session: ${err}`);
      }
    }

    return this.results;

    } finally {
      // R1: Release campaign lock
      try { unlinkSync(lockPath); } catch {}
      this.logger.log("campaign_lock_released", { swarmId: this.swarmId });
    }
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

    let active = 0;
    const maxConcurrency = this.config.localConcurrency;

    console.log(`\n🌊 DAG Streaming Execution`);
    console.log(`   Concurrency: ${maxConcurrency}`);
    this.logger.log("dag_streaming_start", {
      taskCount: tasks.length,
      concurrency: maxConcurrency,
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
        if (active >= maxConcurrency) break;
        if (executing.has(id)) continue;

        const task = taskMap.get(id)!;
        const deps = task.dependsOn || [];
        if (!deps.every(d => completed.has(d))) continue;

        // All deps met and capacity available — launch immediately
        pending.delete(id);
        active++;

        const execution = this.executeTaskWithResilience(task).then(result => {
          return { taskId: id, result };
        });
        executing.set(id, execution);

        console.log(`  ✨ [${id}] Streaming start → ${task.persona} [🖥️  local] (${active}/${maxConcurrency})`);
        this.logger.log("task_streaming_start", { taskId: id, persona: task.persona, active, activeWorkers: executing.size });
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
      active--;

      if (result.success) {
        completed.add(taskId);
        console.log(`  ✅ [${taskId}] Complete (${(result.durationMs / 1000).toFixed(1)}s) — checking for newly ready tasks`);
      } else {
        failed.add(taskId);
        console.log(`  ❌ [${taskId}] Failed: ${result.error}`);
      }
      this.logger.log("task_streaming_complete", { taskId, success: result.success, durationMs: result.durationMs, active, activeWorkers: executing.size });

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
      const chunks = this.createChunks(sortedReady, this.config.localConcurrency);

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
    const triedExecutors = new Set<string>();
    const category = task.memoryMetadata?.category || "general";
    const originalPersona = task.persona;

    while (retries <= this.config.maxRetries) {
      // --- Executor selection (v4.2 retry-with-reroute) ---
      let executorId: string;
      if (originalPersona !== "auto" && retries === 0) {
        // Explicit persona specified — honor it on first attempt
        executorId = originalPersona;
      } else {
        // Auto-route or reroute after failure
        const decision = this.compositeRoute(task, triedExecutors.size > 0 ? triedExecutors : undefined);
        executorId = decision.executorId;

        // If compositeRoute returned a tried executor (all others exhausted), accept it
        if (triedExecutors.has(executorId)) {
          const alternatives = this.getAllRouteCandidates(task, triedExecutors)
            .filter(c => !triedExecutors.has(c.executorId) && c.compositeScore > 0.1);
          if (alternatives.length > 0) {
            executorId = alternatives[0].executorId;
            console.log(`  🔄 [${task.id}] Rerouting away from tried executors → ${executorId}`);
          }
          // else: no untried alternatives, retry same executor (better than nothing)
        }
      }

      triedExecutors.add(executorId);

      // Check circuit breaker for the selected executor
      if (this.isCircuitOpen(executorId)) {
        console.log(`  ⚠️  [${task.id}] Circuit open for ${executorId}, trying next candidate`);
        retries++;
        if (retries <= this.config.maxRetries) continue;
        return {
          task,
          success: false,
          error: `Circuit breaker open for all tried executors: ${[...triedExecutors].join(", ")}`,
          durationMs: Date.now() - startTime,
          retries: retries - 1,
        };
      }

      // Temporarily set task.persona for callAgent dispatch and prompt building
      task.persona = executorId;

      // Build optimized prompt (inside loop — executor may change on reroute)
      const prompt = await this.buildOptimizedPrompt(task);
      const promptTokens = this.estimateTokens(prompt);

      try {
        console.log(`  🚀 [${task.id}] ${executorId} (attempt ${retries + 1}) ~${promptTokens} tokens`);
        this.logger.log("task_start", { taskId: task.id, persona: executorId, attempt: retries + 1, promptTokens });

        const output = await this.callAgent(executorId, prompt, task.timeoutSeconds);
        const outputTokens = this.estimateTokens(output);

        // R3: Post-mutation verification — check expected file changes were applied
        const { verified, failures: mutationFailures } = this.verifyMutations(task);
        if (!verified) {
          const failMsg = `Mutation verification failed: ${mutationFailures.join("; ")}`;
          console.log(`  ⚠️  [${task.id}] ${failMsg}`);
          this.logger.log("mutation_verification_failed", { taskId: task.id, failures: mutationFailures });
          // Throw to enter catch block for retry-with-reroute
          throw new Error(failMsg);
        }
        if (task.expectedMutations?.length) {
          console.log(`  ✓ [${task.id}] Mutation verification passed (${task.expectedMutations.length} checks)`);
          this.logger.log("mutation_verification_passed", { taskId: task.id, checks: task.expectedMutations.length });
        }

        // Record success (circuit breaker + history + cognitive profile)
        this.recordSuccess(executorId);
        const taskEntities = [category, ...(task.memoryMetadata?.tags || [])];
        recordOutcome(executorId, category, true, Date.now() - startTime, {
          entities: taskEntities,
        });
        this.logger.log("task_success", { taskId: task.id, persona: executorId, durationMs: Date.now() - startTime, outputTokens });

        // Save to memory with token optimization
        if (this.memoryManager) {
          this.memoryManager.addAgentOutput(
            executorId,
            output,
            {
              ...task.memoryMetadata,
              outputToMemory: task.outputToMemory,
            }
          );
        }

        // R2: Track completed output for cross-task sliding window context
        this.completedOutputs.push({
          persona: executorId,
          category: task.memoryMetadata?.category || "general",
          summary: output.slice(0, 200),
        });

        task.persona = originalPersona;
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
        // Record failure (circuit breaker + history + cognitive profile)
        this.recordFailure(executorId);
        const errorStr = String(error);
        const errorType = errorStr.includes("timeout") ? "timeout"
          : errorStr.includes("Mutation verification") ? "mutation_failed"
          : errorStr.includes("ENOENT") ? "file_not_found"
          : errorStr.includes("permission") ? "permission_denied"
          : "unknown";
        const failEntities = [category, ...(task.memoryMetadata?.tags || [])];
        recordOutcome(executorId, category, false, Date.now() - startTime, {
          errorType,
          entities: failEntities,
        });

        console.log(`  ⚠️  [${task.id}] ${executorId} failed (attempt ${retries}): ${error}`);
        this.logger.log("task_error", { taskId: task.id, persona: executorId, attempt: retries, error: errorStr });

        if (retries <= this.config.maxRetries) {
          // Reroute on next iteration — the failed executor's health score
          // is now lower, so compositeRoute will naturally prefer alternatives
          const delay = Math.pow(2, Math.max(retries - 1, 0)) * 500;
          console.log(`  ⏳ [${task.id}] Will reroute in ${delay}ms...`);
          await this.sleep(delay);
        } else {
          // v4.6: OmniRoute last-resort fallback before giving up
          if (this.config.omniRouteEnabled) {
            try {
              console.log(`  🌐 [${task.id}] All local executors exhausted, trying OmniRoute fallback...`);
              const omniPrompt = await this.buildOptimizedPrompt(task);
              const output = await this.callOmniRoute(omniPrompt, task.timeoutSeconds);
              const outputTokens = this.estimateTokens(output);

              this.logger.log("task_success_omniroute", { taskId: task.id, durationMs: Date.now() - startTime, outputTokens });

              if (this.memoryManager) {
                this.memoryManager.addAgentOutput("omniroute", output, {
                  ...task.memoryMetadata,
                  outputToMemory: task.outputToMemory,
                });
              }
              this.completedOutputs.push({
                persona: "omniroute",
                category: task.memoryMetadata?.category || "general",
                summary: output.slice(0, 200),
              });

              task.persona = originalPersona;
              return {
                task,
                success: true,
                output,
                durationMs: Date.now() - startTime,
                retries,
                tokensUsed: this.estimateTokens(omniPrompt) + outputTokens,
              };
            } catch (omniError) {
              console.log(`  ❌ [${task.id}] OmniRoute fallback also failed: ${omniError}`);
              this.logger.log("omniroute_fallback_failed", { taskId: task.id, error: String(omniError) });
            }
          }

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
    }

    // v4.6: OmniRoute last-resort for loop exhaustion (e.g. all circuits open)
    if (this.config.omniRouteEnabled) {
      try {
        console.log(`  🌐 [${task.id}] Retry loop exhausted, trying OmniRoute fallback...`);
        const omniPrompt = await this.buildOptimizedPrompt(task);
        const output = await this.callOmniRoute(omniPrompt, task.timeoutSeconds);

        this.logger.log("task_success_omniroute", { taskId: task.id, durationMs: Date.now() - startTime });
        task.persona = originalPersona;
        return { task, success: true, output, durationMs: Date.now() - startTime, retries };
      } catch (omniError) {
        console.log(`  ❌ [${task.id}] OmniRoute fallback also failed: ${omniError}`);
        this.logger.log("omniroute_fallback_failed", { taskId: task.id, error: String(omniError) });
      }
    }

    task.persona = originalPersona;
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

    // R7: Prompt reinforcement for tasks with expected file mutations
    if (task.expectedMutations && task.expectedMutations.length > 0) {
      const mutationList = task.expectedMutations
        .map(m => `- ${m.file} (must contain: "${m.contains}")`)
        .join("\n");
      fullPrompt += `\n\nIMPORTANT: This task requires ACTUAL FILE CHANGES. ` +
        `You must modify the following files:\n${mutationList}\n` +
        `Do NOT just describe the changes. MAKE the changes using your file editing tools.`;
    }

    return fullPrompt;
  }

  // --------------------------------------------------------------------------
  // AGENT COMMUNICATION
  // --------------------------------------------------------------------------

  private async callAgent(persona: string, prompt: string, taskTimeoutSeconds?: number): Promise<string> {
    const localExec = this.localExecutors.get(persona);
    if (!localExec) {
      throw new Error(`No local executor found for persona: ${persona}. Register an executor in the executor registry.`);
    }
    return this.callLocalAgent(localExec, prompt, taskTimeoutSeconds);
  }

  private async callLocalAgent(executor: LocalExecutor, prompt: string, taskTimeoutSeconds?: number): Promise<string> {
    const effectiveTimeout = taskTimeoutSeconds || this.config.timeoutSeconds;
    const timeoutMs = effectiveTimeout * 1000;

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
        reject(new Error(`Local executor ${executor.id} timed out after ${effectiveTimeout}s`));
      }, timeoutMs);
    });

    const result = await Promise.race([execPromise, timeoutPromise]);
    this.logger.log("local_executor_complete", { executor: executor.id, outputLength: result.length });
    return result;
  }

  /**
   * v4.6: OmniRoute API-level failover — called as last resort when all local
   * executors have been exhausted. Routes through OmniRoute's priority combo
   * which handles provider-level failover (e.g. Anthropic → OpenAI → free tiers).
   */
  private async callOmniRoute(prompt: string, taskTimeoutSeconds?: number): Promise<string> {
    const url = this.config.omniRouteUrl!;
    const model = this.config.omniRouteModel!;
    const effectiveTimeout = (taskTimeoutSeconds || this.config.timeoutSeconds) * 1000;

    // Resolve API key: config → env file → error
    let apiKey = this.config.omniRouteApiKey;
    if (!apiKey) {
      try {
        const envContent = readFileSync(join(WORKSPACE, "OmniRoute", ".env"), "utf-8");
        const match = envContent.match(/^API_KEY_SECRET=(.+)$/m);
        if (match) apiKey = match[1].trim();
      } catch { /* ignore */ }
    }
    if (!apiKey) {
      throw new Error("OmniRoute API key not found. Set SWARM_OMNIROUTE_API_KEY or ensure OmniRoute/.env has API_KEY_SECRET.");
    }

    console.log(`  🌐 [omniroute] Fallback via OmniRoute combo: ${model}`);
    this.logger.log("omniroute_fallback_start", { model, url });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 16384,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`OmniRoute HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }

      const data: any = await resp.json();

      // Handle both OpenAI and Anthropic response formats
      let output = "";
      if (data.choices?.[0]?.message?.content) {
        output = data.choices[0].message.content;
      } else if (data.content?.[0]?.text) {
        output = data.content[0].text;
      } else if (typeof data.output === "string") {
        output = data.output;
      }

      if (!output) {
        throw new Error(`OmniRoute returned empty response: ${JSON.stringify(data).slice(0, 300)}`);
      }

      const routedModel = data.model || data.choices?.[0]?.model || model;
      console.log(`  ✅ [omniroute] Success via ${routedModel} (${output.length} chars)`);
      this.logger.log("omniroute_fallback_success", { model: routedModel, outputLength: output.length });
      return output.trim();
    } finally {
      clearTimeout(timer);
    }
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
  // COMPOSITE ROUTER (v4.2)
  // --------------------------------------------------------------------------

  private healthScore(persona: string): number {
    const cb = this.circuitBreakers.get(persona);
    if (!cb) return 1.0;
    if (cb.isOpen) return 0.0;
    const failurePenalty = cb.failures * 0.3;
    const recencyBonus = cb.lastFailure > 0
      ? Math.min(0.2, (Date.now() - cb.lastFailure) / 60000 * 0.2)
      : 0;
    return Math.max(0, Math.min(1.0, 1.0 - failurePenalty + recencyBonus));
  }

  private static SEMANTIC_SYNONYMS: Record<string, string[]> = {
    "audit": ["review", "inspect", "assess", "evaluate", "check", "examine", "analyze", "analysis"],
    "review": ["audit", "inspect", "assess", "evaluate", "examine", "analyze", "analysis"],
    "research": ["investigate", "explore", "search", "find", "discover", "lookup", "gather", "scrape", "crawl", "fetch"],
    "security": ["vulnerability", "exploit", "threat", "risk", "compliance", "penetration", "pentest", "hardening"],
    "summarize": ["summary", "synthesize", "synthesis", "consolidate", "digest", "overview", "recap", "distill"],
    "analyze": ["analysis", "examine", "evaluate", "assess", "inspect", "diagnose", "investigate", "audit"],
    "scrape": ["crawl", "extract", "fetch", "parse", "harvest", "collect", "gather", "research"],
    "generate": ["create", "produce", "build", "make", "write", "compose", "draft", "render"],
    "debug": ["troubleshoot", "diagnose", "fix", "investigate", "trace", "inspect"],
    "test": ["validate", "verify", "check", "assert", "spec", "quality"],
    "deploy": ["publish", "release", "ship", "launch", "provision"],
    "document": ["documentation", "describe", "explain", "annotate", "write"],
    "performance": ["speed", "optimize", "latency", "benchmark", "profiling", "fast"],
    "data": ["dataset", "database", "csv", "json", "table", "schema", "query", "sql"],
    "web": ["website", "page", "url", "http", "html", "browser", "site", "online", "internet"],
    "image": ["photo", "picture", "visual", "graphic", "screenshot", "render", "illustration"],
    "api": ["endpoint", "rest", "webhook", "integration", "request", "response"],
    "tool": ["orchestration", "workflow", "pipeline", "automation", "chain"],
    "multimodal": ["image", "audio", "video", "visual", "media", "multi-modal"],
    "reasoning": ["logic", "think", "deduce", "infer", "evaluate", "assess", "judge", "compare"],
    "prototyping": ["prototype", "scaffold", "skeleton", "boilerplate", "draft", "quick", "rapid", "spike"],
    "large-context": ["large", "corpus", "comprehensive", "thorough", "full", "entire", "complete"],
  };

  private expandWithSynonyms(words: Set<string>): Set<string> {
    const expanded = new Set(words);
    for (const w of words) {
      const syns = TokenOptimizedOrchestrator.SEMANTIC_SYNONYMS[w];
      if (syns) {
        for (const s of syns) expanded.add(s);
      }
    }
    return expanded;
  }

  private capabilityScore(task: Task, cap: ExecutorCapability): CapabilityScore {
    const taskText = `${task.task} ${task.id} ${task.memoryMetadata?.category || ""} ${(task.memoryMetadata?.tags || []).join(" ")}`.toLowerCase();
    const taskWords = new Set(taskText.split(/[\s,.\-_\/()]+/).filter(w => w.length > 2));
    const taskStems = new Set<string>();
    for (const w of taskWords) {
      taskStems.add(w);
      if (w.endsWith("ing")) taskStems.add(w.slice(0, -3));
      if (w.endsWith("tion")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("ment")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("ity")) taskStems.add(w.slice(0, -3));
      if (w.endsWith("ness")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("able")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("ible")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("ous")) taskStems.add(w.slice(0, -3));
      if (w.endsWith("ive")) taskStems.add(w.slice(0, -3));
      if (w.endsWith("al")) taskStems.add(w.slice(0, -2));
      if (w.endsWith("ly")) taskStems.add(w.slice(0, -2));
      if (w.endsWith("er")) taskStems.add(w.slice(0, -2));
      if (w.endsWith("ed")) taskStems.add(w.slice(0, -2));
      if (w.endsWith("s") && w.length > 4) taskStems.add(w.slice(0, -1));
    }

    const expandedTaskWords = this.expandWithSynonyms(taskWords);
    const expandedTaskStems = this.expandWithSynonyms(taskStems);

    const wordMatches = (capWord: string): boolean => {
      if (capWord.length <= 2) return false;
      if (expandedTaskWords.has(capWord)) return true;
      const capStems = [capWord];
      if (capWord.endsWith("ing")) capStems.push(capWord.slice(0, -3));
      if (capWord.endsWith("tion")) capStems.push(capWord.slice(0, -4));
      if (capWord.endsWith("ment")) capStems.push(capWord.slice(0, -4));
      if (capWord.endsWith("ity")) capStems.push(capWord.slice(0, -3));
      if (capWord.endsWith("al")) capStems.push(capWord.slice(0, -2));
      if (capWord.endsWith("ly")) capStems.push(capWord.slice(0, -2));
      if (capWord.endsWith("er")) capStems.push(capWord.slice(0, -2));
      if (capWord.endsWith("ed")) capStems.push(capWord.slice(0, -2));
      if (capWord.endsWith("s") && capWord.length > 4) capStems.push(capWord.slice(0, -1));
      for (const cs of capStems) {
        if (cs.length > 2 && expandedTaskStems.has(cs)) return true;
      }
      return false;
    };

    let raw = 0;
    let maxPossible = 0;
    const matches: string[] = [];

    for (const keyword of cap.expertise) {
      const kwLower = keyword.toLowerCase();
      const kwWords = kwLower.split(/[-_\s\/]+/);
      const kwMaxScore = kwWords.length > 1 ? 3 : 2;
      maxPossible += kwMaxScore;
      let kwHits = 0;
      for (const kw of kwWords) {
        if (wordMatches(kw)) kwHits++;
      }
      if (kwHits > 0) {
        const kwScore = kwWords.length > 1 && kwHits > 1 ? 3 : 2;
        raw += kwScore;
        matches.push(`expertise:${keyword}`);
      }
    }

    for (const phrase of cap.bestFor) {
      maxPossible += 4;
      const phraseLower = phrase.toLowerCase();
      const phraseWords = phraseLower.split(/[\s,.\-_\/()]+/).filter(w => w.length > 2);
      let phraseHits = 0;
      for (const pw of phraseWords) {
        if (wordMatches(pw)) phraseHits++;
      }
      if (phraseWords.length > 0 && phraseHits >= 2) {
        const density = phraseHits / phraseWords.length;
        const phraseScore = density * 4;
        raw += phraseScore;
        matches.push(`best_for:"${phrase}" (${phraseHits}/${phraseWords.length})`);
      }
    }

    const normalized = maxPossible > 0 ? Math.min(1.0, raw / maxPossible) : 0;
    return { raw, normalized, matches };
  }

  private compositeRoute(task: Task, excludeExecutors?: Set<string>): RouteDecision {
    const strategy = this.config.routingStrategy || "balanced";
    const w = STRATEGY_WEIGHTS[strategy] || STRATEGY_WEIGHTS.balanced;
    const complexity = estimateComplexity(task);
    const category = task.memoryMetadata?.category || "general";

    const candidates: RouteDecision[] = [];

    for (const [id, cap] of this.executorCapabilities) {
      if (excludeExecutors?.has(id)) continue;

      const capScore = this.capabilityScore(task, cap);
      const hlth = this.healthScore(id);
      const cfit = complexityFitScore(id, complexity.tier);
      const hist = historyScore(id, category);

      // v4.5: Memory-enriched scoring (additive bonuses, 0.10 + 0.05 max)
      const procScore = getProcedureSuccessRate(id, category);
      const tempScore = getRecentSuccessRate(id, 7);

      const composite = (w.capability * capScore.normalized)
                      + (w.health * hlth)
                      + (w.complexityFit * cfit)
                      + (w.history * hist)
                      + (0.10 * (procScore - 0.5))   // Procedure bonus/penalty (±0.05)
                      + (0.05 * (tempScore - 0.5));   // Temporal bonus/penalty (±0.025)

      candidates.push({
        executorId: id,
        executorName: cap.name,
        compositeScore: composite,
        breakdown: {
          capability: capScore.normalized,
          health: hlth,
          complexityFit: cfit,
          history: hist,
          procedure: procScore,
          temporal: tempScore,
        },
        method: "composite",
      });
    }

    candidates.sort((a, b) => b.compositeScore - a.compositeScore);

    const top3 = candidates.slice(0, 3);
    console.log(`  🧭 [${task.id}] Route candidates (${complexity.tier}, strategy=${strategy}):`);
    for (const c of top3) {
      const b = c.breakdown;
      console.log(`     ${c.executorId}: ${c.compositeScore.toFixed(3)} ` +
        `(cap=${b.capability.toFixed(2)} hlth=${b.health.toFixed(2)} ` +
        `cplx=${b.complexityFit.toFixed(2)} hist=${b.history.toFixed(2)}` +
        `${b.procedure !== undefined ? ` proc=${b.procedure.toFixed(2)}` : ""}` +
        `${b.temporal !== undefined ? ` temp=${b.temporal.toFixed(2)}` : ""})`);
    }
    this.logger.log("composite_route", {
      taskId: task.id,
      complexity: complexity.tier,
      strategy,
      winner: candidates[0]?.executorId,
      compositeScore: candidates[0]?.compositeScore,
      breakdown: candidates[0]?.breakdown,
      candidates: top3.map(c => ({ id: c.executorId, score: c.compositeScore })),
    });

    const winner = candidates[0];
    if (!winner || winner.compositeScore < 0.1) {
      const fallbackId = this.executorCapabilities.has("claude-code") ? "claude-code" : [...this.executorCapabilities.keys()][0] || "claude-code";
      return {
        executorId: fallbackId,
        executorName: "Claude Code",
        compositeScore: 0,
        breakdown: { capability: 0, health: 0, complexityFit: 0, history: 0 },
        method: "fallback",
      };
    }

    return winner;
  }

  private getAllRouteCandidates(task: Task, excludeExecutors?: Set<string>): RouteDecision[] {
    const strategy = this.config.routingStrategy || "balanced";
    const w = STRATEGY_WEIGHTS[strategy] || STRATEGY_WEIGHTS.balanced;
    const complexity = estimateComplexity(task);
    const category = task.memoryMetadata?.category || "general";

    const candidates: RouteDecision[] = [];
    for (const [id, cap] of this.executorCapabilities) {
      if (excludeExecutors?.has(id)) continue;
      const capScore = this.capabilityScore(task, cap);
      const hlth = this.healthScore(id);
      const cfit = complexityFitScore(id, complexity.tier);
      const hist = historyScore(id, category);
      const procScore = getProcedureSuccessRate(id, category);
      const tempScore = getRecentSuccessRate(id, 7);
      const composite = (w.capability * capScore.normalized)
                      + (w.health * hlth)
                      + (w.complexityFit * cfit)
                      + (w.history * hist)
                      + (0.10 * (procScore - 0.5))
                      + (0.05 * (tempScore - 0.5));
      candidates.push({
        executorId: id,
        executorName: cap.name,
        compositeScore: composite,
        breakdown: { capability: capScore.normalized, health: hlth, complexityFit: cfit, history: hist, procedure: procScore, temporal: tempScore },
        method: "composite",
      });
    }
    return candidates.sort((a, b) => b.compositeScore - a.compositeScore);
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
        const personas = registry.personas || [];
        for (const p of personas) {
          // Register local executor bridge
          if (p.executor === "local" && p.bridge) {
            const bridgePath = p.bridge.startsWith("/") ? p.bridge : join(WORKSPACE, p.bridge);
            this.localExecutors.set(p.id, {
              id: p.id,
              bridge: bridgePath,
              name: p.name || p.id,
            });
          }
          // Register capability profile for all personas (local and API)
          if (p.expertise || p.best_for) {
            this.executorCapabilities.set(p.id, {
              id: p.id,
              name: p.name || p.id,
              expertise: p.expertise || [],
              bestFor: p.best_for || [],
              isLocal: p.executor === "local",
            });
          }
        }
        if (this.localExecutors.size > 0) {
          console.log(`   Local executors: ${[...this.localExecutors.keys()].join(", ")}`);
        }
      }
    } catch {}

    if (knownPersonas.size === 0 && this.executorCapabilities.size === 0) return;

    const uniqueKnown = [...new Set(knownList)];

    // Phase 1: Composite-route tasks with persona === "auto" (v4.2)
    let autoRouted = 0;
    for (const task of tasks) {
      if (task.persona === "auto") {
        if (this.executorCapabilities.size === 0) {
          console.log(`  ⚠️  [${task.id}] No executor capabilities loaded — cannot auto-route`);
          this.logger.log("auto_route_skip", { taskId: task.id, reason: "no_capabilities" });
          continue;
        }
        const decision = this.compositeRoute(task);
        task.persona = decision.executorId;
        console.log(`  🎯 [${task.id}] Composite-route → ${decision.executorName} (score: ${decision.compositeScore.toFixed(3)}, method: ${decision.method})`);
        this.logger.log("composite_route_assigned", { taskId: task.id, routed: decision.executorId, score: decision.compositeScore, method: decision.method });
        autoRouted++;
      }
    }
    if (autoRouted > 0) {
      console.log(`   Composite-routed ${autoRouted} task(s) using ${this.config.routingStrategy || "balanced"} strategy\n`);
    }

    // Phase 2: Fuzzy-match remaining unknown personas
    for (const task of tasks) {
      // Skip fuzzy matching for local executor personas — they're invoked by exact ID
      if (this.localExecutors.has(task.persona)) continue;
      // Skip already-resolved auto tasks
      if (task.persona !== "auto" && this.executorCapabilities.has(task.persona)) continue;

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

  /**
   * Auto-route a task with persona "auto" to the best-matching executor
   * based on keyword matching between the task text and executor capabilities.
   * Returns true if a match was found and the task.persona was updated.
   */
  private autoRouteTask(task: Task): boolean {
    if (this.executorCapabilities.size === 0) {
      console.log(`  ⚠️  [${task.id}] No executor capabilities loaded — cannot auto-route`);
      this.logger.log("auto_route_skip", { taskId: task.id, reason: "no_capabilities" });
      return false;
    }

    const taskText = `${task.task} ${task.id} ${task.memoryMetadata?.category || ""} ${(task.memoryMetadata?.tags || []).join(" ")}`.toLowerCase();
    const taskWords = new Set(taskText.split(/[\s,.\-_\/()]+/).filter(w => w.length > 2));
    // Build stems for fuzzy matching (e.g. "refactor" matches "refactoring")
    const taskStems = new Set<string>();
    for (const w of taskWords) {
      taskStems.add(w);
      if (w.endsWith("ing")) taskStems.add(w.slice(0, -3));
      if (w.endsWith("tion")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("ment")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("ity")) taskStems.add(w.slice(0, -3));
      if (w.endsWith("ness")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("able")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("ible")) taskStems.add(w.slice(0, -4));
      if (w.endsWith("ous")) taskStems.add(w.slice(0, -3));
      if (w.endsWith("ive")) taskStems.add(w.slice(0, -3));
      if (w.endsWith("al")) taskStems.add(w.slice(0, -2));
      if (w.endsWith("ly")) taskStems.add(w.slice(0, -2));
      if (w.endsWith("er")) taskStems.add(w.slice(0, -2));
      if (w.endsWith("ed")) taskStems.add(w.slice(0, -2));
      if (w.endsWith("s") && w.length > 4) taskStems.add(w.slice(0, -1));
    }

    const scores: Array<{ id: string; name: string; score: number; matches: string[] }> = [];

    // Helper: check if a capability word matches the task (exact or stem)
    const wordMatches = (capWord: string): boolean => {
      if (capWord.length <= 2) return false;
      if (taskWords.has(capWord)) return true;
      // Try stem of the capability word
      const capStems = [capWord];
      if (capWord.endsWith("ing")) capStems.push(capWord.slice(0, -3));
      if (capWord.endsWith("tion")) capStems.push(capWord.slice(0, -4));
      if (capWord.endsWith("ment")) capStems.push(capWord.slice(0, -4));
      if (capWord.endsWith("ity")) capStems.push(capWord.slice(0, -3));
      if (capWord.endsWith("ness")) capStems.push(capWord.slice(0, -4));
      if (capWord.endsWith("able")) capStems.push(capWord.slice(0, -4));
      if (capWord.endsWith("ible")) capStems.push(capWord.slice(0, -4));
      if (capWord.endsWith("ous")) capStems.push(capWord.slice(0, -3));
      if (capWord.endsWith("ive")) capStems.push(capWord.slice(0, -3));
      if (capWord.endsWith("al")) capStems.push(capWord.slice(0, -2));
      if (capWord.endsWith("ly")) capStems.push(capWord.slice(0, -2));
      if (capWord.endsWith("er")) capStems.push(capWord.slice(0, -2));
      if (capWord.endsWith("ed")) capStems.push(capWord.slice(0, -2));
      if (capWord.endsWith("s") && capWord.length > 4) capStems.push(capWord.slice(0, -1));
      for (const cs of capStems) {
        if (cs.length > 2 && taskStems.has(cs)) return true;
      }
      return false;
    };

    for (const [id, cap] of this.executorCapabilities) {
      let score = 0;
      const matches: string[] = [];

      // Score expertise keywords — word-boundary match with stemming
      for (const keyword of cap.expertise) {
        const kwLower = keyword.toLowerCase();
        const kwWords = kwLower.split(/[-_\s\/]+/);
        let kwHits = 0;
        for (const kw of kwWords) {
          if (wordMatches(kw)) kwHits++;
        }
        if (kwHits > 0) {
          const kwScore = kwWords.length > 1 && kwHits > 1 ? 3 : 2;
          score += kwScore;
          matches.push(`expertise:${keyword}`);
        }
      }

      // Score best_for phrases — weighted by match density
      for (const phrase of cap.bestFor) {
        const phraseLower = phrase.toLowerCase();
        const phraseWords = phraseLower.split(/[\s,.\-_\/()]+/).filter(w => w.length > 2);
        let phraseHits = 0;
        for (const pw of phraseWords) {
          if (wordMatches(pw)) phraseHits++;
        }
        if (phraseWords.length > 0 && phraseHits >= 2) {
          const density = phraseHits / phraseWords.length;
          const phraseScore = density * 4;
          score += phraseScore;
          matches.push(`best_for:"${phrase}" (${phraseHits}/${phraseWords.length})`);
        }
      }

      if (score > 0) {
        scores.push({ id, name: cap.name, score, matches });
      }
    }

    if (scores.length === 0) {
      // Default fallback: prefer claude-code as the most general-purpose executor
      const fallback = this.executorCapabilities.has("claude-code") ? "claude-code" : [...this.executorCapabilities.keys()][0];
      task.persona = fallback;
      console.log(`  🎯 [${task.id}] Auto-route → ${fallback} (fallback — no keyword matches)`);
      this.logger.log("auto_route", { taskId: task.id, routed: fallback, method: "fallback", scores: [] });
      return true;
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);
    const winner = scores[0];

    task.persona = winner.id;
    console.log(`  🎯 [${task.id}] Auto-route → ${winner.name} (score: ${winner.score.toFixed(1)}, matches: ${winner.matches.slice(0, 3).join(", ")})`);
    this.logger.log("auto_route", {
      taskId: task.id,
      routed: winner.id,
      method: "capability_match",
      score: winner.score,
      matches: winner.matches,
      candidates: scores.slice(0, 4).map(s => ({ id: s.id, score: s.score })),
    });

    // Log runner-up if close (within 30% of winner score)
    if (scores.length > 1 && scores[1].score >= winner.score * 0.7) {
      console.log(`       Runner-up: ${scores[1].name} (score: ${scores[1].score.toFixed(1)})`);
    }

    return true;
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

  // R3: Post-Mutation Verification — check that expected file changes were applied
  private verifyMutations(task: Task): { verified: boolean; failures: string[] } {
    const mutations = task.expectedMutations;
    if (!mutations || mutations.length === 0) {
      return { verified: true, failures: [] };
    }

    const failures: string[] = [];
    for (const m of mutations) {
      try {
        if (!existsSync(m.file)) {
          failures.push(`File not found: ${m.file}`);
          continue;
        }
        const content = readFileSync(m.file, "utf8");
        if (!content.includes(m.contains)) {
          failures.push(`Mutation not found: ${m.file} missing "${m.contains.slice(0, 80)}"`);
        }
      } catch (err) {
        failures.push(`Error reading ${m.file}: ${err}`);
      }
    }

    return { verified: failures.length === 0, failures };
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

  // R5 Option A: Write completion file to well-known path for caller polling
  private writeCompletionFile(totalDurationMs: number): void {
    const completionPath = `/dev/shm/${this.swarmId}-complete.json`;
    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);

    const completion = {
      swarmId: this.swarmId,
      sessionId: this.sessionId,
      status: failed.length === 0 ? "success" : "completed_with_failures",
      completedAt: new Date().toISOString(),
      totalTasks: this.results.length,
      successful: successful.length,
      failed: failed.length,
      durationMs: totalDurationMs,
      durationHuman: `${(totalDurationMs / 1000 / 60).toFixed(1)} minutes`,
      failedTasks: failed.map(r => ({ id: r.task.id, error: r.error })),
    };

    try {
      writeFileSync(completionPath, JSON.stringify(completion, null, 2));
      console.log(`  📣 Completion file: ${completionPath}`);
      this.logger.log("completion_file_written", { path: completionPath });
    } catch (err) {
      console.warn(`  ⚠️ Failed to write completion file: ${err}`);
    }
  }

  // R5 Option C: Send SMS or email notification via local executor
  private async sendCompletionNotification(totalDurationMs: number): Promise<void> {
    const channel = this.config.notifyOnComplete;
    if (!channel || channel === "none") return;

    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);
    const status = failed.length === 0 ? "✅" : "⚠️";
    const duration = `${(totalDurationMs / 1000 / 60).toFixed(1)}m`;

    const message = `${status} Swarm "${this.swarmId}" complete: ${successful.length}/${this.results.length} tasks passed in ${duration}` +
      (failed.length > 0 ? `\nFailed: ${failed.map(r => r.task.id).join(", ")}` : "");

    const toolName = channel === "sms" ? "send_sms_to_user" : "send_email_to_user";
    const toolInput = channel === "sms"
      ? { message }
      : { subject: `${status} Swarm ${this.swarmId} — ${successful.length}/${this.results.length} passed`, markdown_body: message };

    // Find any available local executor to send the notification
    const executor = this.localExecutors.values().next().value;
    if (!executor) {
      console.log("  ⚠️ Cannot send notification: no local executors available");
      return;
    }

    try {
      console.log(`  📲 Sending ${channel} notification via ${executor.name}...`);
      this.logger.log("notification_sending", { channel, swarmId: this.swarmId, executor: executor.id });

      const notifyPrompt = `Use the ${toolName} tool with this exact payload: ${JSON.stringify(toolInput)}. Do not add any extra text or commentary, just send it.`;
      await this.callLocalAgent(executor, notifyPrompt, 60);

      console.log(`  ✓ ${channel.toUpperCase()} notification sent`);
      this.logger.log("notification_sent", { channel });
    } catch (err) {
      console.log(`  ⚠️ Notification error: ${err}`);
      this.logger.log("notification_error", { channel, error: String(err) });
    }
  }

    private async saveResults(totalDurationMs: number): Promise<string | null> {
    try {
      const resultsDir = join(process.env.HOME || "/tmp", ".swarm", "results");
      if (!existsSync(resultsDir)) {
        mkdirSync(resultsDir, { recursive: true });
      }

      const successful = this.results.filter(r => r.success);
      const failed = this.results.filter(r => !r.success);
      const avgDuration = successful.reduce((sum, r) => sum + r.durationMs, 0) / successful.length || 0;
      const totalTokens = successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);

      const outputPath = join(resultsDir, `${this.swarmId}_${Date.now()}.json`);
      const report = {
        swarmId: this.swarmId,
        sessionId: this.sessionId,
        config: {
          concurrency: this.config.localConcurrency,
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

      writeFileSync(outputPath, JSON.stringify(report, null, 2));
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
    console.log("Swarm Orchestrator v4.3.0 - Hivemind Routing");
    console.log("\nUsage: bun orchestrate-v4.ts <tasks.json> [options]");
    console.log("\nOptions:");
    console.log("  --help, -h            Show this help message");
    console.log("  --swarm-id <id>       Specify swarm ID");
    console.log("  --no-memory           Disable persistent memory");
    console.log("  --strategy <type>     Memory strategy: hierarchical|sliding|none (default: hierarchical)");
    console.log("  --max-tokens <n>      Max context tokens (default: 8000)");
    console.log("  --concurrency <n>     Max concurrent local executors (default: 4)");
    console.log("  --timeout <seconds>   Task timeout in seconds (default: 300)");
    console.log("  --dag-mode <mode>     DAG execution mode: streaming|waves (default: streaming)");
    console.log("  --notify <channel>    Send completion notification: sms|email (default: none, file always written)");
    console.log("  --routing-strategy <s> Routing strategy: fast|reliable|balanced|explore (default: balanced)");
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
    console.log(`  localConcurrency: ${cfg.localConcurrency} ✓`);
    console.log(`  timeoutSeconds: ${cfg.timeoutSeconds} ${cfg.timeoutSeconds > 600 ? "⚠️  (very long)" : "✓"}`);
    console.log(`  maxRetries: ${cfg.maxRetries} ✓`);
    console.log(`  memory.enable: ${cfg.memory.enable} ✓`);
    console.log(`  mode: local executors only ✓`);

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
  let localConcurrency = fileConfig.localConcurrency;
  let timeoutSeconds = fileConfig.timeoutSeconds;
  let dagMode: "streaming" | "waves" = "streaming";
  let routingStrategy: RoutingStrategy = (process.env.SWARM_ROUTING_STRATEGY as RoutingStrategy) || "balanced";

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
      case "--notify":
        const notifyChannel = args[++i] as "sms" | "email";
        if (notifyChannel !== "sms" && notifyChannel !== "email") {
          console.error(`Invalid --notify value: ${notifyChannel}. Must be 'sms' or 'email'.`);
          process.exit(1);
        }
        (fileConfig as any)._notifyOnComplete = notifyChannel;
        break;
      case "--routing-strategy":
        const rs = args[++i] as RoutingStrategy;
        if (!["fast", "reliable", "balanced", "explore"].includes(rs)) {
          console.error(`Invalid --routing-strategy value: ${rs}. Must be one of: fast, reliable, balanced, explore.`);
          process.exit(1);
        }
        routingStrategy = rs;
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
    localConcurrency,
    timeoutSeconds,
    maxRetries: fileConfig.maxRetries,
    dagMode,
    modelName: fileConfig.modelName,
    notifyOnComplete: (fileConfig as any)._notifyOnComplete || "none",
    routingStrategy,
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
