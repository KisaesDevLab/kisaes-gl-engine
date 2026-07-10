// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, sql } from 'drizzle-orm';
import type { AiConfigUpdateInput, AiFunctionKey, TaskOptions, ExtractionOptions } from '@kis-books/shared';
import { db } from '../db/index.js';
import { aiConfig } from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { assertExternalUrlSafe } from '../utils/url-safety.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import * as aiConsent from './ai-consent.service.js';
import { resolveTaskParams, resolveTaskExec } from './ai-task-options.js';

async function getOrCreateConfig() {
  let config = await db.query.aiConfig.findFirst();
  if (!config) {
    const [created] = await db.insert(aiConfig).values({
      piiProtectionLevel: 'strict',
      cloudVisionEnabled: false,
      disclosureVersion: 1,
    }).returning();
    config = created!;
    // NOTE: we deliberately no longer seed simplistic default prompt
    // templates here. The real per-function defaults live as hardcoded
    // strings in each task service and are the runtime fallback; the
    // prompt editor surfaces them via GET /ai/admin/prompts/defaults.
    // Seeding short generic placeholders only created misleading
    // "defaults" that didn't match what actually runs. See
    // AI_FUNCTION_SETTINGS_PLAN / Mechanism B wiring.
  }
  return config;
}

export interface ProviderTestRecord {
  /** ISO 8601 timestamp of the most recent /admin/test/:provider call. */
  verifiedAt: string;
  success: boolean;
  modelInfo?: string;
  error?: string;
}

export type ProviderTestHistory = Record<string, ProviderTestRecord>;

export async function getConfig() {
  const config = await getOrCreateConfig();
  return {
    providerTestHistory: (config.providerTestHistory as ProviderTestHistory) || {},
    isEnabled: config.isEnabled || false,
    categorizationProvider: config.categorizationProvider,
    categorizationModel: config.categorizationModel,
    ocrProvider: config.ocrProvider,
    ocrModel: config.ocrModel,
    documentClassificationProvider: config.documentClassificationProvider,
    documentClassificationModel: config.documentClassificationModel,
    fallbackChain: (config.fallbackChain as string[]) || ['anthropic', 'openai', 'gemini', 'ollama'],
    hasAnthropicKey: !!config.anthropicApiKeyEncrypted,
    hasOpenaiKey: !!config.openaiApiKeyEncrypted,
    hasGeminiKey: !!config.geminiApiKeyEncrypted,
    ollamaBaseUrl: config.ollamaBaseUrl,
    // Generic OpenAI-compatible server — Ollama /v1, llama.cpp, LM
    // Studio, vLLM, etc. Key returned as a boolean flag; plaintext
    // round-trips via the write path only.
    openaiCompatBaseUrl: config.openaiCompatBaseUrl,
    openaiCompatModel: config.openaiCompatModel,
    openaiCompatMode: (config.openaiCompatMode as 'auto' | 'native' | 'compat') || 'auto',
    hasOpenaiCompatKey: !!config.openaiCompatApiKeyEncrypted,
    // GLM-OCR engine (statement-import redesign). Key returned as a boolean
    // flag only; null/blank fields fall back to GLM_OCR_* env at resolve time.
    glmOcrEnabled: !!config.glmOcrEnabled,
    glmOcrBaseUrl: config.glmOcrBaseUrl,
    glmOcrModel: config.glmOcrModel,
    glmOcrPrompt: config.glmOcrPrompt,
    glmOcrTimeoutMs: config.glmOcrTimeoutMs,
    glmOcrConcurrency: config.glmOcrConcurrency,
    glmOcrForceOcr: !!config.glmOcrForceOcr,
    glmOcrRenderDpi: config.glmOcrRenderDpi,
    hasGlmOcrKey: !!config.glmOcrApiKeyEncrypted,
    // Stage-2 statement extraction LLM.
    statementExtractionProvider: (config.statementExtractionProvider as 'local' | 'anthropic') || 'local',
    statementExtractionModel: config.statementExtractionModel,
    autoCategorizeOnImport: config.autoCategorizeOnImport ?? true,
    autoOcrOnUpload: config.autoOcrOnUpload ?? true,
    // FIX 5: parse fallback for a null column matches the schema default (0.50).
    categorizationConfidenceThreshold: parseFloat(config.categorizationConfidenceThreshold || '0.50'),
    maxConcurrentJobs: config.maxConcurrentJobs || 5,
    trackUsage: config.trackUsage ?? true,
    monthlyBudgetLimit: config.monthlyBudgetLimit ? parseFloat(config.monthlyBudgetLimit) : null,
    // Per-function settings overlay (AI_FUNCTION_SETTINGS_PLAN.md).
    // Stored as JSONB keyed by function; absent/null keys resolve to the
    // built-in default at call time via resolveTaskParams/resolveTaskExec.
    taskOptions: (config.taskOptions as TaskOptions) || {},
    // Document-extraction overrides (Ollama/Qwen). Absent keys fall back to
    // EXTRACTION_* env defaults at call time (resolveExtractionOptions).
    extractionOptions: (config.extractionOptions as ExtractionOptions) || {},
    // Chat support (see AI_CHAT_SUPPORT_PLAN.md §2.1)
    chatSupportEnabled: config.chatSupportEnabled ?? false,
    chatProvider: config.chatProvider,
    chatModel: config.chatModel,
    chatMaxHistory: config.chatMaxHistory ?? 50,
    chatDataAccessLevel: (config.chatDataAccessLevel as 'none' | 'contextual' | 'full') || 'contextual',
    // PII protection
    piiProtectionLevel: config.piiProtectionLevel ?? 'strict',
    cloudVisionEnabled: !!config.cloudVisionEnabled,
    adminDisclosureAcceptedAt: config.adminDisclosureAcceptedAt ?? null,
    adminDisclosureAcceptedBy: config.adminDisclosureAcceptedBy ?? null,
    disclosureVersion: config.disclosureVersion ?? 1,
  };
}

export async function getRawConfig() {
  return getOrCreateConfig();
}

export interface ResolvedGlmOcrConfig {
  /** True only when the engine is enabled AND a base URL resolves. */
  enabled: boolean;
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  concurrency: number;
  apiKey: string | null;
  /** Force OCR even for text-layer PDFs (ai_config → STATEMENT_FORCE_OCR env). */
  forceOcr: boolean;
  /** Rasterization DPI for the OCR path (ai_config → EXTRACTION_RENDER_DPI env). */
  renderDpi: number;
}

/**
 * Resolve the GLM-OCR engine config for the statement pipeline and the admin
 * Test-connection route. Precedence: ai_config value → GLM_OCR_* env default.
 * The bearer key is decrypted here (never returned by getConfig). `enabled` is
 * the gate the statement parser checks before taking the OCR path.
 */
export async function resolveGlmOcrConfig(): Promise<ResolvedGlmOcrConfig> {
  const config = await getOrCreateConfig();
  const baseUrl = (config.glmOcrBaseUrl || env.GLM_OCR_BASE_URL || '').trim();
  let apiKey: string | null = null;
  if (config.glmOcrApiKeyEncrypted) {
    try {
      apiKey = decrypt(config.glmOcrApiKeyEncrypted);
    } catch {
      apiKey = null;
    }
  }
  return {
    enabled: !!config.glmOcrEnabled && baseUrl.length > 0,
    baseUrl,
    model: config.glmOcrModel || env.GLM_OCR_MODEL,
    prompt: config.glmOcrPrompt || env.GLM_OCR_PROMPT,
    timeoutMs: config.glmOcrTimeoutMs ?? env.GLM_OCR_TIMEOUT_MS,
    concurrency: config.glmOcrConcurrency ?? env.GLM_OCR_CONCURRENCY,
    apiKey,
    // glmOcrForceOcr is a NOT NULL boolean (default false); OR with the env
    // flag so either source can force OCR.
    forceOcr: !!config.glmOcrForceOcr || env.STATEMENT_FORCE_OCR,
    renderDpi: config.glmOcrRenderDpi ?? env.EXTRACTION_RENDER_DPI,
  };
}

export async function updateConfig(input: AiConfigUpdateInput, userId?: string) {
  const config = await getOrCreateConfig();
  // Use Drizzle's `$inferInsert` partial so the updates object is typed
  // against the actual aiConfig column shape. Dot-notation accesses
  // work because we're no longer hiding behind `Record<string, unknown>`.
  const updates: Partial<typeof aiConfig.$inferInsert> = { updatedAt: new Date() };

  // Snapshot the data-flow-relevant fields BEFORE applying updates so
  // we can detect loosening changes and bump disclosure_version.
  // See ai-consent.service changeRequiresReconsent() for the rules.
  const before = await aiConsent.snapshotDataFlow();

  if (input.isEnabled !== undefined) {
    // Gate: cannot enable AI until the super admin has accepted the
    // system disclosure. Acceptance is recorded separately via
    // ai-consent.acceptSystemDisclosure.
    if (input.isEnabled === true && !(config as any).adminDisclosureAcceptedAt) {
      throw AppError.badRequest('Accept the AI processing disclosure before enabling AI. See System Settings → AI → Disclosure.');
    }
    updates.isEnabled = input.isEnabled;
  }
  if (input.categorizationProvider !== undefined) updates.categorizationProvider = input.categorizationProvider;
  if (input.categorizationModel !== undefined) updates.categorizationModel = input.categorizationModel;
  if (input.ocrProvider !== undefined) updates.ocrProvider = input.ocrProvider;
  if (input.ocrModel !== undefined) updates.ocrModel = input.ocrModel;
  if (input.documentClassificationProvider !== undefined) updates.documentClassificationProvider = input.documentClassificationProvider;
  if (input.documentClassificationModel !== undefined) updates.documentClassificationModel = input.documentClassificationModel;
  if (input.fallbackChain) updates.fallbackChain = input.fallbackChain;
  // Credential fields use a 3-state sentinel:
  //   undefined / missing  → no change (form re-save without re-typing)
  //   ''                   → no change (defensive — frontend often defaults '')
  //   null                 → explicit clear (admin wants to remove the key)
  //   non-empty string     → encrypt and store
  // The GET endpoint never round-trips these (returns `has*Key` booleans
  // only), so a blank form value must NEVER be interpreted as "clear" or
  // every unrelated save would wipe the stored keys. Admins who want to
  // clear an existing key must explicitly send `null`.
  if (input.anthropicApiKey === null) updates.anthropicApiKeyEncrypted = null;
  else if (input.anthropicApiKey) updates.anthropicApiKeyEncrypted = encrypt(input.anthropicApiKey);
  if (input.openaiApiKey === null) updates.openaiApiKeyEncrypted = null;
  else if (input.openaiApiKey) updates.openaiApiKeyEncrypted = encrypt(input.openaiApiKey);
  if (input.geminiApiKey === null) updates.geminiApiKeyEncrypted = null;
  else if (input.geminiApiKey) updates.geminiApiKeyEncrypted = encrypt(input.geminiApiKey);
  if (input.ollamaBaseUrl !== undefined) {
    // Self-hosted AI: allowPrivate so a LAN box (192.168.x.x / 10.x /
    // localhost) is a valid target. Metadata endpoints stay blocked.
    if (input.ollamaBaseUrl) assertExternalUrlSafe(input.ollamaBaseUrl, 'Ollama base URL', { allowPrivate: true });
    updates.ollamaBaseUrl = input.ollamaBaseUrl || null;
  }
  // Generic OpenAI-compatible provider — Ollama /v1, llama.cpp, etc.
  // allowPrivate lets it reach a self-hosted box on the LAN (e.g. an
  // Ollama server at http://192.168.x.x:11434); the metadata endpoint
  // (169.254.169.254 / metadata.*) stays blocked.
  if (input.openaiCompatApiKey === null) updates.openaiCompatApiKeyEncrypted = null;
  else if (input.openaiCompatApiKey) updates.openaiCompatApiKeyEncrypted = encrypt(input.openaiCompatApiKey);
  if (input.openaiCompatBaseUrl !== undefined) {
    if (input.openaiCompatBaseUrl) assertExternalUrlSafe(input.openaiCompatBaseUrl, 'OpenAI-compat base URL', { allowPrivate: true });
    updates.openaiCompatBaseUrl = input.openaiCompatBaseUrl || null;
  }
  if (input.openaiCompatModel !== undefined) updates.openaiCompatModel = input.openaiCompatModel || null;
  if (input.openaiCompatMode !== undefined) updates.openaiCompatMode = input.openaiCompatMode;
  // GLM-OCR engine. Same 3-state credential sentinel; allowPrivate so the
  // llama.cpp box can live on the LAN. Empty base URL clears it (disables the
  // engine path until reconfigured).
  if (input.glmOcrEnabled !== undefined) updates.glmOcrEnabled = !!input.glmOcrEnabled;
  if (input.glmOcrApiKey === null) updates.glmOcrApiKeyEncrypted = null;
  else if (input.glmOcrApiKey) updates.glmOcrApiKeyEncrypted = encrypt(input.glmOcrApiKey);
  if (input.glmOcrBaseUrl !== undefined) {
    if (input.glmOcrBaseUrl) assertExternalUrlSafe(input.glmOcrBaseUrl, 'GLM-OCR base URL', { allowPrivate: true });
    updates.glmOcrBaseUrl = input.glmOcrBaseUrl || null;
  }
  if (input.glmOcrModel !== undefined) updates.glmOcrModel = input.glmOcrModel || null;
  if (input.glmOcrPrompt !== undefined) updates.glmOcrPrompt = input.glmOcrPrompt || null;
  if (input.glmOcrTimeoutMs !== undefined) updates.glmOcrTimeoutMs = input.glmOcrTimeoutMs ?? null;
  if (input.glmOcrConcurrency !== undefined) updates.glmOcrConcurrency = input.glmOcrConcurrency ?? null;
  if (input.glmOcrForceOcr !== undefined) updates.glmOcrForceOcr = !!input.glmOcrForceOcr;
  if (input.glmOcrRenderDpi !== undefined) updates.glmOcrRenderDpi = input.glmOcrRenderDpi ?? null;
  if (input.statementExtractionProvider !== undefined) updates.statementExtractionProvider = input.statementExtractionProvider;
  if (input.statementExtractionModel !== undefined) updates.statementExtractionModel = input.statementExtractionModel || null;
  if (input.autoCategorizeOnImport !== undefined) updates.autoCategorizeOnImport = input.autoCategorizeOnImport;
  if (input.autoOcrOnUpload !== undefined) updates.autoOcrOnUpload = input.autoOcrOnUpload;
  if (input.categorizationConfidenceThreshold !== undefined) updates.categorizationConfidenceThreshold = String(input.categorizationConfidenceThreshold);
  if (input.maxConcurrentJobs !== undefined) updates.maxConcurrentJobs = input.maxConcurrentJobs;
  if (input.trackUsage !== undefined) updates.trackUsage = input.trackUsage;
  if (input.monthlyBudgetLimit !== undefined) updates.monthlyBudgetLimit = input.monthlyBudgetLimit != null ? String(input.monthlyBudgetLimit) : null;
  // Chat support
  if (input.chatSupportEnabled !== undefined) updates.chatSupportEnabled = input.chatSupportEnabled;
  if (input.chatProvider !== undefined) updates.chatProvider = input.chatProvider || null;
  if (input.chatModel !== undefined) updates.chatModel = input.chatModel || null;
  if (input.chatMaxHistory !== undefined) updates.chatMaxHistory = input.chatMaxHistory;
  if (input.chatDataAccessLevel !== undefined) updates.chatDataAccessLevel = input.chatDataAccessLevel;
  // PII protection fields. Changes here are the primary trigger for
  // company-consent invalidation, checked after the update commits.
  if (input.piiProtectionLevel !== undefined) {
    const lvl = String(input.piiProtectionLevel);
    if (!['strict', 'standard', 'permissive'].includes(lvl)) {
      throw AppError.badRequest('piiProtectionLevel must be strict, standard, or permissive');
    }
    updates.piiProtectionLevel = lvl;
  }
  if (input.cloudVisionEnabled !== undefined) updates.cloudVisionEnabled = !!input.cloudVisionEnabled;
  // Per-function settings: deep-merge per function so a partial update
  // (one function, one key) doesn't wipe the other functions' settings.
  // A key set to null is preserved as null (meaning "use the default"),
  // which is how the UI clears an override.
  if (input.taskOptions) {
    const existing = (config.taskOptions as TaskOptions) || {};
    const merged: TaskOptions = { ...existing };
    for (const key of Object.keys(input.taskOptions) as AiFunctionKey[]) {
      const incoming = input.taskOptions[key];
      if (incoming) merged[key] = { ...(existing[key] || {}), ...incoming };
    }
    updates.taskOptions = merged;
  }
  // Document-extraction overrides — shallow-merge so a partial update keeps
  // the unspecified keys. A key set to null means "use the env default".
  if (input.extractionOptions) {
    const existing = (config.extractionOptions as ExtractionOptions) || {};
    updates.extractionOptions = { ...existing, ...input.extractionOptions };
  }
  if (userId) { updates.configuredBy = userId; updates.configuredAt = new Date(); }

  await db.update(aiConfig).set(updates).where(eq(aiConfig.id, config.id));

  // Compare post-update data flow against the snapshot. If the change
  // loosens data handling, bump ai_config.disclosure_version so every
  // company with stale consent is paused until re-acceptance.
  const after = await aiConsent.snapshotDataFlow();
  const reason = aiConsent.changeRequiresReconsent(before, after);
  if (reason) await aiConsent.invalidateCompanyConsent(reason, userId);

  return getConfig();
}

// Hard ceiling for `Test connection` from the admin UI. 15 s is long
// enough for cold-start cloud providers but short enough that a
// misconfigured base URL doesn't hang the admin's browser. The
// AbortSignal threads into both fetch- and SDK-backed providers so the
// underlying socket / SDK request is cancelled, not just orphaned. On
// timeout we resolve to a structured `success: false` rather than throw,
// matching the shape every other testConnection failure already uses.
const TEST_PROVIDER_TIMEOUT_MS = 15_000;

/**
 * Persist the most recent test result for a single provider so the
 * admin UI can render "Last verified <relative time>" without ever
 * pinging upstream on page load.
 *
 * Race-safety: PostgreSQL `jsonb_set` atomically merges the single
 * provider key into the existing object. A naive read-modify-write
 * (which earlier versions of this function used) would silently drop
 * one of two concurrent admin test results — both threads would read
 * the same prior snapshot, only the last write would land.
 */
async function recordTestResult(
  providerName: string,
  result: { success: boolean; modelInfo?: string; error?: string },
): Promise<void> {
  const cfg = await getOrCreateConfig();
  const record: ProviderTestRecord = {
    verifiedAt: new Date().toISOString(),
    success: result.success,
    ...(result.modelInfo ? { modelInfo: result.modelInfo } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  // `jsonb_set(target, path, value, create_if_missing=true)` — path is a
  // text[] of the keys to descend. Top-level set: `{providerName}`.
  // We pass the record as a parameter and let Postgres cast it to jsonb;
  // both the path array and the value are bind-parameterized so this is
  // safe against injection even though providerName comes from user input.
  await db.execute(sql`
    UPDATE ai_config
       SET provider_test_history =
             jsonb_set(
               COALESCE(provider_test_history, '{}'::jsonb),
               ARRAY[${providerName}]::text[],
               ${JSON.stringify(record)}::jsonb,
               true
             )
     WHERE id = ${cfg.id}
  `);
}

export interface TestProviderResult {
  success: boolean;
  error?: string;
  modelInfo?: string;
}

/**
 * Test the GLM-OCR engine via /health + /v1/models. We deliberately do NOT run
 * a sample OCR: llama-server rejects a tiny placeholder image with HTTP 400
 * ("Failed to load image"), which is a false negative — the server and model
 * are fine. Reachability + the model appearing in the catalog is the right
 * signal. Records the outcome under 'glm_ocr' in provider_test_history.
 */
export async function testGlmOcr(): Promise<TestProviderResult> {
  const glm = await resolveGlmOcrConfig();
  if (!glm.baseUrl) {
    const result: TestProviderResult = { success: false, error: 'GLM-OCR base URL is not set' };
    await recordTestResult('glm_ocr', result);
    return result;
  }
  const { probeGlmOcrHealth, probeGlmOcrModels } = await import('./extraction/glm-ocr.client.js');
  const cfg = { baseUrl: glm.baseUrl, apiKey: glm.apiKey };
  let result: TestProviderResult;
  try {
    const health = await probeGlmOcrHealth(cfg);
    let models: string[] = [];
    let modelsError: string | undefined;
    try {
      models = await probeGlmOcrModels(cfg);
    } catch (err) {
      modelsError = err instanceof Error ? err.message : String(err);
    }
    if (!health.ok && models.length === 0) {
      result = {
        success: false,
        error: `GLM-OCR not reachable at ${glm.baseUrl} (health ${health.status ?? health.detail ?? '?'}${modelsError ? `; models: ${modelsError}` : ''})`,
      };
    } else {
      const hasModel = models.length === 0 || models.includes(glm.model);
      result = {
        success: true,
        modelInfo:
          `Reachable at ${glm.baseUrl}. health=${health.ok ? 'ok' : '?'}; ` +
          `models=${models.join(', ') || 'n/a'}` +
          (!hasModel ? ` (configured '${glm.model}' NOT in catalog)` : ''),
      };
    }
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  await recordTestResult('glm_ocr', result);
  return result;
}

export interface ProviderModelsResult {
  models: string[];
  error?: string;
}

/** List available models for a provider, for the settings model dropdowns. */
export async function listProviderModels(providerName: string): Promise<ProviderModelsResult> {
  const config = await getRawConfig();
  try {
    const { getProvider } = await import('./ai-providers/index.js');
    const provider = getProvider(providerName, config);
    if (typeof provider.listModels !== 'function') return { models: [] };
    const { abortableTimeout } = await import('../utils/retry.js');
    const { signal, cancel } = abortableTimeout(12_000);
    try {
      const models = await provider.listModels(signal);
      return { models };
    } finally {
      cancel();
    }
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** List models advertised by the configured GLM-OCR llama-server. */
export async function listGlmOcrModels(): Promise<ProviderModelsResult> {
  const glm = await resolveGlmOcrConfig();
  if (!glm.baseUrl) return { models: [], error: 'GLM-OCR base URL is not set' };
  try {
    const { probeGlmOcrModels } = await import('./extraction/glm-ocr.client.js');
    const models = await probeGlmOcrModels({ baseUrl: glm.baseUrl, apiKey: glm.apiKey });
    return { models };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Distinct models configured for the functions assigned to `providerName` —
 * the `*_model` column of every function whose `*_provider` column (after
 * the same fallbacks the runtime applies: ocr/doc-classification/chat fall
 * back to the categorization provider) names this provider. Order follows
 * the function list, so the first entry is what the provider most likely
 * runs in production.
 */
function configuredModelsForProvider(
  config: {
    categorizationProvider: string | null;
    categorizationModel: string | null;
    ocrProvider: string | null;
    ocrModel: string | null;
    documentClassificationProvider: string | null;
    documentClassificationModel: string | null;
    chatProvider: string | null;
    chatModel: string | null;
  },
  providerName: string,
): string[] {
  const assignments: Array<{ provider: string | null; model: string | null }> = [
    { provider: config.categorizationProvider, model: config.categorizationModel },
    { provider: config.ocrProvider || config.categorizationProvider, model: config.ocrModel },
    {
      provider: config.documentClassificationProvider || config.categorizationProvider,
      model: config.documentClassificationModel,
    },
    { provider: config.chatProvider, model: config.chatModel },
  ];
  const models: string[] = [];
  for (const a of assignments) {
    if (a.provider === providerName && a.model && !models.includes(a.model)) models.push(a.model);
  }
  return models;
}

export async function testProvider(providerName: string): Promise<TestProviderResult> {
  const config = await getRawConfig();
  const { getProvider } = await import('./ai-providers/index.js');
  const { abortableTimeout, TimeoutError } = await import('../utils/retry.js');
  // Test the model this provider is ACTUALLY configured to run (the
  // *_model columns of the functions assigned to it), not the provider's
  // hardcoded default — a green badge must mean the real production call
  // path works. Several distinct models: test the first and name the rest;
  // none configured: keep the provider default.
  const configuredModels = configuredModelsForProvider(config, providerName);
  let provider;
  try {
    provider = getProvider(providerName, config, configuredModels[0]);
  } catch (err) {
    const result: TestProviderResult = { success: false, error: err instanceof Error ? err.message : String(err) };
    await recordTestResult(providerName, result);
    return result;
  }
  const { signal, cancel } = abortableTimeout(TEST_PROVIDER_TIMEOUT_MS);
  let result: TestProviderResult;
  try {
    result = await provider.testConnection(signal);
    if (result.success && configuredModels.length > 1) {
      const others = configuredModels.slice(1).join(', ');
      result = {
        ...result,
        modelInfo: `${result.modelInfo ? `${result.modelInfo} — ` : ''}also configured for this provider (untested): ${others}`,
      };
    }
  } catch (err) {
    // Abort/timeout detection. Different SDKs name abort errors
    // differently:
    //   - Native DOMException: name 'AbortError'
    //   - OpenAI SDK v4+:      throws APIUserAbortError, name 'APIUserAbortError'
    //   - Anthropic SDK:       passes through DOMException name
    //   - Our outer race:      our TimeoutError class
    // A name-substring match catches all of them without a brittle
    // exhaustive class list. Reflecting all as the same "timed out"
    // message keeps admin UX consistent — they don't need to know
    // which SDK was hit.
    const name = (err as { name?: string } | undefined)?.name ?? '';
    const isAbort = err instanceof TimeoutError || name.toLowerCase().includes('abort');
    result = isAbort
      ? { success: false, error: `Test timed out after ${TEST_PROVIDER_TIMEOUT_MS / 1000}s — provider did not respond` }
      : { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    cancel();
  }
  await recordTestResult(providerName, result);
  return result;
}

export interface SelfTestRow {
  task: 'categorization' | 'ocr' | 'document_classification' | 'chat';
  provider: string | null;
  success: boolean;
  error?: string;
  modelInfo?: string;
  /** Wall-clock latency of the testConnection call in milliseconds.
   *  null when the row was skipped (no provider configured for that task). */
  latencyMs: number | null;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Run `testConnection` for every task that has a provider assigned,
 * returning a matrix the admin UI renders as a status table. Read-only.
 *
 * Distinct providers are tested in parallel; multiple tasks pointing
 * at the same provider share a single ping (admins setting categorize +
 * ocr to anthropic shouldn't pay 2× upstream). Worst case is one
 * TEST_PROVIDER_TIMEOUT_MS for the slowest provider (~15s) instead of
 * the sum of all task budgets.
 */
export async function testAll(): Promise<{ rows: SelfTestRow[]; runAt: string }> {
  const config = await getConfig();
  const tasks: Array<{ task: SelfTestRow['task']; provider: string | null | undefined }> = [
    { task: 'categorization', provider: config.categorizationProvider },
    { task: 'ocr', provider: config.ocrProvider || config.categorizationProvider },
    { task: 'document_classification', provider: config.documentClassificationProvider || config.categorizationProvider },
    { task: 'chat', provider: config.chatProvider },
  ];

  const distinctProviders = Array.from(new Set(tasks.map((t) => t.provider).filter((p): p is string => !!p)));
  const startTimes = new Map<string, number>(distinctProviders.map((p) => [p, Date.now()]));
  const settled = await Promise.all(
    distinctProviders.map(async (provider) => ({ provider, result: await testProvider(provider) })),
  );
  const resultByProvider = new Map(settled.map(({ provider, result }) => [provider, result]));
  const latencyByProvider = new Map(
    settled.map(({ provider }) => [provider, Date.now() - (startTimes.get(provider) ?? Date.now())]),
  );

  const rows: SelfTestRow[] = tasks.map(({ task, provider }) => {
    if (!provider) {
      return { task, provider: null, success: false, latencyMs: null, skipped: true, skipReason: 'no_provider_configured' };
    }
    const result = resultByProvider.get(provider)!;
    return {
      task,
      provider,
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      ...(result.modelInfo ? { modelInfo: result.modelInfo } : {}),
      latencyMs: latencyByProvider.get(provider) ?? null,
    };
  });
  return { rows, runAt: new Date().toISOString() };
}

/**
 * Read-only diagnostics view for company owners (non-admin). Returns
 * the subset of the self-test history relevant to "will this task work
 * for me right now?" — pulled straight from the persisted
 * provider_test_history so we never trigger an upstream call from a
 * non-admin endpoint (no rate-limit / SSRF surface). When a provider
 * hasn't been verified recently, `staleSeconds` is null.
 *
 * Distinct from `testAll()` (admin-only, does ping upstream). The
 * diagnostic matrix here is the "is the system healthy for my company"
 * view; running a fresh check is admin-only by design.
 */
export interface DiagnosticsRow {
  task: 'categorization' | 'ocr' | 'document_classification' | 'chat';
  provider: string | null;
  status: 'configured' | 'not_configured' | 'untested' | 'ok' | 'failed';
  lastVerifiedAt?: string;
  modelInfo?: string;
  error?: string;
}

export async function getDiagnostics(): Promise<{
  systemEnabled: boolean;
  rows: DiagnosticsRow[];
}> {
  const config = await getConfig();
  const history = config.providerTestHistory;
  const taskMap: Array<{ task: DiagnosticsRow['task']; provider: string | null | undefined }> = [
    { task: 'categorization', provider: config.categorizationProvider },
    { task: 'ocr', provider: config.ocrProvider || config.categorizationProvider },
    { task: 'document_classification', provider: config.documentClassificationProvider || config.categorizationProvider },
    { task: 'chat', provider: config.chatProvider },
  ];
  const rows: DiagnosticsRow[] = taskMap.map(({ task, provider }) => {
    if (!provider) return { task, provider: null, status: 'not_configured' };
    const record = history[provider];
    if (!record) return { task, provider, status: 'untested' };
    return {
      task,
      provider,
      status: record.success ? 'ok' : 'failed',
      lastVerifiedAt: record.verifiedAt,
      ...(record.modelInfo ? { modelInfo: record.modelInfo } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  });
  return { systemEnabled: config.isEnabled, rows };
}

// ─── Per-function settings resolution ──────────────────────────────
// Pure resolvers live in ./ai-task-options.js (dependency-free, unit
// tested). Re-exported here so call sites keep using
// `aiConfigService.resolveTaskParams(...)`.
export { resolveTaskParams, resolveTaskExec } from './ai-task-options.js';
export type { ResolvedTaskParams, ResolvedTaskExec } from './ai-task-options.js';

export interface TestFunctionResult {
  success: boolean;
  provider: string | null;
  error?: string;
  modelInfo?: string;
  durationMs: number;
}

// Per-function test maxTokens — mirrors each function's real built-in
// default so the round-trip behaves like production (a thinking model
// starved of tokens would falsely "fail" the test).
const TEST_FN_MAX_TOKENS: Record<AiFunctionKey, number> = {
  categorization: 512,
  ocr: 1024,
  document_classification: 256,
  chat: 256,
};

/**
 * Real, end-to-end per-function test. Unlike `testProvider` (which only
 * pings reachability, e.g. Ollama's /api/tags), this runs an actual JSON
 * completion through the function's resolved provider + options + thinking
 * + timeout + fallback chain, and asserts non-empty parseable output.
 *
 * This is the check that catches the failure class behind
 * `ai_all_providers_failed`: a thinking model on the OpenAI-compat /v1
 * path returns empty `content`, which a reachability ping never sees.
 * On failure it surfaces the per-provider error detail (`providerErrors`)
 * that the user-facing toast otherwise discards.
 */
export async function testFunction(fn: AiFunctionKey): Promise<TestFunctionResult> {
  const config = await getConfig();
  const rawConfig = await getRawConfig();

  const providerByFn: Record<AiFunctionKey, string | null> = {
    categorization: config.categorizationProvider,
    ocr: config.ocrProvider || config.categorizationProvider,
    document_classification: config.documentClassificationProvider || config.categorizationProvider,
    chat: config.chatProvider || config.categorizationProvider,
  };
  const modelByFn: Record<AiFunctionKey, string | undefined> = {
    categorization: config.categorizationModel || undefined,
    ocr: config.ocrModel || undefined,
    document_classification: config.documentClassificationModel || undefined,
    chat: config.chatModel || undefined,
  };

  const provider = providerByFn[fn];
  const start = Date.now();
  if (!provider) {
    return { success: false, provider: null, durationMs: 0, error: 'No provider configured for this function' };
  }

  const tp = resolveTaskParams(config, fn, { maxTokens: TEST_FN_MAX_TOKENS[fn], temperature: 0.1 });
  const exec = resolveTaskExec(config, fn);
  const { executeWithFallback } = await import('./ai-providers/index.js');

  try {
    const result = await executeWithFallback(
      {
        systemPrompt: 'You are a connectivity test harness. Reply with strict JSON only, no prose.',
        userPrompt: 'Return exactly {"ok":true} and nothing else.',
        temperature: tp.temperature,
        maxTokens: tp.maxTokens,
        responseFormat: 'json',
        ...(tp.thinking ? { thinking: tp.thinking } : {}),
      },
      rawConfig,
      exec.fallbackChain,
      provider,
      modelByFn[fn],
      exec.timeoutMs ? { timeoutMs: exec.timeoutMs } : undefined,
    );
    const durationMs = Date.now() - start;
    const empty = !result.parsed && !result.text.trim();
    if (result.parseError || empty) {
      return {
        success: false,
        provider,
        durationMs,
        error: result.parseError
          ? `${result.provider} returned non-JSON: ${result.parseError}`
          : `${result.provider} returned empty content (a thinking model on an OpenAI-compatible /v1 endpoint does this — use the native Ollama provider, or turn thinking off)`,
      };
    }
    // The test deliberately runs even when the function is disabled (an
    // admin diagnosing config wants connectivity truth), but the result
    // must say production calls won't run.
    const disabledNote = exec.enabled ? '' : ' — note: this function is currently DISABLED in Admin → AI, so production calls will not run';
    return { success: true, provider, durationMs, modelInfo: `${result.provider} / ${result.model}${disabledNote}` };
  } catch (err) {
    const durationMs = Date.now() - start;
    const e = err as { providerErrors?: string[]; message?: string };
    const detail = Array.isArray(e.providerErrors) && e.providerErrors.length > 0
      ? e.providerErrors.join('; ')
      : (e.message ?? String(err));
    return { success: false, provider, durationMs, error: detail };
  }
}
