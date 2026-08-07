// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 10.6 (ADR-TB-04): client-type actors get a hard 423; staff
// without confirmation get 423 with canOverride; staff WITH
// overrideConfirmed proceed and leave an audit row; context-less
// callers (importers/jobs) get the hard 423.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql, and, desc } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { accounts, auditLog, companies, journalLines, tenants, transactions } from '../../db/schema/index.js';
import * as ledger from '../ledger.service.js';

let tenantId: string;
let companyId: string;
let cashId: string;
let expenseId: string;

const line = (accountId: string, debit: number, credit: number) => ({
  accountId, debit: String(debit), credit: String(credit),
  isTaxable: false, taxRate: '0', taxAmount: '0',
});

const post = (date: string, ctx?: ledger.LockDateContext) =>
  db.transaction(async (tx) => {
    await ledger.checkLockDate(tx, tenantId, date, companyId, ctx);
  });

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'tb-lock-test', slug: `tb-lock-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({
    tenantId, businessName: 'Lock Co', fiscalYearStartMonth: 1,
    lockDate: '2026-06-30', lockDateSetAt: new Date(), lockDateSetBy: null,
  }).returning();
  companyId = c!.id;
  const [cash] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' }).returning();
  const [exp] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: '5000', name: 'Expense', accountType: 'expense' }).returning();
  cashId = cash!.id;
  expenseId = exp!.id;
});

afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('closing-date lock (ADR-TB-04)', () => {
  it('client-type actors are blocked hard with a friendly 423', async () => {
    await expect(post('2026-05-01', { userType: 'client' }))
      .rejects.toMatchObject({
        statusCode: 423,
        code: 'TB_PERIOD_LOCKED',
        details: { canOverride: false },
      });
  });

  it('staff without confirmation get 423 with canOverride: true', async () => {
    await expect(post('2026-05-01', { userType: 'staff' }))
      .rejects.toMatchObject({ statusCode: 423, details: { canOverride: true } });
  });

  it('context-less callers (importers/jobs) get the hard 423 — no bypass', async () => {
    await expect(post('2026-05-01')).rejects.toMatchObject({ statusCode: 423 });
  });

  it('override path posts and audits (explicit ctx)', async () => {
    // postTransaction without any actor context refuses…
    await expect(ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-05-01',
      lines: [line(expenseId, 42, 0), line(cashId, 0, 42)],
    }, undefined, companyId)).rejects.toMatchObject({ statusCode: 423 });

    // checkLockDate with staff+override succeeds and writes the audit row.
    await post('2026-05-01', { userType: 'staff', overrideConfirmed: true, userId: undefined });
    const [row] = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'override')))
      .orderBy(desc(auditLog.id)).limit(1);
    expect(row).toBeTruthy();
    expect(row!.entityType).toBe('closing_date_override');
    const before = row!.beforeData as { lockDate?: string };
    expect(before.lockDate).toBe('2026-06-30');
  });

  it('dates after the closing date pass untouched', async () => {
    await expect(post('2026-07-01', { userType: 'client' })).resolves.toBeUndefined();
  });
});
