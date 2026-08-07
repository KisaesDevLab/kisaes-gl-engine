// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 7: default grouping seed, sign-off ordering (preparer before
// reviewer), staleness on GL change, re-sign invalidation chains, and
// the tb_status completion gate.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import {
  accounts, companies, journalLines, tbGroupingAccounts, tbGroupings,
  tbLeadsheetSignoffs, tenants, transactions, users,
} from '../../db/schema/index.js';
import { seedDefaultGroupings, listGroupings, setAccountGrouping, seedStandardTickmarks, listTickmarks } from './groupings.service.js';
import { checkCompletionGate, listSignoffs, sign, unsign } from './signoffs.service.js';

let tenantId: string;
let companyId: string;
let userId: string;
let cashId: string;
let revenueId: string;

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'tb-signoff-test', slug: `tb-so-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Signoff Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `tb-so-${Date.now()}@test.local`, passwordHash: 'x', displayName: 'TB Tester', role: 'accountant',
  }).returning();
  userId = u!.id;
  const [cash] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset', detailType: 'bank' }).returning();
  const [rev] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: '4000', name: 'Revenue', accountType: 'revenue' }).returning();
  cashId = cash!.id;
  revenueId = rev!.id;
});

afterAll(async () => {
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(tbLeadsheetSignoffs).where(eq(tbLeadsheetSignoffs.tenantId, tenantId));
  await db.delete(tbGroupingAccounts).where(eq(tbGroupingAccounts.tenantId, tenantId));
  await db.delete(tbGroupings).where(eq(tbGroupings.tenantId, tenantId));
  await db.execute(sql`DELETE FROM tb_tickmarks WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('groupings + tickmarks seed', () => {
  it('seeds default leadsheets with auto-membership, idempotently', async () => {
    const first = await seedDefaultGroupings(tenantId, companyId, userId);
    expect(first.seeded).toBe(true);
    const again = await seedDefaultGroupings(tenantId, companyId, userId);
    expect(again.seeded).toBe(false);

    const { groupings } = await listGroupings(tenantId, companyId);
    const cashGroup = groupings.find((g) => g.leadsheetCode === 'A');
    const revGroup = groupings.find((g) => g.leadsheetCode === 'K');
    expect(cashGroup?.accountIds).toContain(cashId);
    expect(revGroup?.accountIds).toContain(revenueId);

    // Move cash to another grouping — membership is exclusive.
    await setAccountGrouping(tenantId, companyId, cashId, revGroup!.id, userId);
    const after = await listGroupings(tenantId, companyId);
    expect(after.groupings.find((g) => g.leadsheetCode === 'A')?.accountIds).not.toContain(cashId);
    expect(after.groupings.find((g) => g.leadsheetCode === 'K')?.accountIds).toContain(cashId);
    await setAccountGrouping(tenantId, companyId, cashId, cashGroup!.id, userId);
  });

  it('seeds the standard tickmark library idempotently', async () => {
    const first = await seedStandardTickmarks(tenantId, userId);
    expect(first.seeded).toBeGreaterThanOrEqual(12);
    const again = await seedStandardTickmarks(tenantId, userId);
    expect(again.seeded).toBe(0);
    const marks = await listTickmarks(tenantId);
    expect(marks.map((m) => m.symbol)).toEqual(expect.arrayContaining(['✓', 'F', 'P']));
  });
});

describe('sign-off workflow (7.6–7.8)', () => {
  const TY = 2026;

  it('enforces preparer-before-reviewer and gates completion', async () => {
    const { groupings } = await listGroupings(tenantId, companyId);
    const target = groupings[0]!;

    // Reviewer first → refused.
    await expect(sign(tenantId, companyId, { taxYear: TY, groupingId: target.id, role: 'reviewer' }, userId))
      .rejects.toMatchObject({ statusCode: 422, code: 'TB_SIGNOFF_ORDER' });

    await sign(tenantId, companyId, { taxYear: TY, groupingId: target.id, role: 'preparer' }, userId);
    await sign(tenantId, companyId, { taxYear: TY, groupingId: target.id, role: 'reviewer' }, userId);

    // Gate: only one of many groupings reviewer-signed → not ok.
    const gate = await checkCompletionGate(tenantId, companyId, TY);
    expect(gate.ok).toBe(false);
    expect(gate.missing.length).toBe(groupings.length - 1);

    // Sign the rest → gate passes.
    for (const g of groupings.slice(1)) {
      await sign(tenantId, companyId, { taxYear: TY, groupingId: g.id, role: 'preparer' }, userId);
      await sign(tenantId, companyId, { taxYear: TY, groupingId: g.id, role: 'reviewer' }, userId);
    }
    expect((await checkCompletionGate(tenantId, companyId, TY)).ok).toBe(true);
  });

  it('flags sign-offs stale after GL activity and supports re-sign', async () => {
    const fresh = await listSignoffs(tenantId, companyId, TY);
    expect(fresh.signoffs.every((s) => !s.stale)).toBe(true);

    // Post GL activity → stamp bumps → everything signed goes stale.
    const [txn] = await db.insert(transactions).values({
      tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-05-01', status: 'posted', basis: 'both',
    }).returning();
    await db.insert(journalLines).values([
      { tenantId, transactionId: txn!.id, accountId: cashId, debit: '100', credit: '0', lineOrder: 0 },
      { tenantId, transactionId: txn!.id, accountId: revenueId, debit: '0', credit: '100', lineOrder: 1 },
    ]);

    const stale = await listSignoffs(tenantId, companyId, TY);
    expect(stale.signoffs.every((s) => s.stale)).toBe(true);

    // One-click re-sign refreshes the stamp; preparer re-sign also
    // invalidates the reviewer (review must follow prep).
    const { groupings } = await listGroupings(tenantId, companyId);
    const target = groupings[0]!;
    await sign(tenantId, companyId, { taxYear: TY, groupingId: target.id, role: 'preparer' }, userId);
    const after = await listSignoffs(tenantId, companyId, TY);
    const targetSignoffs = after.signoffs.filter((s) => s.groupingId === target.id);
    expect(targetSignoffs).toHaveLength(1); // reviewer invalidated
    expect(targetSignoffs[0]!.role).toBe('preparer');
    expect(targetSignoffs[0]!.stale).toBe(false);
    expect((await checkCompletionGate(tenantId, companyId, TY)).ok).toBe(false);
  });

  it('unsign invalidates explicitly', async () => {
    const { groupings } = await listGroupings(tenantId, companyId);
    const other = groupings[1]!;
    const before = await listSignoffs(tenantId, companyId, TY);
    const reviewerSig = before.signoffs.find((s) => s.groupingId === other.id && s.role === 'reviewer')!;
    await unsign(tenantId, companyId, reviewerSig.id, userId);
    const after = await listSignoffs(tenantId, companyId, TY);
    expect(after.signoffs.find((s) => s.id === reviewerSig.id)).toBeUndefined();
  });
});
