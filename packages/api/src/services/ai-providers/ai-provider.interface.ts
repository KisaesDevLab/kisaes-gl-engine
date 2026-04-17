// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export interface CompletionParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json' | 'text';
}

export interface VisionParams extends CompletionParams {
  images: Array<{ base64: string; mimeType: string }>;
}

export interface CompletionResult {
  text: string;
  parsed?: any;
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
  testConnection(): Promise<{ success: boolean; error?: string; modelInfo?: string }>;
  estimateCost(inputTokens: number, outputTokens: number): number;
}
