// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Opening-balance import: the JE must post at the caller's as-of date
// (previously always "today", so any report dated before the import day
// was missing the opening balances), sides must follow normal-balance
// convention, and the offset must land in the Opening Balances equity
// account.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
} from '../db/schema/index.js';
import { importOpeningBalances } from './import.service.js';

let tenantId: string;

// Tenant-SCOPED cleanup — unscoped deletes nuke concurrently-running
// suites' data and die on their FKs. Only ever touch our own tenant.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  // sessions has no tenant_id — scope through this tenant's users.
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'OB', slug: `ob-${Date.now()}` }).returning();
  tenantId = t!.id;
  await db.insert(accounts).values([
    { tenantId, name: 'Checking', accountNumber: '1000', accountType: 'asset' },
    { tenantId, name: 'Loan Payable', accountNumber: '2500', accountType: 'liability' },
    { tenantId, name: 'Opening Balances', accountNumber: '30000', accountType: 'equity', isSystem: true, systemTag: 'opening_balances' },
  ]);
});

afterEach(async () => {
  await cleanDb();
});

describe('importOpeningBalances', () => {
  it('posts the JE at the supplied as-of date with a balancing offset', async () => {
    const result = await importOpeningBalances(tenantId, [
      { accountNumber: '1000', balance: '5000.00' },
      { accountNumber: '2500', balance: '2000.00' },
    ], undefined, '2026-01-01');

    const [txn] = await db.select().from(transactions).where(eq(transactions.id, result.transactionId));
    expect(txn!.txnDate).toBe('2026-01-01');

    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, result.transactionId));
    const totalDebit = lines.reduce((s, l) => s + parseFloat(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + parseFloat(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 4);
    expect(totalDebit).toBeCloseTo(5000, 4); // cash 5000 Dr; loan 2000 Cr + offset 3000 Cr
  });

  it('rejects a malformed as-of date', async () => {
    await expect(importOpeningBalances(tenantId, [
      { accountNumber: '1000', balance: '100.00' },
    ], undefined, '01/01/2026')).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('defaults to today when no date supplied', async () => {
    const result = await importOpeningBalances(tenantId, [
      { accountNumber: '1000', balance: '100.00' },
    ]);
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, result.transactionId));
    expect(txn!.txnDate).toBe(new Date().toISOString().split('T')[0]);
  });
});
