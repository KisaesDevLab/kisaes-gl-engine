// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// M8: a failed AI call still logs to ai_usage_log so the per-tenant monthly
// budget gate isn't blind to tokens burned by a failure (e.g. a full
// completion that then failed to parse).
// LOW: failJob is terminal (status 'failed'), never re-queued to 'pending'
// with no dispatcher to pick it back up.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, aiConfig, aiJobs, aiUsageLog } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as orchestrator from './ai-orchestrator.service.js';

let tenantId: string;

// Tenant-scoped cleanup — only ever touch this file's own tenant so
// concurrently-running suites' data survives.
async function cleanDb() {
  if (tenantId) {
    await db.delete(aiUsageLog).where(eq(aiUsageLog.tenantId, tenantId));
    await db.delete(aiJobs).where(eq(aiJobs.tenantId, tenantId));
  }
  // global table — no tenant column; suites share it by design
  await db.delete(aiConfig);
  if (!tenantId) return;
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function insertJob(overrides: Partial<typeof aiJobs.$inferInsert> = {}) {
  const [job] = await db.insert(aiJobs).values({
    tenantId,
    jobType: 'categorize',
    inputType: 'bank_feed_item',
    inputId: '00000000-0000-0000-0000-000000000001',
    status: 'processing',
    ...overrides,
  }).returning();
  return job!;
}

describe('failJob — usage logging + terminal status', () => {
  beforeEach(async () => {
    await cleanDb();
    const { user } = await authService.register({
      email: `failjob-${Date.now()}@example.com`,
      password: 'password123',
      displayName: 'FailJob Test',
      companyName: 'FailJob Co',
    });
    tenantId = user.tenantId;
  });
  afterEach(async () => { await cleanDb(); });

  it('M8: logs an ai_usage_log row with the tokens the failed call consumed', async () => {
    const job = await insertJob();
    await orchestrator.failJob(job.id, 'model returned non-JSON', {
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 120,
      outputTokens: 40,
    });

    const rows = await db.select().from(aiUsageLog).where(eq(aiUsageLog.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobType).toBe('categorize');
    expect(rows[0]!.inputTokens).toBe(120);
    expect(rows[0]!.outputTokens).toBe(40);
    expect(rows[0]!.provider).toBe('anthropic');
  });

  it('LOW: marks the job terminally failed (not re-queued to pending)', async () => {
    const job = await insertJob({ retryCount: 0, maxRetries: 3 });
    await orchestrator.failJob(job.id, 'boom');

    const updated = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, job.id) });
    expect(updated!.status).toBe('failed');
    expect(updated!.processingCompletedAt).not.toBeNull();
  });

  it('M8: still logs a (zero-cost) marker row when no usage is attributable', async () => {
    const job = await insertJob({ provider: null, model: null });
    await orchestrator.failJob(job.id, 'never reached the provider');

    const rows = await db.select().from(aiUsageLog).where(eq(aiUsageLog.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.estimatedCost)).toBe(0);
  });
});
