// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Rule 24: accounts.balance must equal SUM(debit)−SUM(credit) over
// POSTED journal lines. validateTenantBalances detects drift (e.g. the
// historical Plaid balance clobber) and repairs it from the ledger.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog as auditLogTable, contacts,
  transactions, journalLines, tags, transactionTags,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import { validateTenantBalances } from './balance-validation.service.js';

let tenantId: string;

// Tenant-SCOPED cleanup — unscoped deletes nuke concurrently-running
// suites' data and die on their FKs. Only ever touch our own tenant.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
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
  const [tenant] = await db.insert(tenants).values({ name: 'BV', slug: `bv-${Date.now()}` }).returning();
  tenantId = tenant!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('validateTenantBalances', () => {
  it('reports clean when balances match the posted ledger, detects + repairs a clobber', async () => {
    const [cash] = await db.insert(accounts).values({ tenantId, name: 'Cash', accountNumber: '1000', accountType: 'asset' }).returning();
    const [rev] = await db.insert(accounts).values({ tenantId, name: 'Sales', accountNumber: '4000', accountType: 'revenue' }).returning();

    await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-05-01', memo: 'sale',
      lines: [
        { accountId: cash!.id, debit: '100.00', credit: '0' },
        { accountId: rev!.id, debit: '0', credit: '100.00' },
      ],
    });

    // Clean state: no drift.
    expect(await validateTenantBalances(tenantId)).toHaveLength(0);

    // Simulate the old Plaid clobber: overwrite the GL balance with the
    // bank's number.
    await db.execute(sql`UPDATE accounts SET balance = '85.00' WHERE id = ${cash!.id}`);

    const drifts = await validateTenantBalances(tenantId);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.accountId).toBe(cash!.id);

    // Repair restores the ledger-derived value and audits it.
    await validateTenantBalances(tenantId, { repair: true });
    const [fixed] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, cash!.id)));
    expect(parseFloat(fixed!.balance!)).toBeCloseTo(100, 4);
    expect(await validateTenantBalances(tenantId)).toHaveLength(0);
    const audits = await db.select().from(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    expect(audits.some((a) => a.entityType === 'account_balance_repair')).toBe(true);
  });

  it('stays clean through a void (reversal lines excluded via posted-only sum)', async () => {
    const [cash] = await db.insert(accounts).values({ tenantId, name: 'Cash', accountNumber: '1000', accountType: 'asset' }).returning();
    const [rev] = await db.insert(accounts).values({ tenantId, name: 'Sales', accountNumber: '4000', accountType: 'revenue' }).returning();
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-05-01', memo: 'sale',
      lines: [
        { accountId: cash!.id, debit: '100.00', credit: '0' },
        { accountId: rev!.id, debit: '0', credit: '100.00' },
      ],
    });
    await ledger.voidTransaction(tenantId, txn.id, 'test');
    expect(await validateTenantBalances(tenantId)).toHaveLength(0);
  });
});
