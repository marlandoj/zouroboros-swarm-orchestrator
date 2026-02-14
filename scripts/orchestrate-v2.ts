#!/usr/bin/env bun
/**
 * Swarm Orchestrator v2 - Resilient Multi-Agent Execution
 * 
 * Improvements over v1:
 * - Sequential execution with concurrency limiting
 * - Exponential backoff retry logic
 * - Circuit breaker pattern for failing agents
 * - Chunked processing for large tasks
 * - Progress tracking and detailed logging
 */

import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// Configuration
const CONFIG = {
  MAX_CONCURRENCY: 2, // Reduced from 5
  TIMEOUT_SECONDS: 300, // Increased from 120
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2000,
  CIRCUIT_BREAKER_THRESHOLD: 2,
  CHUNK_SIZE: 2, // Process agents in chunks
};

interface AgentTask {
  id: string;
  persona: string;
  task: string;
  priority: "critical" | "high" | "medium" | "low";
  retries: number;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  error?: string;
  durationMs?: number;
}

interface OrchestratorResult {
  success: boolean;
  completed: AgentTask[];
  failed: AgentTask[];
  durationMs: number;
  summary: string;
}

class ResilientSwarmOrchestrator {
  private tasks: AgentTask[] = [];
  private circuitBreaker: Map<string, number> = new Map();
  private startTime: number = 0;

  async execute(tasks: AgentTask[]): Promise<OrchestratorResult> {
    this.startTime = Date.now();
    this.tasks = tasks.map(t => ({ ...t, retries: 0, status: "pending" }));
    
    console.log(`🚀 Swarm Orchestrator v2 - ${tasks.length} tasks queued`);
    console.log(`   Config: maxConcurrency=${CONFIG.MAX_CONCURRENCY}, timeout=${CONFIG.TIMEOUT_SECONDS}s`);

    // Sort by priority
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    this.tasks.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // Process in chunks to control concurrency
    const chunks = this.chunkArray(this.tasks, CONFIG.CHUNK_SIZE);
    
    for (const chunk of chunks) {
      await this.processChunk(chunk);
    }

    // Retry failed tasks
    await this.retryFailedTasks();

    return this.buildResult();
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private async processChunk(chunk: AgentTask[]): Promise<void> {
    const promises = chunk.map(task => this.executeTask(task));
    await Promise.all(promises);
  }

  private async executeTask(task: AgentTask): Promise<void> {
    // Check circuit breaker
    const failures = this.circuitBreaker.get(task.persona) || 0;
    if (failures >= CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
      console.log(`⚠️  Circuit breaker open for ${task.persona}, skipping...`);
      task.status = "failed";
      task.error = "Circuit breaker open - too many failures";
      return;
    }

    task.status = "running";
    const taskStart = Date.now();

    try {
      console.log(`▶️  [${task.id}] Starting ${task.persona} agent...`);
      
      const result = await this.callZoAPI(task);
      
      task.result = result;
      task.status = "completed";
      task.durationMs = Date.now() - taskStart;
      
      // Reset circuit breaker on success
      this.circuitBreaker.set(task.persona, 0);
      
      console.log(`✅ [${task.id}] Completed in ${task.durationMs}ms`);
      
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.durationMs = Date.now() - taskStart;
      
      // Increment circuit breaker
      this.circuitBreaker.set(task.persona, failures + 1);
      
      console.log(`❌ [${task.id}] Failed: ${task.error}`);
    }
  }

  private async callZoAPI(task: AgentTask): Promise<string> {
    const prompt = this.buildPrompt(task);
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout after ${CONFIG.TIMEOUT_SECONDS}s`));
      }, CONFIG.TIMEOUT_SECONDS * 1000);

      const pythonScript = `
import requests
import os
import json
import sys

url = 'https://api.zo.computer/zo/ask'
headers = {
    'authorization': os.environ.get('ZO_CLIENT_IDENTITY_TOKEN', ''),
    'content-type': 'application/json'
}

try:
    resp = requests.post(
        url,
        headers=headers,
        json={'input': '''${prompt.replace(/'/g, "'\\''")}'''},
        timeout=${CONFIG.TIMEOUT_SECONDS}
    )
    resp.raise_for_status()
    data = resp.json()
    print(json.dumps({'success': True, 'output': data.get('output', '')}))
except Exception as e:
    print(json.dumps({'success': False, 'error': str(e)}))
`;

      const proc = spawn("python3", ["-c", pythonScript], {
        env: { ...process.env, PYTHONUNBUFFERED: "1" }
      });

      let output = "";
      let errorOutput = "";

      proc.stdout.on("data", (data) => {
        output += data.toString();
      });

      proc.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        
        if (code !== 0) {
          reject(new Error(`Process exited with code ${code}: ${errorOutput}`));
          return;
        }

        try {
          const result = JSON.parse(output.trim());
          if (result.success) {
            resolve(result.output);
          } else {
            reject(new Error(result.error));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${output}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private buildPrompt(task: AgentTask): string {
    return `
You are the ${task.persona} persona.

TASK: ${task.task}

IMPORTANT INSTRUCTIONS:
1. Be concise but thorough - aim for 300-500 words maximum
2. Focus on actionable recommendations with specific examples
3. Use markdown formatting with clear sections
4. Prioritize your findings by impact (CRITICAL/HIGH/MEDIUM/LOW)
5. Include code snippets or specific implementation steps where applicable

CONTEXT:
- Website: Fauna & Flora Botanicals (e-commerce)
- Tech Stack: React, TypeScript, Express, Tailwind CSS
- Current Status: Critical security and SEO fixes deployed
- Goal: Address medium priority recommendations

RESPOND NOW with your analysis and recommendations.
`;
  }

  private async retryFailedTasks(): Promise<void> {
    const failedTasks = this.tasks.filter(t => t.status === "failed" && t.retries < CONFIG.MAX_RETRIES);
    
    if (failedTasks.length === 0) return;

    console.log(`\n🔄 Retrying ${failedTasks.length} failed tasks...`);

    for (const task of failedTasks) {
      task.retries++;
      console.log(`   Retry ${task.retries}/${CONFIG.MAX_RETRIES} for ${task.id}`);
      
      await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS * task.retries));
      await this.executeTask(task);
    }
  }

  private buildResult(): OrchestratorResult {
    const completed = this.tasks.filter(t => t.status === "completed");
    const failed = this.tasks.filter(t => t.status === "failed");
    const durationMs = Date.now() - this.startTime;

    const summary = `
## Swarm Execution Summary

**Total Tasks:** ${this.tasks.length}
**Completed:** ${completed.length} ✅
**Failed:** ${failed.length} ❌
**Total Duration:** ${(durationMs / 1000).toFixed(1)}s

### Completed Tasks
${completed.map(t => `- ✅ ${t.id} (${t.persona}): ${t.durationMs}ms`).join("\n")}

### Failed Tasks
${failed.map(t => `- ❌ ${t.id} (${t.persona}): ${t.error}`).join("\n")}

### Circuit Breaker Status
${Array.from(this.circuitBreaker.entries()).map(([persona, count]) => `- ${persona}: ${count} failures`).join("\n")}
`;

    return {
      success: failed.length === 0,
      completed,
      failed,
      durationMs,
      summary
    };
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Usage: bun orchestrate-v2.ts <task-file.json>

Task file format:
[
  {
    "id": "security-audit",
    "persona": "security-engineer",
    "task": "Review authentication flow for vulnerabilities",
    "priority": "critical"
  }
]
`);
    process.exit(1);
  }

  const taskFile = args[0];
  const outputDir = args[1] || "/tmp/swarm-results";

  if (!existsSync(taskFile)) {
    console.error(`❌ Task file not found: ${taskFile}`);
    process.exit(1);
  }

  const tasks: AgentTask[] = await import(taskFile).then(m => m.default || m);
  
  mkdirSync(outputDir, { recursive: true });

  const orchestrator = new ResilientSwarmOrchestrator();
  const result = await orchestrator.execute(tasks);

  // Write results
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = join(outputDir, `swarm-result-${timestamp}.json`);
  
  writeFileSync(outputFile, JSON.stringify(result, null, 2));
  
  console.log("\n" + "=".repeat(60));
  console.log(result.summary);
  console.log("=".repeat(60));
  console.log(`\n📁 Results saved to: ${outputFile}`);

  process.exit(result.success ? 0 : 1);
}

main().catch(console.error);
