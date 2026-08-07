// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 14.2 — the full TB workflow on an 1120S fixture, asserting the
// standing invariants at each step:
//   book work → AJE → assignments → tax RJE → M-1/M-2 → leadsheet
//   sign-offs (incl. staleness + re-sign) → close → report family →
//   export dataset.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, auditLog, companies, companyTaxProfiles,
  journalLines, tenants, transactions, users,
} from '../../db/schema/index.js';
import * as ledger from '../ledger.service.js';
import { createAje } from './aje.service.js';
import { createTaxEntry } from './tax-entries.service.js';
import { computeWorkpaper } from './balance-engine.service.js';
import { buildM1, buildM2 } from './m1.service.js';
import { seedDefaultGroupings, listGroupings } from './groupings.service.js';
import { checkCompletionGate, listSignoffs, sign } from './signoffs.service.js';
import { buildTaxDataset, validateForExport } from './exports.service.js';
import { runDiagnostics } from './diagnostics.service.js';
import { buildTbWorkpaperReport } from './tb-reports.service.js';

let tenantId: string;
let companyId: string;
let userId: string;
const A: Record<string, string> = {};

const line = (name: string, debit: number, credit: number) => ({
  accountId: A[name]!, debit: String(debit), credit: String(credit),
  isTaxable: false, taxRate: '0', taxAmount: '0',
});

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'tb-e2e', slug: `tb-e2e-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: '3 Way Construction LLC', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `tb-e2e-${Date.now()}@test.local`, passwordHash: 'x', displayName: 'Preparer', role: 'accountant',
  }).returning();
  userId = u!.id;
  await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm: '1120S' });
  const mk = async (num: string, name: string, type: string, detail: string | null = null) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type, detailType: detail }).returning();
    A[name] = a!.id;
  };
  await mk('1010', 'Cash in Safe', 'asset', 'bank');
  await mk('1550', 'Accumulated Depreciation', 'asset');
  await mk('4000', 'Roofing Revenue', 'revenue');
  await mk('5100', 'Depreciation Expense', 'expense');
  await mk('5200', 'Meals', 'expense');
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM tb_leadsheet_signoffs WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_grouping_accounts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_groupings WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_tax_entry_lines WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_tax_entries WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_aje_sequences WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_status WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accountTaxAssignments).where(eq(accountTaxAssignments.tenantId, tenantId));
  await db.delete(companyTaxProfiles).where(eq(companyTaxProfiles.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('full TB workflow — 1120S (14.2)', () => {
  it('walks book work → AJE → assignment → RJE → M-1/M-2 → sign-offs → close → export', async () => {
    // 1. Book work.
    await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-02-15',
      lines: [line('Cash in Safe', 5000, 0), line('Roofing Revenue', 0, 5000)],
    }, userId, companyId);
    await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-03-10',
      lines: [line('Meals', 400, 0), line('Cash in Safe', 0, 400)],
    }, userId, companyId);

    // 2. AJE: book depreciation.
    const aje = await createAje(tenantId, companyId, {
      txnDate: '2026-12-31', memo: 'Book depreciation', basis: 'both',
      lines: [line('Depreciation Expense', 900, 0), line('Accumulated Depreciation', 0, 900)],
    }, userId);
    expect(aje.ajeNumberLabel).toBe('AJE-001');

    // Invariant: Adjusted ≡ GL; columns balance.
    let wp = await computeWorkpaper(tenantId, companyId, { periodEnd: '2026-12-31', basis: 'accrual', skipCache: true });
    expect(wp.totals.adjustedDr).toBeCloseTo(wp.totals.adjustedCr, 3);
    expect(wp.rows.find((r) => r.name === 'Depreciation Expense')?.aje).toBe(900);

    // 3. Assignments (incl. an M-1-flagged code on meals).
    const anyCode = (await db.execute(sql`
      SELECT code, activity_type FROM tax_codes WHERE return_form IN ('1120S','common') AND is_m1_adjustment = FALSE AND code NOT IN ('DONOTMAP','MEMO','SUSPENSE','REPORTING_ONLY') LIMIT 1
    `)).rows[0] as { code: string; activity_type: string };
    const m1Code = (await db.execute(sql`
      SELECT code, activity_type FROM tax_codes WHERE return_form IN ('1120S','common') AND is_m1_adjustment = TRUE LIMIT 1
    `)).rows[0] as { code: string; activity_type: string };
    for (const [name, code] of [
      ['Cash in Safe', anyCode], ['Accumulated Depreciation', anyCode],
      ['Roofing Revenue', anyCode], ['Depreciation Expense', anyCode], ['Meals', m1Code],
    ] as const) {
      await db.insert(accountTaxAssignments).values({
        tenantId, companyId, accountId: A[name]!, activityUnitId: null,
        seedCode: code.code, seedActivityType: code.activity_type, source: 'manual',
      });
    }
    const diag = await runDiagnostics(tenantId, companyId, { periodEnd: '2026-12-31', basis: 'accrual' });
    expect(diag.diagnostics.filter((d) => d.kind === 'unassigned')).toHaveLength(0);

    // 4. Tax RJE: 50% meals addback (tax basis only).
    await createTaxEntry(tenantId, companyId, {
      taxYear: 2026, memo: '50% meals',
      lines: [
        { accountId: A['Cash in Safe']!, debit: '200', credit: '0' },
        { accountId: A['Meals']!, debit: '0', credit: '200' },
      ],
    }, userId);
    wp = await computeWorkpaper(tenantId, companyId, { periodEnd: '2026-12-31', basis: 'accrual', skipCache: true });
    expect(wp.rows.find((r) => r.name === 'Meals')?.taxRje).toBe(-200);
    expect(wp.totals.taxDr).toBeCloseTo(wp.totals.taxCr, 3);

    // 5. M-1 / M-2.
    const m1 = await buildM1(tenantId, companyId, { taxYear: 2026, basis: 'accrual' });
    // Book: 5000 − 400 − 900 = 3700; tax adds back 200 meals → 3900.
    expect(m1.bookIncome).toBe(3700);
    expect(m1.taxIncome).toBe(3900);
    expect(m1.reconciles).toBe(true);
    expect(m1.unexplained).toHaveLength(0); // meals carries an M-1 code
    const m2 = await buildM2(tenantId, companyId, { taxYear: 2026, basis: 'accrual' });
    expect(m2.reconciles).toBe(true);

    // 6. Leadsheets + sign-offs, incl. staleness → re-sign.
    await seedDefaultGroupings(tenantId, companyId, userId);
    const { groupings } = await listGroupings(tenantId, companyId);
    for (const g of groupings) {
      await sign(tenantId, companyId, { taxYear: 2026, groupingId: g.id, role: 'preparer' }, userId);
      await sign(tenantId, companyId, { taxYear: 2026, groupingId: g.id, role: 'reviewer' }, userId);
    }
    expect((await checkCompletionGate(tenantId, companyId, 2026)).ok).toBe(true);

    // A late AJE makes every signature stale; re-sign one grouping.
    await createAje(tenantId, companyId, {
      txnDate: '2026-12-31', memo: 'Late adjustment', basis: 'both',
      lines: [line('Depreciation Expense', 10, 0), line('Accumulated Depreciation', 0, 10)],
    }, userId);
    const stale = await listSignoffs(tenantId, companyId, 2026);
    expect(stale.signoffs.every((s) => s.stale)).toBe(true);
    const g0 = groupings[0]!;
    await sign(tenantId, companyId, { taxYear: 2026, groupingId: g0.id, role: 'preparer' }, userId);
    await sign(tenantId, companyId, { taxYear: 2026, groupingId: g0.id, role: 'reviewer' }, userId);

    // 7. Close the period: client hard-blocked, staff JE needs override,
    // AJE still posts.
    await db.update(companies).set({ lockDate: '2026-12-31', lockDateSetAt: new Date(), lockDateSetBy: userId })
      .where(eq(companies.id, companyId));
    await expect(ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-06-01',
      lines: [line('Meals', 1, 0), line('Cash in Safe', 0, 1)],
    }, userId, companyId)).rejects.toMatchObject({ statusCode: 423 });
    const lateAje = await createAje(tenantId, companyId, {
      txnDate: '2026-12-31', memo: 'Post-close AJE', basis: 'both',
      lines: [line('Depreciation Expense', 5, 0), line('Accumulated Depreciation', 0, 5)],
    }, userId);
    expect(lateAje.ajeNumber).toBeGreaterThan(1);

    // 8. Reports + export dataset stay coherent.
    const report = await buildTbWorkpaperReport(tenantId, companyId, '2026-12-31', 'accrual');
    expect(report.data.length).toBeGreaterThan(4);
    const { validation } = await validateForExport(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' });
    expect(validation.hardBlocked).toBe(false);
    const dataset = await buildTaxDataset(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' });
    const total = dataset.lines.reduce((s, l) => s + l.amount, 0);
    expect(total).toBeCloseTo(0, 2); // full TB nets to zero across codes

    // Audit trail covered the journey.
    const actions = await db.select({ action: auditLog.action, entityType: auditLog.entityType })
      .from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const kinds = new Set(actions.map((a) => `${a.action}:${a.entityType}`));
    expect(kinds.has('signoff:tb_leadsheet_signoff')).toBe(true);
    expect(kinds.has('create:tb_tax_entry')).toBe(true);
  });
});
