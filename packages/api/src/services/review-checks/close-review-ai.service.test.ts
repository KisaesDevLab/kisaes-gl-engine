// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { tenants, companies, transactions, findings } from '../../db/schema/index.js';

const m = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  consent: { allowed: true },
  execute: vi.fn(),
}));
vi.mock('../ai-config.service.js', () => ({
  getConfig: async () => m.config,
  getRawConfig: async () => ({}),
  resolveTaskParams: () => ({ maxTokens: 700, temperature: 0.2 }),
  resolveTaskExec: () => ({ fallbackChain: [], enabled: true }),
}));
vi.mock('../ai-consent.service.js', () => ({ checkTenantTaskConsent: async () => m.consent }));
vi.mock('../ai-orchestrator.service.js', () => ({
  piiModeFor: () => 'strict',
  createJob: async () => ({ id: 'job-1' }),
  completeJob: async () => undefined,
  failJobTerminal: async () => undefined,
}));
vi.mock('../ai-providers/index.js', () => ({
  MYBOOKS_TASK_CLASSES: { CLOSE_REVIEW: 'mybooks_close_review' },
  executeWithFallback: (...a: unknown[]) => m.execute(...a),
}));

import { explainFinding, getFindingAi, closeReviewModel } from './close-review-ai.service.js';

let tenantId = '';
let findingId = '';
let txnId = '';

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'CRAI', slug: `crai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Co' }).returning();
  const [tx] = await db.insert(transactions).values({
    tenantId, companyId: c!.id, txnType: 'expense', txnDate: '2026-08-10', total: '1500.0000', status: 'posted',
  }).returning();
  txnId = tx!.id;
  const [f] = await db.insert(findings).values({
    tenantId, companyId: c!.id, checkKey: 'transaction_above_materiality', severity: 'med', status: 'open',
    transactionId: txnId, periodStart: '2026-08-01', periodEnd: '2026-09-01',
    payload: { summary: 'Aug 10 · $1,500', reason: 'At or above $1,000.' },
  }).returning();
  findingId = f!.id;
  m.config = { isEnabled: true, categorizationProvider: 'anthropic', categorizationModel: 'claude', taskOptions: {} };
  m.consent = { allowed: true };
  m.execute.mockReset().mockResolvedValue({
    parsed: { explanation: 'Large one-off purchase.', suggestedFix: 'Attach the invoice.', clientQuestion: 'What was this for?' },
    text: '', model: 'gpt-oss-120b', provider: 'digitalocean', inputTokens: 1, outputTokens: 1, durationMs: 1,
  });
});
afterEach(async () => {
  await db.delete(findings).where(eq(findings.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('close review AI', () => {
  it('uses the Close Review provider when set, else categorization', () => {
    expect(closeReviewModel({ categorizationProvider: 'anthropic', categorizationModel: 'claude', taskOptions: {} } as never))
      .toEqual({ provider: 'anthropic', model: 'claude' });
    expect(closeReviewModel({ categorizationProvider: 'anthropic', categorizationModel: 'claude', taskOptions: { close_review: { provider: 'digitalocean', model: 'gpt-oss' } } } as never))
      .toEqual({ provider: 'digitalocean', model: 'gpt-oss' });
    // A different provider with no model must not inherit categorization's model.
    expect(closeReviewModel({ categorizationProvider: 'anthropic', categorizationModel: 'claude', taskOptions: { close_review: { provider: 'digitalocean' } } } as never).model)
      .toBeUndefined();
  });

  it('explains a finding, stores it, and marks it out of date when the books change', async () => {
    const ai = await explainFinding(tenantId, findingId);
    expect(ai.explanation).toBe('Large one-off purchase.');
    expect(ai.clientQuestion).toBe('What was this for?');
    const call = m.execute.mock.calls[0]![0] as { taskClass: string; userPrompt: string };
    expect(call.taskClass).toBe('mybooks_close_review');
    expect(call.userPrompt).toMatch(/untrusted/);

    expect((await getFindingAi(tenantId, findingId)).stale).toBe(false);
    await db.update(transactions).set({ total: '1600.0000' }).where(eq(transactions.id, txnId));
    const after = await getFindingAi(tenantId, findingId);
    expect(after.ai?.explanation).toBe('Large one-off purchase.');
    expect(after.stale).toBe(true);
  });

  it('refuses without consent, with AI off, or without a provider', async () => {
    m.consent = { allowed: false };
    await expect(explainFinding(tenantId, findingId)).rejects.toThrow(/not agreed to AI review/);
    m.consent = { allowed: true };
    m.config = { ...m.config, isEnabled: false };
    await expect(explainFinding(tenantId, findingId)).rejects.toThrow(/AI is turned off/);
    m.config = { isEnabled: true, categorizationProvider: null, taskOptions: {} };
    await expect(explainFinding(tenantId, findingId)).rejects.toThrow(/No AI provider/);
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('reports a model failure plainly', async () => {
    m.execute.mockRejectedValue(new Error('upstream 503'));
    await expect(explainFinding(tenantId, findingId)).rejects.toThrow(/could not explain this item: upstream 503/);
  });
});
