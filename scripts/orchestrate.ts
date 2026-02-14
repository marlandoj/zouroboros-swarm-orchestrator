#!/usr/bin/env bun
/**
 * Swarm Orchestrator
 * Spawn parallel agent teams and synthesize results
 */

import { spawn, ChildProcess } from "child_process";
import { writeFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// Types
interface SwarmConfig {
  maxConcurrency: number;
  timeoutSeconds: number;
  synthesize: boolean;
  outputFormat: "markdown" | "json" | "recommendation" | "summary";
  mode: "parallel" | "validate" | "pipeline" | "auto-expand";
  verbose: boolean;
}

interface AgentTask {
  persona: string;
  task: string;
  priority?: number;
}

interface AgentResult {
  persona: string;
  task: string;
  output: string;
  duration: number;
  success: boolean;
  error?: string;
}

interface PersonaDefinition {
  id: string;
  name: string;
  expertise: string[];
  best_for: string[];
  mcp_servers?: string[];
}

// Default configuration
const DEFAULT_CONFIG: SwarmConfig = {
  maxConcurrency: parseInt(process.env.SWARM_MAX_CONCURRENCY || "5"),
  timeoutSeconds: parseInt(process.env.SWARM_TIMEOUT_SECONDS || "120"),
  synthesize: false,
  outputFormat: "markdown",
  mode: "parallel",
  verbose: false,
};

// Logger
function log(message: string, verbose: boolean = false) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  
  // Also write to log file
  const logFile = "/dev/shm/swarm-orchestrator.log";
  try {
    Bun.write(logFile, logMessage + "\n", { append: true });
  } catch {}
}

function logVerbose(message: string, config: SwarmConfig) {
  if (config.verbose) {
    log(`[VERBOSE] ${message}`, true);
  }
}

// Load persona registry
async function loadPersonaRegistry(): Promise<PersonaDefinition[]> {
  const registryPath = "/home/workspace/Skills/swarm-orchestrator/assets/persona-registry.json";
  
  if (!existsSync(registryPath)) {
    // Create default registry
    const defaultRegistry = {
      personas: [
        {
          id: "financial-advisor",
          name: "Financial Advisor",
          expertise: ["investment analysis", "portfolio management", "trading"],
          best_for: ["stock analysis", "financial planning", "market data"]
        },
        {
          id: "research-analyst",
          name: "Research Analyst",
          expertise: ["data gathering", "synthesis", "trend analysis"],
          best_for: ["market research", "competitive analysis", "industry trends"]
        },
        {
          id: "risk-analyst",
          name: "Risk Analyst",
          expertise: ["risk assessment", "downside analysis", "compliance"],
          best_for: ["risk evaluation", "mitigation strategies"]
        }
      ]
    };
    
    await mkdir("/home/workspace/Skills/swarm-orchestrator/assets", { recursive: true });
    await writeFile(registryPath, JSON.stringify(defaultRegistry, null, 2));
    return defaultRegistry.personas;
  }
  
  const content = await readFile(registryPath, "utf-8");
  return JSON.parse(content).personas;
}

// Auto-route query to appropriate personas
async function autoRoutePersonas(
  query: string,
  depth: "quick" | "standard" | "comprehensive",
  registry: PersonaDefinition[]
): Promise<string[]> {
  const query_lower = query.toLowerCase();
  const matches: Map<string, number> = new Map();
  
  // Score each persona based on keyword matches
  for (const persona of registry) {
    let score = 0;
    
    // Check expertise keywords
    for (const expertise of persona.expertise) {
      if (query_lower.includes(expertise.toLowerCase())) {
        score += 2;
      }
    }
    
    // Check best_for keywords
    for (const useCase of persona.best_for) {
      if (query_lower.includes(useCase.toLowerCase())) {
        score += 3;
      }
    }
    
    // Check id/name matches
    if (query_lower.includes(persona.id.toLowerCase()) ||
        query_lower.includes(persona.name.toLowerCase())) {
      score += 5;
    }
    
    if (score > 0) {
      matches.set(persona.id, score);
    }
  }
  
  // Sort by score and return top personas based on depth
  const sorted = Array.from(matches.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  
  const limit = depth === "quick" ? 2 : depth === "standard" ? 3 : 5;
  return sorted.slice(0, limit);
}

// Spawn a single agent via /zo/ask API
async function spawnAgent(
  task: AgentTask,
  config: SwarmConfig
): Promise<AgentResult> {
  const startTime = Date.now();
  
  logVerbose(`Spawning agent: ${task.persona} for task: ${task.task}`, config);
  
  // Construct the prompt for the child Zo
  const prompt = `You are the ${task.persona} persona. 

TASK: ${task.task}

Provide a thorough analysis from your specific expertise perspective. 
Be detailed but concise. Focus on actionable insights.

Format your response with:
1. Key findings
2. Analysis
3. Recommendations (if applicable)`;

  // Call /zo/ask API
  const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  if (!token) {
    return {
      persona: task.persona,
      task: task.task,
      output: "",
      duration: 0,
      success: false,
      error: "ZO_CLIENT_IDENTITY_TOKEN not set"
    };
  }
  
  try {
    const response = await fetch("https://api.zo.computer/zo/ask", {
      method: "POST",
      headers: {
        "Authorization": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: prompt,
        persona_id: task.persona
      })
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json();
    const duration = Date.now() - startTime;
    
    logVerbose(`Agent ${task.persona} completed in ${duration}ms`, config);
    
    return {
      persona: task.persona,
      task: task.task,
      output: result.output || "",
      duration,
      success: true
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      persona: task.persona,
      task: task.task,
      output: "",
      duration,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Execute parallel agent swarm
async function executeParallelSwarm(
  tasks: AgentTask[],
  config: SwarmConfig
): Promise<AgentResult[]> {
  log(`Executing parallel swarm with ${tasks.length} agents (max concurrency: ${config.maxConcurrency})`);
  
  const results: AgentResult[] = [];
  const executing: Promise<AgentResult>[] = [];
  
  // Process tasks with concurrency limit
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    
    // Wait if at concurrency limit
    while (executing.length >= config.maxConcurrency) {
      const completed = await Promise.race(executing);
      results.push(completed);
      executing.splice(executing.findIndex(p => p === Promise.resolve(completed)), 1);
    }
    
    // Add timeout wrapper
    const agentPromise = Promise.race([
      spawnAgent(task, config),
      new Promise<AgentResult>((_, reject) => 
        setTimeout(() => reject(new Error("Timeout")), config.timeoutSeconds * 1000)
      )
    ]).catch(error => ({
      persona: task.persona,
      task: task.task,
      output: "",
      duration: config.timeoutSeconds * 1000,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }));
    
    executing.push(agentPromise);
  }
  
  // Wait for remaining agents
  const remaining = await Promise.all(executing);
  results.push(...remaining);
  
  return results;
}

// Synthesize results from multiple agents
async function synthesizeResults(
  query: string,
  results: AgentResult[],
  format: SwarmConfig["outputFormat"]
): Promise<string> {
  // Filter successful results
  const successful = results.filter(r => r.success);
  
  if (successful.length === 0) {
    return "## Error\n\nAll agents failed to produce results.\n\n" + 
           results.map(r => `- ${r.persona}: ${r.error}`).join("\n");
  }
  
  // Build synthesis prompt
  const synthesisPrompt = `Synthesize the following agent analyses into a unified response.

ORIGINAL QUERY: ${query}

AGENT ANALYSES:
${successful.map(r => `
--- ${r.persona.toUpperCase()} ---
${r.output}
`).join("\n")}

Provide a synthesized response that:
1. Integrates insights from all agents
2. Resolves any conflicts or contradictions
3. Provides a clear conclusion or recommendation
4. Maintains the format: ${format}

SYNTHESIS:`;

  // Call synthesis via /zo/ask
  const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  if (!token) {
    return "Error: ZO_CLIENT_IDENTITY_TOKEN not set for synthesis";
  }
  
  try {
    const response = await fetch("https://api.zo.computer/zo/ask", {
      method: "POST",
      headers: {
        "Authorization": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: synthesisPrompt
      })
    });
    
    if (!response.ok) {
      throw new Error(`Synthesis API error: ${response.status}`);
    }
    
    const result = await response.json();
    return result.output || "Synthesis failed";
  } catch (error) {
    return `Synthesis error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Format results without synthesis
function formatResults(results: AgentResult[], format: SwarmConfig["outputFormat"]): string {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  let output = "";
  
  switch (format) {
    case "json":
      output = JSON.stringify({
        successful: successful.map(r => ({
          persona: r.persona,
          task: r.task,
          output: r.output,
          duration_ms: r.duration
        })),
        failed: failed.map(r => ({
          persona: r.persona,
          error: r.error
        })),
        summary: {
          total: results.length,
          successful: successful.length,
          failed: failed.length
        }
      }, null, 2);
      break;
      
    case "summary":
      output = `# Swarm Results Summary

**Agents Spawned:** ${results.length}
**Successful:** ${successful.length}
**Failed:** ${failed.length}
**Total Duration:** ${Math.max(...results.map(r => r.duration))}ms

## Key Findings
${successful.map(r => `- **${r.persona}**: ${r.output.substring(0, 200)}...`).join("\n")}
`;
      break;
      
    default: // markdown or recommendation
      output = `# Multi-Agent Analysis Results

${successful.map(r => `
## ${r.persona}

**Task:** ${r.task}
**Duration:** ${r.duration}ms

${r.output}
`).join("\n---\n")}

${failed.length > 0 ? `
## Failed Agents

${failed.map(r => `- **${r.persona}**: ${r.error}`).join("\n")}
` : ""}

---

**Summary:** ${successful.length}/${results.length} agents completed successfully
`;
  }
  
  return output;
}

// Parse CLI arguments
function parseArgs(args: string[]): { query: string; config: SwarmConfig; tasks: AgentTask[] } {
  const config: SwarmConfig = { ...DEFAULT_CONFIG };
  const tasks: AgentTask[] = [];
  let query = "";
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    
    switch (arg) {
      case "--personas":
      case "-p":
        if (nextArg) {
          const personas = nextArg.split(",");
          personas.forEach(p => tasks.push({ persona: p.trim(), task: "" }));
          i++;
        }
        break;
        
      case "--tasks":
      case "-t":
        if (nextArg) {
          // Format: "persona:task|persona:task"
          const taskDefs = nextArg.split("|");
          taskDefs.forEach(def => {
            const [persona, ...taskParts] = def.split(":");
            tasks.push({
              persona: persona.trim(),
              task: taskParts.join(":").trim()
            });
          });
          i++;
        }
        break;
        
      case "--synthesize":
      case "-s":
        config.synthesize = true;
        break;
        
      case "--format":
      case "-f":
        if (nextArg) {
          config.outputFormat = nextArg as SwarmConfig["outputFormat"];
          i++;
        }
        break;
        
      case "--mode":
      case "-m":
        if (nextArg) {
          config.mode = nextArg as SwarmConfig["mode"];
          i++;
        }
        break;
        
      case "--max-concurrency":
      case "-c":
        if (nextArg) {
          config.maxConcurrency = parseInt(nextArg);
          i++;
        }
        break;
        
      case "--timeout":
      case "-T":
        if (nextArg) {
          config.timeoutSeconds = parseInt(nextArg);
          i++;
        }
        break;
        
      case "--verbose":
      case "-v":
        config.verbose = true;
        break;
        
      default:
        if (!arg.startsWith("-") && !query) {
          query = arg;
        }
    }
  }
  
  return { query, config, tasks };
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Swarm Orchestrator - Spawn parallel agent teams

Usage: bun orchestrate.ts <query> [options]

Options:
  --personas, -p          Comma-separated persona IDs
  --tasks, -t             Task-per-persona (format: "persona:task|persona:task")
  --synthesize, -s        Synthesize results into unified output
  --format, -f            Output format: markdown, json, recommendation, summary
  --mode, -m              Execution mode: parallel (default), validate, pipeline
  --max-concurrency, -c   Max parallel agents (default: 5)
  --timeout, -T           Timeout per agent in seconds (default: 120)
  --verbose, -v           Verbose logging
  --help, -h              Show this help

Examples:
  bun orchestrate.ts "Tesla analysis" -p "financial-advisor,research-analyst"
  bun orchestrate.ts "Crypto investment" -t "financial:ROI|risk:Security" -s
`);
    process.exit(0);
  }
  
  const { query, config, tasks } = parseArgs(args);
  
  if (!query && tasks.length === 0) {
    console.error("Error: No query provided");
    process.exit(1);
  }
  
  log(`🚀 Starting Swarm Orchestrator`);
  log(`Query: ${query || "(tasks provided)"}`);
  log(`Mode: ${config.mode}`);
  log(`Max concurrency: ${config.maxConcurrency}`);
  log(`Synthesize: ${config.synthesize}`);
  
  // Load persona registry
  const registry = await loadPersonaRegistry();
  logVerbose(`Loaded ${registry.length} personas from registry`, config);
  
  // Build task list
  let agentTasks: AgentTask[] = tasks;
  
  if (agentTasks.length === 0 && query) {
    // Auto-route based on query
    const autoPersonas = await autoRoutePersonas(query, "standard", registry);
    agentTasks = autoPersonas.map(p => ({ persona: p, task: query }));
    log(`Auto-routed to personas: ${autoPersonas.join(", ")}`);
  }
  
  if (agentTasks.length === 0) {
    console.error("Error: No personas specified and auto-routing failed");
    process.exit(1);
  }
  
  // Ensure all tasks have a task description
  agentTasks = agentTasks.map(t => ({
    ...t,
    task: t.task || query
  }));
  
  log(`Spawning ${agentTasks.length} agents...`);
  
  // Execute swarm
  const startTime = Date.now();
  const results = await executeParallelSwarm(agentTasks, config);
  const totalDuration = Date.now() - startTime;
  
  log(`Swarm completed in ${totalDuration}ms`);
  
  // Generate output
  let output: string;
  
  if (config.synthesize) {
    log("Synthesizing results...");
    output = await synthesizeResults(query, results, config.outputFormat);
  } else {
    output = formatResults(results, config.outputFormat);
  }
  
  // Print output
  console.log("\n" + "=".repeat(60));
  console.log(output);
  console.log("=".repeat(60) + "\n");
  
  // Print summary
  const successful = results.filter(r => r.success).length;
  console.log(`✅ ${successful}/${results.length} agents completed (${totalDuration}ms)`);
  
  // Exit with error if all agents failed
  if (successful === 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
