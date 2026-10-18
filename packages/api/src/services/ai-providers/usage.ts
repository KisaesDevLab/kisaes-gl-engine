// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Per-call AI usage for API responses (U-09): integer tokens with the
 * provider and model that answered, nothing else (the cost estimate is a
 * float and stays out of the API; see ai-orchestrator.getUsageSummary).
 * Dependency-free so services can attach it without the orchestrator.
 */

export interface AiUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function usageOf(result: { provider: string; model: string; inputTokens: number; outputTokens: number }): AiUsage {
  return {
    provider: result.provider,
    model: result.model,
    inputTokens: Math.max(0, Math.trunc(Number(result.inputTokens) || 0)),
    outputTokens: Math.max(0, Math.trunc(Number(result.outputTokens) || 0)),
  };
}
