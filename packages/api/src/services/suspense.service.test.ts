// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Suspense account: role adoption, and clearing amounts back out of it.
//
// The load-bearing case is the SPLIT one. clearSuspense deliberately uses
// bulkUpdateTransactions' source-move arguments rather than
// setCategoryAccountId, because the category path skips any transaction with
// more than one category line (reason: 'split'). If someone "simplifies"
// clearSuspense to setCategoryAccountId later, that test is what fails.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  transactions, journalLines, transactionTags, tags, contacts,
  reconciliations, reconciliationLines, attachments, bankConnections, bankFeedItems,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';
import * as suspense from './suspense.service.js';
import * as admin from './admin.service.js';
import {
  getOrCreateSystemAccount, findSystemAccountId, SUSPENSE_TAG,
  previewSuspenseConsolidation, consolidateIntoSuspense,
} from './system-accounts.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let bankAccountId = '';
let expenseAccountId = '';
let travelAccountId = '';

async function cleanDb() {
  if (!tenantId) return;
  const recs = await db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  for (const r of recs) await db.delete(reconciliationLines).where(eq(reconciliationLines.reconciliationId, r.id));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
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
    email: `suspense-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Suspense Test User',
    companyName: 'Suspense Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;

  const [bank] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '10999',
  }).returning();
  bankAccountId = bank!.id;
  const [exp] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Office Supplies', accountType: 'expense', accountNumber: '61010',
  }).returning();
  expenseAccountId = exp!.id;
  const [travel] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Travel', accountType: 'expense', accountNumber: '61020',
  }).returning();
  travelAccountId = travel!.id;
}

async function linesOf(txnId: string) {
  return db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));
}
async function balanceOf(accountId: string): Promise<number> {
  const [a] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)));
  return parseFloat(a!.balance ?? '0');
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('suspense account role', () => {
  it('adopts the seeded 89999 Uncategorized account instead of creating a second one', async () => {
    const seeded = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, '89999')));
    // The default COA template seeds it; if that ever changes the resolver
    // still has to produce an account, which the next assertion covers.
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const [acct] = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, suspenseId)));

    expect(acct!.systemTag).toBe(SUSPENSE_TAG);
    expect(acct!.isSystem).toBe(true);
    expect(acct!.accountType).toBe('other_expense');
    if (seeded.length === 1) {
      expect(suspenseId).toBe(seeded[0]!.id);
      const all89999 = await db.select().from(accounts)
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, '89999')));
      expect(all89999).toHaveLength(1);
    }
  });

  it('is idempotent and returns the same account on a second call', async () => {
    const a = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const b = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    expect(a).toBe(b);
  });

  it('creates the account with a null number when 89999 is taken by something else', async () => {
    // Remove the seeded row and squat on the number with a wrong-typed account
    // so neither adoption rule can match.
    await db.delete(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, '89999')));
    await db.insert(accounts).values({
      tenantId, companyId, name: 'Squatter', accountType: 'liability',
      detailType: 'other_current_liability', accountNumber: '89999',
    });

    const id = await getOrCreateSystemAccount(tenantId, SUSPENSE_TAG, companyId, userId);
    const [acct] = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id)));
    expect(acct!.accountNumber).toBeNull();
    expect(acct!.systemTag).toBe(SUSPENSE_TAG);
    expect(acct!.accountType).toBe('other_expense');
  });

  it('never adopts an account that already holds a different system role', async () => {
    await db.delete(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, '89999')));
    await db.insert(accounts).values({
      tenantId, companyId, name: 'Uncategorized', accountType: 'other_expense',
      detailType: 'other_expense', accountNumber: '89999',
      isSystem: true, systemTag: 'cash_over_short',
    });
    const id = await getOrCreateSystemAccount(tenantId, SUSPENSE_TAG, companyId, userId);
    const [acct] = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id)));
    expect(acct!.systemTag).toBe(SUSPENSE_TAG);
    // The cash_over_short account kept its role.
    const stolen = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'cash_over_short')));
    expect(stolen).toHaveLength(1);
  });
});

describe('clearSuspense', () => {
  it('clears a SPLIT transaction carrying two suspense lines', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);

    // A $100 payment split across two unclassified lines.
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense',
      txnDate: '2026-05-01',
      lines: [
        { accountId: suspenseId, debit: '60.00', credit: '0' },
        { accountId: suspenseId, debit: '40.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '100.00' },
      ],
    }, userId, companyId);

    expect(await balanceOf(suspenseId)).toBe(100);

    const res = await suspense.clearSuspense(tenantId, [txn.id], expenseAccountId, userId, companyId);
    expect(res.updated).toBe(1);
    expect(res.skipped).toHaveLength(0);

    const lines = await linesOf(txn.id);
    expect(lines.some((l) => l.accountId === suspenseId)).toBe(false);
    const moved = lines.filter((l) => l.accountId === expenseAccountId);
    expect(moved).toHaveLength(2);

    expect(await balanceOf(suspenseId)).toBe(0);
    expect(await balanceOf(expenseAccountId)).toBe(100);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });

  it('clears a simple single-line transaction', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense',
      txnDate: '2026-05-02',
      lines: [
        { accountId: suspenseId, debit: '25.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '25.00' },
      ],
    }, userId, companyId);

    const res = await suspense.clearSuspense(tenantId, [txn.id], travelAccountId, userId, companyId);
    expect(res.updated).toBe(1);
    expect(await balanceOf(suspenseId)).toBe(0);
    expect(await balanceOf(travelAccountId)).toBe(25);
    expect(await suspense.hasSuspenseLine(tenantId, txn.id)).toBe(false);
  });

  it('handles a money-IN amount without inverting the sign', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const [income] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Consulting Income', accountType: 'revenue', accountNumber: '41010',
    }).returning();

    // An unidentified deposit: bank debited, suspense credited.
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'deposit',
      txnDate: '2026-05-03',
      lines: [
        { accountId: bankAccountId, debit: '500.00', credit: '0' },
        { accountId: suspenseId, debit: '0', credit: '500.00' },
      ],
    }, userId, companyId);

    expect(await balanceOf(suspenseId)).toBe(-500);
    await suspense.clearSuspense(tenantId, [txn.id], income!.id, userId, companyId);

    expect(await balanceOf(suspenseId)).toBe(0);
    expect(await balanceOf(income!.id)).toBe(-500);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });

  it('refuses a system account as the destination', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-05-04',
      lines: [
        { accountId: suspenseId, debit: '10.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '10.00' },
      ],
    }, userId, companyId);

    const ar = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')));
    await expect(
      suspense.clearSuspense(tenantId, [txn.id], ar[0]!.id, userId, companyId),
    ).rejects.toThrow(/system account/i);
  });

  it('refuses the suspense account as its own destination', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    await expect(
      suspense.clearSuspense(tenantId, ['00000000-0000-0000-0000-000000000001'], suspenseId, userId, companyId),
    ).rejects.toThrow(/other than the suspense account/i);
  });

  it('skips a locked period and reports the reason rather than moving money', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-01-15',
      lines: [
        { accountId: suspenseId, debit: '75.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '75.00' },
      ],
    }, userId, companyId);

    await db.update(companies).set({ lockDate: '2026-03-31' })
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));

    await expect(
      suspense.clearSuspense(tenantId, [txn.id], expenseAccountId, userId, companyId),
    ).rejects.toThrow(/locked/i);

    // The money did not move.
    expect(await balanceOf(suspenseId)).toBe(75);
  });

  it('reports a partial batch instead of failing it', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const good = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-06-01',
      lines: [
        { accountId: suspenseId, debit: '10.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '10.00' },
      ],
    }, userId, companyId);
    // A transaction with no suspense line at all.
    const unrelated = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-06-02',
      lines: [
        { accountId: travelAccountId, debit: '20.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '20.00' },
      ],
    }, userId, companyId);

    const res = await suspense.clearSuspense(
      tenantId, [good.id, unrelated.id], expenseAccountId, userId, companyId,
    );
    expect(res.updated).toBe(1);
    expect(res.skipped).toEqual([{ id: unrelated.id, reason: 'no_line_on_account' }]);
  });
});

describe('suspense listing', () => {
  it('summarises the balance and counts, without minting the account', async () => {
    const before = await suspense.getSuspenseSummary(tenantId, companyId);
    // Reading the page must not create the account as a side effect.
    expect(before.suspenseAccountId).toBe(await findSystemAccountId(tenantId, SUSPENSE_TAG));

    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-07-01',
      lines: [
        { accountId: suspenseId, debit: '30.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '30.00' },
      ],
    }, userId, companyId);

    const after = await suspense.getSuspenseSummary(tenantId, companyId);
    expect(after.suspenseAccountId).toBe(suspenseId);
    expect(parseFloat(after.balance)).toBe(30);
    expect(after.transactionCount).toBe(1);

    const listed = await suspense.listInSuspense(tenantId, { companyId });
    expect(listed.total).toBe(1);
    expect(listed.rows[0]!.amount).toContain('30');
    expect(listed.rows[0]!.suspenseLineCount).toBe(1);
    expect(listed.rows[0]!.isSplit).toBe(false);
  });

  it('flags a split entry so the UI can warn that all its suspense lines clear together', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-07-02',
      lines: [
        { accountId: suspenseId, debit: '60.00', credit: '0' },
        { accountId: travelAccountId, debit: '40.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '100.00' },
      ],
    }, userId, companyId);

    const listed = await suspense.listInSuspense(tenantId, { companyId });
    expect(listed.rows[0]!.isSplit).toBe(true);
    expect(listed.rows[0]!.suspenseLineCount).toBe(1);
  });

  it('excludes voided transactions', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-07-03',
      lines: [
        { accountId: suspenseId, debit: '15.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '15.00' },
      ],
    }, userId, companyId);
    await ledger.voidTransaction(tenantId, txn.id, 'test void', userId);

    const listed = await suspense.listInSuspense(tenantId, { companyId });
    expect(listed.total).toBe(0);
    const summary = await suspense.getSuspenseSummary(tenantId, companyId);
    expect(summary.transactionCount).toBe(0);
  });
});

describe('consolidating look-alike accounts into suspense', () => {
  it('previews candidates without moving anything', async () => {
    await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const [stray] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Ask My Accountant',
      accountType: 'other_expense', detailType: 'other_expense', accountNumber: '89998',
    }).returning();

    const preview = await previewSuspenseConsolidation(tenantId);
    const ids = preview.candidates.map((c) => c.id);
    expect(ids).toContain(stray!.id);
    // The tagged account is never a candidate for folding into itself.
    expect(ids).not.toContain(preview.suspenseAccountId);
    // A preview moves nothing.
    expect(await balanceOf(stray!.id)).toBe(0);
  });

  it('moves the lines and the balance, then deactivates the emptied account', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const [stray] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Uncategorised (old)',
      accountType: 'other_expense', detailType: 'other_expense', accountNumber: '89997',
    }).returning();

    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-04-01',
      lines: [
        { accountId: stray!.id, debit: '40.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '40.00' },
      ],
    }, userId, companyId);
    expect(await balanceOf(stray!.id)).toBe(40);

    const res = await consolidateIntoSuspense(tenantId, [stray!.id], userId);
    expect(res.moved).toEqual([{ accountId: stray!.id, lines: 1, deactivated: true }]);
    expect(res.skipped).toEqual([]);

    expect(await balanceOf(stray!.id)).toBe(0);
    expect(await balanceOf(suspenseId)).toBe(40);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);

    const [after] = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, stray!.id)));
    expect(after!.isActive).toBe(false);
  });

  it('refuses to touch lines inside a locked period', async () => {
    await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const [stray] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Suspense (legacy)',
      accountType: 'other_expense', detailType: 'other_expense', accountNumber: '89996',
    }).returning();
    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-01-10',
      lines: [
        { accountId: stray!.id, debit: '15.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '15.00' },
      ],
    }, userId, companyId);
    await db.update(companies).set({ lockDate: '2026-03-31' })
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));

    const res = await consolidateIntoSuspense(tenantId, [stray!.id], userId);
    expect(res.moved).toEqual([]);
    expect(res.skipped).toEqual([{ accountId: stray!.id, reason: 'locked' }]);
    expect(await balanceOf(stray!.id)).toBe(15);
  });

  it('never folds an account that holds another system role', async () => {
    await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const ar = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')));
    const res = await consolidateIntoSuspense(tenantId, [ar[0]!.id], userId);
    expect(res.skipped).toEqual([{ accountId: ar[0]!.id, reason: 'is_system_role' }]);
  });
});

// ── The three gaps fixed on 2026-09-04 ──────────────────────────

describe('gap 1: re-pointing the suspense role must not strand a balance', () => {
  async function seedSuspenseWithMoney(amount = '90.00') {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-05-01',
      lines: [
        { accountId: suspenseId, debit: amount, credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: amount },
      ],
    }, userId, companyId);
    const [replacement] = await db.insert(accounts).values({
      tenantId, companyId, name: 'New Suspense',
      accountType: 'other_expense', detailType: 'other_expense', accountNumber: '89001',
    }).returning();
    return { suspenseId, replacementId: replacement!.id };
  }

  it('REFUSES by default, naming the balance at stake', async () => {
    const { suspenseId, replacementId } = await seedSuspenseWithMoney();
    await expect(
      admin.assignSystemAccount(tenantId, SUSPENSE_TAG, replacementId, userId),
    ).rejects.toMatchObject({ code: 'SYSTEM_ACCOUNT_BALANCE_STRANDED' });

    // Nothing moved and the role did not change.
    expect(await findSystemAccountId(tenantId, SUSPENSE_TAG)).toBe(suspenseId);
    expect(await balanceOf(suspenseId)).toBe(90);
  });

  it("moves the balance with the role when asked", async () => {
    const { suspenseId, replacementId } = await seedSuspenseWithMoney();
    await admin.assignSystemAccount(tenantId, SUSPENSE_TAG, replacementId, userId, { balanceAction: 'move' });

    expect(await findSystemAccountId(tenantId, SUSPENSE_TAG)).toBe(replacementId);
    expect(await balanceOf(suspenseId)).toBe(0);
    expect(await balanceOf(replacementId)).toBe(90);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);

    // And the screen still sees it — the whole point of the fix.
    const summary = await suspense.getSuspenseSummary(tenantId, companyId);
    expect(summary.suspenseAccountId).toBe(replacementId);
    expect(parseFloat(summary.balance)).toBe(90);
    expect(summary.transactionCount).toBe(1);
  });

  it('strands it only when the operator says so explicitly', async () => {
    const { suspenseId, replacementId } = await seedSuspenseWithMoney();
    await admin.assignSystemAccount(tenantId, SUSPENSE_TAG, replacementId, userId, { balanceAction: 'leave' });

    expect(await findSystemAccountId(tenantId, SUSPENSE_TAG)).toBe(replacementId);
    expect(await balanceOf(suspenseId)).toBe(90);
    expect(parseFloat((await suspense.getSuspenseSummary(tenantId, companyId)).balance)).toBe(0);
  });

  it('refuses to MOVE lines that are locked, rather than forcing them', async () => {
    const { replacementId } = await seedSuspenseWithMoney();
    await db.update(companies).set({ lockDate: '2026-12-31' })
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));

    await expect(
      admin.assignSystemAccount(tenantId, SUSPENSE_TAG, replacementId, userId, { balanceAction: 'move' }),
    ).rejects.toMatchObject({ code: 'SYSTEM_ACCOUNT_BALANCE_UNMOVABLE' });
  });

  it('still assigns freely when the outgoing account is empty', async () => {
    const original = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const [replacement] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Fresh Suspense',
      accountType: 'other_expense', detailType: 'other_expense', accountNumber: '89002',
    }).returning();
    await admin.assignSystemAccount(tenantId, SUSPENSE_TAG, replacement!.id, userId);
    expect(await findSystemAccountId(tenantId, SUSPENSE_TAG)).toBe(replacement!.id);
    void original;
  });
});

describe('gap 2: the firm chooses whether suspense sits on the P&L or the balance sheet', () => {
  it('accepts a balance-sheet account', async () => {
    await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const [bs] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Suspense (asset)',
      accountType: 'asset', detailType: 'other_current_asset', accountNumber: '19999',
    }).returning();

    await admin.assignSystemAccount(tenantId, SUSPENSE_TAG, bs!.id, userId);
    expect(await findSystemAccountId(tenantId, SUSPENSE_TAG)).toBe(bs!.id);

    // And it still works end to end as the holding account.
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-06-01',
      lines: [
        { accountId: bs!.id, debit: '20.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '20.00' },
      ],
    }, userId, companyId);
    const res = await suspense.clearSuspense(tenantId, [txn.id], expenseAccountId, userId, companyId);
    expect(res.updated).toBe(1);
    expect(await balanceOf(bs!.id)).toBe(0);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });

  it('still refuses a bank, credit-card or A/R account', async () => {
    await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const [card] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Amex', accountType: 'liability',
      detailType: 'credit_card', accountNumber: '21999',
    }).returning();

    await expect(admin.assignSystemAccount(tenantId, SUSPENSE_TAG, bankAccountId, userId))
      .rejects.toThrow(/bank account cannot be/i);
    await expect(admin.assignSystemAccount(tenantId, SUSPENSE_TAG, card!.id, userId))
      .rejects.toThrow(/credit card account cannot be/i);
  });

  it('still refuses a type no suspense account could be', async () => {
    await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const [eq_] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Owner Equity', accountType: 'equity', accountNumber: '39999',
    }).returning();
    await expect(admin.assignSystemAccount(tenantId, SUSPENSE_TAG, eq_!.id, userId))
      .rejects.toMatchObject({ code: 'SYSTEM_TAG_TYPE_MISMATCH' });
  });

  it('leaves every other role locked to its single type', async () => {
    const info = await admin.getSystemAccountsInfo(tenantId);
    for (const role of info.roles) {
      if (role.tag === 'suspense') {
        expect(role.allowedAccountTypes.length).toBeGreaterThan(1);
        expect(role.tenantAssignable).toBe(true);
      } else {
        expect(role.allowedAccountTypes).toEqual([role.accountType]);
        expect(role.tenantAssignable).toBe(false);
      }
    }
  });
});

describe('attachments on suspense rows', () => {
  async function attach(attachableType: string, attachableId: string, fileName: string) {
    await db.insert(attachments).values({
      tenantId, fileName, filePath: `/uploads/${fileName}`,
      attachableType, attachableId, mimeType: 'image/jpeg', fileSize: 1234,
    });
  }

  it('counts files attached directly to the posted transaction', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-08-01',
      lines: [
        { accountId: suspenseId, debit: '12.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '12.00' },
      ],
    }, userId, companyId);

    let listed = await suspense.listInSuspense(tenantId, { companyId });
    expect(listed.rows[0]!.attachmentCount).toBe(0);
    // The key is the transaction's OWN txn_type, matching what the
    // transaction detail page reads.
    expect(listed.rows[0]!.attachableType).toBe('expense');

    await attach('expense', txn.id, 'receipt.jpg');
    listed = await suspense.listInSuspense(tenantId, { companyId });
    expect(listed.rows[0]!.attachmentCount).toBe(1);
  });

  it('does not count a file keyed to the wrong attachable type', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-08-02',
      lines: [
        { accountId: suspenseId, debit: '12.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '12.00' },
      ],
    }, userId, companyId);
    // 'transaction' is NOT the convention — only tests ever used it.
    await attach('transaction', txn.id, 'wrong-key.jpg');
    const listed = await suspense.listInSuspense(tenantId, { companyId });
    expect(listed.rows[0]!.attachmentCount).toBe(0);
  });

  it('still finds a receipt attached to the bank line BEFORE it posted', async () => {
    const [conn] = await db.insert(bankConnections).values({
      tenantId, accountId: bankAccountId, institutionName: 'Test Bank',
    }).returning();
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-08-03',
      lines: [
        { accountId: suspenseId, debit: '30.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '30.00' },
      ],
    }, userId, companyId);
    const [item] = await db.insert(bankFeedItems).values({
      tenantId, bankConnectionId: conn!.id, companyId,
      feedDate: '2026-08-03', description: 'MYSTERY', amount: '30.0000',
      status: 'categorized', matchedTransactionId: txn.id,
    }).returning();

    // Attached while it was still an unposted bank line. Nothing relinks it
    // on posting, so the row has to look in both places or it seems lost.
    await attach('bank_feed_items', item!.id, 'pre-post-receipt.jpg');

    const listed = await suspense.listInSuspense(tenantId, { companyId });
    const row = listed.rows.find((r) => r.transactionId === txn.id)!;
    expect(row.attachmentCount).toBe(1);
    expect(row.bankFeedItemId).toBe(item!.id);
  });

  it('counts both sources without double-counting', async () => {
    const [conn] = await db.insert(bankConnections).values({
      tenantId, accountId: bankAccountId, institutionName: 'Test Bank',
    }).returning();
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-08-04',
      lines: [
        { accountId: suspenseId, debit: '40.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '40.00' },
      ],
    }, userId, companyId);
    const [item] = await db.insert(bankFeedItems).values({
      tenantId, bankConnectionId: conn!.id, companyId,
      feedDate: '2026-08-04', description: 'BOTH', amount: '40.0000',
      status: 'categorized', matchedTransactionId: txn.id,
    }).returning();

    await attach('bank_feed_items', item!.id, 'a.jpg');
    await attach('expense', txn.id, 'b.jpg');

    const listed = await suspense.listInSuspense(tenantId, { companyId });
    const row = listed.rows.find((r) => r.transactionId === txn.id)!;
    expect(row.attachmentCount).toBe(2);
  });

  it('does not leak another transaction\'s attachments onto the row', async () => {
    const suspenseId = await suspense.getSuspenseAccountId(tenantId, companyId, userId);
    const mine = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-08-05',
      lines: [
        { accountId: suspenseId, debit: '5.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '5.00' },
      ],
    }, userId, companyId);
    const other = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-08-06',
      lines: [
        { accountId: expenseAccountId, debit: '7.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '7.00' },
      ],
    }, userId, companyId);
    await attach('expense', other.id, 'not-mine.jpg');

    const listed = await suspense.listInSuspense(tenantId, { companyId });
    const row = listed.rows.find((r) => r.transactionId === mine.id)!;
    expect(row.attachmentCount).toBe(0);
  });
});
