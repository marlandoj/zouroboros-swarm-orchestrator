#!/usr/bin/env bun
/**
 * A/B Test: DAG Streaming vs Wave Execution
 * 
 * Runs the same FFB task set through both modes and compares results.
 * Designed to run during consistent hours for fair comparison.
 * 
 * Usage: bun ab-test.ts [--tasks <path>] [--concurrency <n>]
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";

const DEFAULT_TASKS = "/home/workspace/Integrations/ffb-swarm-runner/ffb-site-review-tasks.json";
const RESULTS_DIR = join(process.env.HOME || "/tmp", ".swarm", "ab-results");
const ORCHESTRATOR = join(__dirname, "orchestrate-v4.ts");

interface RunResult {
  mode: string;
  swarmId: string;
  wallClockMs: number;
  tasksTotal: number;
  tasksSucceeded: number;
  tasksFailed: number;
  totalTokens: number;
  avgTaskMs: number;
  resultFile: string | null;
}

async function runOrchestrator(mode: "streaming" | "waves", taskFile: string, concurrency: number): Promise<RunResult> {
  const swarmId = `ab-${mode}-${Date.now()}`;
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Running: ${mode.toUpperCase()} mode`);
  console.log(`  Swarm ID: ${swarmId}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}\n`);

  const proc = Bun.spawn([
    "bun", ORCHESTRATOR, taskFile,
    "--swarm-id", swarmId,
    "--dag-mode", mode,
    "--concurrency", String(concurrency),
  ], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2400000, // 40 min max
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const wallClockMs = Date.now() - startTime;

  // Print output
  console.log(stdout);
  if (stderr) console.error(stderr);

  // Parse summary from stdout
  const totalMatch = stdout.match(/Total tasks: (\d+)/);
  const successMatch = stdout.match(/Successful: (\d+)/);
  const failedMatch = stdout.match(/Failed: (\d+)/);
  const durationMatch = stdout.match(/Total duration: ([\d.]+)s/);
  const tokensMatch = stdout.match(/Total tokens used: ~([\d,]+)/);
  const avgMatch = stdout.match(/Avg duration per task: (\d+)ms/);
  const resultsMatch = stdout.match(/Results saved to: (.+)/);

  return {
    mode,
    swarmId,
    wallClockMs,
    tasksTotal: totalMatch ? parseInt(totalMatch[1]) : 0,
    tasksSucceeded: successMatch ? parseInt(successMatch[1]) : 0,
    tasksFailed: failedMatch ? parseInt(failedMatch[1]) : 0,
    totalTokens: tokensMatch ? parseInt(tokensMatch[1].replace(/,/g, "")) : 0,
    avgTaskMs: avgMatch ? parseInt(avgMatch[1]) : 0,
    resultFile: resultsMatch ? resultsMatch[1].trim() : null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let taskFile = DEFAULT_TASKS;
  let concurrency = 3;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tasks") taskFile = args[++i];
    if (args[i] === "--concurrency") concurrency = parseInt(args[++i]);
  }

  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         A/B Test: Streaming vs Waves Execution          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\n  Task file: ${taskFile}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Time: ${new Date().toISOString()}\n`);

  // Run A: Streaming (new)
  const streamingResult = await runOrchestrator("streaming", taskFile, concurrency);

  // Brief pause between runs to avoid API throttling
  console.log("\n⏳ Pausing 30 seconds between runs...\n");
  await new Promise(resolve => setTimeout(resolve, 30000));

  // Run B: Waves (legacy)
  const wavesResult = await runOrchestrator("waves", taskFile, concurrency);

  // Compare results
  const diff = wavesResult.wallClockMs - streamingResult.wallClockMs;
  const pctImprovement = ((diff / wavesResult.wallClockMs) * 100).toFixed(1);

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    A/B Test Results                      ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║ Metric              │ Streaming      │ Waves            ║`);
  console.log(`╠═════════════════════╪════════════════╪══════════════════╣`);
  console.log(`║ Wall-clock          │ ${(streamingResult.wallClockMs / 1000).toFixed(1).padStart(10)}s │ ${(wavesResult.wallClockMs / 1000).toFixed(1).padStart(10)}s       ║`);
  console.log(`║ Tasks OK/Total      │ ${String(streamingResult.tasksSucceeded).padStart(5)}/${String(streamingResult.tasksTotal).padEnd(5)} │ ${String(wavesResult.tasksSucceeded).padStart(5)}/${String(wavesResult.tasksTotal).padEnd(5)}        ║`);
  console.log(`║ Avg task duration   │ ${(streamingResult.avgTaskMs / 1000).toFixed(1).padStart(10)}s │ ${(wavesResult.avgTaskMs / 1000).toFixed(1).padStart(10)}s       ║`);
  console.log(`║ Total tokens        │ ${String(streamingResult.totalTokens).padStart(10)}  │ ${String(wavesResult.totalTokens).padStart(10)}         ║`);
  console.log(`╠═════════════════════╧════════════════╧══════════════════╣`);
  console.log(`║ Streaming ${diff > 0 ? "faster" : "slower"} by: ${Math.abs(diff / 1000).toFixed(1)}s (${diff > 0 ? "+" : ""}${pctImprovement}%)${" ".repeat(Math.max(0, 20 - `${Math.abs(diff / 1000).toFixed(1)}s (${pctImprovement}%)`.length))}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  // Save comparison report
  const report = {
    timestamp: new Date().toISOString(),
    taskFile,
    concurrency,
    streaming: streamingResult,
    waves: wavesResult,
    comparison: {
      wallClockDiffMs: diff,
      percentImprovement: parseFloat(pctImprovement),
      streamingFaster: diff > 0,
    },
  };

  const reportPath = join(RESULTS_DIR, `ab-test-${Date.now()}.json`);
  await Bun.write(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📊 Report saved: ${reportPath}`);
}

main().catch(console.error);
