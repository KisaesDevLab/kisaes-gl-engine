// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 4: entity-type resolution (TB profile → estimator setting → company
// entity type), books readiness (last closed month, unreconciled accounts,
// suspense, unmapped accounts), treatment suggestions, audit, and service-level
// tenant isolation (D1: every function refuses a tenant outside the scope).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../../db/index.js';
import { companyTaxProfiles, reconciliations, taxEstAccountTreatments, taxEstEntitySettings } from '../../db/schema/index.js';
import { importSeed } from '../tb/tax-code-seed.service.js';
import type { FirmScope } from './firm-scope.service.js';
import { decide1040Type, resolveEntityTax, scopeWarningForLink } from './entity-type.service.js';
import { closedThroughMonthOf, getReadiness } from './readiness.service.js';
import { getTaxBasisPl } from './pl-provider.service.js';
import {
  listTransactionFlags, listTreatments, putTransactionFlags, putTreatments, suggestTreatments,
} from './treatments.service.js';
import { getEntitySettings, getYearInputs, upsertEntitySettings, upsertYearInputs } from './entity-settings.service.js';
import { assign, mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');

const A = {
  checking: '', card: '', dormantBank: '', revenue: '', misc: '', suspense: '', ama: '', meals: '',
  ownerHealth: '', estTax: '', wages: '', payrollTax: '',
};
let tA = '';
let cA = '';
let cTypes = '';
let tOther = '';
let cOther = '';
let otherAccount = '';
let otherTxn = '';
let scope: FirmScope;

beforeAll(async () => {
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  tA = await mkTenant('TE4 Readiness');
  cA = await mkCompany(tA, 'Readiness Co', { accountingMethod: 'accrual', entityType: 'single_member_llc' });
  cTypes = await mkCompany(tA, 'Types Co', { entityType: 'partnership' });
  await setProfile(tA, cA, '1040', 'business');
  A.checking = await mkAccount(tA, cA, '1010', 'Checking', 'asset', { detailType: 'checking' });
  A.card = await mkAccount(tA, cA, '2100', 'Amex', 'liability', { detailType: 'credit_card' });
  A.dormantBank = await mkAccount(tA, cA, '1020', 'Old Savings', 'asset', { detailType: 'savings' });
  A.revenue = await mkAccount(tA, cA, '4000', 'Sales', 'revenue');
  A.misc = await mkAccount(tA, cA, '6900', 'Misc Expense', 'expense');
  A.suspense = await mkAccount(tA, cA, '89999', 'Suspense', 'asset', { systemTag: 'suspense', balance: '250' });
  A.ama = await mkAccount(tA, cA, '6999', 'Ask My Accountant', 'expense', { balance: '75' });
  A.meals = await mkAccount(tA, cA, '6420', 'Meals & Entertainment', 'expense');
  A.ownerHealth = await mkAccount(tA, cA, '6200', 'Owner Health Insurance', 'expense');
  A.estTax = await mkAccount(tA, cA, '3030', 'Estimated Tax Payments - IRS', 'equity');
  A.wages = await mkAccount(tA, cA, '6000', 'Salaries & Wages', 'expense');
  A.payrollTax = await mkAccount(tA, cA, '6010', 'Payroll Tax Expense', 'expense');
  await assign(tA, cA, A.revenue, 'business', '801');
  await post(tA, cA, '2026-01-20', [[A.checking, 5000, 0], [A.revenue, 0, 5000]]);
  await post(tA, cA, '2026-02-03', [[A.misc, 120, 0], [A.card, 0, 120]]);
  await post(tA, cA, '2026-03-05', [[A.card, 120, 0], [A.checking, 0, 120]]);
  // Checking reconciled through Sep 30 (month end); Amex statement ends Sep 15.
  await db.insert(reconciliations).values([
    { tenantId: tA, companyId: cA, accountId: A.checking, statementDate: '2026-09-30', statementEndingBalance: '4880', beginningBalance: '0', status: 'complete' },
    { tenantId: tA, companyId: cA, accountId: A.card, statementDate: '2026-09-15', statementEndingBalance: '0', beginningBalance: '0', status: 'complete' },
    { tenantId: tA, companyId: cA, accountId: A.card, statementDate: '2026-10-15', statementEndingBalance: '0', beginningBalance: '0', status: 'in_progress' },
  ]);

  tOther = await mkTenant('TE4 Other Firm Client');
  cOther = await mkCompany(tOther, 'Other Co');
  otherAccount = await mkAccount(tOther, cOther, '6420', 'Meals', 'expense');
  const otherCash = await mkAccount(tOther, cOther, '1010', 'Bank', 'asset', { detailType: 'checking' });
  otherTxn = await post(tOther, cOther, '2026-02-02', [[otherAccount, 10, 0], [otherCash, 0, 10]]);
  await db.insert(taxEstAccountTreatments).values({ tenantId: tOther, companyId: cOther, accountId: otherAccount, treatment: 'nondeductible_pct', pct: '50' });

  scope = { firmId: '00000000-0000-0000-0000-0000000000f2', firmRole: 'firm_staff', allowedTenantIds: [tA] };
}, 60_000);

afterAll(async () => {
  await purgeTenants([tA, tOther]);
  await pool.end();
});

describe('entity type resolution (D3)', () => {
  it('1040 splits Sch C / Sch F by default activity or the farm-code majority', () => {
    expect(decide1040Type('business', new Map()).type).toBe('sch_c');
    expect(decide1040Type('farm', new Map()).type).toBe('sch_f');
    expect(decide1040Type('business', new Map([['farm', 3], ['business', 1], ['common', 9]])).type).toBe('sch_f');
    expect(decide1040Type('business', new Map([['farm', 1], ['business', 1]])).type).toBe('sch_c');
    expect(decide1040Type('rental', new Map()).rentalMajority).toBe(true);
  });

  it('from a TB profile: 1040 / 1065 / 1120S / 1120, and the profile wins over the setting', async () => {
    const cases: Array<[string, string, string]> = [
      ['1040', 'business', 'sch_c'], ['1040', 'farm', 'sch_f'], ['1065', 'business', 'partnership'],
      ['1120S', 'business', 's_corp'], ['1120', 'business', 'c_corp'],
    ];
    await upsertEntitySettings(scope, tA, cTypes, { taxEntityType: 'sch_c' });
    for (const [form, act, expected] of cases) {
      await setProfile(tA, cTypes, form, act);
      const r = await resolveEntityTax(scope, tA, cTypes);
      expect(r.entityType, form).toBe(expected);
      expect(r.entityTypeSource).toBe('tb_profile');
      expect(r.tbReturnForm).toBe(form);
    }
    const r = await resolveEntityTax(scope, tA, cTypes);
    expect(r.warnings.some((w) => w.code === 'TE_ENTITY_TYPE_SETTING_IGNORED')).toBe(true);
  });

  it('without a profile: the estimator setting, then companies.entity_type', async () => {
    await db.delete(companyTaxProfiles).where(and(eq(companyTaxProfiles.tenantId, tA), eq(companyTaxProfiles.companyId, cTypes)));
    await upsertEntitySettings(scope, tA, cTypes, { taxEntityType: 's_corp', taxMethod: 'cash' });
    let r = await resolveEntityTax(scope, tA, cTypes);
    expect(r).toMatchObject({ entityType: 's_corp', entityTypeSource: 'estimator_setting', taxMethod: 'cash', taxMethodSource: 'estimator_setting', booksMethod: 'accrual' });

    await upsertEntitySettings(scope, tA, cTypes, { taxEntityType: null, taxMethod: null });
    r = await resolveEntityTax(scope, tA, cTypes);
    expect(r).toMatchObject({ entityType: 'partnership', entityTypeSource: 'company_entity_type', taxMethodSource: 'company_accounting_method' });
    expect(r.warnings.some((w) => w.code === 'TE_ENTITY_TYPE_FROM_COMPANY')).toBe(true);

    await db.execute(sql`UPDATE companies SET entity_type = 'unknown_kind' WHERE id = ${cTypes}`);
    r = await resolveEntityTax(scope, tA, cTypes);
    expect(r.entityType).toBeNull();
    expect(r.warnings.some((w) => w.code === 'TE_ENTITY_TYPE_MISSING')).toBe(true);
  });

  it('settings and year-input writes are audited against the books tenant', async () => {
    await upsertYearInputs(scope, tA, cA, 2026, { ubia: '125000' });
    expect((await getYearInputs(scope, tA, cA, 2026)).ubia).toBe('125000.0000');
    await expect(upsertYearInputs(scope, tA, cA, 2026, { w2WagesOverride: '1000' }))
      .rejects.toMatchObject({ code: 'TE_W2_OVERRIDE_REASON' });
    const audits = await db.execute<{ entity_type: string }>(sql`
      SELECT entity_type FROM audit_log WHERE tenant_id = ${tA} AND entity_type LIKE 'tax_est_%'`);
    const types = (audits.rows as Array<{ entity_type: string }>).map((r) => r.entity_type);
    expect(types).toContain('tax_est_entity_settings');
    expect(types).toContain('tax_est_entity_year_inputs');
  });
});

describe('books readiness', () => {
  it('statement-date → closed-through month', () => {
    expect(closedThroughMonthOf('2026-09-30')).toBe('2026-09');
    expect(closedThroughMonthOf('2026-09-15')).toBe('2026-08');
    expect(closedThroughMonthOf('2026-01-27')).toBe('2025-12');
  });

  it('last closed month = earliest closed-through across bank AND card accounts with activity', async () => {
    const r = await getReadiness(scope, { tenantId: tA, companyId: cA, throughMonth: '2026-09' });
    expect(r.taxYear).toBe(2026);
    expect(r.lastClosedMonth).toBe('2026-08'); // Amex statement ends Sep 15
    expect(r.throughIsOpen).toBe(true);
    expect(r.unreconciledAccounts.map((a) => a.name)).toEqual(['Amex']);
    const amex = r.reconcilableAccounts.find((a) => a.accountId === A.card)!;
    expect(amex).toMatchObject({ kind: 'credit_card', reconciledThrough: '2026-09-15', hasInProgressReconciliation: true });
    // Dormant savings has no activity → never blocks.
    expect(r.reconcilableAccounts.find((a) => a.accountId === A.dormantBank)!.hasActivityInRange).toBe(false);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['TE_UNRECONCILED_ACCOUNTS', 'TE_RANGE_INCLUDES_OPEN_MONTH']));

    const closed = await getReadiness(scope, { tenantId: tA, companyId: cA, throughMonth: '2026-08' });
    expect(closed.throughIsOpen).toBe(false);
    expect(closed.unreconciledAccounts).toHaveLength(0);
  });

  it('a never-reconciled active account is closed only through the month before its first activity (R1 F11)', async () => {
    await db.delete(reconciliations).where(and(eq(reconciliations.tenantId, tA), eq(reconciliations.accountId, A.card)));
    const r = await getReadiness(scope, { tenantId: tA, companyId: cA, throughMonth: '2026-06' });
    // Amex first used Feb 3 → closed through Jan; checking through Sep.
    expect(r.lastClosedMonth).toBe('2026-01');
    expect(r.unreconciledAccounts.map((a) => a.accountId)).toEqual([A.card]);
  });

  it('suspense / ask-my-accountant balances and unmapped accounts are warned, never blocking', async () => {
    const r = await getReadiness(scope, { tenantId: tA, companyId: cA, throughMonth: '2026-06' });
    expect(r.suspense.balance).toBe('250.0000');
    expect(r.suspense.lookalikeAccounts).toEqual([{ accountId: A.ama, name: 'Ask My Accountant', balance: '75.0000' }]);
    expect(r.unmappedAccounts.map((a) => a.name)).toEqual(['Misc Expense']);
    expect(r.unmappedAccounts[0]!.bookAmount).toBe('-120.0000');
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['TE_SUSPENSE_BALANCE', 'TE_UNMAPPED_ACCOUNTS']));
    expect(r.entity.entityType).toBe('sch_c');
  });

  it('a link whose tenant left the scope becomes a warning for rollups', () => {
    expect(scopeWarningForLink(scope, tA, 'x')).toBeNull();
    expect(scopeWarningForLink(scope, tOther, 'Rivera Plumbing')!.code).toBe('TE_TENANT_NOT_MANAGED');
  });
});

describe('treatment suggestions (never auto-applied)', () => {
  it('suggests by account type + name pattern with a reason, and writes nothing', async () => {
    const before = await db.select().from(taxEstAccountTreatments).where(eq(taxEstAccountTreatments.tenantId, tA));
    const s = await suggestTreatments(scope, tA, cA);
    const by = new Map(s.map((x) => [x.accountId, x]));
    expect(by.get(A.meals)).toMatchObject({ treatment: 'nondeductible_pct', pct: '50' });
    expect(by.get(A.ownerHealth)).toMatchObject({ treatment: 'owner_sehi' });
    expect(by.get(A.estTax)).toMatchObject({ treatment: 'estimated_tax_payment', paymentJurisdiction: 'federal' });
    expect(by.get(A.wages)).toMatchObject({ treatment: 'w2_wages' });
    expect(by.has(A.payrollTax)).toBe(false);
    expect(by.has(A.revenue)).toBe(false);
    for (const x of s) expect(x.reason.length).toBeGreaterThan(10);
    const after = await db.select().from(taxEstAccountTreatments).where(eq(taxEstAccountTreatments.tenantId, tA));
    expect(after).toHaveLength(before.length);
  });

  it('validation: nondeductible needs pct; payment fields only on payments; audit entity tax_est_treatment', async () => {
    await expect(db.insert(taxEstAccountTreatments).values({ tenantId: tA, companyId: cA, accountId: A.misc, treatment: 'owner_sehi', pct: '10' }))
      .rejects.toThrow();
    await putTreatments(scope, tA, cA, [{ accountId: A.meals, treatment: 'nondeductible_pct', pct: '50', nonRecurring: false }]);
    const list = await listTreatments(scope, tA, cA, { limit: 50, offset: 0 });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ accountId: A.meals, treatment: 'nondeductible_pct', pct: '50.0000' });
    const audits = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM audit_log WHERE tenant_id = ${tA} AND entity_type = 'tax_est_treatment'`);
    expect(Number((audits.rows as Array<{ n: string }>)[0]!.n)).toBeGreaterThan(0);
  });
});

describe('isolation (D1): every service refuses a tenant outside the scope', () => {
  const notManaged = { statusCode: 404, code: 'TE_TENANT_NOT_MANAGED' };

  it('tenant outside the scope → 404 TE_TENANT_NOT_MANAGED before any query', async () => {
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['resolveEntityTax', () => resolveEntityTax(scope, tOther, cOther)],
      ['getEntitySettings', () => getEntitySettings(scope, tOther, cOther)],
      ['upsertEntitySettings', () => upsertEntitySettings(scope, tOther, cOther, { isSstb: true })],
      ['getYearInputs', () => getYearInputs(scope, tOther, cOther, 2026)],
      ['upsertYearInputs', () => upsertYearInputs(scope, tOther, cOther, 2026, { ubia: '1' })],
      ['listTreatments', () => listTreatments(scope, tOther, cOther, { limit: 10, offset: 0 })],
      ['putTreatments', () => putTreatments(scope, tOther, cOther, [{ accountId: otherAccount, treatment: 'owner_personal', nonRecurring: false }])],
      ['suggestTreatments', () => suggestTreatments(scope, tOther, cOther)],
      ['listTransactionFlags', () => listTransactionFlags(scope, tOther, cOther, { limit: 10, offset: 0 })],
      ['putTransactionFlags', () => putTransactionFlags(scope, tOther, cOther, { flags: [{ transactionId: otherTxn, nonRecurring: true }] })],
      ['getTaxBasisPl', () => getTaxBasisPl(scope, { tenantId: tOther, companyId: cOther, taxYear: 2026, throughMonth: '2026-06' })],
      ['getReadiness', () => getReadiness(scope, { tenantId: tOther, companyId: cOther, throughMonth: '2026-06' })],
    ];
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toMatchObject(notManaged);
    }
    const otherSettings = await db.select().from(taxEstEntitySettings).where(eq(taxEstEntitySettings.tenantId, tOther));
    expect(otherSettings).toHaveLength(0);
    const otherRows = await db.select().from(taxEstAccountTreatments).where(eq(taxEstAccountTreatments.tenantId, tOther));
    expect(otherRows.map((r) => r.treatment)).toEqual(['nondeductible_pct']);
  });

  it('an empty scope matches nothing', async () => {
    const empty: FirmScope = { ...scope, allowedTenantIds: [] };
    await expect(getEntitySettings(empty, tA, cA)).rejects.toMatchObject(notManaged);
  });

  it('another tenant\'s company / account / transaction cannot ride an in-scope tenant id', async () => {
    await expect(getEntitySettings(scope, tA, cOther)).rejects.toMatchObject({ statusCode: 404, code: 'TE_COMPANY_NOT_FOUND' });
    await expect(putTreatments(scope, tA, cA, [{ accountId: otherAccount, treatment: 'owner_personal', nonRecurring: false }]))
      .rejects.toMatchObject({ statusCode: 404, code: 'TE_ACCOUNT_NOT_FOUND' });
    await expect(putTransactionFlags(scope, tA, cA, { flags: [{ transactionId: otherTxn, nonRecurring: true }] }))
      .rejects.toMatchObject({ statusCode: 404, code: 'TE_TRANSACTION_NOT_FOUND' });
    await expect(putTreatments(scope, tA, cA, [{
      accountId: A.estTax, treatment: 'estimated_tax_payment', paymentTaxpayerId: '00000000-0000-0000-0000-00000000aaaa', nonRecurring: false,
    }])).rejects.toMatchObject({ statusCode: 404, code: 'TE_TAXPAYER_NOT_FOUND' });
  });

  it('reads never return another tenant\'s rows', async () => {
    const list = await listTreatments(scope, tA, cA, { limit: 500, offset: 0 });
    expect(list.items.some((i) => i.accountId === otherAccount)).toBe(false);
    const pl = await getTaxBasisPl(scope, { tenantId: tA, companyId: cA, taxYear: 2026, throughMonth: '2026-06' }, { skipCache: true });
    expect(pl.accounts.some((a) => a.accountId === otherAccount)).toBe(false);
    expect(JSON.stringify(pl)).not.toContain(tOther);
  });
});
