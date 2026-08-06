// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 4.4 standing invariants (CI):
//   1. Adjusted ≡ raw GL trial balance per account, per basis.
//   2. Every column balances (ΣDR = ΣCR).
//   3. Tax entries never appear in any GL query.
//   4. Tag splits sum exactly to the account balance.
// Plus: AJE column membership, prior-year AJE → beginning balances,
// prior-year P&L → RE fold, cache stamp behavior.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import {
  accounts, activityUnits, companies, journalLines, tagActivityMap, tags,
  tbTaxEntries, tbTaxEntryLines, tenants, transactions,
} from '../../db/schema/index.js';
import { buildTrialBalance } from '../report.service.js';
import { computeWorkpaper, getGlVersionStamp, ZERO_UUID } from './balance-engine.service.js';
import { createUnit, mapTag } from './activity-units.service.js';

let tenantId: string;
let companyId: string;
const acct: Record<string, string> = {};
let tagOakId: string;
let unitMainId: string;
let unitOakId: string;

async function mkAccount(number: string, name: string, type: string, detail: string | null = null) {
  const [a] = await db.insert(accounts).values({
    tenantId, companyId, accountNumber: number, name, accountType: type,
    detailType: detail,
  }).returning();
  acct[name] = a!.id;
  return a!.id;
}

async function je(date: string, lines: Array<[string, number, number, string | null]>, txnType = 'journal_entry', basis = 'both') {
  const [t] = await db.insert(transactions).values({
    tenantId, companyId, txnType, txnDate: date, status: 'posted', basis,
  }).returning();
  await db.insert(journalLines).values(lines.map(([accountId, debit, credit, tagId], i) => ({
    tenantId, transactionId: t!.id, accountId,
    debit: String(debit), credit: String(credit), tagId, lineOrder: i,
  })));
  return t!.id;
}

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'tb-engine-test', slug: `tb-eng-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Engine Test Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;

  await mkAccount('1000', 'Cash', 'asset');
  await mkAccount('1200', 'Accounts Receivable', 'asset', 'accounts_receivable');
  await mkAccount('1500', 'Equipment', 'asset');
  await mkAccount('2000', 'Accounts Payable', 'liability', 'accounts_payable');
  await mkAccount('4000', 'Revenue', 'revenue');
  await mkAccount('5000', 'Supplies Expense', 'expense');
  await mkAccount('5100', 'Depreciation Expense', 'expense');
  await mkAccount('1590', 'Accumulated Depreciation', 'asset');

  // Activity units + a tag mapped to the second unit.
  const main = await createUnit(tenantId, companyId, { activityType: 'business', displayName: 'Main Biz' });
  const oak = await createUnit(tenantId, companyId, { activityType: 'rental', displayName: 'Oak Ave Rental' });
  unitMainId = main.id;
  unitOakId = oak.id;
  const [tagOak] = await db.insert(tags).values({ tenantId, name: 'oak-ave' }).returning();
  tagOakId = tagOak!.id;
  await mapTag(tenantId, companyId, tagOakId, unitOakId);

  // Prior year (2025): revenue 1,000 → retained earnings; prior-year
  // AJE hitting BS+P&L (accrue depreciation 50).
  await je('2025-06-15', [
    [acct['Cash']!, 1000, 0, null],
    [acct['Revenue']!, 0, 1000, null],
  ]);
  await je('2025-12-31', [
    [acct['Depreciation Expense']!, 50, 0, null],
    [acct['Accumulated Depreciation']!, 0, 50, null],
  ], 'aje');

  // Current year (2026): mixed-tag revenue (600 default biz, 400 oak
  // rental via line tag), an expense, and a current-FY AJE.
  await je('2026-03-10', [
    [acct['Cash']!, 1000, 0, null],
    [acct['Revenue']!, 0, 600, null],
    [acct['Revenue']!, 0, 400, tagOakId],
  ]);
  await je('2026-04-05', [
    [acct['Supplies Expense']!, 200, 0, null],
    [acct['Cash']!, 0, 200, null],
  ]);
  await je('2026-06-30', [
    [acct['Depreciation Expense']!, 75, 0, null],
    [acct['Accumulated Depreciation']!, 0, 75, null],
  ], 'aje');

  // Cash-vs-accrual divergence: an accrual-only JE (basis='accrual').
  await je('2026-05-01', [
    [acct['Accounts Receivable']!, 300, 0, null],
    [acct['Revenue']!, 0, 300, null],
  ], 'journal_entry', 'accrual');

  // Tax RJE for 2026: Section 179 (never touches the GL).
  const [entry] = await db.insert(tbTaxEntries).values({
    tenantId, companyId, taxYear: 2026, entryNumber: 1, memo: 'Sec 179',
  }).returning();
  await db.insert(tbTaxEntryLines).values([
    { tenantId, entryId: entry!.id, accountId: acct['Depreciation Expense']!, debit: '500', credit: '0', activityUnitId: null, lineOrder: 0 },
    { tenantId, entryId: entry!.id, accountId: acct['Accumulated Depreciation']!, debit: '0', credit: '500', activityUnitId: unitOakId, lineOrder: 1 },
  ]);
});

afterAll(async () => {
  await db.delete(tbTaxEntryLines).where(eq(tbTaxEntryLines.tenantId, tenantId));
  await db.delete(tbTaxEntries).where(eq(tbTaxEntries.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(tagActivityMap).where(eq(tagActivityMap.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(activityUnits).where(eq(activityUnits.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

const row = (wp: Awaited<ReturnType<typeof computeWorkpaper>>, name: string) =>
  wp.rows.find((r) => r.name === name);

describe('five-column workpaper (accrual)', () => {
  it('computes column semantics: AJE membership, prior-year AJE in beginning balances, RE fold', async () => {
    const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: '2026-12-31', basis: 'accrual', skipCache: true });

    // Cash: 1000 (PY) + 1000 - 200 = 1800, no AJE activity.
    expect(row(wp, 'Cash')).toMatchObject({ unadjusted: 1800, aje: 0, adjusted: 1800 });

    // Accumulated Depreciation: PY AJE (-50) sits in UNADJUSTED
    // (beginning balance); current-FY AJE (-75) in the AJE column;
    // tax RJE (-500) in taxRje; tax = -625.
    expect(row(wp, 'Accumulated Depreciation')).toMatchObject({
      unadjusted: -50, aje: -75, adjusted: -125, taxRje: -500, tax: -625,
    });

    // Revenue: current-FY only (PY folded to RE): -600 -400 -300 = -1300.
    expect(row(wp, 'Revenue')).toMatchObject({ unadjusted: -1300, aje: 0 });

    // Depreciation Expense: current-FY AJE 75 in AJE col; PY AJE 50 went
    // through prior-year P&L → RE fold, NOT this row.
    expect(row(wp, 'Depreciation Expense')).toMatchObject({ unadjusted: 0, aje: 75, taxRje: 500, tax: 575 });

    // RE fold: PY revenue -1000 + PY depreciation AJE +50 = -950.
    const re = wp.rows.find((r) => r.detailType === 'retained_earnings');
    expect(re).toBeTruthy();
    expect(re).toMatchObject({ unadjusted: -950, aje: 0, adjusted: -950 });
  });

  it('invariant 1+2: Adjusted ≡ buildTrialBalance and every column balances (both bases)', async () => {
    for (const basis of ['accrual', 'cash'] as const) {
      const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: '2026-12-31', basis, skipCache: true });
      const tb = await buildTrialBalance(tenantId, '2026-01-01', '2026-12-31', companyId, null, basis);

      // Column balance: ΣDR = ΣCR for every column.
      expect(wp.totals.unadjustedDr).toBeCloseTo(wp.totals.unadjustedCr, 3);
      expect(wp.totals.ajeDr).toBeCloseTo(wp.totals.ajeCr, 3);
      expect(wp.totals.adjustedDr).toBeCloseTo(wp.totals.adjustedCr, 3);
      expect(wp.totals.taxRjeDr).toBeCloseTo(wp.totals.taxRjeCr, 3);
      expect(wp.totals.taxDr).toBeCloseTo(wp.totals.taxCr, 3);

      // Adjusted ≡ raw GL: compare per account against buildTrialBalance
      // netted rows (keyed by account number; RE rows normalize).
      const tbByNumber = new Map<string, number>();
      for (const r of tb.data as Array<{ account_number: string | null; debit: number; credit: number; id: string }>) {
        const key = r.account_number ?? r.id;
        tbByNumber.set(key, (tbByNumber.get(key) ?? 0) + r.debit - r.credit);
      }
      for (const r of wp.rows) {
        const key = r.accountNumber ?? r.accountId;
        const glNet = tbByNumber.get(key) ?? 0;
        expect(r.adjusted, `${basis} adjusted mismatch on ${r.name}`).toBeCloseTo(glNet, 3);
        tbByNumber.delete(key);
      }
      // Nothing left unmatched on the GL side either.
      for (const [key, net] of tbByNumber) {
        expect(net, `GL account ${key} missing from workpaper (${basis})`).toBeCloseTo(0, 3);
      }
    }
  });

  it('invariant 3: tax entries never leak into GL queries', async () => {
    const tb = await buildTrialBalance(tenantId, '2026-01-01', '2026-12-31', companyId, null, 'accrual');
    // GL trial balance shows only the 125 of posted depreciation AJEs,
    // never the 500 RJE.
    const accDep = (tb.data as Array<{ account_number: string | null; credit: number }>).find((r) => r.account_number === '1590');
    expect(accDep?.credit).toBeCloseTo(125, 3);
  });

  it('invariant 4: unit splits sum exactly to the account balance', async () => {
    const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: '2026-12-31', basis: 'accrual', skipCache: true });
    for (const r of wp.rows) {
      const sum = (col: 'unadjusted' | 'aje' | 'adjusted' | 'taxRje' | 'tax') =>
        r.units.reduce((acc, u) => acc + u[col], 0);
      expect(sum('unadjusted'), `${r.name} unadjusted split`).toBeCloseTo(r.unadjusted, 3);
      expect(sum('aje'), `${r.name} aje split`).toBeCloseTo(r.aje, 3);
      expect(sum('taxRje'), `${r.name} rje split`).toBeCloseTo(r.taxRje, 3);
      expect(sum('tax'), `${r.name} tax split`).toBeCloseTo(r.tax, 3);
    }
    // The tagged 400 revenue landed on the oak unit; untagged 600+300 on
    // the default (Main Biz) unit.
    const rev = row(wp, 'Revenue')!;
    const oak = rev.units.find((u) => u.unitId === unitOakId);
    const main = rev.units.find((u) => u.unitId === unitMainId);
    expect(oak?.unadjusted).toBeCloseTo(-400, 3);
    expect(main?.unadjusted).toBeCloseTo(-900, 3);
    // Account-level (NULL-unit) RJE lines bucket to the default unit.
    const depExp = row(wp, 'Depreciation Expense')!;
    expect(depExp.units.find((u) => u.unitId === unitMainId)?.taxRje).toBeCloseTo(500, 3);
    expect(depExp.units.some((u) => u.unitId === ZERO_UUID)).toBe(false);
  });

  it('cash basis diverges: accrual-only JE excluded', async () => {
    const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: '2026-12-31', basis: 'cash', skipCache: true });
    // Revenue on cash basis: -1000 (no accrual-only 300).
    expect(row(wp, 'Revenue')?.adjusted).toBeCloseTo(-1000, 3);
    expect(row(wp, 'Accounts Receivable')).toBeUndefined();
  });

  it('glVersionStamp moves on GL change; cache key is exact', async () => {
    const before = await getGlVersionStamp(tenantId, companyId);
    await je('2026-07-01', [
      [acct['Supplies Expense']!, 10, 0, null],
      [acct['Cash']!, 0, 10, null],
    ]);
    const after = await getGlVersionStamp(tenantId, companyId);
    expect(after).toBeGreaterThan(before);
    const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: '2026-12-31', basis: 'accrual', skipCache: true });
    expect(wp.glVersionStamp).toBe(after);
    expect(row(wp, 'Supplies Expense')?.adjusted).toBeCloseTo(210, 3);
  });
});
