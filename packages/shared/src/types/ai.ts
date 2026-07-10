// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

export type AiProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'openai_compat';
export type AiJobType = 'categorize' | 'ocr_receipt' | 'ocr_statement' | 'ocr_invoice' | 'classify_document';
export type AiJobStatus = 'pending' | 'processing' | 'complete' | 'failed' | 'cancelled';

// The four configurable AI functions ("tasks"). OCR is an umbrella over
// receipt/bill/statement parsing (each keeps its own built-in token
// default; the per-function override acts as a ceiling). See
// Build Plans/AI_FUNCTION_SETTINGS_PLAN.md.
export const AI_FUNCTION_KEYS = ['categorization', 'ocr', 'document_classification', 'chat'] as const;
export type AiFunctionKey = (typeof AI_FUNCTION_KEYS)[number];

export type AiThinkingMode = 'on' | 'off';
export type PiiProtectionLevel = 'strict' | 'standard' | 'permissive';

// Per-function settings overlay. Every field is an optional override;
// `null`/absent = "use the built-in default" (no behaviour change). Stored
// in ai_config.task_options as JSONB keyed by AiFunctionKey.
export interface TaskOption {
  maxTokens?: number | null;
  temperature?: number | null;
  thinking?: AiThinkingMode | null;
  timeoutMs?: number | null;
  fallbackChain?: string[] | null;
  enabled?: boolean | null;
  threshold?: number | null;
  autoTrigger?: boolean | null;
  piiLevel?: PiiProtectionLevel | null;
  numCtx?: number | null;
  // Batched AI categorization: how many bank-feed transactions to send in a
  // single AI request (categorization only). null/absent = built-in default
  // (15). 1 = today's per-transaction behaviour. Bounds 1–50.
  batchSize?: number | null;
}

export type TaskOptions = Partial<Record<AiFunctionKey, TaskOption>>;

// Admin overrides for the local document-extraction pipeline (Ollama/Qwen).
// null/absent = use the EXTRACTION_* env default.
export interface ExtractionOptions {
  maxTokens?: number | null;
  numCtx?: number | null;
  thinking?: AiThinkingMode | null;
  ollamaNative?: boolean | null;
  modelTag?: string | null;
  renderDpi?: number | null;
  grayscale?: boolean | null;
  confidenceThreshold?: number | null;
}

export interface AiSystemConfig {
  isEnabled: boolean;
  categorizationProvider: string | null;
  categorizationModel: string | null;
  ocrProvider: string | null;
  ocrModel: string | null;
  documentClassificationProvider: string | null;
  documentClassificationModel: string | null;
  fallbackChain: string[];
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  hasGeminiKey: boolean;
  ollamaBaseUrl: string | null;
  autoCategorizeOnImport: boolean;
  autoOcrOnUpload: boolean;
  categorizationConfidenceThreshold: number;
  maxConcurrentJobs: number;
  trackUsage: boolean;
  monthlyBudgetLimit: number | null;
  taskOptions: TaskOptions;
}

export interface AiJob {
  id: string;
  tenantId: string;
  jobType: AiJobType;
  status: AiJobStatus;
  provider: string | null;
  model: string | null;
  inputType: string | null;
  inputId: string | null;
  outputData: any;
  confidenceScore: number | null;
  userAccepted: boolean | null;
  userModified: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  processingDurationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AiCategorizationResult {
  accountId: string;
  accountName: string;
  contactId: string | null;
  contactName: string | null;
  memo: string | null;
  confidence: number;
  matchType: 'rule' | 'history' | 'ai';
}

export interface AiOcrResult {
  vendor: string | null;
  date: string | null;
  total: string | null;
  tax: string | null;
  lineItems: Array<{ description: string; amount: string; quantity?: number }>;
  paymentMethod: string | null;
  invoiceNumber: string | null;
  confidence: number;
}

export interface AiUsageSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  byProvider: Record<string, { calls: number; cost: number }>;
  byJobType: Record<string, { calls: number; cost: number }>;
}

export interface CompletionParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json' | 'text';
  thinking?: AiThinkingMode;
  /** Per-call Ollama context-window override (num_ctx). Falls back to
   *  OLLAMA_NUM_CTX when unset. Vision/extraction calls set this to fit a
   *  full-page image that would otherwise overflow the model's default. */
  numCtx?: number;
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
