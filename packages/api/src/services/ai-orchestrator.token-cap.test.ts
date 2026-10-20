// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// E6 step 40, server and desktop alike: the integer monthly token cap
// (U-29, ai_config.monthly_token_limit) in createJob, the integer usage
// summary by date range, usageOf(), error-message scrubbing in failJob,
// and the consent audit payload (U-30). Shared test database.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, aiConfig, aiJobs, aiUsageLog, auditLog, companies } from '../db/schema/index.js';
import { registerSecret, _resetSecretScrubberForTests } from '../utils/secret-scrubber.js';
import * as orchestrator from './ai-orchestrator.service.js';
import { assertWithinUsageCaps } from './ai-usage-caps.js';
import { executeWithFallback } from './ai-providers/index.js';
import { completeVisionWithFallback } from './ai-vision-fallback.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import * as aiConsent from './ai-consent.service.js';
import * as companyService from './company.service.js';

const SLUG = 'tokencap-test';
const OTHER = 'tokencap-other';
let tenantId = '';
let otherTenantId = '';
let userId = '';

async function cleanup(): Promise<void> {
  // ai_config.admin_disclosure_accepted_by references users: clear it first.
  await db.delete(aiConfig);
  for (const slug of [SLUG, OTHER]) {
    const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
    for (const t of rows) {
      await db.delete(aiJobs).where(eq(aiJobs.tenantId, t.id));
      await db.delete(aiUsageLog).where(eq(aiUsageLog.tenantId, t.id));
      await db.delete(auditLog).where(eq(auditLog.tenantId, t.id));
      await db.delete(companies).where(eq(companies.tenantId, t.id));
      await db.delete(users).where(eq(users.tenantId, t.id));
    }
    await db.delete(tenants).where(eq(tenants.slug, slug));
  }
}

async function usage(tenant: string, input: number, output: number, provider = 'anthropic', model = 'claude-x', jobType = 'categorize'): Promise<void> {
  await db.insert(aiUsageLog).values({ tenantId: tenant, provider, model, jobType, inputTokens: input, outputTokens: output, estimatedCost: '0' });
}

async function setConfig(patch: Partial<typeof aiConfig.$inferInsert>): Promise<void> {
  await db.delete(aiConfig);
  await db.insert(aiConfig).values({
    isEnabled: true, adminDisclosureAcceptedAt: new Date(), adminDisclosureAcceptedBy: userId,
    categorizationProvider: 'anthropic', ocrProvider: 'ollama', piiProtectionLevel: 'strict', cloudVisionEnabled: false, disclosureVersion: 1,
    ...patch,
  });
}

beforeAll(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({ name: 'Token Cap', slug: SLUG }).returning();
  const [o] = await db.insert(tenants).values({ name: 'Token Cap Other', slug: OTHER }).returning();
  tenantId = t!.id;
  otherTenantId = o!.id;
  const [u] = await db.insert(users).values({ tenantId, email: `${SLUG}@example.com`, passwordHash: 'x', displayName: 'U', role: 'owner', isSuperAdmin: true }).returning();
  userId = u!.id;
});

afterAll(async () => {
  await cleanup();
  _resetSecretScrubberForTests();
});

beforeEach(async () => {
  await db.delete(aiUsageLog).where(eq(aiUsageLog.tenantId, tenantId));
  await db.delete(aiUsageLog).where(eq(aiUsageLog.tenantId, otherTenantId));
  await db.delete(aiJobs).where(eq(aiJobs.tenantId, tenantId));
});

describe('monthly token cap (U-29)', () => {
  it('blocks createJob once this month\'s input + output tokens reach the limit; other tenants are unaffected', async () => {
    await setConfig({ monthlyTokenLimit: 100 });
    await usage(tenantId, 60, 39);
    // 99 < 100: allowed (the job type is outside the consent map on purpose).
    const job = await orchestrator.createJob(tenantId, 'token_cap_probe', 'test', crypto.randomUUID());
    expect(job.status).toBe('pending');
    await usage(tenantId, 1, 0);
    await expect(orchestrator.createJob(tenantId, 'token_cap_probe', 'test', crypto.randomUUID()))
      .rejects.toMatchObject({ statusCode: 400, code: 'ai_token_limit_exceeded' });
    // The other tenant has spent nothing.
    const other = await orchestrator.createJob(otherTenantId, 'token_cap_probe', 'test', crypto.randomUUID());
    expect(other.tenantId).toBe(otherTenantId);
    await db.delete(aiJobs).where(eq(aiJobs.tenantId, otherTenantId));
  });

  it('assertWithinUsageCaps: per tenant, or the sum over every tenant for a null tenant', async () => {
    await setConfig({ monthlyTokenLimit: 100 });
    await usage(tenantId, 60, 0);
    await usage(otherTenantId, 60, 0);
    await expect(assertWithinUsageCaps(tenantId)).resolves.toBeUndefined();
    await expect(assertWithinUsageCaps(null)).rejects.toMatchObject({ code: 'ai_token_limit_exceeded' });
    await setConfig({ monthlyBudgetLimit: '0.5000' });
    await db.insert(aiUsageLog).values({ tenantId, provider: 'anthropic', model: 'm', jobType: 'categorize', inputTokens: 1, outputTokens: 1, estimatedCost: '0.6000' });
    await expect(assertWithinUsageCaps(tenantId)).rejects.toThrow(/Monthly AI budget exceeded/);
    await expect(assertWithinUsageCaps(otherTenantId)).resolves.toBeUndefined();
  });

  it('desktop: executeWithFallback and completeVisionWithFallback apply the cap before any provider', async () => {
    loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: 'cap_' + 'c'.repeat(44), CL_BIND: '127.0.0.1:0', CL_DATA_DIR: os.tmpdir(), CL_OFFLINE: 'off' });
    try {
      await setConfig({ monthlyTokenLimit: 10 });
      await usage(tenantId, 10, 0);
      const params = { systemPrompt: 's', userPrompt: 'u', tenantId };
      await expect(executeWithFallback(params, {}, ['ollama'], 'ollama')).rejects.toMatchObject({ code: 'ai_token_limit_exceeded' });
      await expect(completeVisionWithFallback({ ...params, images: [] }, { rawConfig: {}, ocrProvider: 'ollama', primaryModel: 'llava' }))
        .rejects.toMatchObject({ code: 'ai_token_limit_exceeded' });
      // Another tenant is still allowed through to the providers (fails later for want of a server, not on the cap).
      const other = await executeWithFallback({ ...params, tenantId: otherTenantId }, { ollamaBaseUrl: 'http://127.0.0.1:1' }, ['ollama'], 'ollama').catch((e: { code?: string }) => e);
      expect((other as { code?: string }).code).toBe('ai_all_providers_failed');
    } finally {
      _resetDesktopProfileForTests();
    }
  });

  it('a null limit means no cap; 0 means no calls', async () => {
    await setConfig({ monthlyTokenLimit: null });
    await usage(tenantId, 1_000_000, 1_000_000);
    await expect(orchestrator.createJob(tenantId, 'token_cap_probe', 'test', crypto.randomUUID())).resolves.toBeTruthy();
    await setConfig({ monthlyTokenLimit: 0 });
    await expect(orchestrator.createJob(tenantId, 'token_cap_probe', 'test', crypto.randomUUID()))
      .rejects.toMatchObject({ code: 'ai_token_limit_exceeded' });
  });
});

describe('usage reporting (U-09)', () => {
  it('usageOf() is integer tokens with provider and model, nothing else', () => {
    expect(orchestrator.usageOf({ provider: 'openai', model: 'gpt-x', inputTokens: 12.9, outputTokens: -1 })).toEqual({
      provider: 'openai', model: 'gpt-x', inputTokens: 12, outputTokens: 0,
    });
  });

  it('getUsageSummaryByRange groups by provider/model/job type with integer totals and respects the range', async () => {
    await setConfig({});
    await usage(tenantId, 10, 5);
    await usage(tenantId, 20, 7);
    await usage(tenantId, 3, 1, 'ollama', 'llama3.2', 'ocr_receipt');
    await usage(otherTenantId, 999, 999);
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 60_000);
    const s = await orchestrator.getUsageSummaryByRange(tenantId, from, to);
    expect(s.rows).toEqual([
      { provider: 'anthropic', model: 'claude-x', jobType: 'categorize', calls: 2, inputTokens: 30, outputTokens: 12 },
      { provider: 'ollama', model: 'llama3.2', jobType: 'ocr_receipt', calls: 1, inputTokens: 3, outputTokens: 1 },
    ]);
    expect(s.totals).toEqual({ calls: 3, inputTokens: 33, outputTokens: 13 });
    expect(JSON.stringify(s)).not.toMatch(/cost/i);
    const empty = await orchestrator.getUsageSummaryByRange(tenantId, new Date(Date.now() + 120_000), new Date(Date.now() + 180_000));
    expect(empty.rows).toEqual([]);
    expect(empty.totals).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
  });
});

describe('error scrubbing', () => {
  it('failJob and failJobTerminal never store a registered secret or a key-shaped string', async () => {
    await setConfig({});
    registerSecret('session-secret-value-123');
    const [job] = await db.insert(aiJobs).values({ tenantId, jobType: 'categorize', inputType: 't', inputId: crypto.randomUUID(), status: 'processing' }).returning();
    await orchestrator.failJob(job!.id, 'provider said session-secret-value-123 and sk-ant-' + 'a'.repeat(30));
    let row = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, job!.id) });
    expect(row?.errorMessage).toBe('provider said [redacted] and [redacted]');
    const [job2] = await db.insert(aiJobs).values({ tenantId, jobType: 'ocr_statement', inputType: 't', inputId: crypto.randomUUID(), status: 'processing' }).returning();
    await orchestrator.failJobTerminal(job2!.id, 'Bearer abc.def.ghi failed for session-secret-value-123');
    row = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, job2!.id) });
    expect(row?.errorMessage).not.toContain('session-secret-value-123');
    expect(row?.errorMessage).toContain('[redacted]');
  });
});

describe('consent audit payload (U-30)', () => {
  it('system disclosure acceptance records the disclosure version and providers', async () => {
    await setConfig({ categorizationProvider: 'anthropic', chatProvider: 'openai', disclosureVersion: 3 });
    await aiConsent.acceptSystemDisclosure(userId);
    const [row] = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, '00000000-0000-0000-0000-000000000000'), eq(auditLog.entityType, 'ai_config_system_disclosure')))
      .orderBy(desc(auditLog.createdAt)).limit(1);
    expect(row?.afterData).toMatchObject({
      acceptedBy: userId, disclosureVersion: 3, provider: 'anthropic',
      providers: { categorization: 'anthropic', ocr: 'ollama', documentClassification: 'anthropic', chat: 'openai' },
    });
  });

  it('company consent acceptance records provider and disclosureVersion', async () => {
    await setConfig({ categorizationProvider: 'anthropic', disclosureVersion: 2 });
    const company = await companyService.createCompanyForTenant(tenantId, 'Audit Co');
    await aiConsent.acceptCompanyDisclosure(tenantId, company!.id, userId);
    const [row] = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'company_ai_consent_accepted')))
      .orderBy(desc(auditLog.createdAt)).limit(1);
    expect(row?.afterData).toMatchObject({ aiEnabled: true, version: 2, disclosureVersion: 2, provider: 'anthropic' });
    expect((row?.afterData as { providers: { ocr: string } }).providers.ocr).toBe('ollama');
  });
});
