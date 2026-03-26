#!/usr/bin/env bun

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");
try {
  const envText = await Bun.file(envPath).text();
  for (const line of envText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export type ComplexityTier = "trivial" | "simple" | "moderate" | "complex";
export type TaskType = "coding" | "review" | "planning" | "analysis" | "debugging" | "documentation" | "general" | "data_science" | "devops" | "security" | "content";
export type ConstraintType = "budget" | "latency" | "quality" | "speed";
export type ConstraintValue = "low" | "medium" | "high";
export type ConstraintSource = "explicit" | "inferred" | "default";
export type ScopeModifier = "quick" | "thorough" | "experimental" | "production";

export interface ComplexitySignal {
  name: string;
  rawValue: number;
  normalizedScore: number;
  weight: number;
}

export interface ConstraintSpec {
  type: ConstraintType;
  value: ConstraintValue;
  source: ConstraintSource;
  priority: number;
}

export interface DomainPattern {
  domain: string;
  subdomain: string | null;
  techStack: string[];
  complexityModifier: number;
}

export interface SemanticMatch {
  taskType: TaskType;
  confidence: number;
  matchMethod: "keyword" | "synonym" | "contextual";
  evidenceTokens: string[];
}

export interface ComplexityEstimate {
  tier: ComplexityTier;
  score: number;
  signals: ComplexitySignal[];
  inferredTaskType: TaskType;
  semanticMatch: SemanticMatch;
  domainPattern: DomainPattern | null;
  constraints: ConstraintSpec[];
  scopeModifier: ScopeModifier | null;
  // Legacy fields for backward compat with old code
  _legacy?: {
    wordCount: number;
    fileCount: number;
    hasMultiStep: boolean;
    hasTool: boolean;
    hasAnalysis: boolean;
  };
}

export interface FeedbackEntry {
  id: string;
  timestamp: number;
  taskText: string;
  recommendedTier: ComplexityTier;
  recommendedCombo: string;
  actualTier?: ComplexityTier;
  correctedTier?: ComplexityTier;
  signals: ComplexitySignal[];
  outcome?: "success" | "failure" | "unknown";
}

export interface WeightConfig {
  version: number;
  lastUpdated: number;
  feedbackCount: number;
  weights: Record<string, number>;
  performance: {
    precision: Record<ComplexityTier, number>;
    recall: Record<ComplexityTier, number>;
    f1: Record<ComplexityTier, number>;
  };
}

interface ComboModel {
  provider: string;
  model: string;
  inputCostPer1M: number;
}

export interface OmniRouteRecommendation {
  recommendedCombo: { id: string; name: string; reason: string };
  alternatives: { id: string; name: string; tradeoff: string }[];
  freeAlternative: { id: string; name: string } | null;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const TIER_TO_COMBO: Record<ComplexityTier, string> = {
  trivial: "swarm-light",
  simple: "swarm-light",
  moderate: "swarm-mid",
  complex: "swarm-heavy",
};

export const TIER_CANDIDATES: Record<ComplexityTier, string[]> = {
  trivial: ["swarm-light"],
  simple: ["swarm-light", "swarm-mid"],
  moderate: ["swarm-light", "swarm-mid", "swarm-heavy"],
  complex: ["swarm-light", "swarm-mid", "swarm-heavy"],
};

// Maps executor IDs to their valid model identifiers for each tier
// Used by bridges to resolve SWARM_RESOLVED_MODEL to a valid executor-specific flag
export const EXECUTOR_MODEL_MAP: Record<string, Record<ComplexityTier, string>> = {
  "claude-code": {
    trivial: "haiku",
    simple: "haiku",
    moderate: "sonnet",
    complex: "opus",
  },
};

const TASK_FITNESS: Record<TaskType, { preferred: string[]; traits: string[] }> = {
  coding: { preferred: ["claude", "deepseek", "codex"], traits: ["fast", "code-optimized"] },
  review: { preferred: ["claude", "gemini", "openai"], traits: ["analytical", "thorough"] },
  planning: { preferred: ["gemini", "claude", "openai"], traits: ["reasoning", "structured"] },
  analysis: { preferred: ["gemini", "claude"], traits: ["deep-reasoning", "large-context"] },
  debugging: { preferred: ["claude", "deepseek", "codex"], traits: ["code-aware", "fast"] },
  documentation: { preferred: ["gemini", "claude", "openai"], traits: ["clear", "structured"] },
  general: { preferred: ["gemini", "openrouter"], traits: ["fast", "free", "light"] },
  data_science: { preferred: ["claude", "gemini"], traits: ["analytical", "code-aware"] },
  devops: { preferred: ["claude", "deepseek"], traits: ["infrastructure-aware", "fast"] },
  security: { preferred: ["claude", "gemini"], traits: ["thorough", "analytical"] },
  content: { preferred: ["gemini", "openai"], traits: ["creative", "structured"] },
};

const OMNIROUTE_BASE_URL = process.env.OMNIROUTE_BASE_URL || "http://localhost:20128";
const OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY || "";
const OMNIROUTE_COOKIE = process.env.OMNIROUTE_COOKIE || "";

const DATA_DIR = resolve(__dirname, "../data");
const FEEDBACK_FILE = resolve(DATA_DIR, "feedback.jsonl");
const WEIGHTS_FILE = resolve(DATA_DIR, "weights.json");

// ============================================================================
// SEMANTIC DICTIONARIES (Keyword Expansion)
// ============================================================================

const TASK_TYPE_KEYWORDS: Record<TaskType, string[]> = {
  debugging: ["debug", "bug", "error", "crash", "broken", "stacktrace", "exception", "failure", "troubleshoot", "diagnose", "memory leak", "race condition", "deadlock"],
  analysis: ["analyze", "analyse", "assess", "evaluate", "audit", "investigate", "research", "compare", "examine", "inspect", "study", "explore", "benchmark", "measure", "profile"],
  review: ["review", "pr", "pull request", "code review", "diff", "feedback", "critique", "assess code", "examine code"],
  planning: ["plan", "design", "architect", "roadmap", "strategy", "outline", "proposal", "rfc", "spec", "blueprint", "scheme"],
  documentation: ["document", "readme", "docs", "write up", "explain", "tutorial", "guide", "manual", "howto", "walkthrough"],
  coding: ["implement", "build", "create", "write", "code", "develop", "add", "refactor", "migrate", "deploy", "construct", "program"],
  data_science: ["model", "train", "dataset", "ml", "machine learning", "ai", "neural", "pandas", "numpy", "scikit", "tensorflow", "pytorch", "data analysis", "predict", "classification", "regression"],
  devops: ["deploy", "ci", "cd", "pipeline", "docker", "kubernetes", "k8s", "terraform", "ansible", "jenkins", "github actions", "infrastructure", "provision", "orchestrate"],
  security: ["security", "vulnerability", "cve", "exploit", "penetration", "compliance", "gdpr", "hipaa", "pci", "sox", "encryption", "owasp", "xss", "sql injection", "gdpr compliance", "security audit", "penetration testing"],
  content: ["write", "blog", "article", "post", "copy", "content", "marketing", "seo", "draft", "compose"],
  general: [],
};

const TECH_STACK_PATTERNS: Record<string, RegExp> = {
  react: /\b(react|jsx|tsx|next\.?js)\b/i,
  vue: /\b(vue|vuex|nuxt)\b/i,
  angular: /\b(angular|ng)\b/i,
  node: /\b(node\.?js|express|fastify|koa)\b/i,
  python: /\b(python|django|flask|fastapi)\b/i,
  docker: /\b(docker|container|dockerfile)\b/i,
  kubernetes: /\b(k8s|kubernetes|kubectl|helm)\b/i,
  terraform: /\b(terraform|tf|hcl)\b/i,
  aws: /\b(aws|ec2|s3|lambda|cloudfront)\b/i,
  gcp: /\b(gcp|google cloud|bigquery)\b/i,
  azure: /\b(azure|azuread)\b/i,
  postgres: /\b(postgres|postgresql|pg)\b/i,
  mongodb: /\b(mongo|mongodb)\b/i,
  redis: /\b(redis|cache)\b/i,
  graphql: /\b(graphql|gql)\b/i,
  grpc: /\b(grpc|protobuf)\b/i,
  // NEW: Security/Auth patterns
  oauth: /\b(oauth|oauth2|openid|oidc)\b/i,
  jwt: /\b(jwt|json web token)\b/i,
  auth: /\b(authentication|authorization|mfa|2fa|totp|saml|sso)\b/i,
  security: /\b(security|encrypt|decrypt|vulnerability|penetration|xss|csrf|injection)\b/i,
};

const SCOPE_MODIFIER_PATTERNS: Record<ScopeModifier, RegExp> = {
  quick: /\b(quick|fast|rapid|asap|urgent|immediate|briefly)\b/i,
  thorough: /\b(thorough|comprehensive|complete|detailed|exhaustive|in-depth|careful)\b/i,
  experimental: /\b(experiment|prototype|poc|proof of concept|spike|explore|try)\b/i,
  production: /\b(production|prod|live|deploy|release|ship)\b/i,
};

const CONSTRAINT_PATTERNS: Record<ConstraintType, Record<ConstraintValue, RegExp>> = {
  budget: {
    low: /\b(cheap|free|low cost|budget|economical|inexpensive|minimal cost)\b/i,
    medium: /\b(reasonable cost|moderate budget|standard pricing)\b/i,
    high: /\b(premium|expensive|high cost|no budget limit|unlimited budget)\b/i,
  },
  latency: {
    low: /\b(fast|quick|immediate|instant|low latency|responsive)\b/i,
    medium: /\b(normal speed|moderate latency|reasonable time)\b/i,
    high: /\b(slow|batch|background|can wait|high latency ok)\b/i,
  },
  quality: {
    low: /\b(draft|rough|quick pass|good enough|acceptable)\b/i,
    medium: /\b(standard quality|production ready|professional)\b/i,
    high: /\b(perfect|flawless|highest quality|thorough|comprehensive)\b/i,
  },
  speed: {
    low: /\b(slow|careful|methodical|deliberate)\b/i,
    medium: /\b(normal pace|standard speed)\b/i,
    high: /\b(fast|quick|rapid|urgent|asap|immediate)\b/i,
  },
};

// ============================================================================
// WEIGHT MANAGEMENT
// ============================================================================

let cachedWeights: WeightConfig | null = null;

async function loadWeights(): Promise<WeightConfig> {
  if (cachedWeights) return cachedWeights;
  
  try {
    const file = Bun.file(WEIGHTS_FILE);
    if (await file.exists()) {
      cachedWeights = await file.json();
      return cachedWeights!;
    }
  } catch {}
  
  // Default weights (all equal to start)
  const defaultWeights: WeightConfig = {
    version: 1,
    lastUpdated: Date.now(),
    feedbackCount: 0,
    weights: {
      wordCount: 0.04,
      fileRefs: 0.02,
      multiStep: 0.10,
      toolUsage: 0.04,
      analysisDepth: 0.08,
      domainComplexity: 0.10,
      techStackDepth: 0.10,
      conceptCount: 0.20,
      taskVerbComplexity: 0.10,
      scopeBreadth: 0.12,
      featureListCount: 0.20,
    },
    performance: {
      precision: { trivial: 0, simple: 0, moderate: 0, complex: 0 },
      recall: { trivial: 0, simple: 0, moderate: 0, complex: 0 },
      f1: { trivial: 0, simple: 0, moderate: 0, complex: 0 },
    },
  };
  
  cachedWeights = defaultWeights;
  await saveWeights(defaultWeights);
  return defaultWeights;
}

async function saveWeights(weights: WeightConfig): Promise<void> {
  await Bun.write(WEIGHTS_FILE, JSON.stringify(weights, null, 2));
  cachedWeights = weights;
}

// ============================================================================
// SIGNAL COMPUTATION
// ============================================================================

function normalizeLinear(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

function normalizeLog(value: number, base: number = 10): number {
  if (value <= 1) return 0;
  return Math.min(1, Math.log(value) / Math.log(base));
}

async function computeSignals(text: string, weights: WeightConfig): Promise<ComplexitySignal[]> {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const fileRefs = (lower.match(/\/[\w\-./ ]+\.\w+/g) || []).length;
  
  // Multi-step detection with enhanced patterns
  const stepMarkers = (lower.match(/\b(then|after|next|step \d+|finally|first|second|third|fourth|fifth)\b/g) || []).length;
  const numberedSteps = (lower.match(/\d+\.\s/g) || []).length;
  // Better comma list detection — count items separated by commas/and
  const commaItems = (lower.match(/,\s*(?:and\s+)?/g) || []).length;
  const sentences = text.match(/\.\s+[A-Z]/g)?.length || 0;
  const multiStepIntensity = stepMarkers + numberedSteps + commaItems + sentences;
  
  // Tool usage depth
  const tools = lower.match(/\b(git|npm|bun|pip|curl|sed|grep|awk|mkdir|chmod|docker|kubectl|terraform|ansible|webpack|vite|jest|pytest|make|cmake)\b/g) || [];
  const toolUsageDepth = tools.length;
  
  // Analysis depth — expanded keyword set
  const analysisKeywords = lower.match(/\b(analy[zs]e|assess|evaluate|audit|investigate|research|compare|examine|inspect|suggest|optimize|recommend|improve|bottleneck|performance|diagnose|troubleshoot|review|measure)\b/g) || [];
  const analysisDepth = analysisKeywords.length;
  
  // NEW: Concept count — distinct technical concepts/components mentioned
  const conceptPatterns = lower.match(/\b(api|gateway|service|mesh|auth|authentication|authorization|oauth|jwt|token|database|cache|queue|worker|scheduler|load.?balancer|proxy|middleware|controller|model|view|schema|migration|endpoint|webhook|socket|websocket|stream|pipeline|microservice|monolith|container|cluster|node|pod|replica|deployment|ingress|certificate|ssl|tls|encryption|hashing|session|cookie|cors|csrf|rate.?limit|throttl|pagination|search|index|shard|backup|restore|monitor|alert|log|metric|trace|dashboard|chart|graph|notification|email|sms|push|cron|job|task|event|message|pub.?sub|kafka|rabbit|redis|memcache|cdn|dns|domain|route|network|firewall|vpc|subnet|security.?group|iam|role|policy|permission|mfa|2fa|totp|saml|sso|ldap|refresh|rotation|testing|unit.?test|integration.?test|e2e|ci|cd|pipeline|build|deploy|release|rollback|canary|blue.?green|feature.?flag|a.?b.?test|compliance|gdpr|hipaa|pci|workflow|codebase|real.?time|chat|presence|persistence|receipt|inventory|payment|order|admin|visualization|report|landing.?page|form|contact|navigation|prototype|poc|neural|dataset|training|inference|prometheus|grafana|terraform|helm|ingress|typescript|javascript|react|angular|vue|fastapi|django|flask|express)\b/g) || [];
  const uniqueConcepts = new Set(conceptPatterns);
  const conceptCount = uniqueConcepts.size;
  
  // NEW: Task verb complexity — count distinct action verbs
  const actionVerbs = lower.match(/\b(implement|build|create|write|develop|design|architect|plan|deploy|test|debug|fix|refactor|migrate|optimize|analyze|review|audit|configure|setup|install|integrate|automate|monitor|scale|secure|document|benchmark|profile|validate|verify)\b/g) || [];
  const uniqueVerbs = new Set(actionVerbs);
  const taskVerbComplexity = uniqueVerbs.size;
  
  // NEW: Scope breadth — broad scope vs narrow scope
  const broadScope = (lower.match(/\b(entire|full|comprehensive|all|system|platform|architecture|infrastructure|end.?to.?end|cross.?cutting|enterprise|organization|codebase|stack|ecosystem|framework|suite|pipeline|across|every|workflow)\b/g) || []).length;
  const narrowScope = (lower.match(/\b(function|method|button|field|typo|variable|parameter|class|component|element|line|column|property|attribute|simple|single|one|quick|small|minor|tiny)\b/g) || []).length;
  const scopeScore = Math.max(0, broadScope - narrowScope);

  // NEW: Feature enumeration — count distinct deliverables in "X with A, B, C, and D" patterns
  // This captures prompts that list multiple features/requirements
  const commaAndItems = lower.split(/,\s*(?:and\s+)?|(?:\band\b)/).length;
  const featureListCount = Math.max(0, commaAndItems - 1); // number of separators = items - 1

  return [
    {
      name: "wordCount",
      rawValue: wordCount,
      normalizedScore: normalizeLinear(wordCount, 5, 80),
      weight: weights.weights.wordCount || 0.05,
    },
    {
      name: "fileRefs",
      rawValue: fileRefs,
      normalizedScore: normalizeLog(fileRefs, 5),
      weight: weights.weights.fileRefs || 0.03,
    },
    {
      name: "multiStep",
      rawValue: multiStepIntensity,
      normalizedScore: normalizeLinear(multiStepIntensity, 0, 6),
      weight: weights.weights.multiStep || 0.12,
    },
    {
      name: "toolUsage",
      rawValue: toolUsageDepth,
      normalizedScore: normalizeLog(toolUsageDepth, 5),
      weight: weights.weights.toolUsage || 0.05,
    },
    {
      name: "analysisDepth",
      rawValue: analysisDepth,
      normalizedScore: normalizeLinear(analysisDepth, 0, 3),
      weight: weights.weights.analysisDepth || 0.10,
    },
    {
      name: "conceptCount",
      rawValue: conceptCount,
      normalizedScore: normalizeLinear(conceptCount, 0, 6),
      weight: weights.weights.conceptCount || 0.25,
    },
    {
      name: "taskVerbComplexity",
      rawValue: taskVerbComplexity,
      normalizedScore: normalizeLinear(taskVerbComplexity, 0, 4),
      weight: weights.weights.taskVerbComplexity || 0.20,
    },
    {
      name: "scopeBreadth",
      rawValue: scopeScore,
      normalizedScore: normalizeLinear(scopeScore, 0, 3),
      weight: weights.weights.scopeBreadth || 0.12,
    },
    {
      name: "featureListCount",
      rawValue: featureListCount,
      normalizedScore: normalizeLinear(featureListCount, 0, 4),
      weight: weights.weights.featureListCount || 0.20,
    },
  ];
}

// ============================================================================
// DOMAIN & TECH STACK DETECTION
// ============================================================================

function detectDomainPattern(text: string, taskType: TaskType): DomainPattern | null {
  const lower = text.toLowerCase();
  const detectedTech: string[] = [];
  
  for (const [tech, pattern] of Object.entries(TECH_STACK_PATTERNS)) {
    if (pattern.test(lower)) {
      detectedTech.push(tech);
    }
  }
  
  let domain = taskType;
  let subdomain: string | null = null;
  let complexityModifier = 1.0;
  
  // Subdomain detection for coding
  if (taskType === "coding") {
    if (/\b(frontend|ui|ux|component|view|client|spa)\b/i.test(lower)) {
      subdomain = "frontend";
      complexityModifier = 1.1;
    } else if (/\b(backend|api|server|database|db|endpoint)\b/i.test(lower)) {
      subdomain = "backend";
      complexityModifier = 1.2;
    } else if (/\b(infrastructure|infra|devops|deploy|ci|cd|pipeline)\b/i.test(lower)) {
      subdomain = "infrastructure";
      complexityModifier = 1.3;
    } else if (/\b(auth|security|encrypt|vulnerability|login|signup)\b/i.test(lower)) {
      subdomain = "security";
      complexityModifier = 1.4;
    }
  }
  
  // Tech stack complexity modifiers
  if (detectedTech.includes("kubernetes") || detectedTech.includes("terraform")) {
    complexityModifier *= 1.3;
  }
  if (detectedTech.includes("pytorch") || detectedTech.includes("tensorflow")) {
    complexityModifier *= 1.2;
  }
  if (detectedTech.includes("oauth") || detectedTech.includes("jwt") || detectedTech.includes("auth")) {
    complexityModifier *= 1.2;
  }
  
  // Baseline complexity for non-trivial task types (even without tech stack)
  if (!subdomain && detectedTech.length === 0) {
    if (taskType === "planning" || taskType === "analysis") {
      complexityModifier = 1.1; // Inherent complexity for strategic work
    }
    if (taskType === "security" || taskType === "devops" || taskType === "data_science") {
      complexityModifier = 1.2; // Higher baseline for specialized domains
    }
  }
  
  // Always return a pattern for non-general tasks, even without explicit tech detection
  if (detectedTech.length === 0 && !subdomain && taskType === "general") return null;
  
  return {
    domain,
    subdomain,
    techStack: detectedTech,
    complexityModifier,
  };
}

// ============================================================================
// SEMANTIC TASK INFERENCE
// ============================================================================

function computeStringSimilarity(a: string, b: string): number {
  // Simple character n-gram cosine similarity (no external libs)
  const ngrams = (s: string, n: number = 3): Set<string> => {
    const grams = new Set<string>();
    for (let i = 0; i <= s.length - n; i++) {
      grams.add(s.slice(i, i + n));
    }
    return grams;
  };
  
  const gramsA = ngrams(a.toLowerCase());
  const gramsB = ngrams(b.toLowerCase());
  
  const intersection = new Set([...gramsA].filter(x => gramsB.has(x)));
  const union = new Set([...gramsA, ...gramsB]);
  
  return union.size > 0 ? intersection.size / union.size : 0;
}

function inferTaskTypeSemantic(text: string): SemanticMatch {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  
  let bestMatch: SemanticMatch = {
    taskType: "general",
    confidence: 0,
    matchMethod: "keyword",
    evidenceTokens: [],
  };
  
  for (const [taskType, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    if (taskType === "general") continue;
    
    // Keyword matching — specialized types get a tiebreaker bonus when 2+ keywords match
    const keywordMatches = keywords.filter(kw => lower.includes(kw));
    if (keywordMatches.length > 0) {
      const SPECIALIZATION_BONUS: Partial<Record<string, number>> = {
        security: 0.05, data_science: 0.05, devops: 0.05, analysis: 0.02, planning: 0.02,
      };
      const bonus = keywordMatches.length >= 2 ? (SPECIALIZATION_BONUS[taskType] || 0) : 0;
      const confidence = Math.min(1.0, keywordMatches.length * 0.3 + bonus);
      if (confidence > bestMatch.confidence) {
        bestMatch = {
          taskType: taskType as TaskType,
          confidence,
          matchMethod: "keyword",
          evidenceTokens: keywordMatches,
        };
      }
    }
    
    // Shallow semantic (synonym matching via string similarity)
    for (const word of words) {
      for (const keyword of keywords) {
        const similarity = computeStringSimilarity(word, keyword);
        if (similarity > 0.7) {
          const confidence = Math.min(1.0, similarity * 0.5);
          if (confidence > bestMatch.confidence) {
            bestMatch = {
              taskType: taskType as TaskType,
              confidence,
              matchMethod: "synonym",
              evidenceTokens: [word, keyword],
            };
          }
        }
      }
    }
  }
  
  // Contextual semantic (multi-word combinations)
  for (const [taskType, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    if (taskType === "general") continue;
    
    for (const keyword of keywords) {
      if (keyword.includes(" ")) {
        // Multi-word keyword
        if (lower.includes(keyword)) {
          const confidence = 0.9; // High confidence for phrase matches
          if (confidence > bestMatch.confidence) {
            bestMatch = {
              taskType: taskType as TaskType,
              confidence,
              matchMethod: "contextual",
              evidenceTokens: [keyword],
            };
          }
        }
      }
    }
  }
  
  return bestMatch;
}

// ============================================================================
// CONSTRAINT DETECTION
// ============================================================================

function detectConstraints(text: string, cliConstraints?: Partial<Record<ConstraintType, ConstraintValue>>): ConstraintSpec[] {
  const constraints: ConstraintSpec[] = [];
  
  // Explicit constraints from CLI (highest priority)
  if (cliConstraints) {
    let priority = 100;
    for (const [type, value] of Object.entries(cliConstraints)) {
      constraints.push({
        type: type as ConstraintType,
        value: value as ConstraintValue,
        source: "explicit",
        priority: priority--,
      });
    }
  }
  
  // Inferred constraints from text (medium priority)
  const lower = text.toLowerCase();
  let priority = 50;
  for (const [type, valuePatterns] of Object.entries(CONSTRAINT_PATTERNS)) {
    for (const [value, pattern] of Object.entries(valuePatterns)) {
      if (pattern.test(lower)) {
        constraints.push({
          type: type as ConstraintType,
          value: value as ConstraintValue,
          source: "inferred",
          priority: priority--,
        });
        break; // Only take first match per type
      }
    }
  }
  
  // Default constraints (lowest priority)
  const defaultTypes: ConstraintType[] = ["budget", "latency", "quality", "speed"];
  const existingTypes = new Set(constraints.map(c => c.type));
  priority = 10;
  for (const type of defaultTypes) {
    if (!existingTypes.has(type)) {
      constraints.push({
        type,
        value: "medium",
        source: "default",
        priority: priority--,
      });
    }
  }
  
  return constraints.sort((a, b) => b.priority - a.priority);
}

function detectScopeModifier(text: string): ScopeModifier | null {
  for (const [modifier, pattern] of Object.entries(SCOPE_MODIFIER_PATTERNS)) {
    if (pattern.test(text)) {
      return modifier as ScopeModifier;
    }
  }
  return null;
}

// ============================================================================
// TIER CALCULATION
// ============================================================================

function calculateTier(
  signals: ComplexitySignal[],
  domainPattern: DomainPattern | null,
  constraints: ConstraintSpec[],
  scopeModifier: ScopeModifier | null,
  taskType: TaskType = "general",
): { tier: ComplexityTier; score: number } {
  // Weighted sum of normalized signals
  let weightedScore = 0;
  for (const signal of signals) {
    weightedScore += signal.normalizedScore * signal.weight;
  }

  // Apply domain complexity modifier (ADDITIVE, not multiplicative)
  if (domainPattern) {
    const domainAdjustment = (domainPattern.complexityModifier - 1.0) * 0.2; // Map 0.8-1.5 to -0.04 to +0.10
    weightedScore += domainAdjustment;
  }

  // Apply scope modifier (ADDITIVE)
  if (scopeModifier) {
    if (scopeModifier === "quick") weightedScore -= 0.15; // Reduce complexity
    if (scopeModifier === "thorough") weightedScore += 0.15; // Increase complexity
    if (scopeModifier === "experimental") weightedScore -= 0.10; // Slightly reduce
    if (scopeModifier === "production") weightedScore += 0.10; // Slightly increase
  }

  // Apply constraint adjustments (ADDITIVE)
  for (const constraint of constraints) {
    if (constraint.type === "budget" && constraint.value === "low") {
      weightedScore -= 0.10; // Prefer lighter tier
    }
    if (constraint.type === "speed" && constraint.value === "high") {
      weightedScore -= 0.12; // Prefer faster/lighter tier
    }
    if (constraint.type === "quality" && constraint.value === "high") {
      weightedScore += 0.12; // Prefer heavier tier
    }
  }

  // Clamp score to [0, 1]
  weightedScore = Math.max(0, Math.min(1, weightedScore));

  // Map to tier with calibrated thresholds
  let tier: ComplexityTier;
  if (weightedScore < 0.08) tier = "trivial";
  else if (weightedScore < 0.20) tier = "simple";
  else if (weightedScore < 0.40) tier = "moderate";
  else tier = "complex";

  // Task-type complexity floor: certain domains are inherently non-trivial
  // These can be overridden by scope modifiers (quick/experimental → allow lower)
  if (scopeModifier !== "quick" && scopeModifier !== "experimental") {
    const TIER_ORDER: Record<ComplexityTier, number> = { trivial: 0, simple: 1, moderate: 2, complex: 3 };
    const FLOOR_MAP: Partial<Record<TaskType, ComplexityTier>> = {
      security: "moderate",
      devops: "moderate",
      data_science: "moderate",
      debugging: "simple",
      planning: "simple",
      analysis: "moderate",
    };
    const floor = FLOOR_MAP[taskType];
    if (floor && TIER_ORDER[tier] < TIER_ORDER[floor]) {
      tier = floor;
    }
  }

  return { tier, score: weightedScore };
}

// ============================================================================
// MAIN COMPLEXITY ESTIMATION
// ============================================================================

export async function estimateComplexity(
  text: string,
  options?: {
    budget?: ConstraintValue;
    latency?: ConstraintValue;
    quality?: ConstraintValue;
    speed?: ConstraintValue;
  }
): Promise<ComplexityEstimate> {
  const weights = await loadWeights();
  return _estimateCore(text, weights, options);
}

// ============================================================================
// SYNC API — for callers that can't use async (e.g., orchestrator routing)
// Uses default weights (no disk read). If async estimateComplexity has been
// called previously, uses the cached weights instead.
// ============================================================================

const DEFAULT_WEIGHTS: WeightConfig = {
  version: 1,
  lastUpdated: 0,
  feedbackCount: 0,
  weights: {
    wordCount: 0.04,
    fileRefs: 0.02,
    multiStep: 0.10,
    toolUsage: 0.04,
    analysisDepth: 0.08,
    domainComplexity: 0.10,
    techStackDepth: 0.10,
    conceptCount: 0.20,
    taskVerbComplexity: 0.10,
    scopeBreadth: 0.12,
    featureListCount: 0.20,
  },
  performance: {
    precision: { trivial: 0, simple: 0, moderate: 0, complex: 0 },
    recall: { trivial: 0, simple: 0, moderate: 0, complex: 0 },
    f1: { trivial: 0, simple: 0, moderate: 0, complex: 0 },
  },
};

export function estimateComplexitySync(text: string): ComplexityEstimate {
  const weights = cachedWeights || DEFAULT_WEIGHTS;
  return _estimateCore(text, weights);
}

/** Backward-compat: standalone task type inference from text */
export function inferTaskType(text: string): TaskType {
  return inferTaskTypeSemantic(text.toLowerCase()).taskType;
}

function _estimateCore(
  text: string,
  weights: WeightConfig,
  options?: {
    budget?: ConstraintValue;
    latency?: ConstraintValue;
    quality?: ConstraintValue;
    speed?: ConstraintValue;
  },
): ComplexityEstimate {
  const signals = computeSignalsSync(text, weights);

  const semanticMatch = inferTaskTypeSemantic(text);
  const domainPattern = detectDomainPattern(text, semanticMatch.taskType);

  const cliConstraints: Partial<Record<ConstraintType, ConstraintValue>> = {};
  if (options?.budget) cliConstraints.budget = options.budget;
  if (options?.latency) cliConstraints.latency = options.latency;
  if (options?.quality) cliConstraints.quality = options.quality;
  if (options?.speed) cliConstraints.speed = options.speed;

  const constraints = detectConstraints(text, cliConstraints);
  const scopeModifier = detectScopeModifier(text);

  // Add domain/tech signals
  if (domainPattern && domainPattern.techStack.length > 0) {
    signals.push({
      name: "domainComplexity",
      rawValue: domainPattern.complexityModifier,
      normalizedScore: Math.min(1, (domainPattern.complexityModifier - 0.8) / 0.7),
      weight: weights.weights.domainComplexity || 0.10,
    });
    signals.push({
      name: "techStackDepth",
      rawValue: domainPattern.techStack.length,
      normalizedScore: normalizeLog(domainPattern.techStack.length, 5),
      weight: weights.weights.techStackDepth || 0.10,
    });
  }

  // Heuristic pattern boosters
  const lower = text.toLowerCase();
  let heuristicBoost = 0;

  if (/\b(refactor|migrate|rewrite|overhaul|convert)\b/i.test(lower) &&
      /\b(codebase|entire|all|whole|system|project|application|app)\b/i.test(lower)) {
    heuristicBoost += 0.25;
  }
  if (/\b(compliance|gdpr|hipaa|pci|sox|audit)\b/i.test(lower) &&
      /\b(across|all|entire|every|system|workflow|codebase|platform)\b/i.test(lower)) {
    heuristicBoost += 0.20;
  }
  if (/\bproduction[\s-]?ready\b/i.test(lower)) {
    heuristicBoost += 0.10;
  }
  if (/\b(memory leak|race condition|deadlock|concurrency|heap|segfault|stack overflow|bottleneck)\b/i.test(lower) &&
      /\b(debug|fix|investigate|diagnose|troubleshoot)\b/i.test(lower)) {
    heuristicBoost += 0.15;
  }
  if (/\b(train|neural|model|ml|machine learning)\b/i.test(lower) &&
      /\b(deploy|fastapi|flask|api|serve|production|inference)\b/i.test(lower)) {
    heuristicBoost += 0.15;
  }

  if (heuristicBoost > 0) {
    signals.push({
      name: "heuristicBoost",
      rawValue: heuristicBoost,
      normalizedScore: Math.min(1, heuristicBoost),
      weight: 1.0,
    });
  }

  const { tier, score } = calculateTier(signals, domainPattern, constraints, scopeModifier, semanticMatch.taskType);

  const wordCountSignal = signals.find(s => s.name === "wordCount");
  const fileRefsSignal = signals.find(s => s.name === "fileRefs");
  const multiStepSignal = signals.find(s => s.name === "multiStep");
  const toolSignal = signals.find(s => s.name === "toolUsage");
  const analysisSignal = signals.find(s => s.name === "analysisDepth");

  return {
    tier,
    score,
    signals,
    inferredTaskType: semanticMatch.taskType,
    semanticMatch,
    domainPattern,
    constraints,
    scopeModifier,
    _legacy: {
      wordCount: wordCountSignal?.rawValue || 0,
      fileCount: fileRefsSignal?.rawValue || 0,
      hasMultiStep: (multiStepSignal?.rawValue || 0) > 0,
      hasTool: (toolSignal?.rawValue || 0) > 0,
      hasAnalysis: (analysisSignal?.rawValue || 0) > 0,
    },
  };
}

// Sync version of computeSignals (identical logic, no await)
function computeSignalsSync(text: string, weights: WeightConfig): ComplexitySignal[] {
  // Delegate to computeSignals — it's already sync in practice (no actual awaits inside)
  // The async keyword on computeSignals is vestigial; the function body is pure sync.
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const fileRefs = (lower.match(/\/[\w\-./ ]+\.\w+/g) || []).length;
  const stepMarkers = (lower.match(/\b(then|after|next|step \d+|finally|first|second|third|fourth|fifth)\b/g) || []).length;
  const numberedSteps = (lower.match(/\d+\.\s/g) || []).length;
  const commaItems = (lower.match(/,\s*(?:and\s+)?/g) || []).length;
  const sentences = text.match(/\.\s+[A-Z]/g)?.length || 0;
  const multiStepIntensity = stepMarkers + numberedSteps + commaItems + sentences;
  const tools = lower.match(/\b(git|npm|bun|pip|curl|sed|grep|awk|mkdir|chmod|docker|kubectl|terraform|ansible|webpack|vite|jest|pytest|make|cmake)\b/g) || [];
  const toolUsageDepth = tools.length;
  const analysisKeywords = lower.match(/\b(analy[zs]e|assess|evaluate|audit|investigate|research|compare|examine|inspect|suggest|optimize|recommend|improve|bottleneck|performance|diagnose|troubleshoot|review|measure)\b/g) || [];
  const analysisDepth = analysisKeywords.length;
  const conceptPatterns = lower.match(/\b(api|gateway|service|mesh|auth|authentication|authorization|oauth|jwt|token|database|cache|queue|worker|scheduler|load.?balancer|proxy|middleware|controller|model|view|schema|migration|endpoint|webhook|socket|websocket|stream|pipeline|microservice|monolith|container|cluster|node|pod|replica|deployment|ingress|certificate|ssl|tls|encryption|hashing|session|cookie|cors|csrf|rate.?limit|throttl|pagination|search|index|shard|backup|restore|monitor|alert|log|metric|trace|dashboard|chart|graph|notification|email|sms|push|cron|job|task|event|message|pub.?sub|kafka|rabbit|redis|memcache|cdn|dns|domain|route|network|firewall|vpc|subnet|security.?group|iam|role|policy|permission|mfa|2fa|totp|saml|sso|ldap|refresh|rotation|testing|unit.?test|integration.?test|e2e|ci|cd|pipeline|build|deploy|release|rollback|canary|blue.?green|feature.?flag|a.?b.?test|compliance|gdpr|hipaa|pci|workflow|codebase|real.?time|chat|presence|persistence|receipt|inventory|payment|order|admin|visualization|report|landing.?page|form|contact|navigation|prototype|poc|neural|dataset|training|inference|prometheus|grafana|terraform|helm|ingress|typescript|javascript|react|angular|vue|fastapi|django|flask|express)\b/g) || [];
  const uniqueConcepts = new Set(conceptPatterns);
  const conceptCount = uniqueConcepts.size;
  const actionVerbs = lower.match(/\b(implement|build|create|write|develop|design|architect|plan|deploy|test|debug|fix|refactor|migrate|optimize|analyze|review|audit|configure|setup|install|integrate|automate|monitor|scale|secure|document|benchmark|profile|validate|verify)\b/g) || [];
  const uniqueVerbs = new Set(actionVerbs);
  const taskVerbComplexity = uniqueVerbs.size;
  const broadScope = (lower.match(/\b(entire|full|comprehensive|all|system|platform|architecture|infrastructure|end.?to.?end|cross.?cutting|enterprise|organization|codebase|stack|ecosystem|framework|suite|pipeline|across|every|workflow)\b/g) || []).length;
  const narrowScope = (lower.match(/\b(function|method|button|field|typo|variable|parameter|class|component|element|line|column|property|attribute|simple|single|one|quick|small|minor|tiny)\b/g) || []).length;
  const scopeScore = Math.max(0, broadScope - narrowScope);
  const commaAndItems = lower.split(/,\s*(?:and\s+)?|(?:\band\b)/).length;
  const featureListCount = Math.max(0, commaAndItems - 1);

  return [
    { name: "wordCount", rawValue: wordCount, normalizedScore: normalizeLinear(wordCount, 5, 80), weight: weights.weights.wordCount || 0.04 },
    { name: "fileRefs", rawValue: fileRefs, normalizedScore: normalizeLog(fileRefs, 5), weight: weights.weights.fileRefs || 0.02 },
    { name: "multiStep", rawValue: multiStepIntensity, normalizedScore: normalizeLinear(multiStepIntensity, 0, 6), weight: weights.weights.multiStep || 0.10 },
    { name: "toolUsage", rawValue: toolUsageDepth, normalizedScore: normalizeLog(toolUsageDepth, 5), weight: weights.weights.toolUsage || 0.04 },
    { name: "analysisDepth", rawValue: analysisDepth, normalizedScore: normalizeLinear(analysisDepth, 0, 3), weight: weights.weights.analysisDepth || 0.08 },
    { name: "conceptCount", rawValue: conceptCount, normalizedScore: normalizeLinear(conceptCount, 0, 6), weight: weights.weights.conceptCount || 0.20 },
    { name: "taskVerbComplexity", rawValue: taskVerbComplexity, normalizedScore: normalizeLinear(taskVerbComplexity, 0, 4), weight: weights.weights.taskVerbComplexity || 0.10 },
    { name: "scopeBreadth", rawValue: scopeScore, normalizedScore: normalizeLinear(scopeScore, 0, 3), weight: weights.weights.scopeBreadth || 0.12 },
    { name: "featureListCount", rawValue: featureListCount, normalizedScore: normalizeLinear(featureListCount, 0, 4), weight: weights.weights.featureListCount || 0.20 },
  ];
}

// ============================================================================
// FEEDBACK SYSTEM
// ============================================================================

async function logFeedback(entry: FeedbackEntry): Promise<void> {
  await Bun.write(FEEDBACK_FILE, JSON.stringify(entry) + "\n", { createPath: true, append: true });
}

async function loadFeedback(): Promise<FeedbackEntry[]> {
  try {
    const file = Bun.file(FEEDBACK_FILE);
    if (!(await file.exists())) return [];
    
    const text = await file.text();
    return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function submitCorrection(taskId: string, correctedTier: ComplexityTier): Promise<void> {
  const feedback = await loadFeedback();
  const entry = feedback.find(f => f.id === taskId);
  
  if (!entry) {
    throw new Error(`Feedback entry ${taskId} not found`);
  }
  
  entry.correctedTier = correctedTier;
  entry.outcome = entry.recommendedTier === correctedTier ? "success" : "failure";
  
  // Rewrite file
  const lines = feedback.map(f => JSON.stringify(f)).join("\n") + "\n";
  await Bun.write(FEEDBACK_FILE, lines);
  
  console.log(`✓ Correction recorded: ${taskId} → ${correctedTier}`);
}

async function autoTuneWeights(): Promise<void> {
  const feedback = await loadFeedback();
  const corrected = feedback.filter(f => f.correctedTier);
  
  if (corrected.length < 5) {
    console.log(`⚠ Need at least 5 corrections to auto-tune (have ${corrected.length})`);
    return;
  }
  
  console.log(`🔧 Auto-tuning weights from ${corrected.length} corrections...`);
  
  // Simple gradient-free optimization: grid search over weight adjustments
  const weights = await loadWeights();
  const signalNames = Object.keys(weights.weights);
  
  let bestAccuracy = 0;
  let bestWeights = { ...weights.weights };
  
  // Try small adjustments to each weight
  for (const signalName of signalNames) {
    for (const delta of [-0.02, -0.01, 0.01, 0.02]) {
      const testWeights = { ...weights.weights };
      testWeights[signalName] += delta;
      
      // Normalize weights to sum to 1.0
      const sum = Object.values(testWeights).reduce((a, b) => a + b, 0);
      for (const key of Object.keys(testWeights)) {
        testWeights[key] /= sum;
      }
      
      // Evaluate accuracy
      let correct = 0;
      for (const entry of corrected) {
        // Recalculate tier with test weights
        let score = 0;
        for (const signal of entry.signals) {
          score += signal.normalizedScore * (testWeights[signal.name] || 0);
        }
        
        let tier: ComplexityTier;
        if (score < 0.25) tier = "trivial";
        else if (score < 0.5) tier = "simple";
        else if (score < 0.75) tier = "moderate";
        else tier = "complex";
        
        if (tier === entry.correctedTier) correct++;
      }
      
      const accuracy = correct / corrected.length;
      if (accuracy > bestAccuracy) {
        bestAccuracy = accuracy;
        bestWeights = { ...testWeights };
      }
    }
  }
  
  // Update weights if improvement found
  const currentAccuracy = corrected.filter(f => f.recommendedTier === f.correctedTier).length / corrected.length;
  
  if (bestAccuracy > currentAccuracy) {
    weights.weights = bestWeights;
    weights.lastUpdated = Date.now();
    weights.feedbackCount = corrected.length;
    
    await saveWeights(weights);
    console.log(`✓ Weights updated! Accuracy: ${(currentAccuracy * 100).toFixed(1)}% → ${(bestAccuracy * 100).toFixed(1)}%`);
  } else {
    console.log(`✓ No improvement found. Current accuracy: ${(currentAccuracy * 100).toFixed(1)}%`);
  }
}

// ============================================================================
// OMNIROUTE INTEGRATION (unchanged from v1)
// ============================================================================

export async function fetchCombos(): Promise<any[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (OMNIROUTE_API_KEY) headers["Authorization"] = `Bearer ${OMNIROUTE_API_KEY}`;
  if (OMNIROUTE_COOKIE) headers["Cookie"] = OMNIROUTE_COOKIE;

  const resp = await fetch(`${OMNIROUTE_BASE_URL}/api/combos`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`OmniRoute /api/combos returned ${resp.status}`);
  return await resp.json();
}

export function bestComboForTask(
  combos: any[],
  taskType: TaskType,
  complexityTier: ComplexityTier,
  budgetConstraint?: number,
  latencyConstraint?: number,
): OmniRouteRecommendation {
  const fitness = TASK_FITNESS[taskType] || TASK_FITNESS.general;
  const enabled = combos.filter((c) => c.enabled !== false);
  const allowedNames = TIER_CANDIDATES[complexityTier];

  const tierCandidates = enabled.filter((c) => {
    const name = c.name.toLowerCase();
    return allowedNames.some((allowed) => name.includes(allowed));
  });

  const candidates = tierCandidates.length > 0 ? tierCandidates : enabled;

  const scored = candidates.map((combo) => {
    const { name, models } = combo;
    let score = 0;

    for (const pref of fitness.preferred) {
      if (models.some((m: ComboModel) => m.provider.toLowerCase().includes(pref))) {
        score += 20;
        break;
      }
    }

    for (const trait of fitness.traits) {
      if (name.toLowerCase().includes(trait)) score += 10;
    }

    const avgCost =
      models.length > 0 ? models.reduce((sum: number, m: ComboModel) => sum + (m.inputCostPer1M || 0), 0) / models.length : 0;
    if (budgetConstraint && avgCost > budgetConstraint) score -= 30;

    if (complexityTier === "complex" && name.includes("heavy")) score += 15;
    if (complexityTier === "trivial" && name.includes("light")) score += 15;
    if (complexityTier === "moderate") {
      if (name.includes("mid")) score += 10;
      if (name.includes("heavy")) score -= 15;
      if (name.includes("light")) score += 10;
    }
    if (complexityTier === "trivial" && name.includes("light")) score += 5;

    const isFree =
      name.includes("free") ||
      models.every((m: ComboModel) => m.provider.toLowerCase().includes("free"));

    return { combo, score, avgCost, isFree };
  });

  scored.sort((a, b) => b.score - a.score);

  const recommended = scored[0];
  const alternatives = scored.slice(1, 3).map((s) => ({
    id: s.combo.id,
    name: s.combo.name,
    tradeoff: s.avgCost < recommended.avgCost ? "cheaper but less capable" : "more capable but pricier",
  }));

  const freeOption = scored.find((s) => s.isFree);

  return {
    recommendedCombo: {
      id: recommended.combo.id,
      name: recommended.combo.name,
      reason: `Best fit for ${taskType} (${complexityTier} tier)`,
    },
    alternatives,
    freeAlternative: freeOption
      ? { id: freeOption.combo.id, name: freeOption.combo.name }
      : null,
  };
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  // Feedback subcommands
  if (args[0] === "feedback") {
    if (args[1] === "list") {
      const feedback = await loadFeedback();
      console.log(JSON.stringify(feedback, null, 2));
      return;
    }
    
    if (args[1] === "correct" || args[1] === "fix") {
      const taskIdIdx = args.findIndex(a => a === "--task-id" || a === "-id");
      const tierIdx = args.findIndex(a => a === "--tier" || a === "-t");
      
      if (taskIdIdx === -1 || tierIdx === -1) {
        console.error("Usage: tier-resolve-v2.ts feedback correct --task-id <id> --tier <tier>");
        process.exit(1);
      }
      
      const taskId = args[taskIdIdx + 1];
      const tier = args[tierIdx + 1] as ComplexityTier;
      
      await submitCorrection(taskId, tier);
      return;
    }
    
    if (args[1] === "tune" || args[1] === "auto-tune") {
      await autoTuneWeights();
      return;
    }
    
    console.error("Unknown feedback subcommand. Use: list | correct | tune");
    process.exit(1);
  }
  
  // Original tier-resolve functionality
  const omnirouteMode = args.includes("--omniroute");
  const jsonMode = args.includes("--json");
  
  // Extract constraint flags
  const options: any = {};
  const budgetIdx = args.findIndex(a => a === "--budget");
  if (budgetIdx !== -1) options.budget = args[budgetIdx + 1] as ConstraintValue;
  
  const latencyIdx = args.findIndex(a => a === "--latency");
  if (latencyIdx !== -1) options.latency = args[latencyIdx + 1] as ConstraintValue;
  
  const qualityIdx = args.findIndex(a => a === "--quality");
  if (qualityIdx !== -1) options.quality = args[qualityIdx + 1] as ConstraintValue;
  
  const speedIdx = args.findIndex(a => a === "--speed");
  if (speedIdx !== -1) options.speed = args[speedIdx + 1] as ConstraintValue;
  
  // Collect flag indices that take values
  const flagValueIndices = new Set<number>();
  if (budgetIdx !== -1) flagValueIndices.add(budgetIdx + 1);
  if (latencyIdx !== -1) flagValueIndices.add(latencyIdx + 1);
  if (qualityIdx !== -1) flagValueIndices.add(qualityIdx + 1);
  if (speedIdx !== -1) flagValueIndices.add(speedIdx + 1);
  
  // Collect task text (everything that's not a flag or flag value)
  const taskText = args.filter(
    (a, idx) => !a.startsWith("--") && !flagValueIndices.has(idx)
  ).join(" ");
  
  if (!taskText) {
    console.error("Usage: tier-resolve-v2.ts [options] <task prompt>");
    console.error("\nOptions:");
    console.error("  --omniroute       Query OmniRoute for best combo recommendation");
    console.error("  --json            Output full JSON (signals, domain, constraints)");
    console.error("  --budget <val>    Explicit budget constraint: low | medium | high");
    console.error("  --latency <val>   Explicit latency constraint: low | medium | high");
    console.error("  --quality <val>   Explicit quality constraint: low | medium | high");
    console.error("  --speed <val>     Explicit speed constraint: low | medium | high");
    console.error("\nFeedback subcommands:");
    console.error("  feedback list                       Show all feedback entries");
    console.error("  feedback correct --task-id X --tier Y   Submit correction");
    console.error("  feedback tune                       Auto-tune weights from corrections");
    process.exit(1);
  }
  
  const startTime = Bun.nanoseconds();
  const complexity = await estimateComplexity(taskText, options);
  const elapsedMs = (Bun.nanoseconds() - startTime) / 1_000_000;
  
  const staticCombo = TIER_TO_COMBO[complexity.tier];
  const taskType = complexity.inferredTaskType;
  
  // Log feedback
  const feedbackId = randomUUID();
  await logFeedback({
    id: feedbackId,
    timestamp: Date.now(),
    taskText,
    recommendedTier: complexity.tier,
    recommendedCombo: staticCombo,
    signals: complexity.signals,
  });
  
  if (omnirouteMode) {
    let omniResult: OmniRouteRecommendation | null = null;
    let omniError: string | null = null;
    
    try {
      const combos = await fetchCombos();
      omniResult = bestComboForTask(combos, taskType, complexity.tier);
    } catch (err: any) {
      omniError = err.message;
    }
    
    const output: any = {
      complexity: {
        tier: complexity.tier,
        score: complexity.score,
        signals: complexity.signals,
        inferredTaskType: taskType,
        semanticMatch: complexity.semanticMatch,
        domainPattern: complexity.domainPattern,
        constraints: complexity.constraints,
        scopeModifier: complexity.scopeModifier,
        staticCombo,
      },
      omniroute: omniResult,
      omnirouteError: omniError,
      resolvedCombo: omniResult ? omniResult.recommendedCombo.name : staticCombo,
      feedbackId,
      performanceMs: Math.round(elapsedMs * 100) / 100,
    };
    
    console.log(JSON.stringify(output, null, 2));
  } else if (jsonMode) {
    console.log(JSON.stringify({
      tier: complexity.tier,
      combo: staticCombo,
      score: complexity.score,
      signals: complexity.signals,
      inferredTaskType: taskType,
      semanticMatch: complexity.semanticMatch,
      domainPattern: complexity.domainPattern,
      constraints: complexity.constraints,
      scopeModifier: complexity.scopeModifier,
      feedbackId,
      performanceMs: Math.round(elapsedMs * 100) / 100,
    }, null, 2));
  } else {
    console.log(staticCombo);
  }
}

if (import.meta.main) {
  main();
}
