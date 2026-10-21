// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Posting in a caller's transaction (ClientLedger U-62, templates-v1):
// createCheck, createExpense, createDepositWithWarnings, createTransfer and
// createJournalEntry take an optional `outerTx`. Inside it they post as
// before; when the caller's transaction rolls back nothing stays behind —
// no transaction, no journal line, no balance change, and (checks) the
// check-number counter is where it was. runWithoutOverride gives a
// closed-period context that a closing-date password can't open.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  transactionTags, userPermissions,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as checkService from './check.service.js';
import * as expenseService from './expense.service.js';
import * as depositService from './deposit.service.js';
import * as transferService from './transfer.service.js';
import * as jeService from './journal-entry.service.js';
import { getLockContext, lockContextMiddleware, runWithoutOverride } from './lock-context.js';
import { hashClosingPassword } from './closing-password.service.js';

const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

async function cleanTenant(tid: string) {
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

interface Co { tenantId: string; userId: string; companyId: string; bank: string; savings: string; expense: string; income: string }
let c: Co;

beforeEach(async () => {
  const reg = await authService.register({
    email: `otx-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Outer Tx Co',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const expense = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) });
  const income = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const [savings] = await db.insert(accounts).values({
    tenantId, name: 'Savings', accountType: 'asset', detailType: 'bank',
  }).returning();
  c = { tenantId, userId: reg.user.id, companyId: company!.id, bank: bank!.id, savings: savings!.id, expense: expense!.id, income: income!.id };
});

afterEach(async () => {
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

class Rollback extends Error {}

/** Runs `fn` inside a transaction that is always rolled back. */
async function inRolledBack(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>) {
  let posted: unknown;
  await expect(db.transaction(async (tx) => {
    posted = await fn(tx);
    throw new Rollback('roll back');
  })).rejects.toBeInstanceOf(Rollback);
  return posted;
}

async function snapshot() {
  const txns = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, c.tenantId));
  const lines = await db.select({ id: journalLines.id }).from(journalLines).where(eq(journalLines.tenantId, c.tenantId));
  const accts = await db.select({ id: accounts.id, balance: accounts.balance }).from(accounts)
    .where(eq(accounts.tenantId, c.tenantId)).orderBy(accounts.id);
  const [company] = await db.select({ s: companies.checkSettings }).from(companies).where(eq(companies.tenantId, c.tenantId));
  return { txns: txns.length, lines: lines.length, accts, checkSettings: company?.s ?? null };
}

describe('outerTx: the caller’s rollback leaves nothing', () => {
  it('createCheck (auto number): no transaction, no balance change, counter unchanged', async () => {
    const first = await checkService.createCheck(c.tenantId, {
      bankAccountId: c.bank, payeeNameOnCheck: 'Landlord', txnDate: '2026-03-01', amount: '10.0000',
      printLater: false, lines: [{ accountId: c.expense, amount: '10.0000' }],
    }, undefined, c.companyId);
    const before = await snapshot();
    const inside = await inRolledBack((tx) => checkService.createCheck(c.tenantId, {
      bankAccountId: c.bank, payeeNameOnCheck: 'Landlord', txnDate: '2026-03-02', amount: '25.5000',
      printLater: false, lines: [{ accountId: c.expense, amount: '25.5000' }],
    }, undefined, c.companyId, tx)) as { checkNumber: number };
    expect(inside.checkNumber).toBe(first.checkNumber! + 1);
    expect(await snapshot()).toEqual(before);
    // The counter was not consumed: the next check gets the same number.
    const next = await checkService.createCheck(c.tenantId, {
      bankAccountId: c.bank, payeeNameOnCheck: 'Landlord', txnDate: '2026-03-03', amount: '1.0000',
      printLater: false, lines: [{ accountId: c.expense, amount: '1.0000' }],
    }, undefined, c.companyId);
    expect(next.checkNumber).toBe(first.checkNumber! + 1);
  });

  it('createCheck inside an outer transaction commits with it', async () => {
    const before = await snapshot();
    const posted = await db.transaction((tx) => checkService.createCheck(c.tenantId, {
      bankAccountId: c.bank, payeeNameOnCheck: 'Landlord', txnDate: '2026-03-02', amount: '25.5000',
      printLater: true, lines: [{ accountId: c.expense, amount: '25.5000' }],
    }, undefined, c.companyId, tx));
    expect(posted.printStatus).toBe('queue');
    const after = await snapshot();
    expect(after.txns).toBe(before.txns + 1);
  });

  it('createExpense, createTransfer, createJournalEntry, createDepositWithWarnings', async () => {
    const before = await snapshot();
    await inRolledBack((tx) => expenseService.createExpense(c.tenantId, {
      txnDate: '2026-03-02', payFromAccountId: c.bank, lines: [{ expenseAccountId: c.expense, amount: '12.3456' }],
    }, undefined, c.companyId, tx));
    await inRolledBack((tx) => transferService.createTransfer(c.tenantId, {
      txnDate: '2026-03-02', fromAccountId: c.bank, toAccountId: c.savings, amount: '100.0000',
    }, undefined, c.companyId, tx));
    await inRolledBack((tx) => jeService.createJournalEntry(c.tenantId, {
      txnDate: '2026-03-02', basis: 'both',
      lines: [
        { accountId: c.expense, debit: '5.0000', credit: '0', isTaxable: false, taxRate: '0', taxAmount: '0' },
        { accountId: c.bank, debit: '0', credit: '5.0000', isTaxable: false, taxRate: '0', taxAmount: '0' },
      ],
    }, undefined, c.companyId, {}, tx));
    await inRolledBack((tx) => depositService.createDepositWithWarnings(c.tenantId, {
      txnDate: '2026-03-02', depositToAccountId: c.bank, strictAmounts: true,
      lines: [{ accountId: c.income, amount: '40.0000' }],
    }, undefined, c.companyId, tx));
    expect(await snapshot()).toEqual(before);
  });
});

describe('runWithoutOverride', () => {
  /** Runs `fn` the way a route behind lockContextMiddleware does, with this body. */
  function inRequest<T>(body: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const req = { body, userType: 'staff', userId: c.userId } as unknown as Request;
    const res = new EventEmitter() as unknown as Response;
    return new Promise<T>((resolve, reject) => {
      lockContextMiddleware(req, res, () => { fn().then(resolve, reject); });
    });
  }

  it('a closing-date password in the surrounding request does not open the closed period', async () => {
    await db.update(companies).set({
      lockDate: '2026-02-28', closingPasswordHash: await hashClosingPassword('closing-pass-123'),
    }).where(eq(companies.id, c.companyId));
    const post = (txnDate: string) => transferService.createTransfer(c.tenantId, {
      txnDate, fromAccountId: c.bank, toAccountId: c.savings, amount: '1.0000',
    }, undefined, c.companyId);

    // Control: the password opens it for the request itself.
    const opened = await inRequest({ closingPassword: 'closing-pass-123' }, () => post('2026-02-14'));
    expect(opened.id).toBeTruthy();

    // Inside runWithoutOverride the password is not visible and the date stays closed.
    await expect(inRequest({ closingPassword: 'closing-pass-123', overrideConfirmed: true }, () => runWithoutOverride(async () => {
      expect(getLockContext()).toEqual({ userType: 'client', overrideConfirmed: false });
      return post('2026-02-15');
    }))).rejects.toMatchObject({ statusCode: 423, code: 'TB_PERIOD_LOCKED' });

    // An open date still posts.
    const ok = await runWithoutOverride(() => post('2026-03-15'));
    expect(ok.id).toBeTruthy();
  });
});
