// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export interface CompletionParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json' | 'text';
  /** Optional abort signal — providers thread this into the underlying
   *  SDK / fetch call so socket teardown actually happens on timeout. */
  signal?: AbortSignal;
}

export interface VisionParams extends CompletionParams {
  images: Array<{ base64: string; mimeType: string }>;
}

export interface CompletionResult {
  text: string;
  parsed?: any;
  /** Populated when `responseFormat: 'json'` was requested but the model
   *  response could not be parsed as JSON (even after `safeJsonExtract`
   *  stripped fences and scanned for balanced braces). Holds a short
   *  excerpt of the raw text so callers can surface actionable errors. */
  parseError?: string;
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
}
