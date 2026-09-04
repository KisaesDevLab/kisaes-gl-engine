// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The ledger change counter clients poll instead of polling their lists.
//
// What matters is only that the number MOVES on a ledger write and does not
// move otherwise, and that a NULL-company write is visible to a company-scoped
// reader — the zero-uuid bucket exists for exactly that, and missing it would
// leave whole classes of change silently undetected.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, transactions, journalLines,
} from '../db/schema/index.js';
import { getLedgerVersion } from './ledger-version.service.js';

let tenantId = '';
let companyId = '';
let bankId = '';
let expenseId = '';

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({
    name: 'Ledger Version Test', slug: 'lvt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'LVT Co' }).returning();
  companyId = c!.id;
  const [bank] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Checking', accountType: 'asset', detailType: 'bank',
  }).returning();
  bankId = bank!.id;
  const [exp] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Supplies', accountType: 'expense',
  }).returning();
  expenseId = exp!.id;
});

afterEach(async () => {
  if (!tenantId) return;
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
});

async function postEntry(company: string | null) {
  const [txn] = await db.insert(transactions).values({
    tenantId, companyId: company, txnType: 'expense',
    txnDate: '2026-07-01', status: 'posted', total: '10.0000',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId, transactionId: txn!.id, accountId: expenseId, debit: '10.0000', credit: '0' },
    { tenantId, transactionId: txn!.id, accountId: bankId, debit: '0', credit: '10.0000' },
  ]);
  return txn!.id;
}

describe('getLedgerVersion', () => {
  it('moves when journal lines are written', async () => {
    const before = await getLedgerVersion(tenantId, companyId);
    await postEntry(companyId);
    const after = await getLedgerVersion(tenantId, companyId);
    expect(after).toBeGreaterThan(before);
  });

  it('does not move when nothing is written', async () => {
    await postEntry(companyId);
    const a = await getLedgerVersion(tenantId, companyId);
    const b = await getLedgerVersion(tenantId, companyId);
    expect(b).toBe(a);
  });

  it('surfaces a NULL-company write to a company-scoped reader', async () => {
    // These exist all over this codebase. Reading only the company's own
    // bucket would leave them permanently invisible to the watcher.
    const before = await getLedgerVersion(tenantId, companyId);
    await postEntry(null);
    const after = await getLedgerVersion(tenantId, companyId);
    expect(after).toBeGreaterThan(before);
  });

  it('is unaffected by another tenant posting', async () => {
    const before = await getLedgerVersion(tenantId, companyId);
    const [other] = await db.insert(tenants).values({
      name: 'Other', slug: 'lvt-other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    }).returning();
    const [oa] = await db.insert(accounts).values({
      tenantId: other!.id, name: 'Cash', accountType: 'asset', detailType: 'bank',
    }).returning();
    const [ot] = await db.insert(transactions).values({
      tenantId: other!.id, txnType: 'expense', txnDate: '2026-07-01', status: 'posted', total: '5.0000',
    }).returning();
    await db.insert(journalLines).values({
      tenantId: other!.id, transactionId: ot!.id, accountId: oa!.id, debit: '5.0000', credit: '0',
    });

    expect(await getLedgerVersion(tenantId, companyId)).toBe(before);

    await db.delete(journalLines).where(eq(journalLines.tenantId, other!.id));
    await db.delete(transactions).where(eq(transactions.tenantId, other!.id));
    await db.delete(accounts).where(eq(accounts.tenantId, other!.id));
    await db.delete(tenants).where(eq(tenants.id, other!.id));
  });

  it('returns 0 for a tenant that has never posted', async () => {
    expect(await getLedgerVersion(tenantId, companyId)).toBe(0);
  });
});
