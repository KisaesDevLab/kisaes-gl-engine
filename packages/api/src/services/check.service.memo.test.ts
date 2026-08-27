// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Editing the memo that prints on a check. The memo can be retyped for as
// long as the check is unprinted; once it has printed, the paper is the
// record and the edit is refused rather than silently diverging from it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, accounts, auditLog, transactions, journalLines, transactionTags } from '../db/schema/index.js';
import * as checkService from './check.service.js';

let tenantId = '';
let companyId = '';
let bankId = '';
let expenseId = '';

async function cleanup() {
  if (!tenantId) return;
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({
    name: 'Check Memo Test',
    slug: 'check-memo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Memo Co' }).returning();
  companyId = c!.id;
  const [b] = await db.insert(accounts).values({ tenantId, companyId, name: 'Checking', accountType: 'asset', detailType: 'checking', accountNumber: '1000', balance: '0' }).returning();
  bankId = b!.id;
  const [e] = await db.insert(accounts).values({ tenantId, companyId, name: 'Repairs', accountType: 'expense', accountNumber: '6300', balance: '0' }).returning();
  expenseId = e!.id;
});
afterEach(cleanup);

const queuedCheck = (over: Record<string, unknown> = {}) => ({
  bankAccountId: bankId,
  payeeNameOnCheck: 'Acme Plumbing',
  txnDate: '2026-07-10',
  amount: '150.0000',
  printLater: true,
  lines: [{ accountId: expenseId, amount: '150.0000' }],
  ...over,
});

const memoOf = async (id: string) => {
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, id));
  return txn!.printedMemo;
};

describe('updatePrintedMemo', () => {
  it('retypes the memo on a queued check', async () => {
    const check = await checkService.createCheck(tenantId, queuedCheck({ printedMemo: 'Invoice 12' }), undefined, companyId);

    const result = await checkService.updatePrintedMemo(tenantId, check.id, '  Invoice 12 and 13  ', undefined, companyId);

    expect(result.printedMemo).toBe('Invoice 12 and 13');
    expect(await memoOf(check.id)).toBe('Invoice 12 and 13');
  });

  it('records a cleared memo as empty, not as "never set"', async () => {
    // NULL would fall back to the internal memo at print time, which is the
    // opposite of what clearing the field asks for.
    const check = await checkService.createCheck(
      tenantId, queuedCheck({ printedMemo: 'Invoice 12', memo: 'internal note' }), undefined, companyId,
    );

    await checkService.updatePrintedMemo(tenantId, check.id, '', undefined, companyId);

    expect(await memoOf(check.id)).toBe('');
  });

  it('sets a memo on a check that never had one', async () => {
    const check = await checkService.createCheck(tenantId, queuedCheck(), undefined, companyId);
    expect(await memoOf(check.id)).toBeNull();

    await checkService.updatePrintedMemo(tenantId, check.id, 'Rent — August', undefined, companyId);

    expect(await memoOf(check.id)).toBe('Rent — August');
  });

  it('refuses to edit a check that has already printed', async () => {
    const check = await checkService.createCheck(tenantId, queuedCheck(), undefined, companyId);
    await checkService.printChecks(tenantId, bankId, [check.id], 2001, 'voucher');

    await expect(
      checkService.updatePrintedMemo(tenantId, check.id, 'too late', undefined, companyId),
    ).rejects.toThrow(/already printed/);

    // Requeueing for a reprint makes it editable again.
    await checkService.requeueChecks(tenantId, [check.id]);
    await checkService.updatePrintedMemo(tenantId, check.id, 'corrected', undefined, companyId);
    expect(await memoOf(check.id)).toBe('corrected');
  });

  it('refuses to edit a hand-written check', async () => {
    // The paper already exists — it was written by hand before we saw it.
    const check = await checkService.createCheck(
      tenantId, queuedCheck({ printLater: false }), undefined, companyId,
    );

    await expect(
      checkService.updatePrintedMemo(tenantId, check.id, 'nope', undefined, companyId),
    ).rejects.toThrow(/hand-written/);
  });

  it('refuses to edit a voided check', async () => {
    const check = await checkService.createCheck(tenantId, queuedCheck(), undefined, companyId);
    await db.update(transactions).set({ status: 'void' }).where(eq(transactions.id, check.id));

    await expect(
      checkService.updatePrintedMemo(tenantId, check.id, 'nope', undefined, companyId),
    ).rejects.toThrow(/voided/);
  });

  it('does not reach a check in another tenant', async () => {
    const check = await checkService.createCheck(tenantId, queuedCheck(), undefined, companyId);
    const otherTenant = crypto.randomUUID();

    await expect(
      checkService.updatePrintedMemo(otherTenant, check.id, 'not yours'),
    ).rejects.toThrow(/not found/i);

    expect(await memoOf(check.id)).toBeNull();
  });

  it('rejects a transaction that is not a check', async () => {
    const check = await checkService.createCheck(tenantId, queuedCheck(), undefined, companyId);
    await db.update(transactions).set({ printStatus: null }).where(eq(transactions.id, check.id));

    await expect(
      checkService.updatePrintedMemo(tenantId, check.id, 'nope', undefined, companyId),
    ).rejects.toThrow(/not found/i);
  });
});
