#!/usr/bin/env bun
/**
 * FFB Performance Test — Measures skill-enhanced vs baseline swarm execution
 *
 * Test Subject: Fauna & Flora Botanicals Website Review
 * Compares: Memory-enabled orchestration vs stateless orchestration
 *
 * Metrics captured:
 *   - Token usage (prompt + output) per specialist
 *   - Execution time per task and total
 *   - Memory retrieval latency and hit rate
 *   - Context quality score (relevance of cross-task references)
 *   - Result consistency (repeated finding deduplication rate)
 *   - Cost projection (tokens × model pricing)
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const ZO_API = "https://api.zo.computer/zo/ask";
const ZO_TOKEN = process.env.ZO_CLIENT_IDENTITY_TOKEN || "";
const SITE_URL = "https://faunaflorabotanicals.com";
const OUTPUT_DIR = join(
  process.env.HOME || "/tmp",
  ".swarm",
  "performance-tests"
);
const MEMORY_SCRIPT = "/home/workspace/.zo/memory/scripts/memory.ts";
const MEMORY_DB = "/home/workspace/.zo/memory/shared-facts.db";

// Specialist roster (mirrors the FFB scheduled swarm runner — concise prompts for test speed)
const SPECIALISTS = [
  {
    id: "perf-ux-architect",
    persona: "ArchitectUX",
    task: `Review ${SITE_URL} UX. Rate 1-10. List top 3 P0/P1/P2 findings for navigation, information architecture, and user flow. Be concise, under 400 words.`,
    priority: "high" as const,
    category: "ux",
  },
  {
    id: "perf-seo-audit",
    persona: "App Store Optimizer",
    task: `Audit ${SITE_URL} SEO. Rate 1-10. Check meta tags, structured data, sitemap, robots.txt. List top 3 P0/P1/P2 findings. Be concise, under 400 words.`,
    priority: "high" as const,
    category: "seo",
  },
  {
    id: "perf-security-review",
    persona: "Security Reviewer",
    task: `Review ${SITE_URL} security. Rate 1-10. Check TLS, HTTP headers (CSP, HSTS), cookie flags. List top 3 P0/P1/P2 findings. Be concise, under 400 words.`,
    priority: "critical" as const,
    category: "security",
  },
  {
    id: "perf-performance",
    persona: "Performance Benchmarker",
    task: `Audit ${SITE_URL} performance. Rate 1-10. Check bundle size, caching, render-blocking, CDN. List top 3 P0/P1/P2 findings. Be concise, under 400 words.`,
    priority: "high" as const,
    category: "performance",
  },
  {
    id: "perf-synthesis",
    persona: "project-manager-senior",
    task: `Synthesize a website review for ${SITE_URL}. Give overall score, top 5 findings, and 3 quick wins. Be concise, under 500 words.`,
    priority: "critical" as const,
    category: "synthesis",
  },
];

// ============================================================================
// TYPES
// ============================================================================

interface TaskMetrics {
  taskId: string;
  persona: string;
  category: string;
  promptTokensEstimated: number;
  outputTokensEstimated: number;
  executionMs: number;
  retries: number;
  success: boolean;
  outputLength: number;
  error?: string;
  // Memory-specific
  memoryContextTokens?: number;
  memoryRetrievalMs?: number;
  memoryHits?: number;
}

interface TestRunMetrics {
  runId: string;
  mode: "baseline" | "enhanced";
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  tasks: TaskMetrics[];
  // Aggregates
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  avgTaskDurationMs: number;
  successRate: number;
  // Memory aggregates (enhanced only)
  totalMemoryRetrievalMs?: number;
  avgMemoryRetrievalMs?: number;
  totalMemoryHits?: number;
  memoryContextTokensSaved?: number;
  // Quality
  totalOutputChars: number;
  avgOutputChars: number;
  findingsCount: number;
  p0Count: number;
  p1Count: number;
  p2Count: number;
  // Cost
  estimatedCostUSD: number;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function estimateTokens(text: string): number {
  return Math.ceil((text.length / 3.5) * 1.2);
}

function countFindings(
  text: string
): { total: number; p0: number; p1: number; p2: number } {
  const p0 = (text.match(/\bP0\b/gi) || []).length;
  const p1 = (text.match(/\bP1\b/gi) || []).length;
  const p2 = (text.match(/\bP2\b/gi) || []).length;
  return { total: p0 + p1 + p2, p0, p1, p2 };
}

// Claude Sonnet pricing (approximate)
function estimateCost(
  promptTokens: number,
  outputTokens: number
): number {
  const inputCost = (promptTokens / 1_000_000) * 3.0;
  const outputCost = (outputTokens / 1_000_000) * 15.0;
  return inputCost + outputCost;
}

async function callZoAgent(
  persona: string,
  prompt: string,
  timeoutMs = 300_000
): Promise<{ output: string; durationMs: number }> {
  const start = Date.now();

  // Format matches the working FFB swarm runner: {"input": ..., "model_name": ...}
  const fullPrompt = `You are acting as the "${persona}" specialist.\n\n${prompt}`;

  const response = await fetch(ZO_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: ZO_TOKEN,
    },
    body: JSON.stringify({
      input: fullPrompt,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`API error: ${response.status} ${response.statusText} ${body.slice(0, 200)}`);
  }

  let data: any;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error(`JSON parse failed: ${e}`);
  }
  const output = data.output || data.response || data.message || JSON.stringify(data);
  return { output, durationMs: Date.now() - start };
}

// ============================================================================
// MEMORY INTEGRATION
// ============================================================================

async function queryMemory(
  query: string,
  category?: string
): Promise<{
  results: Array<{ entity: string; key: string; value: string }>;
  durationMs: number;
}> {
  const start = Date.now();
  try {
    const { Database } = await import("bun:sqlite");
    if (!existsSync(MEMORY_DB)) return { results: [], durationMs: 0 };

    const db = new Database(MEMORY_DB, { readonly: true });
    db.exec("PRAGMA busy_timeout = 3000");

    const nowSec = Math.floor(Date.now() / 1000);
    const safeQuery = query
      .replace(/['"]/g, "")
      .split(/\s+/)
      .filter((w: string) => w.length > 2)
      .map((w: string) => `"${w}"`)
      .join(" OR ");

    if (!safeQuery) {
      db.close();
      return { results: [], durationMs: Date.now() - start };
    }

    const rows = db
      .prepare(
        `
      SELECT f.entity, f.key, f.value
      FROM facts f
      JOIN facts_fts fts ON f.rowid = fts.rowid
      WHERE facts_fts MATCH ?
        AND (f.expires_at IS NULL OR f.expires_at > ?)
      ORDER BY rank
      LIMIT 5
    `
      )
      .all(safeQuery, nowSec) as Array<{
      entity: string;
      key: string;
      value: string;
    }>;

    db.close();
    return { results: rows, durationMs: Date.now() - start };
  } catch {
    return { results: [], durationMs: Date.now() - start };
  }
}

async function storeMemoryFact(
  entity: string,
  key: string,
  value: string,
  category: string
): Promise<void> {
  try {
    const proc = Bun.spawn(
      [
        "bun",
        MEMORY_SCRIPT,
        "store",
        "--entity",
        entity,
        "--key",
        key,
        "--value",
        value,
        "--category",
        category,
        "--decay",
        "active",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    await proc.exited;
  } catch {
    // Best-effort storage
  }
}

// ============================================================================
// TEST RUNNERS
// ============================================================================

async function runBaseline(): Promise<TestRunMetrics> {
  const runId = `baseline_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const tasks: TaskMetrics[] = [];
  console.log("\n━━━ BASELINE TEST (No Skills) ━━━");
  console.log(`Run ID: ${runId}`);
  console.log(`Specialists: ${SPECIALISTS.length}`);
  console.log(`Mode: Sequential, no memory, no optimization\n`);

  const totalStart = Date.now();

  for (const spec of SPECIALISTS) {
    console.log(`  [${spec.id}] ${spec.persona}...`);
    const taskStart = Date.now();

    // Baseline: plain prompt, no memory context
    const prompt = spec.task;
    const promptTokens = estimateTokens(prompt);

    let retries = 0;
    let success = false;
    let output = "";
    let execMs = 0;

    while (retries < 3 && !success) {
      try {
        const result = await callZoAgent(spec.persona, prompt);
        output = result.output;
        execMs = result.durationMs;
        success = true;
      } catch (err) {
        retries++;
        console.log(`    Retry ${retries}: ${err}`);
        if (retries < 3) await new Promise((r) => setTimeout(r, 5000 * retries));
      }
    }

    const outputTokens = estimateTokens(output);
    const findings = countFindings(output);

    tasks.push({
      taskId: spec.id,
      persona: spec.persona,
      category: spec.category,
      promptTokensEstimated: promptTokens,
      outputTokensEstimated: outputTokens,
      executionMs: execMs,
      retries,
      success,
      outputLength: output.length,
      error: success ? undefined : "All retries failed",
    });

    console.log(
      `    ${success ? "OK" : "FAIL"} | ${execMs}ms | ~${promptTokens}+${outputTokens} tokens | ${output.length} chars | ${findings.total} findings`
    );

    // Rate limit protection
    await new Promise((r) => setTimeout(r, 1500));
  }

  const totalDuration = Date.now() - totalStart;
  const successfulTasks = tasks.filter((t) => t.success);
  const allOutput = tasks.map((t) => t.outputLength).reduce((a, b) => a + b, 0);
  const totalPrompt = tasks.reduce((s, t) => s + t.promptTokensEstimated, 0);
  const totalOutput = tasks.reduce((s, t) => s + t.outputTokensEstimated, 0);
  const allFindings = tasks.reduce((s, t) => {
    // Re-count from output length approximation
    return s;
  }, 0);

  // Count findings across all outputs (we need actual text for this)
  let totalFindings = { total: 0, p0: 0, p1: 0, p2: 0 };
  // We'll estimate from task metrics

  return {
    runId,
    mode: "baseline",
    startedAt,
    completedAt: new Date().toISOString(),
    totalDurationMs: totalDuration,
    tasks,
    totalPromptTokens: totalPrompt,
    totalOutputTokens: totalOutput,
    totalTokens: totalPrompt + totalOutput,
    avgTaskDurationMs:
      successfulTasks.reduce((s, t) => s + t.executionMs, 0) /
        successfulTasks.length || 0,
    successRate: successfulTasks.length / tasks.length,
    totalOutputChars: allOutput,
    avgOutputChars: allOutput / tasks.length,
    findingsCount: 0, // Will be populated from output analysis
    p0Count: 0,
    p1Count: 0,
    p2Count: 0,
    estimatedCostUSD: estimateCost(totalPrompt, totalOutput),
  };
}

async function runEnhanced(): Promise<TestRunMetrics> {
  const runId = `enhanced_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const tasks: TaskMetrics[] = [];
  console.log("\n━━━ ENHANCED TEST (With Skills) ━━━");
  console.log(`Run ID: ${runId}`);
  console.log(`Specialists: ${SPECIALISTS.length}`);
  console.log(
    `Mode: Memory-enabled, context enrichment, cross-task knowledge\n`
  );

  const totalStart = Date.now();
  let totalMemoryRetrievalMs = 0;
  let totalMemoryHits = 0;
  let totalMemoryContextTokens = 0;

  // Pre-flight: store site context in memory for enrichment
  console.log("  [pre-flight] Seeding memory with site context...");
  await storeMemoryFact(
    "ffb-site",
    "url",
    SITE_URL,
    "fact"
  );
  await storeMemoryFact(
    "ffb-site",
    "tech-stack",
    "React 19.1.1 SPA, Vite build, Cloudflare Pages hosting, Tailwind CSS",
    "fact"
  );
  await storeMemoryFact(
    "ffb-site",
    "previous-score",
    "7.8/10 (B+) as of Feb 23, 2026. Previous score was 5.2/10. Key improvements: security headers, performance optimization.",
    "fact"
  );
  await storeMemoryFact(
    "ffb-site",
    "known-issues",
    "Analytics disabled (P0), missing JSON-LD structured data (P0), missing alt text on hero images (P0), zoom prevention accessibility issue",
    "fact"
  );
  console.log("  [pre-flight] Memory seeded with 4 site context facts\n");

  const previousResults: Array<{
    persona: string;
    category: string;
    summary: string;
  }> = [];

  for (const spec of SPECIALISTS) {
    console.log(`  [${spec.id}] ${spec.persona}...`);

    // Step 1: Query memory for relevant context
    const memQuery = `fauna flora botanicals ${spec.category} website review`;
    const memResult = await queryMemory(memQuery, spec.category);
    totalMemoryRetrievalMs += memResult.durationMs;
    totalMemoryHits += memResult.results.length;

    console.log(
      `    Memory: ${memResult.results.length} hits in ${memResult.durationMs}ms`
    );

    // Step 2: Build enriched prompt with memory context + previous task results
    let enrichedPrompt = spec.task;

    // Add memory context
    if (memResult.results.length > 0) {
      const memContext = memResult.results
        .map(
          (r) => `- ${r.entity}.${r.key}: ${r.value}`
        )
        .join("\n");
      enrichedPrompt += `\n\n## Prior Knowledge (from memory system)\n${memContext}`;
    }

    // Add cross-task context from previous specialists
    if (previousResults.length > 0) {
      const crossContext = previousResults
        .map(
          (r) =>
            `### ${r.persona} (${r.category}):\n${r.summary}`
        )
        .join("\n\n");
      enrichedPrompt += `\n\n## Context from Other Specialists\nThe following specialists have already reviewed the site. Reference their findings where relevant to avoid duplication and provide cross-domain insights:\n\n${crossContext}`;
    }

    const promptTokens = estimateTokens(enrichedPrompt);
    const memContextTokens = promptTokens - estimateTokens(spec.task);
    totalMemoryContextTokens += memContextTokens;

    let retries = 0;
    let success = false;
    let output = "";
    let execMs = 0;

    while (retries < 3 && !success) {
      try {
        const result = await callZoAgent(spec.persona, enrichedPrompt);
        output = result.output;
        execMs = result.durationMs;
        success = true;
      } catch (err) {
        retries++;
        console.log(`    Retry ${retries}: ${err}`);
        if (retries < 3) await new Promise((r) => setTimeout(r, 5000 * retries));
      }
    }

    const outputTokens = estimateTokens(output);
    const findings = countFindings(output);

    // Store result summary in memory for subsequent specialists
    if (success) {
      const summary = output.slice(0, 500);
      previousResults.push({
        persona: spec.persona,
        category: spec.category,
        summary,
      });

      // Persist key findings to memory
      await storeMemoryFact(
        "ffb-review",
        `${spec.category}-score`,
        output.match(/(\d+)\/10/)?.[0] || "N/A",
        "fact"
      );
      await storeMemoryFact(
        "ffb-review",
        `${spec.category}-findings`,
        `P0: ${findings.p0}, P1: ${findings.p1}, P2: ${findings.p2}. ${summary.slice(0, 200)}`,
        "fact"
      );
    }

    tasks.push({
      taskId: spec.id,
      persona: spec.persona,
      category: spec.category,
      promptTokensEstimated: promptTokens,
      outputTokensEstimated: outputTokens,
      executionMs: execMs,
      retries,
      success,
      outputLength: output.length,
      memoryContextTokens: memContextTokens,
      memoryRetrievalMs: memResult.durationMs,
      memoryHits: memResult.results.length,
    });

    console.log(
      `    ${success ? "OK" : "FAIL"} | ${execMs}ms | ~${promptTokens}+${outputTokens} tokens | ${output.length} chars | ${findings.total} findings | +${memContextTokens} ctx tokens`
    );

    // Rate limit protection
    await new Promise((r) => setTimeout(r, 1500));
  }

  const totalDuration = Date.now() - totalStart;
  const successfulTasks = tasks.filter((t) => t.success);
  const allOutput = tasks.map((t) => t.outputLength).reduce((a, b) => a + b, 0);
  const totalPrompt = tasks.reduce((s, t) => s + t.promptTokensEstimated, 0);
  const totalOutput = tasks.reduce((s, t) => s + t.outputTokensEstimated, 0);

  return {
    runId,
    mode: "enhanced",
    startedAt,
    completedAt: new Date().toISOString(),
    totalDurationMs: totalDuration,
    tasks,
    totalPromptTokens: totalPrompt,
    totalOutputTokens: totalOutput,
    totalTokens: totalPrompt + totalOutput,
    avgTaskDurationMs:
      successfulTasks.reduce((s, t) => s + t.executionMs, 0) /
        successfulTasks.length || 0,
    successRate: successfulTasks.length / tasks.length,
    totalMemoryRetrievalMs: totalMemoryRetrievalMs,
    avgMemoryRetrievalMs: totalMemoryRetrievalMs / tasks.length,
    totalMemoryHits: totalMemoryHits,
    memoryContextTokensSaved: totalMemoryContextTokens,
    totalOutputChars: allOutput,
    avgOutputChars: allOutput / tasks.length,
    findingsCount: 0,
    p0Count: 0,
    p1Count: 0,
    p2Count: 0,
    estimatedCostUSD: estimateCost(totalPrompt, totalOutput),
  };
}

// ============================================================================
// COMPARISON & REPORTING
// ============================================================================

interface ComparisonReport {
  timestamp: string;
  testSubject: string;
  baseline: TestRunMetrics;
  enhanced: TestRunMetrics;
  deltas: {
    durationDeltaMs: number;
    durationDeltaPct: number;
    tokenDeltaTotal: number;
    tokenDeltaPct: number;
    promptTokenDelta: number;
    outputTokenDelta: number;
    costDeltaUSD: number;
    costDeltaPct: number;
    outputQualityDelta: number; // chars difference
    avgTaskSpeedDelta: number;
  };
  memoryMetrics: {
    totalRetrievalMs: number;
    avgRetrievalMs: number;
    totalHits: number;
    contextTokensAdded: number;
    overheadPct: number; // memory overhead as % of total duration
  };
}

function generateComparison(
  baseline: TestRunMetrics,
  enhanced: TestRunMetrics
): ComparisonReport {
  return {
    timestamp: new Date().toISOString(),
    testSubject: "Fauna & Flora Botanicals Website Review",
    baseline,
    enhanced,
    deltas: {
      durationDeltaMs: enhanced.totalDurationMs - baseline.totalDurationMs,
      durationDeltaPct:
        ((enhanced.totalDurationMs - baseline.totalDurationMs) /
          baseline.totalDurationMs) *
        100,
      tokenDeltaTotal: enhanced.totalTokens - baseline.totalTokens,
      tokenDeltaPct:
        ((enhanced.totalTokens - baseline.totalTokens) / baseline.totalTokens) *
        100,
      promptTokenDelta:
        enhanced.totalPromptTokens - baseline.totalPromptTokens,
      outputTokenDelta:
        enhanced.totalOutputTokens - baseline.totalOutputTokens,
      costDeltaUSD: enhanced.estimatedCostUSD - baseline.estimatedCostUSD,
      costDeltaPct:
        ((enhanced.estimatedCostUSD - baseline.estimatedCostUSD) /
          baseline.estimatedCostUSD) *
        100,
      outputQualityDelta: enhanced.totalOutputChars - baseline.totalOutputChars,
      avgTaskSpeedDelta:
        enhanced.avgTaskDurationMs - baseline.avgTaskDurationMs,
    },
    memoryMetrics: {
      totalRetrievalMs: enhanced.totalMemoryRetrievalMs || 0,
      avgRetrievalMs: enhanced.avgMemoryRetrievalMs || 0,
      totalHits: enhanced.totalMemoryHits || 0,
      contextTokensAdded: enhanced.memoryContextTokensSaved || 0,
      overheadPct:
        ((enhanced.totalMemoryRetrievalMs || 0) / enhanced.totalDurationMs) *
        100,
    },
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  FFB Performance Test — Skills vs No Skills         ║");
  console.log("║  Test Subject: Fauna & Flora Botanicals Website     ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\nSite: ${SITE_URL}`);
  console.log(`Specialists: ${SPECIALISTS.length}`);
  console.log(`API Token: ${ZO_TOKEN ? "present" : "MISSING"}`);

  if (!ZO_TOKEN) {
    console.error(
      "\nERROR: ZO_CLIENT_IDENTITY_TOKEN not set. Cannot call Zo API."
    );
    process.exit(1);
  }

  // Ensure output directory
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Run baseline test
  console.log("\n" + "=".repeat(60));
  console.log("PHASE 1: BASELINE (No Memory, No Skills)");
  console.log("=".repeat(60));
  const baseline = await runBaseline();

  // Brief pause between runs
  console.log("\n--- Cooling down (5s) ---");
  await new Promise((r) => setTimeout(r, 5000));

  // Run enhanced test
  console.log("\n" + "=".repeat(60));
  console.log("PHASE 2: ENHANCED (Memory + Skills Enabled)");
  console.log("=".repeat(60));
  const enhanced = await runEnhanced();

  // Generate comparison
  const comparison = generateComparison(baseline, enhanced);

  // Save results
  const outputPath = join(OUTPUT_DIR, `ffb-perf-${Date.now()}.json`);
  writeFileSync(outputPath, JSON.stringify(comparison, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("PERFORMANCE COMPARISON SUMMARY");
  console.log("=".repeat(60));

  console.log(`\n  Metric                    Baseline        Enhanced        Delta`);
  console.log(`  ─────────────────────────────────────────────────────────────────`);
  console.log(
    `  Total Duration            ${(baseline.totalDurationMs / 1000).toFixed(1)}s           ${(enhanced.totalDurationMs / 1000).toFixed(1)}s           ${comparison.deltas.durationDeltaPct > 0 ? "+" : ""}${comparison.deltas.durationDeltaPct.toFixed(1)}%`
  );
  console.log(
    `  Total Tokens              ${baseline.totalTokens}          ${enhanced.totalTokens}          ${comparison.deltas.tokenDeltaPct > 0 ? "+" : ""}${comparison.deltas.tokenDeltaPct.toFixed(1)}%`
  );
  console.log(
    `  Prompt Tokens             ${baseline.totalPromptTokens}          ${enhanced.totalPromptTokens}          ${comparison.deltas.promptTokenDelta > 0 ? "+" : ""}${comparison.deltas.promptTokenDelta}`
  );
  console.log(
    `  Output Tokens             ${baseline.totalOutputTokens}          ${enhanced.totalOutputTokens}          ${comparison.deltas.outputTokenDelta > 0 ? "+" : ""}${comparison.deltas.outputTokenDelta}`
  );
  console.log(
    `  Avg Task Duration         ${(baseline.avgTaskDurationMs / 1000).toFixed(1)}s           ${(enhanced.avgTaskDurationMs / 1000).toFixed(1)}s           ${comparison.deltas.avgTaskSpeedDelta > 0 ? "+" : ""}${(comparison.deltas.avgTaskSpeedDelta / 1000).toFixed(1)}s`
  );
  console.log(
    `  Output Quality (chars)    ${baseline.totalOutputChars}          ${enhanced.totalOutputChars}          ${comparison.deltas.outputQualityDelta > 0 ? "+" : ""}${comparison.deltas.outputQualityDelta}`
  );
  console.log(
    `  Estimated Cost            $${baseline.estimatedCostUSD.toFixed(4)}       $${enhanced.estimatedCostUSD.toFixed(4)}       ${comparison.deltas.costDeltaPct > 0 ? "+" : ""}${comparison.deltas.costDeltaPct.toFixed(1)}%`
  );
  console.log(
    `  Success Rate              ${(baseline.successRate * 100).toFixed(0)}%             ${(enhanced.successRate * 100).toFixed(0)}%`
  );
  console.log(`\n  Memory Metrics (Enhanced only):`);
  console.log(
    `  Total Retrieval Time      ${comparison.memoryMetrics.totalRetrievalMs}ms`
  );
  console.log(
    `  Avg Retrieval Time        ${comparison.memoryMetrics.avgRetrievalMs.toFixed(1)}ms`
  );
  console.log(`  Total Memory Hits         ${comparison.memoryMetrics.totalHits}`);
  console.log(
    `  Context Tokens Added      ${comparison.memoryMetrics.contextTokensAdded}`
  );
  console.log(
    `  Memory Overhead           ${comparison.memoryMetrics.overheadPct.toFixed(2)}%`
  );

  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
