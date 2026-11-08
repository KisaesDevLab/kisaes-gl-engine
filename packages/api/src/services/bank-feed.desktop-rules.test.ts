// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// feed-rules.desktop-never-posts (U-168, S6, Q-P26o): in desktop mode the
// rule stages never post (a legacy auto_confirm rule only stages its
// suggestion), and the suggestion carries the rule that staged it
// (suggested_rule_id / _kind, written in the same UPDATE, S3) for both rule
// kinds; classification rows of legacy rules get matched_bank_rule_id.
// Outside desktop mode an auto_confirm rule still posts (MyBooks Online).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const mode = vi.hoisted(() => ({ desktop: true }));
vi.mock('../desktop/profile.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../desktop/profile.js')>();
  return { ...orig, isDesktop: () => mode.desktop };
});
const ai = vi.hoisted(() => ({ batch: vi.fn(async () => new Map()) }));
vi.mock('./ai-categorization.service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./ai-categorization.service.js')>();
  return { ...orig, resolvePreAiLayers: async () => null, categorizeFeedItemsBatch: ai.batch };
});

import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, bankConnections, bankFeedItems, bankRules, conditionalRules,
  conditionalRuleAudit, transactionClassificationState, transactions, journalLines, categorizationHistory,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';

let tenantId = '';
let userId = '';
let connectionId = '';
let expenseId = '';
let otherExpenseId = '';

async function cleanDb() {
  if (!tenantId) return;
  await new Promise((r) => setTimeout(r, 50));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, tenantId));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
  await db.delete(bankRules).where(eq(bankRules.tenantId, tenantId));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  const { user } = await authService.register({
    email: `desk-rules-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Desk Rules', companyName: 'Desk Rules Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const expenses = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(2);
  expenseId = expenses[0]!.id;
  otherExpenseId = expenses[1]!.id;
  const [conn] = await db.insert(bankConnections).values({ tenantId, accountId: bank!.id, provider: 'manual' }).returning();
  connectionId = conn!.id;
  await db.insert(bankRules).values({
    tenantId, name: 'Auto-post utility', isActive: true, isGlobal: false, applyTo: 'both',
    descriptionContains: 'ZZQX UTILITY', assignAccountId: otherExpenseId, autoConfirm: true, priority: 10,
  });
  await db.insert(conditionalRules).values({
    tenantId, scope: 'tenant_user', ownerUserId: userId, name: 'Coffee', priority: 100,
    conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'coffee' },
    actions: [{ type: 'set_account', accountId: expenseId }], active: true,
  });
});

afterEach(async () => {
  mode.desktop = true;
  await cleanDb();
});

async function pending(description: string) {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: connectionId, feedDate: '2026-06-15', description, originalDescription: description,
    amount: '25.0000', status: 'pending',
  }).returning();
  return row!.id;
}
const get = async (id: string) => (await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) }))!;

describe('rules on desktop (U-168, S6)', () => {
  it('desktop mode: an auto_confirm rule only stages, attributed; nothing posts', async () => {
    const utility = await pending('ZZQX UTILITY BILL');
    const coffee = await pending('ZZQX COFFEE SHOP');
    const r = await bankFeedService.reprocessRules(tenantId, { feedItemIds: [utility, coffee] }, userId);
    expect(r.autoCategorized).toBe(0);
    const [rule] = await db.select().from(bankRules).where(eq(bankRules.tenantId, tenantId));
    const [cond] = await db.select().from(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
    const u = await get(utility);
    expect([u.status, u.suggestedAccountId, u.matchType, u.suggestedRuleId, u.suggestedRuleKind])
      .toEqual(['pending', otherExpenseId, 'rule', rule!.id, 'legacy']);
    const c = await get(coffee);
    expect([c.status, c.suggestedAccountId, c.suggestedRuleId, c.suggestedRuleKind]).toEqual(['pending', expenseId, cond!.id, 'conditional']);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).toHaveLength(0);
    const states = await db.select().from(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
    const byItem = new Map(states.map((s) => [s.bankFeedItemId, s]));
    expect([byItem.get(utility)?.matchedRuleId, byItem.get(utility)?.matchedBankRuleId]).toEqual([null, rule!.id]);
    expect([byItem.get(coffee)?.matchedRuleId, byItem.get(coffee)?.matchedBankRuleId]).toEqual([cond!.id, null]);
  });

  it('desktop mode: recleanse never calls AI', async () => {
    const id = await pending('ZZQX SOMETHING 123');
    ai.batch.mockClear();
    const r = await bankFeedService.bulkRecleanse(tenantId, [id]);
    expect(ai.batch).not.toHaveBeenCalled();
    expect(r.cleansing.disabled).toBe(1);
  });

  it('server mode (MyBooks Online): an auto_confirm rule still posts', async () => {
    mode.desktop = false;
    const utility = await pending('ZZQX UTILITY BILL');
    const r = await bankFeedService.reprocessRules(tenantId, { feedItemIds: [utility] }, userId);
    expect(r.autoCategorized).toBe(1);
    expect((await get(utility)).status).toBe('categorized');
  });
});
