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
import { evaluateStatementQuality } from './statement-routing.service.js';
import { eq, and } from 'drizzle-orm';

// Enable AI at the system level and opt `companyId` in to `task` with a
// current disclosure version. Mirrors the setup used by the budget test.
async function enableAiForCompany(userId: string, tenantId: string, companyId: string, task: string) {
  await aiConsent.acceptSystemDisclosure(userId);
  await aiConfigService.updateConfig({ isEnabled: true, monthlyBudgetLimit: 100 });
  const cfg = await aiConfigService.getRawConfig();
  const currentVersion = cfg.disclosureVersion ?? 1;
  await db.update(companies).set({
    aiEnabled: true,
    aiDisclosureAcceptedAt: new Date(),
    aiDisclosureAcceptedBy: userId,
    aiDisclosureVersion: currentVersion,
    aiEnabledTasks: { [task]: true },
  }).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
}

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

  it('should throw ai_disabled_globally when AI is disabled', async () => {
    const { user } = await createTestUser();
    const [item] = await db.insert(bankFeedItems).values({
      tenantId: user.tenantId,
      bankConnectionId: '00000000-0000-0000-0000-000000000000',
      feedDate: '2026-01-15',
      description: 'STARBUCKS STORE 123',
      amount: '5.50',
      status: 'pending',
    }).returning();

    await expect(aiCategorization.categorize(user.tenantId, item!.id))
      .rejects.toMatchObject({ statusCode: 400, code: 'ai_disabled_globally' });
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

    // Record user accepting. The history row is keyed by the CANONICAL
    // normalizePayeePattern form ("NEW VENDOR LLC" → "new vendor") — M12
    // pattern-key unification.
    await aiCategorization.recordUserDecision(user.tenantId, item!.id, expenseAccount.id, null, true, false);

    const history = await db.query.categorizationHistory.findFirst({
      where: and(eq(categorizationHistory.tenantId, user.tenantId), eq(categorizationHistory.payeePattern, 'new vendor')),
    });
    expect(history).toBeTruthy();
    expect(history!.timesConfirmed).toBe(1);
    expect(history!.timesOverridden).toBe(0);
    expect(history!.accountId).toBe(expenseAccount.id);
  });

  it('re-confirming the SAME learned account (even as "modified") increments confirmations', async () => {
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

    // First: record initial decision, then a "modified" decision that lands
    // on the SAME account — the learned mapping was right, so it counts as a
    // confirmation, not an override.
    await aiCategorization.recordUserDecision(user.tenantId, item!.id, expenseAccount.id, null, true, false);
    await aiCategorization.recordUserDecision(user.tenantId, item!.id, expenseAccount.id, null, false, true);

    const history = await db.query.categorizationHistory.findFirst({
      where: and(eq(categorizationHistory.tenantId, user.tenantId), eq(categorizationHistory.payeePattern, 'override test')),
    });
    expect(history!.timesConfirmed).toBe(2);
    expect(history!.timesOverridden).toBe(0);
  });

  it('H8: a decision that CHANGES the learned account resets confirmations to 1 and counts the override', async () => {
    const { user } = await createTestUser();
    const expenseAccounts = await db.query.accounts.findMany({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.accountType, 'expense')),
      limit: 2,
    });
    if (expenseAccounts.length < 2) return;
    const [accountA, accountB] = expenseAccounts;

    // Learned mapping with heavy confirmation weight on account A.
    await db.insert(categorizationHistory).values({
      tenantId: user.tenantId,
      payeePattern: 'reset test vendor',
      accountId: accountA!.id,
      timesConfirmed: 12,
      timesOverridden: 0,
    });
    const [item] = await db.insert(bankFeedItems).values({
      tenantId: user.tenantId,
      bankConnectionId: '00000000-0000-0000-0000-000000000000',
      feedDate: '2026-01-15',
      description: 'RESET TEST VENDOR',
      amount: '50.00',
      status: 'pending',
    }).returning();

    // The user corrects the pattern to account B. The 12 confirmations
    // belonged to account A — B starts at exactly one confirmation
    // (poisoning guard: one correction must not inherit A's trust).
    await aiCategorization.recordUserDecision(user.tenantId, item!.id, accountB!.id, null, true, true);

    const history = await db.query.categorizationHistory.findFirst({
      where: and(eq(categorizationHistory.tenantId, user.tenantId), eq(categorizationHistory.payeePattern, 'reset test vendor')),
    });
    expect(history!.accountId).toBe(accountB!.id);
    expect(history!.timesConfirmed).toBe(1);
    expect(history!.timesOverridden).toBe(1);
  });

  it('H8: recordUserDecision dual-reads a legacy-keyed row and re-keys it to the normalized pattern', async () => {
    const { user } = await createTestUser();
    const expenseAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.accountType, 'expense')),
    });
    if (!expenseAccount) return;

    // Legacy row keyed the OLD way: raw description lowercased, suffixes
    // kept ("legacy vendor llc" vs normalized "legacy vendor").
    await db.insert(categorizationHistory).values({
      tenantId: user.tenantId,
      payeePattern: 'legacy vendor llc',
      accountId: expenseAccount.id,
      timesConfirmed: 4,
      timesOverridden: 0,
    });
    const [item] = await db.insert(bankFeedItems).values({
      tenantId: user.tenantId,
      bankConnectionId: '00000000-0000-0000-0000-000000000000',
      feedDate: '2026-01-15',
      description: 'LEGACY VENDOR LLC',
      amount: '25.00',
      status: 'pending',
    }).returning();

    await aiCategorization.recordUserDecision(user.tenantId, item!.id, expenseAccount.id, null, true, false);

    // One row, migrated to the normalized key, confirmations accumulated.
    const rows = await db.query.categorizationHistory.findMany({
      where: eq(categorizationHistory.tenantId, user.tenantId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payeePattern).toBe('legacy vendor');
    expect(rows[0]!.timesConfirmed).toBe(5);
  });

  it('H8: layer-2 history is NOT used when the override rate is 20%+ (guard parity with suggestCategorization)', async () => {
    const { user } = await createTestUser();
    const expenseAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.accountType, 'expense')),
    });
    if (!expenseAccount) return;

    // Confirmed 4 times but overridden 2 (rate 1/3 ≥ 20%) — must NOT
    // auto-suggest from history any more. With AI unreachable past layer 2,
    // categorize() surfaces the AI-disabled error instead of a history hit.
    await db.insert(categorizationHistory).values({
      tenantId: user.tenantId,
      payeePattern: 'flaky vendor',
      accountId: expenseAccount.id,
      timesConfirmed: 4,
      timesOverridden: 2,
    });
    const [item] = await db.insert(bankFeedItems).values({
      tenantId: user.tenantId,
      bankConnectionId: '00000000-0000-0000-0000-000000000000',
      feedDate: '2026-01-15',
      description: 'FLAKY VENDOR',
      amount: '10.00',
      status: 'pending',
    }).returning();

    await expect(aiCategorization.categorize(user.tenantId, item!.id))
      .rejects.toMatchObject({ code: 'ai_disabled_globally' });
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

describe('H1 — statement auto-import quality gate', () => {
  const clean = {
    confidence: 0.9,
    reconciliation: { status: 'verified', repaired: false },
    suspectRows: [],
  };

  it('passes a clean, verified, high-confidence, un-repaired parse', () => {
    const gate = evaluateStatementQuality(clean);
    expect(gate.ok).toBe(true);
    expect(gate.reasons).toHaveLength(0);
  });

  it('holds when reconciliation is not verified', () => {
    const gate = evaluateStatementQuality({ ...clean, reconciliation: { status: 'discrepancy', repaired: false } });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/not verified/);
  });

  it('holds when the repair pass altered the data', () => {
    const gate = evaluateStatementQuality({
      ...clean,
      reconciliation: { status: 'verified', repaired: true, fixDescription: 'dropped row 3' },
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/repair pass altered/);
  });

  it('holds when confidence is below the 0.7 floor', () => {
    const gate = evaluateStatementQuality({ ...clean, confidence: 0.69 });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/below 0.7/);
  });

  it('holds when there are suspect rows', () => {
    const gate = evaluateStatementQuality({ ...clean, suspectRows: [{ index: 2 }] });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/suspect row/);
  });

  it('accumulates every failing reason', () => {
    const gate = evaluateStatementQuality({
      confidence: 0.1,
      reconciliation: { status: 'discrepancy', repaired: true, fixDescription: 'x' },
      suspectRows: [{ index: 0 }],
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe('H4 — previewCategorize governance (not a side door)', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('rejects with ai_disabled_globally when AI is off system-wide', async () => {
    await createTestUser();
    await expect(
      aiCategorization.previewCategorize('00000000-0000-0000-0000-000000000000', [
        { description: 'STARBUCKS', amount: '5.00' },
      ]),
    ).rejects.toMatchObject({ code: 'ai_disabled_globally' });
  });

  it('returns [] without touching config for an empty batch', async () => {
    const rows = await aiCategorization.previewCategorize('00000000-0000-0000-0000-000000000000', []);
    expect(rows).toEqual([]);
  });
});

describe('H7 — consent is scoped to the specific company', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('allows the opted-in company, blocks a sibling, and tenant-any still resolves', async () => {
    const { user } = await createTestUser();
    const companyA = await db.query.companies.findFirst({ where: eq(companies.tenantId, user.tenantId) });
    const [companyB] = await db.insert(companies).values({
      tenantId: user.tenantId,
      businessName: 'Sibling Co',
    }).returning();

    await enableAiForCompany(user.id, user.tenantId, companyA!.id, 'categorization');

    // The opted-in company passes.
    const a = await aiConsent.checkTenantTaskConsent(user.tenantId, 'categorization', companyA!.id);
    expect(a.allowed).toBe(true);
    expect(a.companyId).toBe(companyA!.id);

    // The sibling that never consented is blocked even though a tenant
    // sibling did opt in — this is the H7 fix.
    const b = await aiConsent.checkTenantTaskConsent(user.tenantId, 'categorization', companyB!.id);
    expect(b.allowed).toBe(false);

    // Tenant-any (no companyId) still finds the one opted-in company.
    const any = await aiConsent.checkTenantTaskConsent(user.tenantId, 'categorization');
    expect(any.allowed).toBe(true);
    expect(any.companyId).toBe(companyA!.id);
  });

  it('blocks a task the company did not toggle on even when another task is enabled', async () => {
    const { user } = await createTestUser();
    const companyA = await db.query.companies.findFirst({ where: eq(companies.tenantId, user.tenantId) });
    await enableAiForCompany(user.id, user.tenantId, companyA!.id, 'categorization');

    const res = await aiConsent.checkTenantTaskConsent(user.tenantId, 'report_summary', companyA!.id);
    expect(res.allowed).toBe(false);
  });
});
