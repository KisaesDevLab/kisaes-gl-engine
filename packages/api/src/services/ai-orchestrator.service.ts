import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiJobs, aiUsageLog } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { Semaphore } from '../utils/retry.js';
import * as aiConfigService from './ai-config.service.js';
import { executeWithFallback, getProvider } from './ai-providers/index.js';
import type { CompletionParams, CompletionResult, VisionParams } from './ai-providers/index.js';

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

export async function createJob(tenantId: string, jobType: string, inputType: string, inputId: string, inputData?: any) {
  const config = await aiConfigService.getConfig();
  if (!config.isEnabled) throw AppError.badRequest('AI processing is not enabled. Contact your administrator.');

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
