// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// TB-by-tag (rule TB7): the workpaper tag filter uses transaction-level
// EXISTS semantics — every line of any transaction carrying the tag is
// included, so DR = CR holds even when only some lines are tagged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import {
  accounts, companies, journalLines, tags, tenants, transactions,
} from '../../db/schema/index.js';
import { computeWorkpaper } from './balance-engine.service.js';

let tenantId: string;
let companyId: string;
let tagId: string;
const A: Record<string, string> = {};

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'tb-tag', slug: `tb-tag-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Tag Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const [tag] = await db.insert(tags).values({ tenantId, companyId, name: 'Rental' }).returning();
  tagId = tag!.id;
  const mk = async (num: string, name: string, type: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type }).returning();
    A[name] = a!.id;
  };
  await mk('1000', 'Cash', 'asset');
  await mk('4000', 'Rent Income', 'revenue');
  await mk('4100', 'Consulting', 'revenue');

  // Tagged transaction: only the income line carries the tag — the
  // whole transaction must be included (both lines).
  const [tagged] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-02-01', status: 'posted', basis: 'both',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId, transactionId: tagged!.id, accountId: A['Cash']!, debit: '500', credit: '0', lineOrder: 0 },
    { tenantId, transactionId: tagged!.id, accountId: A['Rent Income']!, debit: '0', credit: '500', tagId, lineOrder: 1 },
  ]);
  // Untagged transaction: excluded from the tag view entirely.
  const [plain] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-03-01', status: 'posted', basis: 'both',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId, transactionId: plain!.id, accountId: A['Cash']!, debit: '900', credit: '0', lineOrder: 0 },
    { tenantId, transactionId: plain!.id, accountId: A['Consulting']!, debit: '0', credit: '900', lineOrder: 1 },
  ]);
});

afterAll(async () => {
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('workpaper tag filter (TB7)', () => {
  it('includes whole tagged transactions and stays balanced', async () => {
    const wp = await computeWorkpaper(tenantId, companyId, {
      periodEnd: '2026-12-31', basis: 'accrual', skipCache: true, tagId,
    });
    const byName = new Map(wp.rows.map((r) => [r.name, r]));
    expect(byName.get('Cash')?.adjusted).toBeCloseTo(500, 2);
    expect(byName.get('Rent Income')?.adjusted).toBeCloseTo(-500, 2);
    expect(byName.has('Consulting')).toBe(false);
    expect(wp.totals.adjustedDr).toBeCloseTo(wp.totals.adjustedCr, 3);
  });

  it('unfiltered view still shows everything', async () => {
    const wp = await computeWorkpaper(tenantId, companyId, {
      periodEnd: '2026-12-31', basis: 'accrual', skipCache: true,
    });
    const byName = new Map(wp.rows.map((r) => [r.name, r]));
    expect(byName.get('Cash')?.adjusted).toBeCloseTo(1400, 2);
    expect(byName.get('Consulting')?.adjusted).toBeCloseTo(-900, 2);
  });

  it('cash basis honors the same transaction-level filter', async () => {
    const wp = await computeWorkpaper(tenantId, companyId, {
      periodEnd: '2026-12-31', basis: 'cash', skipCache: true, tagId,
    });
    const byName = new Map(wp.rows.map((r) => [r.name, r]));
    expect(byName.get('Cash')?.adjusted).toBeCloseTo(500, 2);
    expect(byName.has('Consulting')).toBe(false);
  });
});
