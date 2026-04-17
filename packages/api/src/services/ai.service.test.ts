// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, aiConfig, aiJobs, aiUsageLog, aiPromptTemplates, categorizationHistory, bankFeedItems } from '../db/schema/index.js';
import { auditLog } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as aiConfigService from './ai-config.service.js';
import * as aiCategorization from './ai-categorization.service.js';
import * as aiPrompt from './ai-prompt.service.js';
import * as aiOrchestrator from './ai-orchestrator.service.js';
import * as aiConsent from './ai-consent.service.js';
import { eq, and } from 'drizzle-orm';

async function cleanDb() {
  await db.delete(aiUsageLog);
  await db.delete(aiJobs);
  await db.delete(aiPromptTemplates);
  await db.delete(categorizationHistory);
  await db.delete(bankFeedItems);
  await db.delete(aiConfig);
  await db.delete(auditLog);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function createTestUser() {
  return authService.register({
    email: 'ai-test@example.com',
    password: 'password123',
    displayName: 'AI Test User',
    companyName: 'AI Test Co',
  });
}

describe('AI Config Service', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should create default config on first access', async () => {
    const config = await aiConfigService.getConfig();
    expect(config.isEnabled).toBe(false);
    expect(config.autoCategorizeOnImport).toBe(true);
    expect(config.categorizationConfidenceThreshold).toBe(0.7);
  });

  it('should update config', async () => {
    const { user } = await createTestUser();
    await aiConsent.acceptSystemDisclosure(user.id);
    await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });
    const config = await aiConfigService.getConfig();
    expect(config.isEnabled).toBe(true);
    expect(config.categorizationProvider).toBe('anthropic');
  });

  it('should encrypt API keys', async () => {
    await aiConfigService.updateConfig({ anthropicApiKey: 'sk-test-123' });
    const config = await aiConfigService.getConfig();
    expect(config.hasAnthropicKey).toBe(true);
    // Raw config should have encrypted value
    const raw = await aiConfigService.getRawConfig();
    expect(raw.anthropicApiKeyEncrypted).toBeTruthy();
    expect(raw.anthropicApiKeyEncrypted).not.toBe('sk-test-123');
  });
});

describe('AI Categorization Service', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should return null when AI is disabled', async () => {
    const { user } = await createTestUser();
    // Create a feed item manually
    const [item] = await db.insert(bankFeedItems).values({
      tenantId: user.tenantId,
      bankConnectionId: '00000000-0000-0000-0000-000000000000',
      feedDate: '2026-01-15',
      description: 'STARBUCKS STORE 123',
      amount: '5.50',
      status: 'pending',
    }).returning();

    const result = await aiCategorization.categorize(user.tenantId, item!.id);
    expect(result).toBeNull(); // AI not enabled
  });

  it('should use history when confirmed 3+ times', async () => {
    const { user } = await createTestUser();

    // Get an expense account from seeded COA
    const expenseAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.accountType, 'expense')),
    });
    if (!expenseAccount) return;

    // Create history entry with 3 confirmations
    await db.insert(categorizationHistory).values({
      tenantId: user.tenantId,
      payeePattern: 'starbucks store 123',
      accountId: expenseAccount.id,
      timesConfirmed: 3,
    });

    // Create a feed item
    const [item] = await db.insert(bankFeedItems).values({
      tenantId: user.tenantId,
      bankConnectionId: '00000000-0000-0000-0000-000000000000',
      feedDate: '2026-01-15',
      description: 'STARBUCKS STORE 123',
      amount: '5.50',
      status: 'pending',
    }).returning();

    // Enable AI but categorization should use history, not AI
    await aiConsent.acceptSystemDisclosure(user.id);
    await aiConfigService.updateConfig({ isEnabled: true, categorizationProvider: 'anthropic' });

    const result = await aiCategorization.categorize(user.tenantId, item!.id);
    expect(result).not.toBeNull();
    expect(result!.matchType).toBe('history');
    expect(result!.accountId).toBe(expenseAccount.id);
    expect(result!.confidence).toBe(0.95);
  });

  it('should record user decision in history', async () => {
    const { user } = await createTestUser();
    const expenseAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.accountType, 'expense')),
    });
    if (!expenseAccount) return;

    const [item] = await db.insert(bankFeedItems).values({
      tenantId: user.tenantId,
      bankConnectionId: '00000000-0000-0000-0000-000000000000',
      feedDate: '2026-01-15',
      description: 'NEW VENDOR LLC',
      amount: '100.00',
      status: 'pending',
    }).returning();

    // Record user accepting
    await aiCategorization.recordUserDecision(user.tenantId, item!.id, expenseAccount.id, null, true, false);

    const history = await db.query.categorizationHistory.findFirst({
      where: and(eq(categorizationHistory.tenantId, user.tenantId), eq(categorizationHistory.payeePattern, 'new vendor llc')),
    });
    expect(history).toBeTruthy();
    expect(history!.timesConfirmed).toBe(1);
    expect(history!.accountId).toBe(expenseAccount.id);
  });

  it('should increment override count on override', async () => {
    const { user } = await createTestUser();
    const expenseAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.accountType, 'expense')),
    });
    if (!expenseAccount) return;

    const [item] = await db.insert(bankFeedItems).values({
      tenantId: user.tenantId,
      bankConnectionId: '00000000-0000-0000-0000-000000000000',
      feedDate: '2026-01-15',
      description: 'OVERRIDE TEST',
      amount: '50.00',
      status: 'pending',
    }).returning();

    // First: record initial decision
    await aiCategorization.recordUserDecision(user.tenantId, item!.id, expenseAccount.id, null, true, false);
    // Then: record override
    await aiCategorization.recordUserDecision(user.tenantId, item!.id, expenseAccount.id, null, false, true);

    const history = await db.query.categorizationHistory.findFirst({
      where: and(eq(categorizationHistory.tenantId, user.tenantId), eq(categorizationHistory.payeePattern, 'override test')),
    });
    expect(history!.timesConfirmed).toBe(1);
    expect(history!.timesOverridden).toBe(1);
  });
});

describe('AI Prompt Template Service', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should create and list prompt templates', async () => {
    const prompt = await aiPrompt.createPrompt({
      taskType: 'categorize',
      systemPrompt: 'You are a bookkeeping assistant.',
      userPromptTemplate: 'Categorize: {{description}} | Amount: {{amount}}',
    });
    expect(prompt).toBeTruthy();
    expect(prompt!.version).toBe(1);
    expect(prompt!.isActive).toBe(true);

    const list = await aiPrompt.listPrompts();
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('should version prompts and deactivate old versions', async () => {
    await aiPrompt.createPrompt({ taskType: 'categorize', systemPrompt: 'v1', userPromptTemplate: 'v1' });
    const v2 = await aiPrompt.createPrompt({ taskType: 'categorize', systemPrompt: 'v2', userPromptTemplate: 'v2' });
    expect(v2!.version).toBe(2);

    const active = await aiPrompt.getActivePrompt('categorize');
    expect(active!.systemPrompt).toBe('v2');
  });

  it('should substitute variables in templates', () => {
    const result = aiPrompt.substituteVariables('Hello {{name}}, amount is {{amount}}', { name: 'Test', amount: '100' });
    expect(result).toBe('Hello Test, amount is 100');
  });
});

describe('AI Orchestrator — Budget Check', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should reject when budget exceeded', async () => {
    const { user } = await createTestUser();
    await aiConsent.acceptSystemDisclosure(user.id);
    await aiConfigService.updateConfig({ isEnabled: true, monthlyBudgetLimit: 0.01 });
    // Read the current disclosure version after enabling (it may have
    // been bumped by the re-consent trigger on false→true).
    const cfg = await aiConfigService.getRawConfig();
    const currentVersion = cfg.disclosureVersion ?? 1;
    // Opt the company in to categorization so the new consent gate
    // doesn't short-circuit the budget check we're testing.
    await db.update(companies).set({
      aiEnabled: true,
      aiDisclosureAcceptedAt: new Date(),
      aiDisclosureAcceptedBy: user.id,
      aiDisclosureVersion: currentVersion,
      aiEnabledTasks: { categorization: true, receipt_ocr: false, statement_parsing: false, document_classification: false },
    }).where(eq(companies.tenantId, user.tenantId));

    // Add usage that exceeds budget
    await db.insert(aiUsageLog).values({
      tenantId: user.tenantId,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      jobType: 'categorize',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: '0.02',
    });

    await expect(aiOrchestrator.createJob(user.tenantId, 'categorize', 'bank_feed_item', '00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/budget exceeded/);
  });
});
