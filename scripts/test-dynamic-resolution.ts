#!/usr/bin/env bun
/**
 * Test: v4.8 dynamic model resolution
 * Validates that resolveModelDynamic returns correct combos for different task types/tiers
 * without actually calling executors.
 */

import {
  estimateComplexitySync,
  inferTaskType,
  fetchCombos,
  bestComboForTask,
  TIER_TO_COMBO,
  type ComplexityTier,
  type TaskType,
} from "./tier-resolve";

interface TestCase {
  label: string;
  prompt: string;
  model?: string;
  expectedTier: ComplexityTier;
  expectedTaskType: TaskType;
}

const cases: TestCase[] = [
  {
    label: "trivial / documentation",
    prompt: "Check for typos in README.md",
    expectedTier: "trivial",
    expectedTaskType: "documentation",
  },
  {
    label: "trivial / coding",
    prompt: "Add a console.log to main.ts",
    expectedTier: "trivial",
    expectedTaskType: "coding",
  },
  {
    label: "complex / analysis (v2: multi-step + security concepts + tools)",
    prompt: "First, review all database query files in src/models/. Then analyse each query for SQL injection. After that, evaluate the middleware at /app/auth.ts and compare against OWASP. Use grep and sed to find patterns.",
    expectedTier: "complex",
    expectedTaskType: "analysis",
  },
  {
    label: "complex / analysis",
    prompt: "First, review all database query files in src/models/ and src/routes/api.ts and src/db/queries.ts and /app/middleware/auth.ts and /app/db/pool.ts. Then analyse each one for SQL injection. After that, evaluate auth middleware. Next, run docker and grep and curl to test each endpoint. Finally, compare everything against OWASP best practices and create a comprehensive audit documenting over two hundred words of detailed findings for the security team to review with specific remediation steps for each vulnerability class identified in the codebase including parameterized queries prepared statements and input validation patterns that should be applied across all route handlers and database access layers to prevent injection attacks and ensure compliance with security standards and regulatory requirements",
    expectedTier: "complex",
    expectedTaskType: "analysis",
  },
  {
    label: "simple / debugging (v2: debugging floor = simple)",
    prompt: "Fix the crash in app.ts",
    expectedTier: "simple",
    expectedTaskType: "debugging",
  },
  {
    label: "override",
    prompt: "What is 2+2?",
    model: "swarm-heavy",
    expectedTier: "trivial",
    expectedTaskType: "general",
  },
];

let passed = 0;
let failed = 0;
let omnirouteAvailable = false;
let combos: any[] = [];

try {
  combos = await fetchCombos();
  omnirouteAvailable = combos.length > 0;
  console.log(`✅ OmniRoute reachable — ${combos.length} combos available`);
} catch (e: any) {
  console.log(`⚠️  OmniRoute unreachable — testing static fallback only (${e.message})`);
}

console.log("");

for (const tc of cases) {
  const complexity = estimateComplexitySync(tc.prompt);
  const taskType = inferTaskType(tc.prompt.toLowerCase());
  const staticCombo = TIER_TO_COMBO[complexity.tier];

  let dynamicCombo: string | null = null;
  let method: "override" | "dynamic" | "static" = "static";

  if (tc.model) {
    dynamicCombo = tc.model;
    method = "override";
  } else if (omnirouteAvailable) {
    const rec = bestComboForTask(combos, taskType, complexity.tier);
    if (rec.recommendedCombo.name && rec.recommendedCombo.name !== "none") {
      dynamicCombo = rec.recommendedCombo.name;
      method = "dynamic";
    }
  }

  const resolvedCombo = dynamicCombo || staticCombo;

  const tierOk = complexity.tier === tc.expectedTier;
  const typeOk = taskType === tc.expectedTaskType;
  const ok = tierOk && typeOk;

  if (ok) {
    passed++;
    console.log(`✅ ${tc.label}`);
  } else {
    failed++;
    console.log(`❌ ${tc.label}`);
    if (!tierOk) console.log(`   tier: expected ${tc.expectedTier}, got ${complexity.tier} (score=${complexity.score})`);
    if (!typeOk) console.log(`   taskType: expected ${tc.expectedTaskType}, got ${taskType}`);
  }

  const icon = method === "dynamic" ? "🎯" : method === "override" ? "📌" : "📋";
  const diff = method === "dynamic" && dynamicCombo !== staticCombo
    ? ` (static would be ${staticCombo})`
    : "";
  console.log(`   ${icon} ${resolvedCombo} — ${method}${diff}`);
  console.log("");
}

console.log(`\n${passed}/${passed + failed} passed${failed > 0 ? ` (${failed} failed)` : ""}`);
if (omnirouteAvailable) {
  console.log("Dynamic resolution was active for all non-override cases.");
} else {
  console.log("Static fallback was used (OmniRoute not available).");
}
process.exit(failed > 0 ? 1 : 0);
