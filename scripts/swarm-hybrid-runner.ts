#!/usr/bin/env bun
/**
 * Hybrid Swarm Runner - Graceful Handoff for Long-Running Swarms
 * 
 * Solves the 15-minute chat timeout problem by:
 * 1. Streaming progress updates for first 12 minutes (while chat is alive)
 * 2. Gracefully handing off to background mode at 13 minutes
 * 3. Sending notification when complete
 * 
 * Usage:
 *   bun swarm-hybrid-runner.ts <campaign.json> [orchestrator-options]
 */

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const CHAT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const HANDOFF_THRESHOLD_MS = 13 * 60 * 1000; // 13 minutes (2 min buffer)
const POLL_INTERVAL_MS = 10 * 1000; // Poll every 10 seconds

interface ProgressData {
  ts: string;
  swarmId: string;
  totalTasks: number;
  completed: number;
  failed: number;
  percentComplete: number;
  elapsedMs: number;
  status?: string;
  errors?: string[];
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("❌ Usage: bun swarm-hybrid-runner.ts <campaign.json> [orchestrator-options]");
    console.error("\nExample:");
    console.error("  bun swarm-hybrid-runner.ts campaign.json --notify sms");
    process.exit(1);
  }

  const campaignFile = args[0];
  const swarmId = `swarm_${Date.now()}`;
  
  // Check if campaign file exists
  if (!existsSync(campaignFile)) {
    console.error(`❌ Campaign file not found: ${campaignFile}`);
    process.exit(1);
  }

  // Load campaign to estimate size
  let taskCount = 0;
  try {
    const data = JSON.parse(readFileSync(campaignFile, "utf-8"));
    taskCount = Array.isArray(data) ? data.length : 1;
  } catch (e) {
    console.error(`❌ Failed to parse campaign file: ${e}`);
    process.exit(1);
  }

  console.log(`\n🐝 Hybrid Swarm Runner`);
  console.log(`   Campaign: ${campaignFile}`);
  console.log(`   Tasks: ${taskCount}`);
  console.log(`   Swarm ID: ${swarmId}`);
  console.log();

  // Determine if we should use background mode immediately
  const estimatedMinutes = Math.ceil(taskCount * 2); // Rough estimate: 2 min per task
  const shouldBackground = estimatedMinutes > 12;

  if (shouldBackground) {
    console.log(`⚠️  Estimated duration: ~${estimatedMinutes} minutes`);
    console.log(`   This will exceed chat timeout (15 min)`);
    console.log(`   Starting in hybrid mode with progress streaming...`);
  } else {
    console.log(`✅ Estimated duration: ~${estimatedMinutes} minutes`);
    console.log(`   Running in foreground mode...`);
  }
  console.log();

  // Ensure --notify is set for long-running swarms
  const extraArgs = [...args.slice(1)];
  const hasNotify = extraArgs.some(arg => arg === "--notify");
  if (!hasNotify && shouldBackground) {
    extraArgs.push("--notify", "sms");
    console.log(`   📱 Auto-enabled SMS notifications (use --notify email to change)`);
  }

  // Build orchestrator command
  const orchestratorScript = join(import.meta.dir, "orchestrate-v4.ts");
  const cmd = ["bun", orchestratorScript, campaignFile, "--swarm-id", swarmId, ...extraArgs];

  // Start orchestrator in background
  const proc = spawn(cmd[0], cmd.slice(1), {
    detached: true,
    stdio: shouldBackground ? "ignore" : "inherit",
  });

  if (!shouldBackground) {
    // Short swarm — just wait for it
    await new Promise<void>((resolve, reject) => {
      proc.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Orchestrator exited with code ${code}`));
      });
    });
    return;
  }

  // Long swarm — hybrid mode
  proc.unref(); // Let it run independently

  const startTime = Date.now();
  const progressFile = join(process.env.HOME || "/tmp", ".swarm", "logs", `${swarmId}_progress.json`);

  console.log(`   ✅ Orchestrator started in background (PID ${proc.pid})`);
  console.log(`   📊 Monitoring progress for next 13 minutes...`);
  console.log();

  let lastProgress: ProgressData | null = null;
  let pollCount = 0;

  // Poll progress until handoff threshold
  while (Date.now() - startTime < HANDOFF_THRESHOLD_MS) {
    await sleep(POLL_INTERVAL_MS);
    pollCount++;

    // Read progress file
    if (existsSync(progressFile)) {
      try {
        const progress: ProgressData = JSON.parse(readFileSync(progressFile, "utf-8"));
        
        // Only print if progress changed
        if (!lastProgress || 
            progress.completed !== lastProgress.completed ||
            progress.failed !== lastProgress.failed ||
            progress.status !== lastProgress.status) {
          
          const elapsed = Math.floor(progress.elapsedMs / 1000);
          const minutes = Math.floor(elapsed / 60);
          const seconds = elapsed % 60;
          
          if (progress.status === "complete") {
            console.log(`\n✅ Swarm complete!`);
            console.log(`   Completed: ${progress.completed}/${progress.totalTasks} tasks`);
            if (progress.failed > 0) {
              console.log(`   Failed: ${progress.failed}`);
            }
            console.log(`   Duration: ${minutes}m ${seconds}s`);
            console.log();
            return;
          } else if (progress.status === "preflight_failed") {
            console.log(`\n❌ Preflight checks failed`);
            if (progress.errors) {
              progress.errors.forEach(err => console.log(`   • ${err}`));
            }
            process.exit(1);
          } else {
            console.log(`[${minutes}m ${seconds}s] Progress: ${progress.completed}/${progress.totalTasks} tasks (${progress.percentComplete}%)`);
            if (progress.failed > 0) {
              console.log(`   ⚠️  Failed: ${progress.failed}`);
            }
          }

          lastProgress = progress;
        }
      } catch (e) {
        // Progress file might be mid-write, ignore parse errors
      }
    }

    // Check if swarm has already completed
    if (lastProgress?.status === "complete") {
      console.log(`\n✅ Swarm completed before handoff threshold`);
      return;
    }
  }

  // Handoff to background mode
  console.log(`\n⏰ Approaching chat timeout — switching to background mode`);
  console.log();
  console.log(`📌 Your swarm is still running:`);
  console.log(`   Swarm ID: ${swarmId}`);
  console.log(`   Progress: ${lastProgress?.completed || 0}/${lastProgress?.totalTasks || taskCount} tasks (${lastProgress?.percentComplete || 0}%)`);
  console.log();
  console.log(`📞 You'll be notified when complete`);
  console.log();
  console.log(`🔍 Check status anytime:`);
  console.log(`   bun ${orchestratorScript} status ${swarmId}`);
  console.log();
  console.log(`📄 Results will be saved to:`);
  console.log(`   ~/.swarm/results/${swarmId}.json`);
  console.log();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\n❌ Hybrid runner failed: ${error}`);
    process.exit(1);
  });
}
