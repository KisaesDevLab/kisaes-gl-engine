// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 9: M-1 bridge (book → tax income, categorization, unexplained
// diagnostic) and M-2 rollforward (roles, tie-out) on a small 1120S-ish
// fixture: book income 900, Sec-179 RJE 500 (flagged M-1), 50% meals
// addback 40 (unflagged → unexplained), distributions 200.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, companies, companyTaxProfiles,
  journalLines, tbTaxEntries, tbTaxEntryLines, tenants, transactions,
} from '../../db/schema/index.js';
import { importSeed } from './tax-code-seed.service.js';
import { buildM1, buildM2, defaultEquityRole, setEquityRoles } from './m1.service.js';
import { createTaxEntry } from './tax-entries.service.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');

let tenantId: string;
let companyId: string;
const A: Record<string, string> = {};

async function mk(num: string, name: string, type: string, detail: string | null = null) {
  const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type, detailType: detail }).returning();
  A[name] = a!.id;
}

async function je(date: string, lines: Array<[string, number, number]>) {
  const [t] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'journal_entry', txnDate: date, status: 'posted', basis: 'both',
  }).returning();
  await db.insert(journalLines).values(lines.map(([acct, d, c], i) => ({
    tenantId, transactionId: t!.id, accountId: acct, debit: String(d), credit: String(c), lineOrder: i,
  })));
}

beforeAll(async () => {
  // CI runs against a fresh DB with no tax-code seed — import it
  // idempotently (byte-identical re-import is a no-op locally).
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  const [t] = await db.insert(tenants).values({ name: 'tb-m1-test', slug: `tb-m1-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'M1 Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm: '1120S' });

  await mk('1000', 'Cash', 'asset');
  await mk('1590', 'Accumulated Depreciation', 'asset');
  await mk('3000', 'Retained Earnings', 'equity', 'retained_earnings');
  await mk('3100', 'Shareholder Distributions', 'equity');
  await mk('4000', 'Revenue', 'revenue');
  await mk('5100', 'Depreciation Expense', 'expense');
  await mk('5200', 'Meals & Entertainment', 'expense');

  // Prior year: 400 income → retained earnings beginning balance.
  await je('2025-08-15', [[A['Cash']!, 400, 0], [A['Revenue']!, 0, 400]]);
  // Current year (2026): revenue 1000, meals 100 → book income 900.
  await je('2026-03-01', [[A['Cash']!, 1000, 0], [A['Revenue']!, 0, 1000]]);
  await je('2026-04-01', [[A['Meals & Entertainment']!, 100, 0], [A['Cash']!, 0, 100]]);
  // Distributions 200 during 2026.
  await je('2026-06-01', [[A['Shareholder Distributions']!, 200, 0], [A['Cash']!, 0, 200]]);

  // RJE 1: Section 179 — extra tax depreciation 500 (dep expense flagged M-1).
  await createTaxEntry(tenantId, companyId, {
    taxYear: 2026, memo: 'Sec 179',
    lines: [
      { accountId: A['Depreciation Expense']!, debit: '500', credit: '0' },
      { accountId: A['Accumulated Depreciation']!, debit: '0', credit: '500' },
    ],
  });
  // RJE 2: 50% meals addback — REDUCE meals expense by 40 on tax basis.
  await createTaxEntry(tenantId, companyId, {
    taxYear: 2026, memo: '50% meals',
    lines: [
      { accountId: A['Meals & Entertainment']!, debit: '0', credit: '40' },
      { accountId: A['Cash']!, debit: '40', credit: '0' }, // parking the offset on a BS account
    ],
  });

  // Flag dep expense with a real M-1 seed code; meals stays unflagged.
  const m1Code = await db.execute(sql`
    SELECT tc.code, tc.activity_type FROM tax_codes tc
    WHERE tc.is_m1_adjustment = TRUE AND tc.return_form IN ('1120S', 'common')
      AND tc.version_id = (SELECT id FROM tax_code_seed_versions WHERE tax_year = 2025 ORDER BY version DESC LIMIT 1)
    ORDER BY tc.code LIMIT 1
  `);
  const codeRow = (m1Code.rows as Array<{ code: string; activity_type: string }>)[0]!;
  await db.insert(accountTaxAssignments).values({
    tenantId, companyId, accountId: A['Depreciation Expense']!, activityUnitId: null,
    seedCode: codeRow.code, seedActivityType: codeRow.activity_type, source: 'manual',
  });
});

afterAll(async () => {
  await db.delete(tbTaxEntryLines).where(eq(tbTaxEntryLines.tenantId, tenantId));
  await db.delete(tbTaxEntries).where(eq(tbTaxEntries.tenantId, tenantId));
  await db.delete(accountTaxAssignments).where(eq(accountTaxAssignments.tenantId, tenantId));
  await db.delete(companyTaxProfiles).where(eq(companyTaxProfiles.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('Schedule M-1 (9.1–9.3)', () => {
  it('bridges book income to tax income with categorized lines', async () => {
    const m1 = await buildM1(tenantId, companyId, { taxYear: 2026, basis: 'accrual' });
    // Book: 1000 revenue − 100 meals = 900.
    expect(m1.bookIncome).toBe(900);
    // Tax: 900 − 500 (179) + 40 (meals addback) = 440.
    expect(m1.taxIncome).toBe(440);
    expect(m1.reconciles).toBe(true);
    expect(m1.computedTaxIncome).toBe(440);

    const dep = m1.lines.find((l) => l.name === 'Depreciation Expense');
    expect(dep).toMatchObject({ category: 'deductions_on_return_not_books', amount: 500, flagged: true });
    const meals = m1.lines.find((l) => l.name === 'Meals & Entertainment');
    expect(meals).toMatchObject({ category: 'expenses_on_books_not_return', amount: 40, flagged: false });

    // 9.3: the unflagged meals delta is the unexplained one.
    expect(m1.unexplained.map((l) => l.name)).toEqual(['Meals & Entertainment']);
  });
});

describe('Schedule M-2 (9.4)', () => {
  it('defaults roles by heuristic and rolls equity forward to a clean tie-out', async () => {
    expect(defaultEquityRole('Shareholder Distributions', null)).toBe('distributions');
    expect(defaultEquityRole('Retained Earnings', 'retained_earnings')).toBe('retained');
    expect(defaultEquityRole('Paid-in Capital', null)).toBe('contributions');

    const m2 = await buildM2(tenantId, companyId, { taxYear: 2026, basis: 'accrual' });
    // Beginning equity = prior-year income 400.
    expect(m2.beginning).toBe(400);
    expect(m2.bookIncome).toBe(900);
    expect(m2.distributions).toBe(200);
    expect(m2.contributions).toBe(0);
    // 400 + 900 − 200 = 1100 computed; GL ending equity + income ties.
    expect(m2.computedEnding).toBe(1100);
    expect(m2.glEndingEquity).toBe(1100);
    expect(m2.reconciles).toBe(true);
  });

  it('honors per-entity role overrides', async () => {
    await setEquityRoles(tenantId, companyId, { [A['Shareholder Distributions']!]: 'other' });
    const m2 = await buildM2(tenantId, companyId, { taxYear: 2026, basis: 'accrual' });
    expect(m2.distributions).toBe(0);
    expect(m2.other).toBe(-200); // outflow now rides ± other
    expect(m2.reconciles).toBe(true);
    await setEquityRoles(tenantId, companyId, {});
  });
});
