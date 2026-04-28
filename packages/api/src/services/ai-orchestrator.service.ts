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

export type AiTask =
  | 'categorize'
  | 'ocr_receipt'
  | 'ocr_invoice'
  | 'ocr_statement'
  | 'classify_document'
  | 'enrich_vendor'
  | 'judgment_review';

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
//
// `openai_compat` is a special case — the admin points it at an arbitrary
// URL, so whether data stays on-server depends on where that URL resolves.
// isSelfHostedProvider() inspects the configured URL and returns true only
// when it's clearly local (loopback, private IP, .local hostname, or a
// Docker/Compose-style short DNS name). Anything else — including any
// https://public.cloud/... URL — is treated as cloud so the PII sanitizer
// still engages.
const ALWAYS_SELF_HOSTED = new Set(['ollama', 'glm_ocr_local']);

function isLocalUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    // Normalise: lowercase, strip trailing dot (valid FQDN suffix
    // that URL parsing keeps), strip IPv6 brackets so `::1` matches
    // equality-wise.
    let host = u.hostname.toLowerCase();
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

    if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    // Whole 127.0.0.0/8 loopback range per RFC 1122 — `127.0.0.2`,
    // `127.1.2.3` etc. all route to the local host and must count as
    // self-hosted.
    if (/^127\./.test(host)) return true;
    // RFC 1918 private ranges
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    // Docker/Compose short names (no dots) and IPv6 link-local fe80::/10
    if (!host.includes('.') && !host.includes(':')) return true;
    if (host.startsWith('fe80:')) return true;
    return false;
  } catch {
    return false;
  }
}

export function isSelfHostedProvider(providerName: string, config?: { openaiCompatBaseUrl?: string | null }): boolean {
  if (ALWAYS_SELF_HOSTED.has(providerName)) return true;
  if (providerName === 'openai_compat') return isLocalUrl(config?.openaiCompatBaseUrl);
  return false;
}

/**
 * Pick the PII sanitizer mode for a given provider and task. Self-hosted
 * providers get `none` (data never leaves the server); cloud providers
 * get a task-appropriate mode per addendum §PII Sanitizer.
 */
export function piiModeFor(
  providerName: string,
  task: AiTask,
  config?: { openaiCompatBaseUrl?: string | null },
): SanitizerMode {
  // Pass through the URL-aware self-hosted check for openai_compat so
  // sanitization correctly skips when the admin points it at a local
  // server, and correctly engages when it's aimed at a cloud URL.
  return pickMode(providerName, task, isSelfHostedProvider(providerName, config));
}

/**
 * Block cloud-vision (image-input) calls unless explicitly authorised.
 * Self-hosted providers are always allowed. Cloud providers require
 * `ai_config.cloud_vision_enabled = true` AND `pii_protection_level =
 * 'permissive'` — the admin opt-in path per addendum §Tier 1.
 */
export async function assertCloudVisionAllowed(providerName: string): Promise<void> {
  const raw = await aiConfigService.getRawConfig();
  if (isSelfHostedProvider(providerName, { openaiCompatBaseUrl: raw.openaiCompatBaseUrl })) return;
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
  enrich_vendor: 'enrich_vendor',
  judgment_review: 'judgment_review',
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

// NOTE: processJob/completeJob/failJob are worker-internal and the caller is
// expected to already have verified access to `jobId` via its enclosing tenant
// context. They do NOT take tenantId because the worker dispatcher pulls jobs
// off an internal queue keyed by jobId alone. Tenant isolation is preserved
// because every user-facing endpoint that triggers AI work (ai.routes.ts,
// chat.routes.ts) already scopes the insert in enqueueJob() to req.tenantId.
// If these helpers ever become reachable from a user-controllable jobId path,
// add `tenantId` as a required argument and include it in the WHERE clause.
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
  // Some code paths (e.g. the keyword-first document classifier) synthesize
  // a CompletionResult with a pseudo-provider like 'local' that isn't
  // registered in getProvider(). Treat those as zero-cost rather than
  // letting the unknown-provider throw abort the whole job completion.
  let estimatedCost = '0';
  try {
    const rawConfig = await aiConfigService.getRawConfig();
    estimatedCost = String(getProvider(result.provider, rawConfig, result.model).estimateCost(result.inputTokens, result.outputTokens));
  } catch { /* unknown/pseudo provider → cost stays 0 */ }

  await db.update(aiJobs).set({
    status: 'complete',
    provider: result.provider,
    model: result.model,
    outputData,
    confidenceScore: String(confidenceScore),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCost,
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
