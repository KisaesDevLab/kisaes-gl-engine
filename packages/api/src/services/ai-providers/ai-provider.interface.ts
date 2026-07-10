// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

export interface CompletionParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json' | 'text';
  /** Optional abort signal — providers thread this into the underlying
   *  SDK / fetch call so socket teardown actually happens on timeout. */
  signal?: AbortSignal;
  /** Per-function "thinking"/reasoning preference. Provider-specific and
   *  capability-aware: each provider translates it (Ollama `think:false`,
   *  Gemini `thinkingBudget:0`, etc.) and silently no-ops where the
   *  provider/model doesn't support a thinking toggle. `undefined` =
   *  provider default (current behaviour). See
   *  Build Plans/AI_FUNCTION_SETTINGS_PLAN.md §5. */
  thinking?: 'on' | 'off';
  /** Per-call Ollama context-window override (num_ctx); falls back to
   *  OLLAMA_NUM_CTX. Vision/extraction calls set this so a full-page image
   *  doesn't overflow the model's small default context. */
  numCtx?: number;
}

export interface VisionParams extends CompletionParams {
  images: Array<{ base64: string; mimeType: string }>;
}

export interface CompletionResult {
  text: string;
  parsed?: any;
  /** Populated when `responseFormat: 'json'` was requested but the model
   *  response could not be parsed as JSON (even after `safeJsonExtract`
   *  stripped fences/reasoning blocks and scanned for balanced braces).
   *  Holds a short excerpt of the raw text so callers can surface
   *  actionable errors. */
  parseError?: string;
  /** True when the upstream reported a token-limit stop (Anthropic
   *  `stop_reason: 'max_tokens'`, OpenAI-style `finish_reason: 'length'`,
   *  Ollama `done_reason: 'length'`, Gemini `MAX_TOKENS`). Callers use
   *  this to (a) render "raise max tokens" instead of "non-JSON" and
   *  (b) skip parse-retries that would truncate again. */
  truncated?: boolean;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
  durationMs: number;
}

export interface AiProvider {
  name: string;
  supportsVision: boolean;
  complete(params: CompletionParams): Promise<CompletionResult>;
  completeWithImage(params: VisionParams): Promise<CompletionResult>;
  testConnection(signal?: AbortSignal): Promise<{ success: boolean; error?: string; modelInfo?: string }>;
  estimateCost(inputTokens: number, outputTokens: number): number;
  /** List the model ids available to this provider's credentials/endpoint, for
   *  populating the model dropdowns in AI settings. Optional — providers that
   *  can't enumerate models omit it (callers fall back to free-text). */
  listModels?(signal?: AbortSignal): Promise<string[]>;
}
