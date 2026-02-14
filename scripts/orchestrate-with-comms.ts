#!/usr/bin/env bun
/**
 * Swarm Orchestrator with Inter-Agent Communication
 * Spawn parallel agent teams with real-time collaboration
 */

import { InterAgentBus, CommunicatingAgent } from "./inter-agent-comms.ts";

// Types
interface SwarmConfig {
  maxConcurrency: number;
  timeoutSeconds: number;
  synthesize: boolean;
  outputFormat: "markdown" | "json" | "recommendation" | "summary";
  mode: "parallel" | "validate" | "pipeline" | "collaborative";
  verbose: boolean;
  enableInterAgentComms: boolean;
  collaborationRounds: number;
}

interface AgentTask {
  persona: string;
  task: string;
  priority?: number;
  canCollaborate?: boolean;
}

interface AgentResult {
  persona: string;
  task: string;
  output: string;
  duration: number;
  success: boolean;
  error?: string;
  collaborationLog?: string[];
}

const DEFAULT_CONFIG: SwarmConfig = {
  maxConcurrency: 5,
  timeoutSeconds: 120,
  synthesize: true,
  outputFormat: "markdown",
  mode: "collaborative",
  verbose: false,
  enableInterAgentComms: true,
  collaborationRounds: 2,
};

// Logger
function log(message: string) {
  const timestamp = new Date().toISOString().substr(11, 8);
  console.log(`[${timestamp}] ${message}`);
}

// Spawn a communicating agent
async function spawnCollaborativeAgent(
  bus: InterAgentBus,
  task: AgentTask,
  config: SwarmConfig
): Promise<AgentResult> {
  const startTime = Date.now();
  const collaborationLog: string[] = [];
  
  const agent = new CommunicatingAgent(bus, task.persona);
  await agent.initialize();
  await agent.startTask(task.task);
  
  log(`🤖 ${task.persona} started: ${task.task.substring(0, 60)}...`);
  
  try {
    // Get collaborative context from other agents
    let collaborativeContext = "";
    if (config.enableInterAgentComms) {
      collaborativeContext = await agent.getCollaborativeContext();
      if (collaborativeContext) {
        collaborationLog.push(`Received context: ${collaborativeContext.substring(0, 100)}...`);
      }
    }
    
    // Construct prompt with collaboration context
    const prompt = constructPrompt(task, collaborativeContext, config);
    
    // Execute the agent
    const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
    if (!token) {
      throw new Error("ZO_CLIENT_IDENTITY_TOKEN not set");
    }
    
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
      throw new Error(`API error: ${response.status}`);
    }
    
    const result = await response.json();
    const output = result.output || "";
    
    // Share findings with other agents
    if (config.enableInterAgentComms && task.canCollaborate !== false) {
      await agent.shareFinding(output.substring(0, 500), 0.8);
      collaborationLog.push("Shared findings with swarm");
      
      // Check for conflicts and respond
      const conflicts = await agent.checkForConflicts();
      for (const conflict of conflicts) {
        collaborationLog.push(`Conflict flagged by ${conflict.from}: ${conflict.reason.substring(0, 80)}...`);
        // Could send resolution here
      }
    }
    
    await agent.completeTask();
    const duration = Date.now() - startTime;
    
    log(`✅ ${task.persona} completed in ${duration}ms`);
    
    return {
      persona: task.persona,
      task: task.task,
      output,
      duration,
      success: true,
      collaborationLog
    };
    
  } catch (error) {
    await bus.updateStatus(task.persona, "blocked");
    const duration = Date.now() - startTime;
    
    log(`❌ ${task.persona} failed: ${error instanceof Error ? error.message : String(error)}`);
    
    return {
      persona: task.persona,
      task: task.task,
      output: "",
      duration,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      collaborationLog
    };
  }
}

// Construct prompt with collaboration context
function constructPrompt(task: AgentTask, context: string, config: SwarmConfig): string {
  let prompt = `You are the ${task.persona} persona.

YOUR TASK: ${task.task}

Provide a thorough analysis from your specific expertise perspective.
Be detailed but concise. Focus on actionable insights.`;

  if (config.enableInterAgentComms && context) {
    prompt += `

COLLABORATIVE CONTEXT (findings from other swarm agents):
${context}

Consider how your analysis relates to or differs from the above findings.
If you disagree with another agent's assessment, briefly explain why.
If you have complementary insights, build upon their work.`;
  }

  prompt += `

Format your response with:
1. Key findings
2. Analysis
3. Recommendations (if applicable)`;

  return prompt;
}

// Multi-round collaboration
async function runCollaborativeRounds(
  bus: InterAgentBus,
  tasks: AgentTask[],
  config: SwarmConfig
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  
  for (let round = 1; round <= config.collaborationRounds; round++) {
    log(`\n🔄 Collaboration Round ${round}/${config.collaborationRounds}`);
    
    const roundResults = await Promise.all(
      tasks.map(task => spawnCollaborativeAgent(bus, task, config))
    );
    
    results.push(...roundResults);
    
    // Short pause between rounds for message propagation
    if (round < config.collaborationRounds) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  return results;
}

// Synthesize with conversation context
async function synthesizeWithContext(
  query: string,
  results: AgentResult[],
  bus: InterAgentBus,
  format: SwarmConfig["outputFormat"]
): Promise<string> {
  const successful = results.filter(r => r.success);
  const conversationSummary = bus.getConversationSummary();
  
  const synthesisPrompt = `Synthesize the following agent analyses into a unified response.

ORIGINAL QUERY: ${query}

AGENT ANALYSES:
${successful.map(r => `
--- ${r.persona.toUpperCase()} ---
${r.output}
${r.collaborationLog && r.collaborationLog.length > 0 ? `
Collaboration Notes:
${r.collaborationLog.map(log => `- ${log}`).join("\n")}
` : ""}
`).join("\n")}

SWARM CONVERSATION LOG:
${conversationSummary}

Provide a synthesized response that:
1. Integrates insights from all agents
2. Resolves any conflicts or contradictions noted in collaboration
3. References where agents built upon each other's work
4. Provides a clear conclusion or recommendation
5. Maintains the format: ${format}

SYNTHESIS:`;

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
      body: JSON.stringify({ input: synthesisPrompt })
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

// Main execution with communication hub
export async function runCollaborativeSwarm(
  query: string,
  tasks: AgentTask[],
  config: Partial<SwarmConfig> = {}
): Promise<{ results: AgentResult[]; output: string; conversationLog: string }> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const swarmId = `swarm-${Date.now()}`;
  
  log(`🚀 Starting Collaborative Swarm: ${swarmId}`);
  log(`Query: ${query}`);
  log(`Agents: ${tasks.map(t => t.persona).join(", ")}`);
  log(`Collaboration rounds: ${fullConfig.collaborationRounds}`);
  
  const bus = new InterAgentBus({ swarmId, enablePersistence: true });
  await bus.initialize();
  
  const startTime = Date.now();
  
  let results: AgentResult[];
  
  if (fullConfig.enableInterAgentComms && fullConfig.mode === "collaborative") {
    results = await runCollaborativeRounds(bus, tasks, fullConfig);
  } else {
    // Fall back to parallel execution
    const { executeParallelSwarm } = await import("./orchestrate.ts");
    results = await executeParallelSwarm(tasks, fullConfig);
  }
  
  const duration = Date.now() - startTime;
  
  log(`\n✅ Swarm completed in ${duration}ms`);
  
  // Generate output
  let output: string;
  if (fullConfig.synthesize) {
    log("Synthesizing results with conversation context...");
    output = await synthesizeWithContext(query, results, bus, fullConfig.outputFormat);
  } else {
    const { formatResults } = await import("./orchestrate.ts");
    output = formatResults(results, fullConfig.outputFormat);
  }
  
  const conversationLog = bus.getConversationSummary();
  
  await bus.shutdown();
  
  return { results, output, conversationLog };
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes("--help")) {
    console.log(`
Swarm Orchestrator with Inter-Agent Communication

Usage: bun orchestrate-with-comms.ts <query> [options]

Options:
  --personas, -p              Comma-separated persona IDs
  --tasks, -t                 Task-per-persona (format: "p1:task1|p2:task2")
  --collaboration-rounds, -r  Number of collaboration rounds (default: 2)
  --synthesize, -s            Synthesize results (default: true)
  --format, -f                Output format: markdown, json, summary
  --max-concurrency, -c       Max parallel agents (default: 5)
  --timeout, -T               Timeout per agent in seconds (default: 120)
  --output, -o                Output file path
  --conversation-log          Save conversation log to file
  --verbose, -v               Verbose logging

Examples:
  bun orchestrate-with-comms.ts "Tesla analysis" -p "financial,research,risk" -r 3
  bun orchestrate-with-comms.ts "Crypto investment" -t "fin:ROI|res:Trends|risk:Security" -s
`);
    process.exit(0);
  }
  
  // Parse args
  let query = "";
  const tasks: AgentTask[] = [];
  const config: Partial<SwarmConfig> = {};
  let outputFile: string | undefined;
  let conversationLogFile: string | undefined;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    
    switch (arg) {
      case "--personas":
      case "-p":
        next?.split(",").forEach(p => tasks.push({ persona: p.trim(), task: "" }));
        i++;
        break;
      case "--tasks":
      case "-t":
        next?.split("|").forEach(def => {
          const [persona, ...taskParts] = def.split(":");
          tasks.push({ persona: persona.trim(), task: taskParts.join(":").trim() });
        });
        i++;
        break;
      case "--collaboration-rounds":
      case "-r":
        config.collaborationRounds = parseInt(next || "2");
        i++;
        break;
      case "--synthesize":
      case "-s":
        config.synthesize = true;
        break;
      case "--format":
      case "-f":
        config.outputFormat = next as any;
        i++;
        break;
      case "--output":
      case "-o":
        outputFile = next;
        i++;
        break;
      case "--conversation-log":
        conversationLogFile = next;
        i++;
        break;
      case "--verbose":
      case "-v":
        config.verbose = true;
        break;
      default:
        if (!arg.startsWith("-") && !query) query = arg;
    }
  }
  
  // Set tasks from query if not specified
  tasks.forEach(t => { if (!t.task) t.task = query; });
  
  if (tasks.length === 0) {
    console.error("Error: No personas specified");
    process.exit(1);
  }
  
  // Run swarm
  const { results, output, conversationLog } = await runCollaborativeSwarm(query, tasks, config);
  
  // Output
  console.log("\n" + "=".repeat(60));
  console.log(output);
  console.log("=".repeat(60));
  
  if (outputFile) {
    await Bun.write(outputFile, output);
    console.log(`\n💾 Output saved to: ${outputFile}`);
  }
  
  if (conversationLogFile) {
    await Bun.write(conversationLogFile, conversationLog);
    console.log(`💬 Conversation log saved to: ${conversationLogFile}`);
  }
  
  // Summary
  const successful = results.filter(r => r.success).length;
  console.log(`\n✅ ${successful}/${results.length} agents completed`);
  
  if (successful === 0) process.exit(1);
}

if (import.meta.main) {
  main();
}
