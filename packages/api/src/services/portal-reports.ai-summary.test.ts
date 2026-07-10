// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// AI executive-summary generation for Report Builder instances:
//   - grounded prompt carries the period + custom author instructions
//   - generated text is persisted (upsert) into report_ai_summaries
//   - usage is logged; drafts only; AI-disabled tenants get a clear error

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, aiConfig, aiJobs, aiUsageLog,
  auditLog, transactions, journalLines,
  reportTemplates, reportInstances, reportComments, reportAiSummaries, kpiDefinitions,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as aiConfigService from './ai-config.service.js';
import * as aiConsent from './ai-consent.service.js';
import * as providers from './ai-providers/index.js';
import * as svc from './portal-reports.service.js';

let tenantId: string;
let userId: string;
let companyId: string;

async function cleanDb() {
  await db.delete(reportAiSummaries);
  await db.delete(reportComments);
  await db.delete(reportInstances);
  await db.delete(reportTemplates);
  await db.delete(kpiDefinitions);
  await db.delete(aiUsageLog);
  await db.delete(aiJobs);
  await db.delete(aiConfig);
  await db.delete(auditLog);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function setup() {
  const reg = await authService.register({
    email: `report-ai-${Date.now()}@example.com`,
    password: 'password123456',
    displayName: 'Report AI Test',
    companyName: 'Report AI Co',
  });
  userId = reg.user.id;
  tenantId = reg.user.tenantId;
  const company = await db.query.companies.findFirst({
    where: eq(companies.tenantId, tenantId),
  });
  companyId = company!.id;
  await aiConsent.acceptSystemDisclosure(userId);
}

function mockProvider(text: string) {
  return vi.spyOn(providers, 'executeWithFallback').mockResolvedValue({
    text,
    inputTokens: 120,
    outputTokens: 60,
    model: 'claude-test',
    provider: 'anthropic',
    durationMs: 200,
  });
}

async function enableAi() {
  await aiConfigService.updateConfig({
    isEnabled: true,
    chatProvider: 'anthropic',
    chatModel: 'claude-test',
    anthropicApiKey: 'sk-test-fake-key',
  });
  // H6: generateAiSummary is now consent-gated — the instance's company must
  // have opted in to the 'report_summary' task with a current disclosure.
  const cfg = await aiConfigService.getRawConfig();
  await db.update(companies).set({
    aiEnabled: true,
    aiDisclosureAcceptedAt: new Date(),
    aiDisclosureAcceptedBy: userId,
    aiDisclosureVersion: cfg.disclosureVersion ?? 1,
    aiEnabledTasks: { report_summary: true },
  }).where(eq(companies.id, companyId));
}

async function makeInstance(): Promise<string> {
  const { id } = await svc.createInstance(tenantId, userId, {
    templateId: null,
    companyId,
    periodStart: '2026-04-01',
    periodEnd: '2026-06-30',
  });
  return id;
}

describe('generateAiSummary', () => {
  beforeEach(async () => {
    await cleanDb();
    await setup();
  });
  afterEach(async () => {
    await cleanDb();
    vi.restoreAllMocks();
  });

  it('rejects when AI processing is disabled', async () => {
    const id = await makeInstance();
    await expect(
      svc.generateAiSummary(tenantId, id, userId),
    ).rejects.toThrow(/AI processing is not enabled/i);
  });

  it('H6: rejects when the company has not opted in to the report_summary task', async () => {
    // System AI is on, but the company never enabled the report_summary
    // task — its report figures must not be sent to the provider.
    await aiConfigService.updateConfig({
      isEnabled: true,
      chatProvider: 'anthropic',
      chatModel: 'claude-test',
      anthropicApiKey: 'sk-test-fake-key',
    });
    const id = await makeInstance();
    const spy = mockProvider('should never run');
    await expect(
      svc.generateAiSummary(tenantId, id, userId),
    ).rejects.toMatchObject({ code: 'ai_consent_blocked' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('generates grounded text, persists it, and logs usage', async () => {
    await enableAi();
    const id = await makeInstance();
    const spy = mockProvider('The quarter closed with solid net income.');

    const result = await svc.generateAiSummary(tenantId, id, userId, {
      prompt: 'Focus on the cash position.',
      blockRef: 'blk-1',
    });

    expect(result.text).toBe('The quarter closed with solid net income.');
    expect(result.modelUsed).toBe('claude-test');
    expect(result.provider).toBe('anthropic');

    // Prompt is grounded: period + company + author instructions.
    expect(spy).toHaveBeenCalledTimes(1);
    const params = spy.mock.calls[0]![0];
    expect(params.responseFormat).toBe('text');
    expect(params.userPrompt).toContain('2026-04-01');
    expect(params.userPrompt).toContain('2026-06-30');
    expect(params.userPrompt).toContain('Report AI Co');
    expect(params.userPrompt).toContain('Focus on the cash position.');
    expect(params.userPrompt).toContain('Revenue:');
    expect(params.systemPrompt).toMatch(/never invent/i);

    // Persisted to report_ai_summaries under the blockRef.
    const rows = await db.select().from(reportAiSummaries)
      .where(eq(reportAiSummaries.instanceId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.generatedText).toBe('The quarter closed with solid net income.');
    expect(rows[0]!.blockRef).toBe('blk-1');
    expect(rows[0]!.modelUsed).toBe('claude-test');

    // Usage logged.
    const usage = await db.select().from(aiUsageLog).where(eq(aiUsageLog.tenantId, tenantId));
    expect(usage.length).toBe(1);
    expect(usage[0]!.jobType).toBe('report_summary');
    expect(usage[0]!.inputTokens).toBe(120);
  });

  it('regenerating for the same block upserts instead of accumulating rows', async () => {
    await enableAi();
    const id = await makeInstance();
    mockProvider('First draft.');
    await svc.generateAiSummary(tenantId, id, userId, { blockRef: 'blk-1' });
    vi.restoreAllMocks();
    const spy2 = mockProvider('Second draft.');

    const result = await svc.generateAiSummary(tenantId, id, userId, { blockRef: 'blk-1' });
    expect(result.text).toBe('Second draft.');
    // No custom prompt this time — the default instructions still apply.
    expect(spy2.mock.calls[0]![0].userPrompt).toContain('100 word summary of the financials');
    expect(spy2.mock.calls[0]![0].userPrompt).not.toContain('Author instructions');

    const rows = await db.select().from(reportAiSummaries)
      .where(eq(reportAiSummaries.instanceId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.generatedText).toBe('Second draft.');
  });

  it('refuses to generate on a published instance', async () => {
    await enableAi();
    const id = await makeInstance();
    await db.update(reportInstances).set({ status: 'published' }).where(eq(reportInstances.id, id));
    const spy = mockProvider('nope');
    await expect(
      svc.generateAiSummary(tenantId, id, userId),
    ).rejects.toThrow(/published/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces empty completions as an error instead of saving blank text', async () => {
    await enableAi();
    const id = await makeInstance();
    mockProvider('   ');
    await expect(
      svc.generateAiSummary(tenantId, id, userId),
    ).rejects.toThrow(/empty summary/i);
    const rows = await db.select().from(reportAiSummaries)
      .where(eq(reportAiSummaries.instanceId, id));
    expect(rows).toHaveLength(0);
  });
});
