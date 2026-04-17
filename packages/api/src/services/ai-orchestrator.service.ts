// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiJobs, aiUsageLog } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { Semaphore } from '../utils/retry.js';
import * as aiConfigService from './ai-config.service.js';
import { executeWithFallback, getProvider } from './ai-providers/index.js';
import type { CompletionParams, CompletionResult, VisionParams } from './ai-providers/index.js';
import { pickMode, type SanitizerMode } from './pii-sanitizer.service.js';
import { checkTenantTaskConsent, type AiTaskKey } from './ai-consent.service.js';

export type AiTask = 'categorize' | 'ocr_receipt' | 'ocr_invoice' | 'ocr_statement' | 'classify_document';

function consentReasonMessage(reason: string | undefined): string {
  switch (reason) {
    case 'system_disabled':
      return 'AI processing is not enabled. Contact your administrator.';
    case 'system_disclosure_not_accepted':
      return 'The system administrator has not accepted the AI processing disclosure.';
    case 'company_not_opted_in':
      return 'This company has not opted in to AI processing. Enable it in Company Settings → AI Processing.';
    case 'task_disabled':
      return 'This AI task is disabled for your company. Enable it in Company Settings → AI Processing.';
    case 'consent_stale':
      return 'The AI configuration has changed — please review and re-accept the AI disclosure in Company Settings before AI features resume.';
    default:
      return 'AI processing is blocked by consent rules.';
  }
}

// Providers whose calls stay on-server. For these the PII sanitizer is a
// no-op and the cloud-vision gate is skipped.
const SELF_HOSTED_PROVIDERS = new Set(['ollama', 'glm_ocr_local']);

export function isSelfHostedProvider(providerName: string): boolean {
  return SELF_HOSTED_PROVIDERS.has(providerName);
}

/**
 * Pick the PII sanitizer mode for a given provider and task. Self-hosted
 * providers get `none` (data never leaves the server); cloud providers
 * get a task-appropriate mode per addendum §PII Sanitizer.
 */
export function piiModeFor(providerName: string, task: AiTask): SanitizerMode {
  return pickMode(providerName, task);
}

/**
 * Block cloud-vision (image-input) calls unless explicitly authorised.
 * Self-hosted providers are always allowed. Cloud providers require
 * `ai_config.cloud_vision_enabled = true` AND `pii_protection_level =
 * 'permissive'` — the admin opt-in path per addendum §Tier 1.
 */
export async function assertCloudVisionAllowed(providerName: string): Promise<void> {
  if (isSelfHostedProvider(providerName)) return;
  const raw = await aiConfigService.getRawConfig();
  const cloudVisionEnabled = !!raw.cloudVisionEnabled;
  const level = raw.piiProtectionLevel || 'strict';
  if (cloudVisionEnabled && level === 'permissive') return;
  throw AppError.badRequest(
    'Cloud vision is disabled by PII protection settings. Enable GLM-OCR or Ollama for local image processing, or ask your administrator to switch the system to Permissive mode with cloud vision enabled.',
  );
}

// Global concurrency semaphore — initialized lazily from config
let _semaphore: Semaphore | null = null;
async function getSemaphore(): Promise<Semaphore> {
  if (!_semaphore) {
    const config = await aiConfigService.getConfig();
    _semaphore = new Semaphore(config.maxConcurrentJobs || 5);
  }
  return _semaphore;
}
// Reset semaphore when config changes
export function resetConcurrencyLimit() { _semaphore = null; }

// Map the orchestrator's jobType codes to the per-company task toggle
// keys on companies.ai_enabled_tasks. Bill OCR falls under the receipt
// OCR toggle — they share a single "process uploaded documents"
// semantic from the company owner's point of view.
const JOB_TO_TASK: Record<string, AiTaskKey> = {
  categorize: 'categorization',
  ocr_receipt: 'receipt_ocr',
  ocr_invoice: 'receipt_ocr',
  ocr_statement: 'statement_parsing',
  classify_document: 'document_classification',
};

export async function createJob(tenantId: string, jobType: string, inputType: string, inputId: string, inputData?: any) {
  const config = await aiConfigService.getConfig();
  if (!config.isEnabled) throw AppError.badRequest('AI processing is not enabled. Contact your administrator.');

  // Two-tier consent gate. The system-level checks (enabled +
  // disclosure accepted) are also in checkTenantTaskConsent; calling
  // it here lets the consent service own the whole policy.
  const task = JOB_TO_TASK[jobType];
  if (task) {
    const check = await checkTenantTaskConsent(tenantId, task);
    if (!check.allowed) {
      throw AppError.badRequest(consentReasonMessage(check.reason));
    }
  }

  // Budget check
  if (config.monthlyBudgetLimit != null) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const usage = await db.execute(sql`
      SELECT COALESCE(SUM(estimated_cost::numeric), 0) as total
      FROM ai_usage_log
      WHERE tenant_id = ${tenantId} AND created_at >= ${monthStart.toISOString()}
    `);
    const currentCost = parseFloat((usage.rows[0] as any)?.total || '0');
    if (currentCost >= config.monthlyBudgetLimit) {
      throw AppError.badRequest('Monthly AI budget exceeded. Contact your administrator to increase the limit.');
    }
  }

  const [job] = await db.insert(aiJobs).values({
    tenantId,
    jobType,
    inputType,
    inputId,
    inputData,
    status: 'pending',
  }).returning();

  return job!;
}

export async function processJob(jobId: string) {
  const job = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
  if (!job || job.status !== 'pending') return null;

  await db.update(aiJobs).set({ status: 'processing', processingStartedAt: new Date() }).where(eq(aiJobs.id, jobId));

  return job;
}

/**
 * Attach PII/quality metadata to the stored outputData for this job.
 * Callers pass the sanitizer's detected PII types and any quality
 * warnings (e.g. "Tesseract fallback used") so the on-screen AI badge
 * can surface an accurate "what was sent / not sent" record.
 */
export function withAiMetadata<T extends Record<string, any>>(
  outputData: T,
  meta: { piiRedacted?: string[]; qualityWarnings?: string[]; extractionSource?: string },
): T & { _ai?: { piiRedacted?: string[]; qualityWarnings?: string[]; extractionSource?: string } } {
  const _ai: any = {};
  if (meta.piiRedacted && meta.piiRedacted.length) _ai.piiRedacted = meta.piiRedacted;
  if (meta.qualityWarnings && meta.qualityWarnings.length) _ai.qualityWarnings = meta.qualityWarnings;
  if (meta.extractionSource) _ai.extractionSource = meta.extractionSource;
  if (Object.keys(_ai).length === 0) return outputData;
  return { ...outputData, _ai };
}

export async function completeJob(jobId: string, result: CompletionResult, outputData: any, confidenceScore: number) {
  await db.update(aiJobs).set({
    status: 'complete',
    provider: result.provider,
    model: result.model,
    outputData,
    confidenceScore: String(confidenceScore),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCost: String(getProvider(result.provider, await aiConfigService.getRawConfig(), result.model).estimateCost(result.inputTokens, result.outputTokens)),
    processingCompletedAt: new Date(),
    processingDurationMs: result.durationMs,
    updatedAt: new Date(),
  }).where(eq(aiJobs.id, jobId));

  // Log usage
  const job = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
  if (job) {
    await db.insert(aiUsageLog).values({
      tenantId: job.tenantId,
      provider: result.provider,
      model: result.model,
      jobType: job.jobType,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCost: job.estimatedCost || '0',
    });
  }
}

export async function failJob(jobId: string, error: string) {
  const job = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
  if (!job) return;

  const retryCount = (job.retryCount || 0) + 1;
  if (retryCount < (job.maxRetries || 3)) {
    await db.update(aiJobs).set({ status: 'pending', retryCount, errorMessage: error, updatedAt: new Date() }).where(eq(aiJobs.id, jobId));
  } else {
    await db.update(aiJobs).set({ status: 'failed', retryCount, errorMessage: error, processingCompletedAt: new Date(), updatedAt: new Date() }).where(eq(aiJobs.id, jobId));
  }
}

export async function executeCompletion(tenantId: string, params: CompletionParams): Promise<CompletionResult> {
  const sem = await getSemaphore();
  return sem.run(async () => {
    const config = await aiConfigService.getConfig();
    const rawConfig = await aiConfigService.getRawConfig();
    return executeWithFallback(params, rawConfig, config.fallbackChain);
  });
}

export async function getUsageSummary(tenantId: string, months: number = 1) {
  const start = new Date();
  start.setMonth(start.getMonth() - months);

  const rows = await db.execute(sql`
    SELECT provider, job_type, COUNT(*) as calls,
      SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
      SUM(estimated_cost::numeric) as cost
    FROM ai_usage_log
    WHERE tenant_id = ${tenantId} AND created_at >= ${start.toISOString()}
    GROUP BY provider, job_type
  `);

  const byProvider: Record<string, { calls: number; cost: number }> = {};
  const byJobType: Record<string, { calls: number; cost: number }> = {};
  let totalCalls = 0, totalInput = 0, totalOutput = 0, totalCost = 0;

  for (const row of rows.rows as any[]) {
    totalCalls += parseInt(row.calls);
    totalInput += parseInt(row.input_tokens || '0');
    totalOutput += parseInt(row.output_tokens || '0');
    totalCost += parseFloat(row.cost || '0');

    if (!byProvider[row.provider]) byProvider[row.provider] = { calls: 0, cost: 0 };
    byProvider[row.provider]!.calls += parseInt(row.calls);
    byProvider[row.provider]!.cost += parseFloat(row.cost || '0');

    if (!byJobType[row.job_type]) byJobType[row.job_type] = { calls: 0, cost: 0 };
    byJobType[row.job_type]!.calls += parseInt(row.calls);
    byJobType[row.job_type]!.cost += parseFloat(row.cost || '0');
  }

  return { totalCalls, totalInputTokens: totalInput, totalOutputTokens: totalOutput, totalCost, byProvider, byJobType };
}
