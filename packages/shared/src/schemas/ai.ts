// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

// Per-function settings overlay (AI_FUNCTION_SETTINGS_PLAN.md §3). Every
// field is an optional, nullable override — `null`/absent = "use the
// built-in default". `.strict()` rejects unknown keys so typos surface
// instead of silently no-op'ing.
export const taskOptionSchema = z
  .object({
    maxTokens: z.number().int().positive().max(200000).nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    thinking: z.enum(['on', 'off']).nullable().optional(),
    timeoutMs: z.number().int().min(1000).max(600000).nullable().optional(),
    fallbackChain: z.array(z.string()).nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    threshold: z.number().min(0).max(1).nullable().optional(),
    autoTrigger: z.boolean().nullable().optional(),
    piiLevel: z.enum(['strict', 'standard', 'permissive']).nullable().optional(),
    // Ollama context-window override (num_ctx) for this function. null/absent
    // = use OLLAMA_NUM_CTX / model default.
    numCtx: z.number().int().min(512).max(1000000).nullable().optional(),
  })
  .strict();

// Admin overrides for the local document-extraction pipeline. Every field is
// optional; null/absent = use the EXTRACTION_* env default.
export const extractionOptionsSchema = z
  .object({
    maxTokens: z.number().int().positive().max(200000).nullable().optional(),
    numCtx: z.number().int().min(512).max(1000000).nullable().optional(),
    thinking: z.enum(['on', 'off']).nullable().optional(),
    ollamaNative: z.boolean().nullable().optional(),
    modelTag: z.string().max(200).nullable().optional(),
    renderDpi: z.number().int().min(72).max(600).nullable().optional(),
    grayscale: z.boolean().nullable().optional(),
    confidenceThreshold: z.number().min(0).max(1).nullable().optional(),
  })
  .strict();

export const taskOptionsSchema = z
  .object({
    categorization: taskOptionSchema.optional(),
    ocr: taskOptionSchema.optional(),
    document_classification: taskOptionSchema.optional(),
    chat: taskOptionSchema.optional(),
  })
  .strict();

export const aiConfigUpdateSchema = z.object({
  isEnabled: z.boolean().optional(),
  categorizationProvider: z.string().nullable().optional(),
  categorizationModel: z.string().nullable().optional(),
  ocrProvider: z.string().nullable().optional(),
  ocrModel: z.string().nullable().optional(),
  documentClassificationProvider: z.string().nullable().optional(),
  documentClassificationModel: z.string().nullable().optional(),
  fallbackChain: z.array(z.string()).optional(),
  // Credential fields use 3-state sentinel: null = clear, '' = no
  // change, non-empty = set. nullish() accepts both null and undefined.
  anthropicApiKey: z.string().nullish(),
  openaiApiKey: z.string().nullish(),
  geminiApiKey: z.string().nullish(),
  ollamaBaseUrl: z.string().optional(),
  openaiCompatApiKey: z.string().nullish(),
  openaiCompatBaseUrl: z.string().optional(),
  openaiCompatModel: z.string().nullable().optional(),
  // How the openai_compat endpoint is driven (Ollama native vs /v1).
  openaiCompatMode: z.enum(['auto', 'native', 'compat']).optional(),
  // GLM-OCR engine (statement-import redesign). Dedicated llama.cpp OCR
  // server with its own base URL + tuning. apiKey uses the 3-state sentinel.
  glmOcrEnabled: z.boolean().optional(),
  glmOcrBaseUrl: z.string().optional(),
  glmOcrApiKey: z.string().nullish(),
  glmOcrModel: z.string().nullable().optional(),
  glmOcrPrompt: z.string().nullable().optional(),
  glmOcrTimeoutMs: z.number().int().min(1000).max(600_000).nullable().optional(),
  glmOcrConcurrency: z.number().int().min(1).max(16).nullable().optional(),
  glmOcrForceOcr: z.boolean().optional(),
  glmOcrRenderDpi: z.number().int().min(72).max(600).nullable().optional(),
  // Stage-2 extraction LLM: self-hosted ('local') or cloud ('anthropic').
  statementExtractionProvider: z.enum(['local', 'anthropic']).optional(),
  statementExtractionModel: z.string().nullable().optional(),
  autoCategorizeOnImport: z.boolean().optional(),
  autoOcrOnUpload: z.boolean().optional(),
  categorizationConfidenceThreshold: z.number().min(0).max(1).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(20).optional(),
  trackUsage: z.boolean().optional(),
  monthlyBudgetLimit: z.number().nullable().optional(),
  piiProtectionLevel: z.enum(['strict', 'standard', 'permissive']).optional(),
  cloudVisionEnabled: z.boolean().optional(),
  // Chat support fields (tier-2 consent flow, see AI_CHAT_SUPPORT_PLAN).
  chatSupportEnabled: z.boolean().optional(),
  chatProvider: z.string().nullable().optional(),
  chatModel: z.string().nullable().optional(),
  chatMaxHistory: z.number().int().min(0).max(100).optional(),
  chatDataAccessLevel: z.enum(['none', 'metadata', 'redacted', 'full']).optional(),
  // Per-function settings. Partial deep-merge in the service so a partial
  // update (one function, one key) doesn't wipe the rest.
  taskOptions: taskOptionsSchema.optional(),
  // Document-extraction overrides (deep-merged in the service).
  extractionOptions: extractionOptionsSchema.optional(),
});
export type AiConfigUpdateInput = z.infer<typeof aiConfigUpdateSchema>;
export type TaskOptionInput = z.infer<typeof taskOptionSchema>;
export type TaskOptionsInput = z.infer<typeof taskOptionsSchema>;
export type ExtractionOptionsInput = z.infer<typeof extractionOptionsSchema>;

export const aiCategorizeSchema = z.object({
  feedItemId: z.string().uuid(),
});

export const aiBatchCategorizeSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(100),
});

// Dry-run categorization for not-yet-imported rows (statement review preview).
// Transient transactions, so no feed-item ids — just description + amount.
export const aiCategorizePreviewSchema = z.object({
  transactions: z
    .array(z.object({ description: z.string().max(500), amount: z.union([z.string(), z.number()]) }))
    .min(1)
    .max(300),
});

export const aiOcrSchema = z.object({
  attachmentId: z.string().uuid(),
});

export const aiClassifySchema = z.object({
  attachmentId: z.string().uuid(),
});

export const aiPromptTemplateSchema = z.object({
  taskType: z.string(),
  provider: z.string().nullable().optional(),
  systemPrompt: z.string().min(1),
  userPromptTemplate: z.string().min(1),
  outputSchema: z.any().optional(),
  notes: z.string().optional(),
});

export const aiJobAcceptSchema = z.object({
  accepted: z.boolean(),
  modified: z.boolean().optional(),
  overrideData: z.any().optional(),
});

// Recording a user decision on an AI categorization suggestion.
// Feeds the categorization_history table used by the learning loop.
export const aiCategorizeAcceptSchema = z.object({
  feedItemId: z.string().uuid(),
  accountId: z.string().uuid(),
  contactId: z.string().uuid().nullable().optional(),
  accepted: z.boolean(),
  modified: z.boolean().optional(),
});

// Parse a bank statement attachment via AI.
export const aiParseStatementSchema = z.object({
  attachmentId: z.string().uuid(),
});

// Import transactions from a previously-parsed statement. The
// `transactions` array is capped to keep the downstream insert loop
// bounded.
export const aiImportStatementSchema = z
  .object({
    // Either target an existing connection directly, or pass the GL accountId
    // and let the importer find-or-create the manual connection for it.
    bankConnectionId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    transactions: z
      .array(
        z.object({
          date: z.string().min(1).max(20),
          description: z.string().max(500),
          amount: z.string().max(30),
          type: z.string().max(20).optional(),
        }),
      )
      .min(1)
      .max(5000),
  })
  .refine((d) => !!d.bankConnectionId || !!d.accountId, {
    message: 'accountId or bankConnectionId is required',
  });

// Per-company AI task toggles. Used by PATCH /ai/consent/:companyId/tasks.
export const aiTaskTogglesSchema = z.object({
  categorization: z.boolean().optional(),
  receipt_ocr: z.boolean().optional(),
  statement_parsing: z.boolean().optional(),
  document_classification: z.boolean().optional(),
});

// Admin prompt template mutations.
export const aiUpdatePromptTemplateSchema = aiPromptTemplateSchema.partial();
