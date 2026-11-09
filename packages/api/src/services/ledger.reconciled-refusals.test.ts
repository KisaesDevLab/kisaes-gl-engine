// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-195 (reconcile-qa-v1): changing the date or reconciled line of an entry
// cleared in a completed reconciliation, voiding it, or voiding such a bill
// payment is 409 RECONCILED_TRANSACTION like delete, with details naming the
// latest such reconciliation. The message text is the one older clients match.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
  billPaymentApplications, reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import type { PayBillsInput } from '@kis-books/shared';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import * as billService from './bill.service.js';
import * as billPaymentService from './bill-payment.service.js';

let tenantId: string;
let companyId: string;

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(reconciliationLines).where(
    inArray(reconciliationLines.reconciliationId, db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId))),
  );
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function mkAccount(name: string, accountType: string, accountNumber: string, detailType?: string, systemTag?: string) {
  const [a] = await db.insert(accounts).values({
    tenantId, companyId, name, accountNumber, accountType, detailType: detailType ?? null,
    isSystem: !!systemTag, systemTag: systemTag ?? null,
  }).returning();
  return a!;
}

/** A completed reconciliation of `accountId` clearing `txnId`'s line on it. */
async function reconcile(accountId: string, txnId: string, statementDate: string, completedAt = new Date()) {
  const [rec] = await db.insert(reconciliations).values({
    tenantId, companyId, accountId, statementDate, statementEndingBalance: '0', beginningBalance: '0',
    status: 'complete', completedAt,
  }).returning();
  const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txnId));
  const line = lines.find((l) => l.accountId === accountId)!;
  await db.insert(reconciliationLines).values({ reconciliationId: rec!.id, journalLineId: line.id, isCleared: true });
  return rec!;
}

async function refusal(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

beforeEach(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({ name: 'Reconciled Refusals', slug: `recref-${Date.now()}` }).returning();
  tenantId = tenant!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Co', entityType: 'sole_prop', setupComplete: true }).returning();
  companyId = c!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('reconciled-entry refusals (U-195)', () => {
  it('advertises the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('reconcile-qa-v1');
  });

  async function reconciledDeposit() {
    const bank = await mkAccount('Checking', 'asset', '1010', 'checking');
    const rev = await mkAccount('Sales', 'revenue', '4000');
    const lines = (amount: string) => [
      { accountId: bank.id, debit: amount, credit: '0' },
      { accountId: rev.id, debit: '0', credit: amount },
    ];
    const txn = await ledger.postTransaction(tenantId, { txnType: 'deposit', txnDate: '2026-01-05', lines: lines('100.00') }, undefined, companyId);
    // Two completed reconciliations clearing it: details name the later.
    await reconcile(bank.id, txn.id, '2026-01-31', new Date('2026-02-01T10:00:00Z'));
    const latest = await reconcile(bank.id, txn.id, '2026-02-28', new Date('2026-03-01T10:00:00Z'));
    return { bank, rev, txn, lines, latest };
  }

  it('a date change is 409 RECONCILED_TRANSACTION, field txnDate, message unchanged', async () => {
    const { txn, lines, latest } = await reconciledDeposit();
    const err = await refusal(ledger.updateTransaction(tenantId, txn.id, { txnType: 'deposit', txnDate: '2026-01-06', lines: lines('100.00') }, undefined, companyId));
    expect([err.statusCode, err.code]).toEqual([409, 'RECONCILED_TRANSACTION']);
    expect(err.message).toMatch(/completed bank reconciliation, so its reconciled \(balance-sheet\) line and date can’t change/);
    expect(err.details).toEqual({ action: 'update', field: 'txnDate', reconciliationId: latest.id, statementDate: '2026-02-28' });
  });

  it('a reconciled line change is 409 RECONCILED_TRANSACTION, field lines', async () => {
    const { txn, lines, latest } = await reconciledDeposit();
    const err = await refusal(ledger.updateTransaction(tenantId, txn.id, { txnType: 'deposit', txnDate: '2026-01-05', lines: lines('120.00') }, undefined, companyId));
    expect([err.statusCode, err.code]).toEqual([409, 'RECONCILED_TRANSACTION']);
    expect(err.details).toEqual({ action: 'update', field: 'lines', reconciliationId: latest.id, statementDate: '2026-02-28' });
  });

  it('recategorizing the income line is still allowed', async () => {
    const { bank, txn } = await reconciledDeposit();
    const other = await mkAccount('Other income', 'revenue', '4100');
    await ledger.updateTransaction(tenantId, txn.id, {
      txnType: 'deposit', txnDate: '2026-01-05',
      lines: [{ accountId: bank.id, debit: '100.00', credit: '0' }, { accountId: other.id, debit: '0', credit: '100.00' }],
    }, undefined, companyId);
  });

  it('a void is 409 RECONCILED_TRANSACTION, action void, message unchanged', async () => {
    const { txn, latest } = await reconciledDeposit();
    const err = await refusal(ledger.voidTransaction(tenantId, txn.id, 'oops'));
    expect([err.statusCode, err.code]).toEqual([409, 'RECONCILED_TRANSACTION']);
    expect(err.message).toMatch(/^Cannot void a transaction whose lines are cleared in a completed bank reconciliation\./);
    expect(err.details).toEqual({ action: 'void', reconciliationId: latest.id, statementDate: '2026-02-28' });
  });

  it('a delete keeps its code and gains the same details', async () => {
    const { txn, latest } = await reconciledDeposit();
    const err = await refusal(ledger.deleteTransaction(tenantId, txn.id));
    expect([err.statusCode, err.code]).toEqual([409, 'RECONCILED_TRANSACTION']);
    expect(err.details).toEqual({ action: 'delete', reconciliationId: latest.id, statementDate: '2026-02-28' });
  });

  it('a bill payment void is 409 RECONCILED_TRANSACTION, action void', async () => {
    const bank = await mkAccount('Checking', 'asset', '1010', 'checking');
    await mkAccount('Accounts Payable', 'liability', '20100', 'accounts_payable', 'accounts_payable');
    const exp = await mkAccount('Supplies', 'expense', '6000');
    const [vendor] = await db.insert(contacts).values({ tenantId, companyId, displayName: 'Vendor', contactType: 'vendor' }).returning();
    const bill = await billService.createBill(tenantId, {
      contactId: vendor!.id, txnDate: '2026-01-10', lines: [{ accountId: exp.id, amount: '500.00' }],
    }, undefined, companyId);
    const input = { bankAccountId: bank.id, txnDate: '2026-01-20', bills: [{ billId: bill.id, amount: '500.00' }] } as unknown as PayBillsInput;
    const paid = await billPaymentService.payBills(tenantId, input, undefined, companyId);
    const paymentId = paid.payments[0]!.id;
    const rec = await reconcile(bank.id, paymentId, '2026-01-31');

    const err = await refusal(billPaymentService.voidBillPayment(tenantId, paymentId, 'oops'));
    expect([err.statusCode, err.code]).toEqual([409, 'RECONCILED_TRANSACTION']);
    expect(err.message).toMatch(/^Cannot void a bill payment whose lines are cleared in a completed bank reconciliation\./);
    expect(err.details).toEqual({ action: 'void', reconciliationId: rec.id, statementDate: '2026-01-31' });
  });
});
