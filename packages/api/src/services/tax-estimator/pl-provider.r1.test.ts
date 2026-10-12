// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Fable review R1 (docs/reviews/R1-books-to-tax-basis.md) regression tests:
// one describe per finding F1-F16. Each test failed on the pre-R1 provider
// and passes after the fix (see the review's "Fix status").

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountTreatmentInputSchema } from '@kis-books/shared';
import { db, pool } from '../../db/index.js';
import {
  accountTaxAssignments, billPaymentApplications, firmTaxCodes, paymentApplications, reconciliations, taxCodes,
  taxEstPersons, taxEstTaxpayers, tbTaxEntries, tbTaxEntryLines,
} from '../../db/schema/index.js';
import { importSeed } from '../tb/tax-code-seed.service.js';
import type { FirmScope } from './firm-scope.service.js';
import { characterForCode, getTaxBasisPl, loadConfigVersion, SEED_CODE_MEANING } from './pl-provider.service.js';
import { getReadiness } from './readiness.service.js';
import { putTreatments, suggestTreatments } from './treatments.service.js';
import { upsertEntitySettings, upsertYearInputs } from './entity-settings.service.js';
import { assign, mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');
const FIRM = '00000000-0000-0000-0000-0000000000f7';
const d = (s: string) => Number(s);
const OCT_11 = new Date('2026-10-11T12:00:00Z');

let tenant = '';
let scope: FirmScope;
const taxpayerIds: string[] = [];
let personA = '';
let personB = '';
let personM = '';
type IdKey = 'C'|'cChk'|'cHealth'|'cInterest'|'cRev'|'F'|'fChk'|'fRev'|'P'|'pChk'|'pFirm'|'pGain'|'pGp'|'pHealth'|'pRev'|'pSup'|'Q'|'qAp'|'qChk'|'qEst'|'R'|'R2'|'r2Ama'|'rCard'|'rChk'|'rExp'|'rRev'|'S'|'sChk'|'sHealth'|'sRev'|'sSep'|'sWages'|'X'|'xAr'|'xChk'|'xRevA'|'xRevB'|'Y'|'yChk'|'yExp'|'yOther';
const ids = {} as Record<IdKey, string>;
let firmCodeId = '';

async function mkPerson(first: string): Promise<string> {
  const [tp] = await db.insert(taxEstTaxpayers).values({ firmId: FIRM, displayName: `R1 ${first}` }).returning();
  const taxpayerId = tp!.id;
  taxpayerIds.push(taxpayerId);
  const [p] = await db.insert(taxEstPersons).values({
    taxpayerId, role: 'primary', firstName: first, lastName: 'R1', sehiEligibleMonths: Array(12).fill(true),
  }).returning();
  return p!.id;
}

beforeAll(async () => {
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  tenant = await mkTenant('TE R1');
  scope = { firmId: FIRM, firmRole: 'firm_staff', allowedTenantIds: [tenant] };
  personA = await mkPerson('Alex');
  personB = await mkPerson('Blair');
  personM = await mkPerson('Maria');
  const t = tenant;

  // ── Partnership (1065): 300,000 revenue, 100,000 supplies, 60,000 GP to A (TB 201), 10,000 partner health ──
  const P = await mkCompany(t, 'Two Partners LLC', { accountingMethod: 'cash', entityType: 'partnership' });
  ids.P = P;
  await setProfile(t, P, '1065', 'business');
  ids.pChk = await mkAccount(t, P, 'P1010', 'Checking', 'asset', { detailType: 'checking' });
  ids.pRev = await mkAccount(t, P, 'P4000', 'Fees', 'revenue');
  ids.pSup = await mkAccount(t, P, 'P6100', 'Supplies', 'expense');
  ids.pGp = await mkAccount(t, P, 'P6050', 'Guaranteed payments - A', 'expense');
  ids.pHealth = await mkAccount(t, P, 'P6060', 'Partner B health insurance', 'expense');
  ids.pGain = await mkAccount(t, P, 'P7100', 'Gain on sale of equipment', 'other_revenue');
  await assign(t, P, ids.pRev, 'business', '100');
  await assign(t, P, ids.pGp, 'business', '201');
  await assign(t, P, ids.pGain, 'common', '491');
  await post(t, P, '2026-03-15', [[ids.pChk, 300000, 0], [ids.pRev, 0, 300000]]);
  await post(t, P, '2026-03-20', [[ids.pSup, 100000, 0], [ids.pChk, 0, 100000]]);
  await post(t, P, '2026-04-01', [[ids.pGp, 60000, 0], [ids.pChk, 0, 60000]]);
  await post(t, P, '2026-04-02', [[ids.pHealth, 10000, 0], [ids.pChk, 0, 10000]]);
  await post(t, P, '2026-05-02', [[ids.pChk, 40000, 0], [ids.pGain, 0, 40000]]);

  // ── S corp (1120S): 240,000 sales, officer wages 4,500/mo, officer health 1,000/mo, officer SEP 6,000 ──
  const S = await mkCompany(t, 'Ozark Officer Co', { accountingMethod: 'cash', entityType: 's_corp' });
  ids.S = S;
  await setProfile(t, S, '1120S', 'business');
  ids.sChk = await mkAccount(t, S, 'S1010', 'Operating', 'asset', { detailType: 'checking' });
  ids.sRev = await mkAccount(t, S, 'S4000', 'Sales', 'revenue');
  ids.sWages = await mkAccount(t, S, 'S6010', 'Officer Compensation', 'expense');
  ids.sHealth = await mkAccount(t, S, 'S6020', 'Officer health insurance', 'expense');
  ids.sSep = await mkAccount(t, S, 'S6030', 'Officer SEP contribution', 'expense');
  await assign(t, S, ids.sRev, 'business', '100');
  for (let m = 1; m <= 12; m++) {
    const dt = `2026-${String(m).padStart(2, '0')}-10`;
    await post(t, S, dt, [[ids.sChk, 20000, 0], [ids.sRev, 0, 20000]]);
    await post(t, S, dt, [[ids.sWages, 4500, 0], [ids.sChk, 0, 4500]]);
    await post(t, S, dt, [[ids.sHealth, 1000, 0], [ids.sChk, 0, 1000]]);
  }
  await post(t, S, '2026-12-15', [[ids.sSep, 6000, 0], [ids.sChk, 0, 6000]]);

  // ── Sch C with a TB 887 SEHI code and no estimator treatment (F3), never reconciled (F5) ──
  const C = await mkCompany(t, 'Coded Plumbing', { accountingMethod: 'cash', entityType: 'single_member_llc' });
  ids.C = C;
  await setProfile(t, C, '1040', 'business');
  ids.cChk = await mkAccount(t, C, '1010', 'Checking', 'asset', { detailType: 'checking' });
  ids.cRev = await mkAccount(t, C, '4000', 'Revenue', 'revenue');
  ids.cHealth = await mkAccount(t, C, '6200', 'Health insurance', 'expense');
  ids.cInterest = await mkAccount(t, C, '7000', 'Interest income', 'other_revenue');
  await assign(t, C, ids.cRev, 'business', '801');
  await assign(t, C, ids.cHealth, 'business', '887');
  for (let m = 1; m <= 12; m++) {
    const dt = `2026-${String(m).padStart(2, '0')}-12`;
    await post(t, C, dt, [[ids.cChk, 2000, 0], [ids.cRev, 0, 2000]]);
    await post(t, C, dt, [[ids.cHealth, 100, 0], [ids.cChk, 0, 100]]);
  }
  await post(t, C, '2026-06-30', [[ids.cChk, 240, 0], [ids.cInterest, 0, 240]]);

  // ── Accrual Sch C: estimated tax entered as bills to the IRS (F4) ──
  const Q = await mkCompany(t, 'Accrual Bills Co', { accountingMethod: 'accrual', entityType: 'sole_prop' });
  ids.Q = Q;
  ids.qChk = await mkAccount(t, Q, 'Q1010', 'Checking', 'asset', { detailType: 'checking' });
  ids.qAp = await mkAccount(t, Q, 'Q2000', 'Accounts Payable', 'liability', { detailType: 'accounts_payable' });
  ids.qEst = await mkAccount(t, Q, 'Q3030', 'Estimated Tax Payments', 'equity');
  const paidBill = await post(t, Q, '2026-05-01', [[ids.qEst, 6000, 0], [ids.qAp, 0, 6000]], { txnType: 'bill', total: '6000' });
  await post(t, Q, '2026-09-01', [[ids.qEst, 6000, 0], [ids.qAp, 0, 6000]], { txnType: 'bill', total: '6000' }); // never paid
  const pay = await post(t, Q, '2026-06-20', [[ids.qAp, 6000, 0], [ids.qChk, 0, 6000]], { txnType: 'bill_payment', total: '6000' });
  await db.insert(billPaymentApplications).values({ tenantId: t, companyId: Q, paymentId: pay, billId: paidBill, amount: '6000' });

  // ── Reconciled company (F5 default = last closed month, F11 card opened mid-year, F12 lookalike scope) ──
  const R = await mkCompany(t, 'Reconciled Co', { accountingMethod: 'cash', entityType: 'sole_prop' });
  ids.R = R;
  ids.rChk = await mkAccount(t, R, 'R1010', 'Checking', 'asset', { detailType: 'checking' });
  ids.rCard = await mkAccount(t, R, 'R2100', 'New Card', 'liability', { detailType: 'credit_card' });
  ids.rRev = await mkAccount(t, R, 'R4000', 'Sales', 'revenue');
  ids.rExp = await mkAccount(t, R, 'R6000', 'Expenses', 'expense');
  await post(t, R, '2026-01-05', [[ids.rChk, 1000, 0], [ids.rRev, 0, 1000]]);
  await post(t, R, '2026-09-20', [[ids.rExp, 50, 0], [ids.rCard, 0, 50]]); // card first used Sep 20, never reconciled
  await db.insert(reconciliations).values({
    tenantId: t, companyId: R, accountId: ids.rChk, statementDate: '2026-09-30', statementEndingBalance: '1000', beginningBalance: '0', status: 'complete',
  });
  // Sibling company in the same tenant with an ask-my-accountant balance (F12).
  const R2 = await mkCompany(t, 'Sibling Co', { accountingMethod: 'cash' });
  ids.R2 = R2;
  ids.r2Ama = await mkAccount(t, R2, 'R26999', 'Ask My Accountant', 'expense', { balance: '75' });

  // ── Farm via estimator setting, no TB profile, all revenue unassigned (F8) ──
  const F = await mkCompany(t, 'Prairie Farm', { accountingMethod: 'cash', entityType: 'sole_prop' });
  ids.F = F;
  ids.fChk = await mkAccount(t, F, 'F1010', 'Checking', 'asset', { detailType: 'checking' });
  ids.fRev = await mkAccount(t, F, 'F4000', 'Grain sales', 'revenue');
  await post(t, F, '2025-08-01', [[ids.fChk, 300000, 0], [ids.fRev, 0, 300000]]);
  await post(t, F, '2026-08-01', [[ids.fChk, 400000, 0], [ids.fRev, 0, 400000]]);

  // ── Cash basis partial payments of a 3.0000 invoice (F15) ──
  const X = await mkCompany(t, 'Exact Cents Co', { accountingMethod: 'cash', entityType: 'sole_prop' });
  ids.X = X;
  ids.xChk = await mkAccount(t, X, 'X1010', 'Checking', 'asset', { detailType: 'checking' });
  ids.xAr = await mkAccount(t, X, 'X1200', 'AR', 'asset', { detailType: 'accounts_receivable' });
  ids.xRevA = await mkAccount(t, X, 'X4000', 'Service A', 'revenue');
  ids.xRevB = await mkAccount(t, X, 'X4010', 'Service B', 'revenue');
  const inv = await post(t, X, '2026-01-02', [[ids.xAr, 3, 0], [ids.xRevA, 0, 1], [ids.xRevB, 0, 2]], { txnType: 'invoice', total: '3' });
  for (const m of ['01', '02', '03']) {
    const p = await post(t, X, `2026-${m}-20`, [[ids.xChk, 1, 0], [ids.xAr, 0, 1]], { txnType: 'customer_payment', total: '1' });
    await db.insert(paymentApplications).values({ tenantId: t, paymentId: p, invoiceId: inv, amount: '1' });
  }

  // ── Pass-through with a July fiscal year and a 2026 TB tax RJE (F14) ──
  const Y = await mkCompany(t, 'July FY S Corp', { accountingMethod: 'cash', entityType: 's_corp', fyStartMonth: 7 });
  ids.Y = Y;
  await setProfile(t, Y, '1120S', 'business');
  ids.yChk = await mkAccount(t, Y, 'Y1010', 'Checking', 'asset', { detailType: 'checking' });
  ids.yExp = await mkAccount(t, Y, 'Y6000', 'Repairs', 'expense');
  ids.yOther = await mkAccount(t, Y, 'Y6100', 'Depreciation', 'expense');
  await post(t, Y, '2026-02-01', [[ids.yExp, 900, 0], [ids.yChk, 0, 900]]);
  const [rje] = await db.insert(tbTaxEntries).values({ tenantId: t, companyId: Y, taxYear: 2026, entryNumber: 1 }).returning();
  await db.insert(tbTaxEntryLines).values([
    { tenantId: t, entryId: rje!.id, accountId: ids.yExp, debit: '0', credit: '500', lineOrder: 0 },
    { tenantId: t, entryId: rje!.id, accountId: ids.yOther, debit: '500', credit: '0', lineOrder: 1 },
  ]);

  // ── Firm (tenant-owned) code assigned to an account (F13) ──
  const [fc] = await db.insert(firmTaxCodes).values({
    tenantId: t, code: 'FIRM:R1', description: 'Other income', returnForm: '1065', activityType: 'common',
  }).returning();
  firmCodeId = fc!.id;
  ids.pFirm = await mkAccount(t, P, 'P7200', 'Misc portfolio', 'other_revenue');
  await db.insert(accountTaxAssignments).values({
    tenantId: t, companyId: P, accountId: ids.pFirm, activityUnitId: null, firmCodeId, source: 'manual',
  });
}, 120_000);

afterAll(async () => {
  await purgeTenants([tenant]);
  for (const id of taxpayerIds) {
    await db.delete(taxEstPersons).where(eq(taxEstPersons.taxpayerId, id));
    await db.delete(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, id));
  }
  await pool.end();
});

/** `through` null = no range end (the provider default). */
const pl = (companyId: string, through: string | null = '2026-12', today = OCT_11) =>
  getTaxBasisPl(scope, { tenantId: tenant, companyId, taxYear: 2026, throughMonth: through ?? undefined }, { skipCache: true, today });

describe('F1 — partnership guaranteed payments reach the partner', () => {
  it('a TB GP code with no treatment is suggested (never applied) and warned loudly', async () => {
    const r = await pl(ids.P!);
    expect(r.guaranteedPayments).toEqual([]);
    const w = r.warnings.find((x) => x.code === 'TE_GP_CODE_WITHOUT_TREATMENT');
    expect(w?.severity).toBe('warning');
    expect(w?.message).toMatch(/NOT allocated to any partner/);
    const s = await suggestTreatments(scope, tenant, ids.P!);
    expect(s.find((x) => x.accountId === ids.pGp)).toMatchObject({ treatment: 'guaranteed_payment', basis: 'tb_code' });
  });

  it('the person is required (Zod + service)', async () => {
    expect(accountTreatmentInputSchema.safeParse({ accountId: ids.pGp, treatment: 'guaranteed_payment', nonRecurring: false }).success).toBe(false);
    await expect(putTreatments(scope, tenant, ids.P!, [{ accountId: ids.pGp!, treatment: 'guaranteed_payment', nonRecurring: false }]))
      .rejects.toMatchObject({ statusCode: 422, code: 'TE_PERSON_REQUIRED' });
  });

  it('50/50 partnership: GP 60,000 stays deducted at the entity and goes to partner A only', async () => {
    await putTreatments(scope, tenant, ids.P!, [
      { accountId: ids.pGp!, treatment: 'guaranteed_payment', paymentPersonId: personA, nonRecurring: false },
    ]);
    const r = await pl(ids.P!);
    // 300,000 − 100,000 − 60,000 GP − 10,000 health (ordinary until treated) + 40,000 gain + 0
    expect(d(r.byCharacter.ordinary)).toBe(170000);
    expect(r.guaranteedPayments).toHaveLength(1);
    expect(r.guaranteedPayments[0]).toMatchObject({ personId: personA, amount: '60000.0000' });
    expect(r.guaranteedPayments[0]!.trace[0]!.source).toBe('gl_map');
    expect(r.accounts.find((a) => a.accountId === ids.pGp)).toMatchObject({ route: 'guaranteed_payment', personId: personA, taxAmount: '-60000.0000' });
    expect(r.warnings.find((x) => x.code === 'TE_GP_CODE_WITHOUT_TREATMENT')).toBeUndefined();
    expect(d(r.months[3]!.guaranteedPayments)).toBe(60000);
  });

  it('a guaranteed payment on a Sch C or S corp is rejected (422 TE_TREATMENT_NOT_FOR_ENTITY)', async () => {
    for (const [company, account] of [[ids.C!, ids.cHealth!], [ids.S!, ids.sWages!]] as const) {
      await expect(putTreatments(scope, tenant, company, [
        { accountId: account, treatment: 'guaranteed_payment', paymentPersonId: personA, nonRecurring: false },
      ])).rejects.toMatchObject({ statusCode: 422, code: 'TE_TREATMENT_NOT_FOR_ENTITY' });
    }
  });
});

describe('F2 / F10 — owner items are entity-type aware and carry a person', () => {
  it('partnership owner SEHI is removed from entity profit and routed to the partner (as before)', async () => {
    await putTreatments(scope, tenant, ids.P!, [
      { accountId: ids.pHealth!, treatment: 'owner_sehi', paymentPersonId: personB, nonRecurring: false },
    ]);
    const r = await pl(ids.P!);
    expect(d(r.byCharacter.ordinary)).toBe(180000);
    expect(d(r.ownerLevel.ownerSehi)).toBe(10000);
    expect(r.ownerLevel.byPerson.find((p) => p.personId === personB)).toMatchObject({ ownerSehi: '10000.0000', sehiAsW2Wages: '0.0000' });
  });

  it('S corp owner items need the officer (422 TE_PERSON_REQUIRED)', async () => {
    await expect(putTreatments(scope, tenant, ids.S!, [{ accountId: ids.sHealth!, treatment: 'owner_sehi', nonRecurring: false }]))
      .rejects.toMatchObject({ statusCode: 422, code: 'TE_PERSON_REQUIRED' });
    await expect(putTreatments(scope, tenant, ids.S!, [{ accountId: ids.sSep!, treatment: 'owner_retirement', nonRecurring: false }]))
      .rejects.toMatchObject({ statusCode: 422, code: 'TE_PERSON_REQUIRED' });
  });

  it('S corp >2% health: kept as the S corp deduction; officer W-2 box 1 + SEHI on that officer (D10)', async () => {
    await putTreatments(scope, tenant, ids.S!, [
      { accountId: ids.sWages!, treatment: 'w2_wages', paymentPersonId: personM, nonRecurring: false },
      { accountId: ids.sHealth!, treatment: 'owner_sehi', paymentPersonId: personM, nonRecurring: false },
      { accountId: ids.sSep!, treatment: 'owner_retirement', paymentPersonId: personM, nonRecurring: false },
    ]);
    const r = await pl(ids.S!);
    expect(r.entityType).toBe('s_corp');
    // 240,000 − 54,000 wages − 12,000 health − 6,000 SEP: all stay corporate deductions.
    expect(d(r.taxBasisProfit)).toBe(168000);
    expect(r.ownerLevel).toMatchObject({ ownerSehi: '12000.0000', sehiAsW2Wages: '12000.0000', ownerRetirement: '0.0000' });
    expect(r.ownerLevel.byPerson).toEqual([expect.objectContaining({
      personId: personM, ownerSehi: '12000.0000', sehiAsW2Wages: '12000.0000', employerRetirement: '6000.0000', ownerRetirement: '0.0000',
    })]);
    expect(r.accounts.find((a) => a.accountId === ids.sHealth)).toMatchObject({ route: 'officer_sehi', taxAmount: '-12000.0000' });
    expect(r.accounts.find((a) => a.accountId === ids.sSep)).toMatchObject({ route: 'officer_retirement' });
    // Officer wages per officer (F10).
    expect(r.w2Wages.byPerson).toEqual([{ personId: personM, ytd: '54000.0000' }]);
  });
});

describe('F3 — a TB SEHI code is honoured without an estimator treatment', () => {
  it('code 887, no treatment: removed from Sch C profit, owner SEHI, traced "from TB code 887"', async () => {
    const r = await pl(ids.C!);
    expect(d(r.bookNetIncome)).toBe(24000 - 1200 + 240);
    expect(d(r.taxBasisProfit)).toBe(24240);
    expect(d(r.ownerLevel.ownerSehi)).toBe(1200);
    const line = r.accounts.find((a) => a.accountId === ids.cHealth)!;
    expect(line).toMatchObject({ treatment: null, effectiveTreatment: 'owner_sehi', treatmentSource: 'tb_code', route: 'owner_sehi' });
    const tr = r.trace.find((x) => x.label.startsWith('6200 Health insurance'))!;
    expect(tr.source).toBe('gl_map');
    expect(tr.formula).toContain('from TB code 887');
  });

  it('estimator treatment + TB code: applied once (never double-removed)', async () => {
    await putTreatments(scope, tenant, ids.C!, [{ accountId: ids.cHealth!, treatment: 'owner_sehi', nonRecurring: false }]);
    const r = await pl(ids.C!);
    expect(d(r.taxBasisProfit)).toBe(24240);
    expect(d(r.ownerLevel.ownerSehi)).toBe(1200);
    expect(r.accounts.find((a) => a.accountId === ids.cHealth)).toMatchObject({ treatmentSource: 'estimator' });
    await putTreatments(scope, tenant, ids.C!, [{ accountId: ids.cHealth!, treatment: null, nonRecurring: false }]);
  });
});

describe('F4 — the payment ledger is always read on a cash basis', () => {
  it('accrual entity: an unpaid IRS bill is not a payment; a paid one counts at the payment date', async () => {
    await putTreatments(scope, tenant, ids.Q!, [{ accountId: ids.qEst!, treatment: 'estimated_tax_payment', paymentJurisdiction: 'federal', nonRecurring: false }]);
    const r = await pl(ids.Q!);
    expect(r.basis).toBe('accrual');
    expect(r.estimatedPayments.map((p) => [p.date, d(p.amount)])).toEqual([['2026-06-20', 6000]]);
  });
});

describe('F5 — default range end = last closed month, else last complete month; never the partial month', () => {
  it('no closed month → last complete calendar month (Sep on Oct 11), months elapsed 9', async () => {
    const r = await pl(ids.C!, null);
    expect(r.throughMonth).toBe('2026-09');
    expect(r.throughMonthSource).toBe('last_complete_month');
    expect(r.throughMonthReason).toMatch(/Last complete calendar month/);
    expect(r.monthsElapsed).toBe(9);
    expect(r.monthsRemaining).toBe(3);
  });

  it('closed month exists → that month, and readiness agrees', async () => {
    const r = await pl(ids.R!, null);
    expect(r.throughMonth).toBe('2026-08'); // card first used Sep 20 (F11), checking reconciled through Sep
    expect(r.throughMonthSource).toBe('last_closed_month');
    const rd = await getReadiness(scope, { tenantId: tenant, companyId: ids.R!, taxYear: 2026 }, { today: OCT_11 });
    expect(rd.throughMonth).toBe('2026-08');
    expect(rd.throughMonthSource).toBe('last_closed_month');
  });

  it('requesting the current month is allowed but warned (TE_RANGE_PARTIAL_MONTH)', async () => {
    const r = await pl(ids.C!, '2026-10');
    expect(r.throughMonthSource).toBe('requested');
    expect(r.warnings.map((w) => w.code)).toContain('TE_RANGE_PARTIAL_MONTH');
    expect((await pl(ids.C!, '2026-09')).warnings.map((w) => w.code)).not.toContain('TE_RANGE_PARTIAL_MONTH');
  });

  it('no complete month in the year yet → 422 TE_NO_COMPLETE_MONTH', async () => {
    await expect(pl(ids.C!, null, new Date('2026-01-10T00:00:00Z'))).rejects.toMatchObject({ statusCode: 422, code: 'TE_NO_COMPLETE_MONTH' });
  });
});

describe('F6 — character is mapped by seed CODE identity, tied to the real seed', () => {
  it('every 2025 seed code → the expected character (no fictional descriptions)', async () => {
    const rows = await db.select().from(taxCodes);
    expect(rows.length).toBeGreaterThan(500);
    const nonOrdinary: Record<string, string[]> = {};
    for (const r of rows) {
      if (r.activityType === 'rental' || r.activityType === 'farm_rental') continue;
      const ch = characterForCode({
        returnForm: r.returnForm, activityType: r.activityType, code: r.code, description: r.description, source: 'seed', isM1Adjustment: r.isM1Adjustment,
      }, 'other_revenue');
      if (ch !== 'ordinary') (nonOrdinary[ch] ??= []).push(`${r.returnForm}|${r.activityType}|${r.code}`);
    }
    for (const k of Object.keys(nonOrdinary)) nonOrdinary[k]!.sort();
    expect(nonOrdinary).toEqual({
      interest: ['1065|common|110', '1065|common|115', '1120S|common|150', '1120S|common|151', '1120|business|105', '1120|business|106'],
      dividends_ordinary: ['1065|common|111', '1120S|common|156', '1120|common|107', '1120|common|108', '1120|common|109',
        '1120|common|112', '1120|common|113', '1120|common|118', '1120|common|121', '1120|common|122'],
      capital_gain_lt: ['1065|common|399', '1120S|common|104', '1120S|common|105', '1120|common|125'],
    });
    // Every identity in the table exists in the seed.
    const seedKeys = new Set(rows.map((r) => `${r.returnForm}|${r.activityType}|${r.code}`));
    for (const k of SEED_CODE_MEANING.keys()) expect(seedKeys.has(k), k).toBe(true);
    // The real 4797 M-1 code is NOT §1231; an interest EXPENSE code is ordinary.
    expect(characterForCode({ returnForm: '1065', activityType: 'common', code: '491', description: 'Sch M-1; var - 4797 gain/loss - book', source: 'seed', isM1Adjustment: true }, 'other_revenue')).toBe('ordinary');
    expect(characterForCode({ returnForm: '1065', activityType: 'common', code: '110', description: '', source: 'seed' }, 'expense')).toBe('ordinary');
  });

  it('M-1 4797 book gain stays ordinary with a warning; a section_1231 treatment sets the character', async () => {
    let r = await pl(ids.P!);
    expect(r.accounts.find((a) => a.accountId === ids.pGain)).toMatchObject({ character: 'ordinary' });
    expect(d(r.byCharacter.section_1231)).toBe(0);
    expect(r.warnings.find((w) => w.code === 'TE_M1_CODE_ON_PL_ACCOUNT')).toBeDefined();
    await putTreatments(scope, tenant, ids.P!, [{ accountId: ids.pGain!, treatment: 'section_1231', nonRecurring: false }]);
    r = await pl(ids.P!);
    expect(r.accounts.find((a) => a.accountId === ids.pGain)).toMatchObject({ character: 'section_1231', characterSource: 'treatment' });
    expect(d(r.byCharacter.section_1231)).toBe(40000);
    expect(r.warnings.find((w) => w.code === 'TE_M1_CODE_ON_PL_ACCOUNT')).toBeUndefined();
  });

  it('Sch C bank interest: the interest treatment makes it interest (no 1040 interest code exists)', async () => {
    await putTreatments(scope, tenant, ids.C!, [{ accountId: ids.cInterest!, treatment: 'interest', nonRecurring: false }]);
    const r = await pl(ids.C!);
    expect(d(r.byCharacter.interest)).toBe(240);
    expect(d(r.byCharacter.ordinary)).toBe(24000);
  });
});

describe('F7 — w2Wages.effective is the projected full year', () => {
  it('through September: YTD 40,500, projected 54,000; the override still wins', async () => {
    let r = await pl(ids.S!, '2026-09');
    expect(r.w2Wages).toMatchObject({ ytd: '40500.0000', projectedYear: '54000.0000', effective: '54000.0000', source: 'books' });
    await upsertYearInputs(scope, tenant, ids.S!, 2026, { w2WagesOverride: '60000', w2WagesOverrideReason: 'payroll report' });
    r = await pl(ids.S!, '2026-09');
    expect(r.w2Wages).toMatchObject({ ytd: '40500.0000', effective: '60000.0000', source: 'override' });
    await upsertYearInputs(scope, tenant, ids.S!, 2026, { w2WagesOverride: null });
  });
});

describe('F8 — Sch F without farm codes counts all income as farming', () => {
  it('estimator sch_f, unassigned revenue → gross farming income from all income accounts + warning', async () => {
    await upsertEntitySettings(scope, tenant, ids.F!, { taxEntityType: 'sch_f' });
    const r = await pl(ids.F!);
    expect(r.entityType).toBe('sch_f');
    expect(r.farmingGrossIncome).toEqual({ currentYear: '400000.0000', priorYear: '300000.0000' });
    expect(r.warnings.map((w) => w.code)).toContain('TE_FARM_INCOME_ASSUMED');
  });
});

describe('F9 — treatments are validated against the account type', () => {
  it('owner_sehi on revenue, a character on an expense → 422 TE_TREATMENT_ACCOUNT_TYPE', async () => {
    await expect(putTreatments(scope, tenant, ids.P!, [{ accountId: ids.pRev!, treatment: 'owner_sehi', paymentPersonId: personA, nonRecurring: false }]))
      .rejects.toMatchObject({ statusCode: 422, code: 'TE_TREATMENT_ACCOUNT_TYPE' });
    await expect(putTreatments(scope, tenant, ids.P!, [{ accountId: ids.pSup!, treatment: 'capital_gain_lt', nonRecurring: false }]))
      .rejects.toMatchObject({ statusCode: 422, code: 'TE_TREATMENT_ACCOUNT_TYPE' });
    await expect(putTreatments(scope, tenant, ids.P!, [{ accountId: ids.pRev!, treatment: 'nondeductible_pct', pct: '50', nonRecurring: false }]))
      .rejects.toMatchObject({ statusCode: 422, code: 'TE_TREATMENT_ACCOUNT_TYPE' });
  });
});

describe('F11 / F12 — readiness', () => {
  it('a card opened mid-year does not null the closed month; look-alikes are company-scoped', async () => {
    const r = await getReadiness(scope, { tenantId: tenant, companyId: ids.R!, throughMonth: '2026-09' }, { today: OCT_11 });
    expect(r.lastClosedMonth).toBe('2026-08');
    expect(r.reconcilableAccounts.find((a) => a.accountId === ids.rCard)).toMatchObject({
      closedThroughMonth: '2026-08', closedThroughSource: 'before_first_activity', firstActivityMonth: '2026-09',
    });
    expect(r.suspense.lookalikeAccounts.map((a) => a.accountId)).not.toContain(ids.r2Ama);
    const sib = await getReadiness(scope, { tenantId: tenant, companyId: ids.R2!, throughMonth: '2026-09' }, { today: OCT_11 });
    expect(sib.suspense.lookalikeAccounts.map((a) => a.accountId)).toContain(ids.r2Ama);
  });
});

describe('F13 — cache config hash covers firm code edits', () => {
  it('editing a firm code description changes the config version', async () => {
    const before = await loadConfigVersion(tenant, ids.P!, 2026);
    await new Promise((r) => setTimeout(r, 5));
    await db.update(firmTaxCodes).set({ description: 'Capital gain distributions', updatedAt: new Date() }).where(eq(firmTaxCodes.id, firmCodeId));
    expect(await loadConfigVersion(tenant, ids.P!, 2026)).not.toBe(before);
  });
});

describe('F14 — TB RJEs use the estimator tax year for pass-throughs', () => {
  it('a July-FY S corp on a calendar window shows its 2026 RJE', async () => {
    const r = await pl(ids.Y!, '2026-09');
    expect(r.periodStart).toBe('2026-01-01');
    expect(r.accounts.find((a) => a.accountId === ids.yExp)!.tbTaxRje).toBe('500.0000');
  });
});

describe('F15 — no float hop: exact decimals from the report builders', () => {
  it('three 1/3 cash recognitions of a 1.0000 revenue line sum to exactly 1.0000', async () => {
    const r = await pl(ids.X!, '2026-03');
    expect(r.accounts.find((a) => a.accountId === ids.xRevA)!.bookAmount).toBe('1.0000');
    expect(r.bookNetIncome).toBe('3.0000');
  });
});

describe('F16 — treatment audits carry the firm', () => {
  it('audit rows for tax_est_treatment are tagged with firmId', async () => {
    const res = await db.execute<{ after_data: string | null }>(sql`
      SELECT after_data::text AS after_data FROM audit_log
      WHERE tenant_id = ${tenant} AND entity_type = 'tax_est_treatment' AND after_data IS NOT NULL LIMIT 5`);
    const rows = res.rows as Array<{ after_data: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(String(row.after_data)).toContain(FIRM);
  });
});

describe('scope (D1) still guards every new path', () => {
  it('a tenant outside the scope → 404 before any query', async () => {
    const other: FirmScope = { ...scope, allowedTenantIds: [] };
    await expect(getTaxBasisPl(other, { tenantId: tenant, companyId: ids.P!, taxYear: 2026 }, { today: OCT_11 }))
      .rejects.toMatchObject({ statusCode: 404, code: 'TE_TENANT_NOT_MANAGED' });
    await expect(suggestTreatments(other, tenant, ids.P!)).rejects.toMatchObject({ statusCode: 404, code: 'TE_TENANT_NOT_MANAGED' });
    const rows = await db.select().from(accountTaxAssignments).where(and(eq(accountTaxAssignments.tenantId, tenant), eq(accountTaxAssignments.companyId, ids.P!)));
    expect(rows.length).toBeGreaterThan(0);
  });
});
