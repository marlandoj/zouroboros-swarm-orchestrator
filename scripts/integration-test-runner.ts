#!/usr/bin/env bun
/**
 * Integration test runner for orchestrate-v4 with real-time file logging.
 * Wraps the orchestrator and captures all output to a log file.
 */

import { appendFileSync, writeFileSync } from "fs";

const LOG_FILE = "/home/workspace/Reports/integration-test-live.log";

// Override console.log to also write to file
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function log(...args: any[]) {
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  origLog(msg);
  try { appendFileSync(LOG_FILE, msg + "\n"); } catch {}
}

console.log = log;
console.warn = (...args: any[]) => {
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  origWarn(msg);
  try { appendFileSync(LOG_FILE, "[WARN] " + msg + "\n"); } catch {}
};
console.error = (...args: any[]) => {
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  origError(msg);
  try { appendFileSync(LOG_FILE, "[ERROR] " + msg + "\n"); } catch {}
};

// Clear log file
writeFileSync(LOG_FILE, `=== Integration Test Started: ${new Date().toISOString()} ===\n`);

// API health check before running the full suite
log("Running API health check...");
try {
  const healthStart = Date.now();
  const healthResp = await fetch("https://api.zo.computer/zo/ask", {
    method: "POST",
    headers: {
      "authorization": process.env.ZO_CLIENT_IDENTITY_TOKEN || "",
      "content-type": "application/json",
    },
    body: JSON.stringify({ input: "Reply with exactly: HEALTH_OK" }),
    signal: AbortSignal.timeout(120_000),
  });
  const healthData = await healthResp.json() as { output?: string };
  const healthMs = Date.now() - healthStart;
  if (!healthResp.ok) {
    log(`[FATAL] API health check failed: HTTP ${healthResp.status}. Aborting.`);
    process.exit(1);
  }
  log(`API health check passed: ${healthMs}ms latency, response: "${(healthData.output || "").slice(0, 50)}"`);
} catch (err) {
  log(`[FATAL] API unreachable: ${err}. Aborting.`);
  process.exit(1);
}

// Import and run orchestrator
const { TokenOptimizedOrchestrator } = await import("./orchestrate-v4");

const taskFile = "/home/workspace/Integrations/ffb-swarm-runner/ffb-site-review-tasks.json";
const tasks = await Bun.file(taskFile).json();

log(`Loaded ${tasks.length} tasks from ${taskFile}`);

const orchestrator = new TokenOptimizedOrchestrator("ffb-int-test", {
  enableMemory: true,
  maxConcurrency: 2,
  timeoutSeconds: 600,
  maxRetries: 3,
  maxContextTokens: 8000,
  crossTaskContextWindow: 3,
  defaultMemoryStrategy: {
    workingMemorySize: 2,
    longTermMemorySize: 3,
    enableDeduplication: true,
    enableHTMLStripping: true,
    maxTokens: 8000,
  },
});

try {
  const results = await orchestrator.run(tasks);
  
  log("\n========================================");
  log("INTEGRATION TEST COMPLETE");
  log("========================================");
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  log(`Total: ${results.length}`);
  log(`Successful: ${successful.length}`);
  log(`Failed: ${failed.length}`);
  
  // Write results JSON
  const resultsPath = "/home/workspace/Reports/integration-test-results.json";
  await Bun.write(resultsPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      successful: successful.length,
      failed: failed.length,
    },
    results: results.map(r => ({
      taskId: r.task.id,
      persona: r.task.persona,
      success: r.success,
      durationMs: r.durationMs,
      retries: r.retries,
      tokensUsed: r.tokensUsed,
      error: r.error,
      outputLength: r.output?.length,
      dependsOn: r.task.dependsOn,
      category: r.task.memoryMetadata?.category,
    })),
  }, null, 2));
  
  log(`\nResults saved to: ${resultsPath}`);
  
} catch (err) {
  log(`[FATAL] Orchestration failed: ${err}`);
  process.exit(1);
}
