#!/usr/bin/env bun
/**
 * Swarm Orchestrator v3.0.0 - Persistent Memory Edition
 * 
 * Features:
 * - All v2 reliability features (chunking, retry, circuit breaker)
 * - SQLite-backed persistent context storage
 * - Cross-session memory sharing
 * - Memory-aware task injection
 * - Session resumption capabilities
 */

import { SwarmMemory, getSwarmMemory, ContextAccessMode, MemoryQuery } from "./swarm-memory";

// ============================================================================
// TYPES
// ============================================================================

interface Task {
  id: string;
  persona: string;
  task: string;
  priority: "critical" | "high" | "medium" | "low";
  contextAccess?: ContextAccessMode;
  contextQuery?: MemoryQuery;
  contextTags?: string[];
  outputToMemory?: boolean;
  memoryMetadata?: {
    category?: string;
    priority?: "critical" | "high" | "medium" | "low";
    tags?: string[];
  };
  promoteToPersonaMemory?: boolean;
  promotionMetadata?: { entity?: string; category?: string; decay?: string };
}

interface TaskResult {
  task: Task;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  retries: number;
}

interface OrchestratorConfig {
  maxConcurrency: number;
  timeoutSeconds: number;
  maxRetries: number;
  enableMemory: boolean;
  memoryDbPath?: string;
  sharedContextId?: string;
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
  timeoutSeconds: parseInt(process.env.SWARM_TIMEOUT_SECONDS || "300"),
  maxRetries: parseInt(process.env.SWARM_MAX_RETRIES || "3"),
  enableMemory: true,
};

// ============================================================================
// PERSONA MEMORY INTEGRATION (Zo)
// ============================================================================

type PromotionMetadata = {
  entity?: string;
  category?: string;
  decay?: string;
};

function slugifyPersona(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function extractKeywords(taskText: string, max: number = 3): string[] {
  const stop = new Set([
    "the","a","an","and","or","to","of","in","on","for","with","from","is","are","be","this","that","it","as","at","by","you","your","we","our","please","only","task","agent","persona","implement","create","update","fix","test","qa","pass","fail",
  ]);

  const words = taskText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stop.has(w));

  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);

  return [...freq.entries()]
    .sort((a,b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, max);
}

async function runPersonaMemorySearch(query: string): Promise<string> {
  const proc = Bun.spawn(
    ["bun", ".zo/memory/scripts/memory.ts", "search", query, "--limit", "5"],
    { cwd: "/home/workspace", stdout: "pipe", stderr: "pipe" }
  );

  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;

  if (code !== 0) {
    throw new Error(err || `persona memory search failed (${code})`);
  }

  return out.trim();
}

async function personaMemoryBrief(personaName: string, taskText: string): Promise<string> {
  try {
    const slug = slugifyPersona(personaName);
    const personaPath = `/home/workspace/.zo/memory/personas/${slug}.md`;

    let personaExcerpt = "";
    const f = Bun.file(personaPath);
    if (await f.exists()) {
      const text = await f.text();
      personaExcerpt = text.split("\n").slice(0, 30).join("\n").trim();
    }

    const keywords = extractKeywords(taskText, 3);
    const searches: string[] = [];

    for (const k of keywords.slice(0, 2)) {
      try {
        const res = await runPersonaMemorySearch(k);
        if (res && !res.startsWith("Found 0")) searches.push(res);
      } catch {
        // ignore
      }
    }

    if (!personaExcerpt && searches.length === 0) return "";

    const parts: string[] = [];
    parts.push("## Persona Memory Brief");

    if (personaExcerpt) {
      parts.push("### Persona file (top excerpt)");
      parts.push(personaExcerpt);
    }

    if (searches.length > 0) {
      parts.push("### Shared memory search results");
      parts.push(searches.join("\n\n"));
    }

    return parts.join("\n\n");
  } catch {
    return "";
  }
}

function extractPromotableFacts(output: string): string[] {
  const idx = output.indexOf("PROMOTABLE FACTS");
  if (idx === -1) return [];

  const tail = output.slice(idx);
  const lines = tail.split("\n");

  const facts: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // stop if we hit another all-caps section header
    if (/^[A-Z][A-Z\s]{6,}$/.test(line)) break;

    const m = line.match(/^[-*]\s+(.*)$/) || line.match(/^\d+\.?\s+(.*)$/);
    if (!m) continue;

    const fact = m[1].trim();
    if (fact.length < 3) continue;
    facts.push(fact);

    if (facts.length >= 7) break;
  }

  return facts;
}

async function promoteFactsToPersonaMemory(
  facts: string[],
  meta: PromotionMetadata = {}
): Promise<void> {
  for (const fact of facts) {
    const args = [
      "bun",
      ".zo/memory/scripts/memory.ts",
      "store",
      "--persona", "shared",
      "--entity", meta.entity || "swarm",
      "--key", "promoted",
      "--value", fact,
      "--category", meta.category || "decision",
      "--decay", meta.decay || "stable",
      "--source", "swarm-promoted",
      "--text", fact,
    ];

    const proc = Bun.spawn(args, { cwd: "/home/workspace", stdout: "ignore", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      // Do not throw; promotion should never break orchestration
      console.log(`  ⚠️  Promotion failed for fact: ${fact.slice(0, 40)}${fact.length > 40 ? "…" : ""}`);
      if (err.trim()) console.log(`      ${err.trim()}`);
    }
  }
}

// ============================================================================
// ORCHESTRATOR CLASS
// ============================================================================

class MemoryAwareOrchestrator {
  private config: OrchestratorConfig;
  private memory: SwarmMemory;
  private swarmId: string;
  private sessionId: string;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private results: TaskResult[] = [];

  constructor(swarmId: string, config: Partial<OrchestratorConfig> = {}) {
    this.swarmId = swarmId;
    this.sessionId = `${swarmId}_${Date.now()}`;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    if (this.config.enableMemory) {
      this.memory = getSwarmMemory(this.config.memoryDbPath);
    } else {
      // Create a null memory implementation for memory-disabled mode
      this.memory = null as any;
    }
  }

  // --------------------------------------------------------------------------
  // MAIN EXECUTION
  // --------------------------------------------------------------------------

  async run(tasks: Task[]): Promise<TaskResult[]> {
    console.log(`\n🐝 Swarm Orchestrator v3.0.0 - Persistent Memory`);
    console.log(`   Swarm ID: ${this.swarmId}`);
    console.log(`   Session: ${this.sessionId}`);
    console.log(`   Tasks: ${tasks.length}`);
    console.log(`   Memory: ${this.config.enableMemory ? "enabled" : "disabled"}\n`);

    // Initialize session in memory
    if (this.config.enableMemory) {
      this.memory.createSession(this.swarmId, this.sessionId, {
        description: `Swarm execution with ${tasks.length} tasks`,
        tags: ["v3", "persistent-memory"],
      }, tasks.length);
    }

    // Sort by priority
    const sortedTasks = this.sortByPriority(tasks);

    // Process in chunks
    const chunks = this.createChunks(sortedTasks, this.config.maxConcurrency);
    
    for (let i = 0; i < chunks.length; i++) {
      console.log(`\n📦 Chunk ${i + 1}/${chunks.length} (${chunks[i].length} tasks)`);
      await this.processChunk(chunks[i]);
      
      // Update progress
      if (this.config.enableMemory) {
        this.memory.updateSessionStatus(this.swarmId, "active", this.results.filter(r => r.success).length);
      }
    }

    // Mark session complete
    if (this.config.enableMemory) {
      const successCount = this.results.filter(r => r.success).length;
      const status = successCount === tasks.length ? "completed" : "failed";
      this.memory.updateSessionStatus(this.swarmId, status, successCount);
    }

    // Final summary
    this.printSummary();

    return this.results;
  }

  // --------------------------------------------------------------------------
  // CHUNK PROCESSING
  // --------------------------------------------------------------------------

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

    // Build prompt with memory injection
    const prompt = await this.buildPromptWithMemory(task);

    while (retries <= this.config.maxRetries) {
      try {
        console.log(`  🚀 [${task.id}] ${task.persona} (attempt ${retries + 1})`);
        
        const output = await this.callAgent(task.persona, prompt);
        
        // Record success
        this.recordSuccess(task.persona);
        
        // Save output to memory if requested
        if (this.config.enableMemory && task.outputToMemory) {
          this.memory.writeContext(this.swarmId, output, {
            sourceAgent: task.persona,
            category: task.memoryMetadata?.category || "general",
            priority: task.memoryMetadata?.priority || "medium",
            tags: [...(task.memoryMetadata?.tags || []), task.id],
          });
        }

        // Promote curated facts to Zo persona memory (optional)
        if (this.config.enableMemory && task.outputToMemory && task.promoteToPersonaMemory) {
          const promotable = extractPromotableFacts(output);
          if (promotable.length > 0) {
            await promoteFactsToPersonaMemory(
              promotable,
              task.promotionMetadata || {}
            );
          }
        }

        return {
          task,
          success: true,
          output,
          durationMs: Date.now() - startTime,
          retries,
        };

      } catch (error) {
        retries++;
        console.log(`  ⚠️  [${task.id}] Error: ${error}`);

        if (retries <= this.config.maxRetries) {
          const delay = Math.pow(2, retries) * 1000; // Exponential backoff
          console.log(`  ⏳ [${task.id}] Retrying in ${delay}ms...`);
          await this.sleep(delay);
        } else {
          // Record failure for circuit breaker
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
  // MEMORY INTEGRATION
  // --------------------------------------------------------------------------

  private async buildPromptWithMemory(task: Task): Promise<string> {
    let basePrompt = task.task;

    // Add footer asking for promotable facts when promotion is enabled
    const promotionEnabled = task.promoteToPersonaMemory;
    if (promotionEnabled) {
      basePrompt += `\n\n---\n\nAt the end of your response, include a section titled exactly:\n\nPROMOTABLE FACTS\n- Provide 3-7 bullet points that are stable decisions, preferences, or constraints worth remembering for future tasks.\n- Keep each bullet to one sentence.\n`;
    }

    // Persona memory brief (Zo)
    const personaBrief = await personaMemoryBrief(task.persona, task.task);

    if (!this.config.enableMemory || task.contextAccess === "none") {
      return personaBrief ? `${personaBrief}\n\n## Your Task\n\n${basePrompt}` : basePrompt;
    }

    // Retrieve relevant context based on task configuration
    let contexts = [];

    if (task.contextQuery) {
      // Use specific query
      contexts = this.memory.queryContexts({
        ...task.contextQuery,
        swarmId: this.swarmId, // Always filter to current swarm for isolation
      });
    } else if (task.contextTags && task.contextTags.length > 0) {
      // Query by tags
      contexts = this.memory.queryContexts({
        swarmId: this.swarmId,
        tags: task.contextTags,
      });
    } else if (task.contextAccess === "read" || task.contextAccess === "append") {
      // Get recent contexts from this swarm
      contexts = this.memory.queryContexts({
        swarmId: this.swarmId,
        limit: 5,
      });
    }

    // Format and inject swarm context
    const contextInjection = this.memory.formatContextForInjection(
      contexts,
      task.contextAccess || "read"
    );

    const blocks: string[] = [];
    if (personaBrief) blocks.push(personaBrief);
    if (contextInjection) blocks.push(contextInjection.trim());

    if (blocks.length > 0) {
      return `${blocks.join("\n\n")}` + `\n\n## Your Task\n\n${basePrompt}`;
    }

    return basePrompt;
  }

  // --------------------------------------------------------------------------
  // AGENT COMMUNICATION
  // --------------------------------------------------------------------------

  private async callAgent(persona: string, prompt: string): Promise<string> {
    const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
    if (!token) {
      throw new Error("ZO_CLIENT_IDENTITY_TOKEN not set");
    }

    const response = await fetch("https://api.zo.computer/zo/ask", {
      method: "POST",
      headers: {
        "authorization": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: `[Persona: ${persona}]\n\n${prompt}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.output || "";
  }

  // --------------------------------------------------------------------------
  // CIRCUIT BREAKER
  // --------------------------------------------------------------------------

  private isCircuitOpen(persona: string): boolean {
    const cb = this.circuitBreakers.get(persona);
    if (!cb) return false;
    
    if (cb.isOpen) {
      // Check if we should try resetting (after 60 seconds)
      if (Date.now() - cb.lastFailure > 60000) {
        cb.isOpen = false;
        cb.failures = 0;
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
    
    if (cb.failures >= 2) {
      cb.isOpen = true;
      console.log(`  🔴 Circuit breaker opened for ${persona}`);
    }
    
    this.circuitBreakers.set(persona, cb);
  }

  // --------------------------------------------------------------------------
  // UTILITY METHODS
  // --------------------------------------------------------------------------

  private sortByPriority(tasks: Task[]): Task[] {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
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

  private printSummary(): void {
    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);
    const avgDuration = successful.reduce((sum, r) => sum + r.durationMs, 0) / successful.length || 0;

    console.log(`\n📊 Execution Summary`);
    console.log(`   Total tasks: ${this.results.length}`);
    console.log(`   Successful: ${successful.length}`);
    console.log(`   Failed: ${failed.length}`);
    console.log(`   Avg duration: ${Math.round(avgDuration)}ms`);

    if (this.config.enableMemory) {
      const stats = this.memory.getStats();
      console.log(`   Memory contexts: ${stats.contexts}`);
    }

    if (failed.length > 0) {
      console.log(`\n❌ Failed tasks:`);
      for (const result of failed) {
        console.log(`   - ${result.task.id}: ${result.error}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // PUBLIC API FOR MEMORY ACCESS
  // --------------------------------------------------------------------------

  getMemory(): SwarmMemory | null {
    return this.config.enableMemory ? this.memory : null;
  }

  getSwarmId(): string {
    return this.swarmId;
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log("Swarm Orchestrator v3.0.0 - Persistent Memory");
    console.log("\nUsage: bun orchestrate-v3.ts <tasks.json> [options]");
    console.log("\nOptions:");
    console.log("  --swarm-id <id>       Specify swarm ID (default: auto-generated)");
    console.log("  --no-memory           Disable persistent memory");
    console.log("  --db-path <path>      Custom database path");
    console.log("\nExample:");
    console.log("  bun orchestrate-v3.ts tasks.json --swarm-id my-analysis");
    process.exit(1);
  }

  const taskFile = args[0];
  
  // Parse options
  let swarmId = `swarm_${Date.now()}`;
  let enableMemory = true;
  let dbPath: string | undefined;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--swarm-id":
        swarmId = args[++i];
        break;
      case "--no-memory":
        enableMemory = false;
        break;
      case "--db-path":
        dbPath = args[++i];
        break;
    }
  }

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
  const orchestrator = new MemoryAwareOrchestrator(swarmId, {
    enableMemory,
    memoryDbPath: dbPath,
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

export { MemoryAwareOrchestrator, Task, TaskResult, OrchestratorConfig };
