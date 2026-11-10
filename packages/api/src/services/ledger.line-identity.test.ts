// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Line identity across a full-replace edit (U-192, line-identity-v1): an
// in-progress reconciliation keeps its tick and the bank-file row its link
// when an entry is edited without touching its bank line; an amount change
// unticks (audited); an account change drops the worksheet row; completed
// reconciliations are never touched. U-199 (feed-entry-changed-v1, Q-PR5a):
// an amount or account change flags the bank-file row entry_changed_at.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, auditLog, transactions, journalLines, reconciliations, reconciliationLines,
  bankConnections, bankFeedItems, bankFeedAcceptGroups, bankFeedAcceptGroupItems, idempotencyKeys,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as reconciliation from './reconciliation.service.js';
import * as feed from './bank-feed.service.js';
import * as feedAccept from './bank-feed-accept.service.js';
import { pairLines } from './line-identity.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let tenantId = '';
let companyId = '';
let bankId = '';
let savingsId = '';
let expenseId = '';
let otherExpenseId = '';

beforeEach(async () => {
  connId = '';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [t] = await db.insert(tenants).values({ name: 'Line identity', slug: `line-identity-${stamp}` }).returning();
  tenantId = t!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Line identity Co' }).returning();
  companyId = co!.id;
  const mk = async (name: string, accountType: string, accountNumber: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber }).returning();
    return a!.id;
  };
  bankId = await mk('Checking', 'asset', '1010');
  savingsId = await mk('Savings', 'asset', '1020');
  expenseId = await mk('Supplies', 'expense', '6000');
  otherExpenseId = await mk('Office', 'expense', '6010');
});

afterEach(async () => {
  await db.delete(reconciliationLines).where(inArray(
    reconciliationLines.reconciliationId,
    db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId)),
  ));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(bankFeedAcceptGroupItems).where(eq(bankFeedAcceptGroupItems.tenantId, tenantId));
  await db.delete(bankFeedAcceptGroups).where(eq(bankFeedAcceptGroups.tenantId, tenantId));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

const expense = (amount: string, opts: { category?: string; bank?: string; memo?: string } = {}) => ({
  txnType: 'expense' as const,
  txnDate: '2026-03-10',
  memo: opts.memo ?? 'Paper',
  total: amount,
  lines: [
    { accountId: opts.category ?? expenseId, debit: amount, credit: '0' },
    { accountId: opts.bank ?? bankId, debit: '0', credit: amount },
  ],
});

async function bankLine(txnId: string, accountId = bankId): Promise<string> {
  const [l] = await db.select({ id: journalLines.id }).from(journalLines)
    .where(and(eq(journalLines.transactionId, txnId), eq(journalLines.accountId, accountId)));
  return l!.id;
}

let connId = '';
async function feedRow(amount: string, accountId = bankId): Promise<string> {
  let conn = connId && accountId === bankId ? connId : '';
  if (!conn) {
    const [c] = await db.insert(bankConnections).values({ tenantId, companyId, accountId, provider: 'manual' }).returning();
    conn = c!.id;
    if (accountId === bankId) connId = conn;
  }
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, companyId, bankConnectionId: conn, feedDate: '2026-03-10', amount, description: `ROW ${amount}`, status: 'pending',
  }).returning();
  return item!.id;
}

async function worksheet(reconId: string) {
  return db.select().from(reconciliationLines).where(eq(reconciliationLines.reconciliationId, reconId));
}

async function setup() {
  const txn = await ledger.postTransaction(tenantId, expense('40.0000'), undefined, companyId);
  const recon = await reconciliation.start(tenantId, bankId, '2026-03-31', '-40.00');
  const line = await bankLine(txn.id);
  await reconciliation.updateLines(tenantId, recon.id, [{ journalLineId: line, isCleared: true }]);
  const [conn] = await db.insert(bankConnections).values({ tenantId, companyId, accountId: bankId, provider: 'manual' }).returning();
  connId = conn!.id;
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-03-10', amount: '40.0000', description: 'PAPER',
    status: 'matched', matchedTransactionId: txn.id, matchedJournalLineId: line,
  }).returning();
  return { txn, recon, line, itemId: item!.id };
}

describe('line identity across a full-replace edit (U-192)', () => {
  it('a memo / category edit keeps the tick and the bank-file link', async () => {
    const { txn, recon, line, itemId } = await setup();
    await ledger.updateTransaction(tenantId, txn.id, expense('40.0000', { memo: 'Printer paper', category: otherExpenseId }), undefined, companyId);
    const newLine = await bankLine(txn.id);
    expect(newLine).not.toBe(line);
    const rows = await worksheet(recon.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.journalLineId).toBe(newLine);
    expect(rows[0]!.isCleared).toBe(true);
    const [item] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, itemId));
    expect(item!.matchedJournalLineId).toBe(newLine);
    const view = await reconciliation.getReconciliation(tenantId, recon.id);
    expect(view.differenceExact).toBe('0.0000');
  });

  it('an amount edit unticks (audited), flags the bank-file row and keeps the new line held (U-199)', async () => {
    const { txn, recon, line, itemId } = await setup();
    await ledger.updateTransaction(tenantId, txn.id, expense('45.0000'), undefined, companyId);
    const newLine = await bankLine(txn.id);
    expect(newLine).not.toBe(line);
    const rows = await worksheet(recon.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.journalLineId).toBe(newLine);
    expect(rows[0]!.isCleared).toBe(false);
    const [item] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, itemId));
    // Never a dead pointer: re-pointed to the new line, flagged, still accepted with its entry.
    expect(item!.matchedJournalLineId).toBe(newLine);
    expect(item!.entryChangedAt).not.toBeNull();
    expect(item!.status).toBe('matched');
    expect(item!.matchedTransactionId).toBe(txn.id);
    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'reconciliation'), eq(auditLog.entityId, recon.id)));
    const untick = audits.find((a) => JSON.stringify(a.afterData).includes('amount_changed'));
    expect(untick).toBeTruthy();
    const feedAudit = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_feed'), eq(auditLog.entityId, itemId)));
    const flagged = feedAudit.find((a) => (a.afterData as { action?: string } | null)?.action === 'entry_changed');
    expect(flagged?.beforeData).toMatchObject({ matchedJournalLineId: line });
    expect(flagged?.afterData).toMatchObject({ matchedJournalLineId: newLine, reason: 'amount_changed', transactionId: txn.id });

    // Another bank line of the new amount does not get the edited entry's line.
    const other = await feedRow('45.0000');
    expect(await feed.findMatchCandidates(tenantId, other)).toEqual([]);
    // The list and counts show the changed state.
    const listed = await feed.list(tenantId, { entryChanged: true, limit: 50, offset: 0 } as Parameters<typeof feed.list>[1]);
    expect(listed.data.map((r: { id: string }) => r.id)).toEqual([itemId]);
    expect((listed.data[0] as { entryChanged?: boolean }).entryChanged).toBe(true);
    expect((await feed.counts(tenantId)).entryChanged).toBe(1);
  });

  it('a flagged row is not a reconcile pre-check source and not fromBankFeed; Review again takes it back (U-199)', async () => {
    const { txn, recon, itemId } = await setup();
    await reconciliation.cancel(tenantId, recon.id);
    await ledger.updateTransaction(tenantId, txn.id, expense('45.0000'), undefined, companyId);
    const fresh = await reconciliation.start(tenantId, bankId, '2026-03-31', '-45.00', { precheck: 'bank_feed' });
    const view = await reconciliation.getReconciliation(tenantId, fresh.id);
    const lines = view.lines as Array<{ is_cleared?: boolean; isCleared?: boolean; fromBankFeed?: boolean }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.isCleared ?? lines[0]!.is_cleared).toBe(false);
    expect(lines[0]!.fromBankFeed).toBe(false);
    // Review again: back to waiting, unlinked, audited; the edited entry stays.
    const item = await feed.reviewAgain(tenantId, itemId, undefined, companyId);
    expect(item.status).toBe('pending');
    expect(item.matchedTransactionId).toBeNull();
    expect(item.matchedJournalLineId).toBeNull();
    expect(item.entryChangedAt).toBeNull();
    const [still] = await db.select().from(transactions).where(eq(transactions.id, txn.id));
    expect(still!.status).toBe('posted');
    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_feed'), eq(auditLog.entityId, itemId)));
    expect(audits.some((a) => (a.afterData as { action?: string } | null)?.action === 'review_again')).toBe(true);
    // The bank line can now be matched to the edited entry again once the amounts agree.
    expect(await feed.findMatchCandidates(tenantId, itemId)).toEqual([]);
  });

  it('an account move clears the line and flags the row; the entry is free to match on its new account (U-199)', async () => {
    const { txn, itemId } = await setup();
    await ledger.updateTransaction(tenantId, txn.id, expense('40.0000', { bank: savingsId }), undefined, companyId);
    const [item] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, itemId));
    expect(item!.matchedJournalLineId).toBeNull();
    expect(item!.entryChangedAt).not.toBeNull();
    expect(item!.matchedTransactionId).toBe(txn.id);
    // The flagged row no longer holds the whole entry (legacy branch): a Savings line of 40.00 finds it.
    const savingsRow = await feedRow('40.0000', savingsId);
    const c = await feed.findMatchCandidates(tenantId, savingsRow);
    expect(c.map((x) => x.journalLineId)).toEqual([await bankLine(txn.id, savingsId)]);
  });

  it('a row flagged with its line cleared (the 0273 backfill state) does not hold the entry; a legacy row still does', async () => {
    const { txn, itemId } = await setup();
    await db.update(bankFeedItems).set({ matchedJournalLineId: null, entryChangedAt: new Date() }).where(eq(bankFeedItems.id, itemId));
    const other = await feedRow('40.0000');
    expect((await feed.findMatchCandidates(tenantId, other)).map((x) => x.id)).toEqual([txn.id]);
    await db.update(bankFeedItems).set({ entryChangedAt: null }).where(eq(bankFeedItems.id, itemId));
    expect(await feed.findMatchCandidates(tenantId, other)).toEqual([]);
  });

  it('Undo of a match whose edited entry line was reconciled since is refused (U-199)', async () => {
    const txn = await ledger.postTransaction(tenantId, expense('40.0000'), undefined, companyId);
    const itemId = await feedRow('40.0000');
    // No onRecorded (as api-v2 and match-apply call it): the Undo record is still written.
    await feed.match(tenantId, itemId, txn.id, { companyId });
    await ledger.updateTransaction(tenantId, txn.id, expense('45.0000'), undefined, companyId);
    const recon = await reconciliation.start(tenantId, bankId, '2026-03-31', '-45.00');
    await reconciliation.updateLines(tenantId, recon.id, [{ journalLineId: await bankLine(txn.id), isCleared: true }]);
    await reconciliation.complete(tenantId, recon.id);
    const r = await feedAccept.undoFeedAccepts(tenantId, companyId, undefined, { feedItemIds: [itemId] });
    expect(r.undone).toEqual([]);
    expect(r.failures.map((f) => f.code)).toEqual(['FEED_UNDO_RECONCILED']);
  });

  it('a same-amount edit leaves the row unflagged (feed-entry-changed-v1 listed)', async () => {
    const { txn, itemId } = await setup();
    await ledger.updateTransaction(tenantId, txn.id, expense('40.0000', { memo: 'Memo only' }), undefined, companyId);
    const [item] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, itemId));
    expect(item!.entryChangedAt).toBeNull();
    expect(DESKTOP_CAPABILITIES).toContain('feed-entry-changed-v1');
  });

  it('an account change removes the worksheet row; refresh does not bring it back to this account', async () => {
    const { txn, recon } = await setup();
    await ledger.updateTransaction(tenantId, txn.id, expense('40.0000', { bank: savingsId }), undefined, companyId);
    expect(await worksheet(recon.id)).toHaveLength(0);
    const r = await reconciliation.refreshLines(tenantId, recon.id);
    expect(r).toEqual({ added: 0, removed: 0, prechecked: 0 });
  });

  it('leaves completed reconciliations alone (their entries cannot be replaced)', async () => {
    const { txn, recon } = await setup();
    await reconciliation.complete(tenantId, recon.id);
    const before = await worksheet(recon.id);
    await expect(ledger.updateTransaction(tenantId, txn.id, expense('45.0000'), undefined, companyId)).rejects.toThrow(/reconciliation/);
    // A category edit goes through the partial-edit path and keeps the line.
    await ledger.updateTransaction(tenantId, txn.id, expense('40.0000', { category: otherExpenseId }), undefined, companyId);
    expect(await worksheet(recon.id)).toEqual(before);
  });

  it('pairs only when one line per account and side exists on both sides', () => {
    const l = (id: string, accountId: string, debit: string, credit: string) => ({ id, accountId, debit, credit });
    const pairs = pairLines(
      [l('o1', 'bank', '0', '10'), l('o2', 'exp', '10', '0'), l('o3', 'exp2', '5', '0'), l('o4', 'exp2', '5', '0')],
      [l('n1', 'bank', '0', '12'), l('n2', 'exp', '12', '0'), l('n3', 'exp2', '10', '0')],
    );
    expect(pairs.get('o1')?.id).toBe('n1');
    expect(pairs.get('o2')?.id).toBe('n2');
    expect(pairs.has('o3')).toBe(false);
    expect(pairs.has('o4')).toBe(false);
    // Side matters: a money-in line never pairs with a money-out one.
    expect(pairLines([l('o', 'bank', '0', '10')], [l('n', 'bank', '10', '0')]).size).toBe(0);
  });

  it('does nothing when no reference names the old lines', async () => {
    const txn = await ledger.postTransaction(tenantId, expense('40.0000'), undefined, companyId);
    await ledger.updateTransaction(tenantId, txn.id, expense('41.0000'), undefined, companyId);
    const n = await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${tenantId} AND entity_type = 'reconciliation'`);
    expect((n.rows as Array<{ n: number }>)[0]!.n).toBe(0);
  });
});
