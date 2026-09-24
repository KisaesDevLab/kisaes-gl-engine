// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The dashboard's work-queue counts. Each one has to agree with the screen it
// sends the bookkeeper to, so these pin the predicates: what counts as
// uncategorized, as an open question, as an open document request, and as a
// statement still waiting to be checked.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { computeWorkQueue } from '../routes/dashboard.routes.js';
import { db } from '../db/index.js';
import {
  tenants, users, companies, accounts, transactions, journalLines, bankConnections,
  bankFeedItems, portalQuestions, portalContacts, documentRequests, aiJobs,
  tenantFeatureFlags, auditLog, sessions,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let tenantId = '';
let companyId = '';
let userId = '';
let suspenseId = '';
let contactId = '';

const summary = () => computeWorkQueue(tenantId);

beforeAll(async () => {
  const reg = await authService.register({
    email: `wq-${stamp}@example.com`, password: 'password123',
    displayName: 'Work Queue', companyName: 'Work Queue Co',
  });
  tenantId = reg.user.tenantId;
  userId = reg.user.id;
  const [co] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  companyId = co!.id;
  const [sus] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Suspense', accountType: 'expense',
    accountNumber: `89${stamp.slice(0, 3)}`, systemTag: 'suspense',
  }).returning();
  suspenseId = sus!.id;
  // register() may seed some of these already, so upsert rather than insert.
  for (const key of ['UNCATEGORIZED_REVIEW_V1', 'CLIENT_PORTAL_V1', 'RECURRING_DOC_REQUESTS_V1']) {
    await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: key, enabled: true })
      .onConflictDoUpdate({
        target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey],
        set: { enabled: true },
      });
  }
  const [pc] = await db.insert(portalContacts).values({
    tenantId, email: `wq-client-${stamp}@example.com`, status: 'active',
  }).returning();
  contactId = pc!.id;
});

afterAll(async () => {
  if (!tenantId) return;
  await db.delete(aiJobs).where(eq(aiJobs.tenantId, tenantId));
  await db.delete(documentRequests).where(eq(documentRequests.tenantId, tenantId));
  await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, tenantId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

beforeEach(async () => {
  await db.delete(aiJobs).where(eq(aiJobs.tenantId, tenantId));
  await db.delete(documentRequests).where(eq(documentRequests.tenantId, tenantId));
  await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
});

async function feedItem(status: string) {
  const [bank] = await db.select().from(accounts)
    .where(eq(accounts.tenantId, tenantId)).limit(1);
  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: bank!.id, provider: 'manual', institutionName: 'Bank',
  }).returning();
  await db.insert(bankFeedItems).values({
    tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-08-01',
    description: 'LINE', amount: '-10.0000', status,
  });
}

/** A transaction with one line parked in suspense. */
async function suspenseTxn(status: 'posted' | 'void') {
  const [t] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'expense', txnDate: '2026-08-01', status,
  }).returning();
  await db.insert(journalLines).values({
    tenantId, transactionId: t!.id, accountId: suspenseId, debit: '10.0000', credit: '0', lineOrder: 1,
  });
}

describe('dashboard work queue counts', () => {
  it('counts uncategorized as the two halves the screen shows', async () => {
    await feedItem('pending');
    await feedItem('categorized');   // already dealt with
    await suspenseTxn('posted');
    await suspenseTxn('void');       // voided entries are not work
    const wq = await summary();
    expect(wq.uncategorized).toEqual({ notPosted: 1, inSuspense: 1, total: 2 });
  });

  it('counts every unresolved question, matching the tab default', async () => {
    for (const status of ['open', 'viewed', 'responded', 'resolved']) {
      await db.insert(portalQuestions).values({
        tenantId, companyId, body: `q ${status}`, createdBy: userId, status,
      });
    }
    const wq = await summary();
    expect(wq.openQuestions).toBe(3);   // resolved is done
  });

  it('counts document requests asked for but not sent in', async () => {
    for (const status of ['pending', 'pending', 'submitted', 'cancelled']) {
      await db.insert(documentRequests).values({
        tenantId, contactId, documentType: 'bank_statement',
        description: 'Statement', periodLabel: '2026-08', status,
      });
    }
    const wq = await summary();
    expect(wq.openRequests).toBe(2);
  });

  it('counts statements read but not yet accepted', async () => {
    const mk = (status: string, importedAt: Date | null) => db.insert(aiJobs).values({
      tenantId, jobType: 'ocr_statement', status, importedAt,
    });
    await mk('complete', null);            // waiting for a human
    await mk('complete', new Date());      // already imported
    await mk('processing', null);          // still being read
    await mk('failed', null);              // not reviewable
    const wq = await summary();
    expect(wq.statementsPendingReview).toBe(1);
  });

  it('returns null for a count whose feature is off, not zero', async () => {
    await db.update(tenantFeatureFlags).set({ enabled: false })
      .where(eq(tenantFeatureFlags.tenantId, tenantId));
    try {
      const wq = await summary();
      // Null is "not turned on"; zero would read as "nothing to do".
      expect(wq.uncategorized).toBeNull();
      expect(wq.openQuestions).toBeNull();
      expect(wq.openRequests).toBeNull();
      // Statement review has no flag of its own, so it always answers.
      expect(wq.statementsPendingReview).toBe(0);
    } finally {
      await db.update(tenantFeatureFlags).set({ enabled: true })
        .where(eq(tenantFeatureFlags.tenantId, tenantId));
    }
  });
});
