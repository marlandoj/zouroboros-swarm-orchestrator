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

// ============================================================================
// TYPES
// ============================================================================

type PriorityQueue = "critical" | "high" | "medium" | "low";

interface Task {
  id: string;
  persona: string;
  task: string;
  priority: PriorityQueue;
  
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
  timeoutSeconds: number;
  maxRetries: number;
  enableMemory: boolean;
  defaultMemoryStrategy: MemoryStrategy;
  maxContextTokens: number;
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
  defaultMemoryStrategy: {
    workingMemorySize: 2,
    longTermMemorySize: 3,
    enableDeduplication: true,
    enableHTMLStripping: true,
    maxTokens: 8000,
  },
  maxContextTokens: 8000,
};

// ============================================================================
// MEMORY INTEGRATION MODULE
// ============================================================================

class MemoryManager {
  private swarmMemory: SwarmMemory | null = null;
  private hierarchicalMemory: HierarchicalMemory | SlidingWindowMemory | null = null;

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

class TokenOptimizedOrchestrator {
  private config: OrchestratorConfig;
  private memoryManager: MemoryManager | null = null;
  private swarmId: string;
  private sessionId: string;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private results: TaskResult[] = [];

  constructor(swarmId: string, config: Partial<OrchestratorConfig> = {}) {
    this.swarmId = swarmId;
    this.sessionId = `${swarmId}_${Date.now()}`;
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.enableMemory) {
      this.memoryManager = new MemoryManager(
        swarmId,
        this.config,
        config.memoryDbPath
      );
    }
  }

  // --------------------------------------------------------------------------
  // MAIN EXECUTION
  // --------------------------------------------------------------------------

  async run(tasks: Task[]): Promise<TaskResult[]> {
    const startTime = Date.now();
    
    console.log(`\n🐝 Swarm Orchestrator v4.0.0 - Token Optimizer`);
    console.log(`   Swarm ID: ${this.swarmId}`);
    console.log(`   Session: ${this.sessionId}`);
    console.log(`   Tasks: ${tasks.length}`);
    console.log(`   Concurrency: ${this.config.maxConcurrency}`);
    console.log(`   Max Context Tokens: ${this.config.maxContextTokens}`);
    console.log(`   Memory Strategy: ${this.config.defaultMemoryStrategy.enableDeduplication ? "Hierarchical (optimized)" : "Basic"}\n`);

    // Sort by priority
    const sortedTasks = this.sortByPriority(tasks);

    // Process in chunks
    const chunks = this.createChunks(sortedTasks, this.config.maxConcurrency);

    for (let i = 0; i < chunks.length; i++) {
      console.log(`\n📦 Chunk ${i + 1}/${chunks.length} (${chunks[i].length} tasks)`);
      await this.processChunk(chunks[i]);
    }

    // Final summary
    this.printSummary(Date.now() - startTime);

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

    // Build optimized prompt
    const prompt = await this.buildOptimizedPrompt(task);
    const promptTokens = this.estimateTokens(prompt);

    while (retries <= this.config.maxRetries) {
      try {
        console.log(`  🚀 [${task.id}] ${task.persona} (attempt ${retries + 1}) ~${promptTokens} tokens`);
        
        const output = await this.callAgent(task.persona, prompt);
        const outputTokens = this.estimateTokens(output);
        
        // Record success
        this.recordSuccess(task.persona);

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

        if (retries <= this.config.maxRetries) {
          const delay = Math.pow(2, retries) * 1000;
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

  private async buildOptimizedPrompt(task: Task): Promise<string> {
    const basePrompt = task.task;

    // Get memory context
    const memoryContext = this.memoryManager?.getContext(task) || "";
    
    // Build full prompt
    let fullPrompt = "";
    
    if (memoryContext) {
      fullPrompt += memoryContext + "\n\n";
    }

    fullPrompt += `## Your Task\n\n${basePrompt}`;

    // Check token budget
    const estimatedTokens = this.estimateTokens(fullPrompt);
    
    if (estimatedTokens > this.config.maxContextTokens * 0.9) {
      console.log(`  ⚠️  [${task.id}] Prompt exceeds token budget (${estimatedTokens} > ${this.config.maxContextTokens}), truncating...`);
      
      // Simple truncation: trim memory context first
      if (memoryContext) {
        const budgetExcess = estimatedTokens - (this.config.maxContextTokens * 0.8);
        const truncatedMemory = this.truncateToBudget(memoryContext, memoryContext.length - Math.ceil(budgetExcess * 4));
        fullPrompt = truncatedMemory + "\n\n## Your Task\n\n" + basePrompt;
      }
    }

    return fullPrompt;
  }

  // --------------------------------------------------------------------------
  // AGENT COMMUNICATION
  // --------------------------------------------------------------------------

  private async callAgent(persona: string, prompt: string): Promise<string> {
    const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
    if (!token) {
      throw new Error("ZO_CLIENT_IDENTITY_TOKEN not set");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutSeconds * 1000);

    try {
      const response = await fetch("https://api.zo.computer/zo/ask", {
        method: "POST",
        headers: {
          "authorization": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: `[Persona: ${persona}]\n\n${prompt}`,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.output || "";
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // CIRCUIT BREAKER
  // --------------------------------------------------------------------------

  private isCircuitOpen(persona: string): boolean {
    const cb = this.circuitBreakers.get(persona);
    if (!cb) return false;
    
    if (cb.isOpen) {
      // Reset after 60 seconds
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
    // Rough approximation: ~4 chars per token for GPT models
    return Math.ceil(text.length / 4);
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
  // SUMMARY
  // --------------------------------------------------------------------------

  private printSummary(totalDurationMs: number): void {
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
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log("Swarm Orchestrator v4.0.0 - Token Optimizer");
    console.log("\nUsage: bun orchestrate-v4.ts <tasks.json> [options]");
    console.log("\nOptions:");
    console.log("  --swarm-id <id>       Specify swarm ID");
    console.log("  --no-memory           Disable persistent memory");
    console.log("  --strategy <type>     Memory strategy: hierarchical|sliding|none (default: hierarchical)");
    console.log("  --max-tokens <n>      Max context tokens (default: 8000)");
    console.log("  --concurrency <n>     Max concurrent tasks (default: 2)");
    console.log("\nExample:");
    console.log("  bun orchestrate-v4.ts tasks.json --strategy hierarchical --max-tokens 12000");
    process.exit(1);
  }

  const taskFile = args[0];
  
  // Parse options
  let swarmId = `swarm_${Date.now()}`;
  let enableMemory = true;
  let strategy: MemoryStrategy = DEFAULT_CONFIG.defaultMemoryStrategy;
  let maxTokens = DEFAULT_CONFIG.maxContextTokens;
  let concurrency = DEFAULT_CONFIG.maxConcurrency;

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
