// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// "Reprocess Rules" bulk action (bank feed):
//   - a Phase-4 conditional rule refreshes the suggestion fields on
//     matching pending items (suggestedAccountId / matchType / confidence)
//   - a legacy bank rule with autoConfirm posts the item via categorize(),
//     exactly as it would have at import time
//   - items no rule matches are LEFT UNTOUCHED — an existing AI
//     suggestion survives the reprocess
//   - non-pending items in an explicit selection are silently skipped
//   - the allPending path scopes to a bank connection when asked
//   - exactly one selector (feedItemIds XOR allPending) is required

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  bankConnections, bankFeedItems, bankRules, conditionalRules,
  conditionalRuleAudit, transactionClassificationState, transactions,
  journalLines, categorizationHistory,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';

let tenantId = '';
let userId = '';
let connectionId = '';
let bankAccountId = '';
let expenseAccountId = '';
let otherExpenseAccountId = '';

async function cleanDb() {
  if (!tenantId) return;
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

async function setup() {
  const { user } = await authService.register({
    email: `reprocess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Reprocess Test User',
    companyName: 'Reprocess Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;

  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  bankAccountId = bank!.id;

  const expenseRows = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')))
    .limit(2);
  expenseAccountId = expenseRows[0]!.id;
  otherExpenseAccountId = expenseRows[1]!.id;

  const [conn] = await db.insert(bankConnections).values({
    tenantId,
    accountId: bankAccountId,
    provider: 'manual',
    institutionName: 'Test Bank',
  }).returning();
  connectionId = conn!.id;
}

async function insertPendingItem(
  description: string,
  extra: Partial<typeof bankFeedItems.$inferInsert> = {},
): Promise<typeof bankFeedItems.$inferSelect> {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: connectionId,
    feedDate: '2026-06-15',
    description,
    originalDescription: description,
    amount: '25.0000',
    status: 'pending',
    ...extra,
  }).returning();
  return row!;
}

beforeEach(async () => {
  await cleanDb();
  await setup();
});

afterEach(async () => {
  await cleanDb();
});

describe('reprocessRules — selector validation', () => {
  it('rejects when neither feedItemIds nor allPending is given', async () => {
    await expect(bankFeedService.reprocessRules(tenantId, {})).rejects.toThrow(/exactly one/i);
  });

  it('rejects when both selectors are given', async () => {
    await expect(bankFeedService.reprocessRules(tenantId, {
      feedItemIds: [crypto.randomUUID()],
      allPending: true,
    })).rejects.toThrow(/exactly one/i);
  });
});

describe('reprocessRules — rules stages over pending items', () => {
  it('conditional rule refreshes suggestions, autoConfirm rule posts, unmatched item keeps its AI suggestion, non-pending skipped', async () => {
    // Conditional rule (Phase 4) — stages suggestedAccountId + matchType.
    await db.insert(conditionalRules).values({
      tenantId,
      scope: 'tenant_user',
      ownerUserId: userId,
      name: 'Coffee to Office Expense',
      priority: 100,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'coffee' },
      actions: [{ type: 'set_account', accountId: expenseAccountId }],
      active: true,
    });
    // Legacy bank rule with autoConfirm — posts via categorize().
    await db.insert(bankRules).values({
      tenantId,
      name: 'Auto-post utility bill',
      isActive: true,
      isGlobal: false,
      applyTo: 'both',
      descriptionContains: 'ZZQX UTILITY',
      assignAccountId: otherExpenseAccountId,
      autoConfirm: true,
      priority: 10,
    });

    const conditionalItem = await insertPendingItem('ZZQX COFFEE SHOP 001');
    const autoItem = await insertPendingItem('ZZQX UTILITY BILL 002');
    // Already carries an AI suggestion; matches no rule — must be untouched.
    const aiItem = await insertPendingItem('ZZQX NOMATCH VENDOR 003', {
      suggestedAccountId: otherExpenseAccountId,
      matchType: 'ai',
      confidenceScore: '0.87',
    });
    // Non-pending item in the selection — silently skipped.
    const doneItem = await insertPendingItem('ZZQX COFFEE SHOP 004', { status: 'excluded' });

    const result = await bankFeedService.reprocessRules(tenantId, {
      feedItemIds: [conditionalItem.id, autoItem.id, aiItem.id, doneItem.id],
    }, userId);

    expect(result).toEqual({
      processed: 3,
      matched: 2,
      autoCategorized: 1,
      suggestionsUpdated: 1,
      untouched: 1,
    });

    // Conditional match — suggestion fields refreshed, still pending.
    const cond = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, conditionalItem.id) });
    expect(cond!.status).toBe('pending');
    expect(cond!.suggestedAccountId).toBe(expenseAccountId);
    expect(cond!.matchType).toBe('rule');
    expect(cond!.confidenceScore).toBe('1.00');

    // autoConfirm match — posted exactly as at import.
    const auto = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, autoItem.id) });
    expect(auto!.status).toBe('categorized');
    expect(auto!.matchedTransactionId).toBeTruthy();
    const txn = await db.query.transactions.findFirst({
      where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, auto!.matchedTransactionId!)),
    });
    expect(txn).toBeDefined();
    expect(txn!.txnType).toBe('expense');
    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txn!.id)));
    expect(lines.some((l) => l.accountId === otherExpenseAccountId)).toBe(true);

    // No rule matched — the existing AI suggestion is preserved verbatim.
    const ai = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, aiItem.id) });
    expect(ai!.status).toBe('pending');
    expect(ai!.suggestedAccountId).toBe(otherExpenseAccountId);
    expect(ai!.matchType).toBe('ai');
    expect(ai!.confidenceScore).toBe('0.87');

    // Non-pending item untouched.
    const done = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, doneItem.id) });
    expect(done!.status).toBe('excluded');
    expect(done!.suggestedAccountId).toBeNull();

    // One summary audit entry for the action.
    const audits = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const summary = audits.find((a) => a.entityType === 'bank_feed');
    expect(summary).toBeDefined();
    // jsonb round-trips as an object.
    const after = summary!.afterData as { action?: string; processed?: number; autoCategorized?: number };
    expect(after.action).toBe('reprocess_rules');
    expect(after.processed).toBe(3);
    expect(after.autoCategorized).toBe(1);
  });

  it('allPending processes every pending item, optionally scoped to a connection', async () => {
    await db.insert(bankRules).values({
      tenantId,
      name: 'Suggest-only vendor rule',
      isActive: true,
      isGlobal: false,
      applyTo: 'both',
      descriptionContains: 'ZZQX VENDOR',
      assignAccountId: expenseAccountId,
      autoConfirm: false,
      priority: 10,
    });

    const [otherConn] = await db.insert(bankConnections).values({
      tenantId,
      accountId: bankAccountId,
      provider: 'manual',
      institutionName: 'Second Bank',
    }).returning();

    const a = await insertPendingItem('ZZQX VENDOR ALPHA');
    const b = await insertPendingItem('ZZQX VENDOR BETA');
    const c = await insertPendingItem('ZZQX VENDOR GAMMA', { bankConnectionId: otherConn!.id });

    // Scoped to the first connection: c is out of scope.
    const scoped = await bankFeedService.reprocessRules(tenantId, {
      allPending: true,
      bankConnectionId: connectionId,
    }, userId);
    expect(scoped.processed).toBe(2);
    expect(scoped.matched).toBe(2);
    expect(scoped.autoCategorized).toBe(0);
    expect(scoped.suggestionsUpdated).toBe(2);

    // Unscoped: all three connections' pending items (a and b are still
    // pending — the rule is suggest-only, it does not post).
    const all = await bankFeedService.reprocessRules(tenantId, { allPending: true }, userId);
    expect(all.processed).toBe(3);
    expect(all.matched).toBe(3);

    for (const id of [a.id, b.id, c.id]) {
      const row = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) });
      expect(row!.status).toBe('pending');
    }
  });

  it('rejects a bankConnectionId from another tenant', async () => {
    await expect(bankFeedService.reprocessRules(tenantId, {
      allPending: true,
      bankConnectionId: crypto.randomUUID(),
    })).rejects.toThrow(/not found/i);
  });
});
