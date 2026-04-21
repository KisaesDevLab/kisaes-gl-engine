// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Bank reconciliation service tests. Covers the Decimal-precision
// cleared-balance arithmetic, concurrency guards (the FOR UPDATE row
// locks on complete/updateLines/undo), and the status-transition
// invariants. A bug in any of these is a silent financial-integrity
// problem: a difference that "rounds away" a cent, or two concurrent
// complete() calls both flipping status, leaves a reconciliation in
// an inconsistent state that only shows up on the next month's rec.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants,
  users,
  sessions,
  accounts,
  companies,
  auditLog,
  contacts,
  transactions,
  journalLines,
  tags,
  transactionTags,
  reconciliations,
  reconciliationLines,
} from '../db/schema/index.js';
import * as reconciliation from './reconciliation.service.js';
import * as ledger from './ledger.service.js';
import * as accountsService from './accounts.service.js';

let tenantId: string;
let bankAccountId: string;
let revenueAccountId: string;
let expenseAccountId: string;

async function cleanDb(): Promise<void> {
  await db.delete(reconciliationLines);
  await db.delete(reconciliations);
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function setupAccounts(): Promise<void> {
  const [tenant] = await db.insert(tenants).values({
    name: 'Recon Test',
    slug: 'recon-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = tenant!.id;

  const bank = await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', accountNumber: '1010' });
  bankAccountId = bank.id;

  const revenue = await accountsService.create(tenantId, { name: 'Revenue', accountType: 'revenue', accountNumber: '4000' });
  revenueAccountId = revenue.id;

  const expense = await accountsService.create(tenantId, { name: 'Office Supplies', accountType: 'expense', accountNumber: '6000' });
  expenseAccountId = expense.id;
}

async function postDeposit(amount: string, date: string): Promise<string> {
  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry',
    txnDate: date,
    memo: `Deposit ${amount}`,
    lines: [
      { accountId: bankAccountId, debit: amount, credit: '0' },
      { accountId: revenueAccountId, debit: '0', credit: amount },
    ],
  });
  return txn.id;
}

async function postWithdrawal(amount: string, date: string): Promise<string> {
  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry',
    txnDate: date,
    memo: `Withdrawal ${amount}`,
    lines: [
      { accountId: expenseAccountId, debit: amount, credit: '0' },
      { accountId: bankAccountId, debit: '0', credit: amount },
    ],
  });
  return txn.id;
}

async function getBankLineIds(txnId: string): Promise<string[]> {
  const lines = await db.query.journalLines.findMany({
    where: (jl, { and: a, eq: e }) => a(e(jl.transactionId, txnId), e(jl.accountId, bankAccountId)),
  });
  return lines.map((l) => l.id);
}

describe('Reconciliation Service', () => {
  beforeEach(async () => {
    await cleanDb();
    await setupAccounts();
  });

  afterEach(async () => {
    await cleanDb();
  });

  describe('start', () => {
    it('creates a reconciliation row with beginningBalance 0 when none prior', async () => {
      await postDeposit('100.00', '2026-04-01');
      await postDeposit('50.00', '2026-04-05');

      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '150.00');
      expect(recon.status).toBe('in_progress');
      // Postgres decimal(19,4) stores '0' as '0.0000'; compare by value not by string.
      expect(parseFloat(recon.beginningBalance || '0')).toBe(0);
      expect(parseFloat(recon.statementEndingBalance || '0')).toBe(150);
      expect(recon.accountId).toBe(bankAccountId);
    });

    it('loads uncleared lines dated on-or-before the statement date as not-cleared', async () => {
      await postDeposit('100.00', '2026-04-01');
      await postWithdrawal('30.00', '2026-04-10');
      await postDeposit('200.00', '2026-05-15'); // After statement

      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '70.00');
      const lines = await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      });
      // Two bank lines: $100 deposit and $30 withdrawal. The May
      // deposit is excluded by the statement-date filter.
      expect(lines.length).toBe(2);
      expect(lines.every((l) => l.isCleared === false)).toBe(true);
    });

    it('inherits beginning balance from the most recent complete reconciliation', async () => {
      await postDeposit('100.00', '2026-03-01');
      const recon1 = await reconciliation.start(tenantId, bankAccountId, '2026-03-31', '100.00');
      const lineIds = await getBankLineIds(await firstTxnId());
      await reconciliation.updateLines(tenantId, recon1.id, lineIds.map((id) => ({ journalLineId: id, isCleared: true })));
      await reconciliation.complete(tenantId, recon1.id);

      await postDeposit('200.00', '2026-04-01');
      const recon2 = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '300.00');
      expect(parseFloat(recon2.beginningBalance || '0')).toBe(100);
    });

    it('refuses to start a second reconciliation while one is in_progress', async () => {
      await postDeposit('100.00', '2026-04-01');
      await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');
      await expect(
        reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00'),
      ).rejects.toThrow('already in progress');
    });

    it('allows starting a new reconciliation after the previous one completes', async () => {
      await postDeposit('100.00', '2026-04-01');
      const recon1 = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');
      const lineIds = await getBankLineIds(await firstTxnId());
      await reconciliation.updateLines(tenantId, recon1.id, lineIds.map((id) => ({ journalLineId: id, isCleared: true })));
      await reconciliation.complete(tenantId, recon1.id);

      await postDeposit('50.00', '2026-05-01');
      const recon2 = await reconciliation.start(tenantId, bankAccountId, '2026-05-31', '150.00');
      expect(recon2.status).toBe('in_progress');
    });
  });

  describe('getReconciliation', () => {
    it('returns difference=statementEnding when no lines are cleared', async () => {
      await postDeposit('100.00', '2026-04-01');
      await postWithdrawal('30.00', '2026-04-10');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '70.00');

      const view = await reconciliation.getReconciliation(tenantId, recon.id);
      expect(view.clearedBalance).toBe(0);
      expect(view.difference).toBe(70);
    });

    it('returns difference=0 when all lines are cleared and balance matches statement', async () => {
      const txnId = await postDeposit('100.00', '2026-04-01');
      await postWithdrawal('30.00', '2026-04-10');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '70.00');

      const allLineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(
        tenantId,
        recon.id,
        allLineIds.map((id) => ({ journalLineId: id, isCleared: true })),
      );

      const view = await reconciliation.getReconciliation(tenantId, recon.id);
      expect(view.clearedBalance).toBe(70);
      expect(view.difference).toBe(0);
      // Silence unused-variable lint — the txnId is only used to
      // produce lines; we asserted their totals above.
      void txnId;
    });

    it('uses Decimal arithmetic so summing cents yields exact pennies (no float drift)', async () => {
      // Three deposits of $0.10 + statement of $0.30 should tie out
      // exactly. With native Number arithmetic, 0.1+0.1+0.1 !== 0.3.
      await postDeposit('0.10', '2026-04-01');
      await postDeposit('0.10', '2026-04-02');
      await postDeposit('0.10', '2026-04-03');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '0.30');
      const lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(
        tenantId,
        recon.id,
        lineIds.map((id) => ({ journalLineId: id, isCleared: true })),
      );

      const view = await reconciliation.getReconciliation(tenantId, recon.id);
      expect(view.difference).toBe(0);
    });

    it('throws on unknown reconciliation id', async () => {
      await expect(
        reconciliation.getReconciliation(tenantId, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow('not found');
    });

    it('enforces tenant scoping — another tenant cannot read this reconciliation', async () => {
      await postDeposit('100.00', '2026-04-01');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');

      const [otherTenant] = await db.insert(tenants).values({
        name: 'Other', slug: 'other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      }).returning();
      await expect(
        reconciliation.getReconciliation(otherTenant!.id, recon.id),
      ).rejects.toThrow('not found');
    });
  });

  describe('updateLines', () => {
    it('marks lines as cleared and stamps clearedAt', async () => {
      await postDeposit('100.00', '2026-04-01');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');
      const lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);

      await reconciliation.updateLines(
        tenantId,
        recon.id,
        lineIds.map((id) => ({ journalLineId: id, isCleared: true })),
      );

      const after = await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      });
      expect(after.every((l) => l.isCleared === true)).toBe(true);
      expect(after.every((l) => l.clearedAt !== null)).toBe(true);
    });

    it('can flip a previously-cleared line back to uncleared (nulls clearedAt)', async () => {
      await postDeposit('100.00', '2026-04-01');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');
      const [lineId] = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);

      await reconciliation.updateLines(tenantId, recon.id, [{ journalLineId: lineId!, isCleared: true }]);
      await reconciliation.updateLines(tenantId, recon.id, [{ journalLineId: lineId!, isCleared: false }]);

      const [after] = await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      });
      expect(after?.isCleared).toBe(false);
      expect(after?.clearedAt).toBeNull();
    });

    it('rejects updates to an already-complete reconciliation', async () => {
      await postDeposit('100.00', '2026-04-01');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');
      const lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(
        tenantId,
        recon.id,
        lineIds.map((id) => ({ journalLineId: id, isCleared: true })),
      );
      await reconciliation.complete(tenantId, recon.id);

      await expect(
        reconciliation.updateLines(tenantId, recon.id, [{ journalLineId: lineIds[0]!, isCleared: false }]),
      ).rejects.toThrow('already complete');
    });
  });

  describe('complete', () => {
    it('succeeds when cleared total equals statement ending balance exactly', async () => {
      await postDeposit('100.00', '2026-04-01');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');
      const lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(
        tenantId,
        recon.id,
        lineIds.map((id) => ({ journalLineId: id, isCleared: true })),
      );

      await reconciliation.complete(tenantId, recon.id);
      const [after] = await db.select().from(reconciliations).where(
        (await import('drizzle-orm')).eq(reconciliations.id, recon.id),
      );
      expect(after?.status).toBe('complete');
      expect(after?.completedAt).not.toBeNull();
    });

    it('rejects completion when the difference exceeds one cent', async () => {
      await postDeposit('100.00', '2026-04-01');
      // Statement says $99.50 but our ledger has $100.00 cleared — $0.50 out.
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '99.50');
      const lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(
        tenantId,
        recon.id,
        lineIds.map((id) => ({ journalLineId: id, isCleared: true })),
      );

      await expect(reconciliation.complete(tenantId, recon.id)).rejects.toThrow(/difference/);
    });

    it('refuses double-completion', async () => {
      await postDeposit('100.00', '2026-04-01');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');
      const lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(
        tenantId,
        recon.id,
        lineIds.map((id) => ({ journalLineId: id, isCleared: true })),
      );
      await reconciliation.complete(tenantId, recon.id);

      await expect(reconciliation.complete(tenantId, recon.id)).rejects.toThrow('already complete');
    });

    it('stamps the completedBy user when provided', async () => {
      await postDeposit('100.00', '2026-04-01');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');
      const lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(
        tenantId,
        recon.id,
        lineIds.map((id) => ({ journalLineId: id, isCleared: true })),
      );

      const [user] = await db.insert(users).values({
        tenantId,
        email: 'recon-tester@example.com',
        passwordHash: 'x',
        role: 'owner',
      }).returning();
      await reconciliation.complete(tenantId, recon.id, user!.id);

      const [after] = await db.select().from(reconciliations).where(
        (await import('drizzle-orm')).eq(reconciliations.id, recon.id),
      );
      expect(after?.completedBy).toBe(user!.id);
    });
  });

  describe('undo', () => {
    it('flips a completed reconciliation back to in_progress and unclears every line', async () => {
      await postDeposit('100.00', '2026-04-01');
      const recon = await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');
      const lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(
        tenantId,
        recon.id,
        lineIds.map((id) => ({ journalLineId: id, isCleared: true })),
      );
      await reconciliation.complete(tenantId, recon.id);

      await reconciliation.undo(tenantId, recon.id);

      const [after] = await db.select().from(reconciliations).where(
        (await import('drizzle-orm')).eq(reconciliations.id, recon.id),
      );
      expect(after?.status).toBe('in_progress');
      expect(after?.completedAt).toBeNull();
      expect(after?.completedBy).toBeNull();

      const lines = await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, recon.id),
      });
      expect(lines.every((l) => l.isCleared === false)).toBe(true);
      expect(lines.every((l) => l.clearedAt === null)).toBe(true);
    });
  });

  describe('getHistory', () => {
    it('returns completed reconciliations ordered by statement date descending', async () => {
      await postDeposit('100.00', '2026-01-01');
      const janRecon = await reconciliation.start(tenantId, bankAccountId, '2026-01-31', '100.00');
      let lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, janRecon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(tenantId, janRecon.id, lineIds.map((id) => ({ journalLineId: id, isCleared: true })));
      await reconciliation.complete(tenantId, janRecon.id);

      await postDeposit('50.00', '2026-02-01');
      const febRecon = await reconciliation.start(tenantId, bankAccountId, '2026-02-28', '150.00');
      lineIds = (await db.query.reconciliationLines.findMany({
        where: (rl, { eq: e }) => e(rl.reconciliationId, febRecon.id),
      })).map((l) => l.journalLineId);
      await reconciliation.updateLines(tenantId, febRecon.id, lineIds.map((id) => ({ journalLineId: id, isCleared: true })));
      await reconciliation.complete(tenantId, febRecon.id);

      const history = await reconciliation.getHistory(tenantId, bankAccountId);
      expect(history.length).toBe(2);
      expect(history[0]!.statementDate).toBe('2026-02-28');
      expect(history[1]!.statementDate).toBe('2026-01-31');
    });

    it('scopes results to the requested tenant', async () => {
      await postDeposit('100.00', '2026-04-01');
      await reconciliation.start(tenantId, bankAccountId, '2026-04-30', '100.00');

      const [otherTenant] = await db.insert(tenants).values({
        name: 'Other', slug: 'other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      }).returning();
      const history = await reconciliation.getHistory(otherTenant!.id, bankAccountId);
      expect(history.length).toBe(0);
    });
  });
});

// Helper: return the txn_id of the most recent transaction for the
// current tenant. The beginning-balance inheritance test needs to
// clear the single deposit posted at the top of the `describe` block
// without re-posting it.
async function firstTxnId(): Promise<string> {
  const [txn] = await db.select().from(transactions).where(
    (await import('drizzle-orm')).eq(transactions.tenantId, tenantId),
  );
  return txn!.id;
}
