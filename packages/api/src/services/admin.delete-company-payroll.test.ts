// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, transactions, payrollImportSessions } from '../db/schema/index.js';
import * as admin from './admin.service.js';

const tenantIds: string[] = [];
afterEach(async () => {
  for (const t of tenantIds.splice(0)) {
    for (const tbl of ['payroll_import_sessions', 'transactions', 'companies', 'audit_log']) {
      await db.execute(sql`DELETE FROM ${sql.identifier(tbl)} WHERE tenant_id = ${t}`);
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${t}`);
  }
});

async function seedTenant(): Promise<string> {
  const [t] = await db.insert(tenants).values({ name: 'DelTest', slug: `del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  tenantIds.push(t!.id);
  return t!.id;
}

describe('admin.deleteCompany', () => {
  it('hard-deletes one company and its data, keeping the other company', async () => {
    const tenantId = await seedTenant();
    const [a] = await db.insert(companies).values({ tenantId, businessName: 'Company A' }).returning();
    const [b] = await db.insert(companies).values({ tenantId, businessName: 'Company B' }).returning();
    await db.insert(transactions).values([
      { tenantId, companyId: a!.id, txnType: 'journal_entry', txnDate: '2026-05-01' },
      { tenantId, companyId: a!.id, txnType: 'journal_entry', txnDate: '2026-05-02' },
      { tenantId, companyId: b!.id, txnType: 'journal_entry', txnDate: '2026-05-03' },
    ]);

    const res = await admin.deleteCompany(tenantId, a!.id);
    expect(res.deleted).toBe(true);
    expect(res.rowsDeleted).toBeGreaterThanOrEqual(2);

    // Company A gone, B intact.
    const comps = await db.execute(sql`SELECT id FROM companies WHERE tenant_id = ${tenantId}`);
    expect((comps.rows as { id: string }[]).map((r) => r.id)).toEqual([b!.id]);
    // A's transactions gone, B's remain.
    const aTxns = await db.execute(sql`SELECT count(*)::int AS c FROM transactions WHERE company_id = ${a!.id}`);
    expect((aTxns.rows[0] as { c: number }).c).toBe(0);
    const bTxns = await db.execute(sql`SELECT count(*)::int AS c FROM transactions WHERE company_id = ${b!.id}`);
    expect((bTxns.rows[0] as { c: number }).c).toBe(1);
  });

  it("refuses to delete a tenant's only company", async () => {
    const tenantId = await seedTenant();
    const [only] = await db.insert(companies).values({ tenantId, businessName: 'Solo' }).returning();
    await expect(admin.deleteCompany(tenantId, only!.id)).rejects.toThrow(/only company/i);
  });
});

describe('admin.deletePayrollImportHistory', () => {
  it('removes import-history records but leaves the posted journal entries', async () => {
    const tenantId = await seedTenant();
    // A posted journal entry (the "JE" a payroll import created).
    const [je] = await db.insert(transactions).values({ tenantId, txnType: 'journal_entry', txnDate: '2026-05-01', source: 'payroll_import' }).returning();
    // A posted payroll import session referencing that JE.
    await db.insert(payrollImportSessions).values({
      tenantId, importMode: 'prebuilt_je', originalFilename: 'GLEntries.csv',
      filePath: '/tmp/GLEntries.csv', fileHash: 'deadbeef', status: 'posted', journalEntryId: je!.id,
    });

    const res = await admin.deletePayrollImportHistory(tenantId);
    expect(res.deleted).toBe(true);
    expect(res.sessionCount).toBe(1);

    // Session gone…
    const sess = await db.execute(sql`SELECT count(*)::int AS c FROM payroll_import_sessions WHERE tenant_id = ${tenantId}`);
    expect((sess.rows[0] as { c: number }).c).toBe(0);
    // …but the posted JE remains.
    const jeRows = await db.execute(sql`SELECT count(*)::int AS c FROM transactions WHERE id = ${je!.id}`);
    expect((jeRows.rows[0] as { c: number }).c).toBe(1);
  });
});
