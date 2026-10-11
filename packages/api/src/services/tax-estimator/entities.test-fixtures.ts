// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Test-only fixture builders for the Phase 4 entity tests (direct DB inserts
// into kisbooks_test; every row is purged by tenant afterwards). Not imported
// by application code.

import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, companies, companyTaxProfiles, journalLines, tenants, transactions,
} from '../../db/schema/index.js';

export const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export async function mkTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenants).values({ name, slug: uniq('te4') }).returning();
  return t!.id;
}

export async function mkCompany(
  tenantId: string, name: string,
  opts: { accountingMethod?: 'cash' | 'accrual'; entityType?: string; fyStartMonth?: number } = {},
): Promise<string> {
  const [c] = await db.insert(companies).values({
    tenantId, businessName: name,
    accountingMethod: opts.accountingMethod ?? 'accrual',
    entityType: opts.entityType ?? 'sole_prop',
    fiscalYearStartMonth: opts.fyStartMonth ?? 1,
  }).returning();
  return c!.id;
}

export async function mkAccount(
  tenantId: string, companyId: string | null, num: string, name: string, type: string,
  opts: { detailType?: string | null; balance?: string; systemTag?: string } = {},
): Promise<string> {
  const [a] = await db.insert(accounts).values({
    tenantId, companyId, accountNumber: num, name, accountType: type,
    detailType: opts.detailType ?? null, balance: opts.balance ?? '0', systemTag: opts.systemTag ?? null,
  }).returning();
  return a!.id;
}

export type Line = [accountId: string, debit: string | number, credit: string | number];

export async function post(
  tenantId: string, companyId: string, date: string, lines: Line[],
  opts: { txnType?: string; basis?: string; total?: string } = {},
): Promise<string> {
  const [t] = await db.insert(transactions).values({
    tenantId, companyId, txnType: opts.txnType ?? 'journal_entry', txnDate: date, status: 'posted',
    basis: opts.basis ?? 'both', total: opts.total ?? null,
  }).returning();
  await db.insert(journalLines).values(lines.map(([accountId, d, c], i) => ({
    tenantId, companyId, transactionId: t!.id, accountId, debit: String(d), credit: String(c), lineOrder: i,
  })));
  return t!.id;
}

export async function setProfile(tenantId: string, companyId: string, returnForm: string, defaultActivityType = 'business') {
  await db.delete(companyTaxProfiles).where(sql`${companyTaxProfiles.tenantId} = ${tenantId} AND ${companyTaxProfiles.companyId} = ${companyId}`);
  await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm, defaultActivityType });
}

export async function assign(tenantId: string, companyId: string, accountId: string, activityType: string, code: string) {
  await db.insert(accountTaxAssignments).values({
    tenantId, companyId, accountId, activityUnitId: null, seedCode: code, seedActivityType: activityType, source: 'manual',
  });
}

/**
 * Delete every row of the given tenants from every table that has a tenant_id
 * column (several passes, so FK order resolves itself), then the tenants.
 */
export async function purgeTenants(tenantIds: string[]): Promise<void> {
  const ids = tenantIds.filter(Boolean);
  if (ids.length === 0) return;
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
  `);
  const names = (tables.rows as Array<{ table_name: string }>).map((r) => r.table_name).filter((n) => n !== 'tenants');
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  for (let pass = 0; pass < 6; pass++) {
    let failures = 0;
    for (const name of names) {
      try {
        await db.execute(sql`DELETE FROM ${sql.identifier(name)} WHERE tenant_id IN (${list})`);
      } catch {
        failures++;
      }
    }
    if (failures === 0) break;
  }
  await db.execute(sql`DELETE FROM tenants WHERE id IN (${list})`);
}
