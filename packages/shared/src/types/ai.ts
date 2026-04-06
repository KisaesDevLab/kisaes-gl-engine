export type AiProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'glm_ocr_cloud' | 'glm_ocr_local';
export type AiJobType = 'categorize' | 'ocr_receipt' | 'ocr_statement' | 'ocr_invoice' | 'classify_document';
export type AiJobStatus = 'pending' | 'processing' | 'complete' | 'failed' | 'cancelled';

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
  hasGlmOcrKey: boolean;
  glmOcrBaseUrl: string | null;
  autoCategorizeOnImport: boolean;
  autoOcrOnUpload: boolean;
  categorizationConfidenceThreshold: number;
  maxConcurrentJobs: number;
  trackUsage: boolean;
  monthlyBudgetLimit: number | null;
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
