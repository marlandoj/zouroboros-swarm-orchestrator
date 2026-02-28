# Swarm Orchestrator — Model Selection Guide

## Available Models (Zo API)

| Model Name | Label | Type | Context Window | Cost Tier |
|---|---|---|---|---|
| `baseten:moonshotai/Kimi-K2.5` | Kimi K2.5 | free | 262,144 | Free |
| `openrouter:z-ai/glm-5` | GLM 5 | free | 202,752 | Free |
| `openrouter:minimax/minimax-m2.5` | MiniMax 2.5 | free | 196,608 | Free |
| `anthropic:claude-opus-4-6` | Opus 4.6 | subscribers | 200,000 | Paid |
| `anthropic:claude-sonnet-4-5-20250929` | Sonnet 4.5 | subscribers | 1,000,000 | Paid |
| `openai:gpt-5.2-codex` | GPT-5.2 Codex | subscribers | 400,000 | Paid |
| `openai:gpt-5.2-2025-12-11` | GPT-5.2 Thinking | subscribers | 400,000 | Paid |
| `google-vertex:gemini-3-pro-preview` | Gemini 3 Pro | subscribers | 1,000,000 | Paid |

## Recommended Task-to-Model Mapping

### Tier 1: Simple/Fast Tasks (free models)
- **Model**: `baseten:moonshotai/Kimi-K2.5` (current default)
- **Context**: 262K tokens — sufficient for all swarm tasks
- **Best for**: PM checklist, SEO audit, analytics, performance checks
- **Latency**: Variable (17-120s observed)

### Tier 2: Specialist Tasks (free, alternative)
- **Model**: `openrouter:minimax/minimax-m2.5` or `openrouter:z-ai/glm-5`
- **Context**: ~200K tokens
- **Best for**: Parallel specialist tasks where Kimi rate limits are hit
- **Use case**: Load balancing across free models at concurrency 3

### Tier 3: Synthesis/Complex Tasks (subscribers)
- **Model**: `anthropic:claude-sonnet-4-5-20250929`
- **Context**: 1M tokens — massive headroom
- **Best for**: Synthesis tasks, evidence QA, cross-domain analysis
- **Trade-off**: Higher cost, but significantly better reasoning

## Implementation Notes

- The `model_name` parameter is passed via the `/zo/ask` API's `model_name` field
- Current implementation does NOT pass model_name (uses Zo's default model)
- Adding per-task model selection requires a `model` field in the task JSON schema
- Token limits are not a concern — smallest model has 196K context, our max prompt is ~8K
- The real bottleneck is API **latency**, not token limits
- Recommend: use free models for specialists, paid models for synthesis only

## Status: RESEARCH COMPLETE — Implementation deferred

Per user direction, this investigation documents findings for future implementation.
Adding the `model_name` parameter requires:
1. New `model` field in Task interface
2. Pass `model_name` in callAgent() fetch body
3. Task JSON files updated with per-task model assignments
4. Config.json updated with default model and tier mappings
