// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Test-only fixture: the Rivera household (rivera_expected.json) seeded THROUGH THE
// SERVICES into kisbooks_test — three linked companies in three tenants (D1), books for
// the full year, treatments, year inputs (prior-year tax 31,500 / AGI 182,000),
// adjustments and MO / AR state rows. Same setup as estimate.integration.test.ts
// (Phase 10b); used by the Phase 12 snapshot tests. Not imported by production code.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSeed } from '../tb/tax-code-seed.service.js';
import { UNRESTRICTED_VIEWER, type FirmScope } from './firm-scope.service.js';
import { syncShippedSeeds } from './tax-parameters.service.js';
import { syncShippedStateRules } from './tax-state-rules.service.js';
import { createTaxpayer, upsertPerson, upsertLink } from './taxpayers.service.js';
import { putTreatments } from './treatments.service.js';
import { upsertYear } from './years.service.js';
import { createAdjustment } from './adjustments.service.js';
import { listAdjustmentTypes } from './adjustment-types.service.js';
import { replaceStateRows } from './state-rows.service.js';
import { assign, mkAccount, mkCompany, mkTenant, post, setProfile } from './entities.test-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_FILE_PATH = join(here, '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');
export const riveraExpected = JSON.parse(readFileSync(join(here, '..', '..', '..', '..', '..', 'features', 'tax-estimator', 'docs', 'reference-calc', 'rivera_expected.json'), 'utf8')) as Record<string, Record<string, unknown>>;

// Rivera Plumbing books (the Phase 4 fixture): 115,400 book → 128,000 tax basis.
const SUPPLIES = ['4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.36', '4183.33', '4183.33', '4183.34'];
const mm = (m: number) => String(m).padStart(2, '0');

export interface RiveraFixture {
  T: { schc: string; scorp: string; lp: string; other: string };
  C: { schc: string; scorp: string; lp: string; other: string };
  scopeA: FirmScope;
  scopeB: FirmScope;
  actor: { tenantId: string; userId: string };
  taxpayerId: string;
  baseScenarioId: string;
  carlosId: string;
  mariaId: string;
  q1Txn: string;
  decPriorTxn: string;
  janQ4Txn: string;
}

/** Seed the Rivera household for firm A; firm B manages T.other and (also) reaches T.schc. */
export async function seedRivera(FIRM_A: string, FIRM_B: string, userId: string): Promise<RiveraFixture> {
  const T = { schc: '', scorp: '', lp: '', other: '' };
  const C = { schc: '', scorp: '', lp: '', other: '' };
  let scopeA: FirmScope;
  let scopeB: FirmScope;
  let actor = { tenantId: '', userId };
  let taxpayerId = '';
  let baseScenarioId = '';
  let carlosId = '';
  let mariaId = '';
  let q1Txn = '';
  let decPriorTxn = '';
  let janQ4Txn = '';
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  await syncShippedSeeds();
  await syncShippedStateRules();

  // ── tenant 1: Rivera Plumbing LLC (Sch C, cash) ──
  T.schc = await mkTenant('TE10 Rivera Plumbing');
  C.schc = await mkCompany(T.schc, 'Rivera Plumbing LLC', { accountingMethod: 'cash', entityType: 'single_member_llc' });
  await setProfile(T.schc, C.schc, '1040', 'business');
  const r = {
    checking: await mkAccount(T.schc, C.schc, '1010', 'Checking', 'asset', { detailType: 'checking' }),
    draws: await mkAccount(T.schc, C.schc, '3020', 'Owner Draws', 'equity', { detailType: 'owners_draw' }),
    revenue: await mkAccount(T.schc, C.schc, '4000', 'Plumbing Revenue', 'revenue'),
    supplies: await mkAccount(T.schc, C.schc, '6100', 'Supplies', 'expense'),
    health: await mkAccount(T.schc, C.schc, '6200', 'Owner Health Insurance', 'expense'),
    meals: await mkAccount(T.schc, C.schc, '6420', 'Meals', 'expense'),
  };
  await assign(T.schc, C.schc, r.revenue, 'business', '801');
  await assign(T.schc, C.schc, r.supplies, 'business', '822');
  for (let m = 1; m <= 12; m++) {
    const d = `2026-${mm(m)}-15`;
    await post(T.schc, C.schc, d, [[r.checking, 15000, 0], [r.revenue, 0, 15000]]);
    await post(T.schc, C.schc, d, [[r.health, 900, 0], [r.checking, 0, 900]]);
    await post(T.schc, C.schc, d, [[r.meals, 300, 0], [r.checking, 0, 300]]);
    await post(T.schc, C.schc, d, [[r.supplies, SUPPLIES[m - 1]!, 0], [r.checking, 0, SUPPLIES[m - 1]!]]);
  }
  // Federal estimates paid from the owner's draw account (oracle dates and amounts),
  // a December 2025 payment (prior year, outside the window) and the Q4 payment on Jan 15, 2027.
  q1Txn = await post(T.schc, C.schc, '2026-04-15', [[r.draws, 6600, 0], [r.checking, 0, 6600]]);
  await post(T.schc, C.schc, '2026-06-15', [[r.draws, 6600, 0], [r.checking, 0, 6600]]);
  await post(T.schc, C.schc, '2026-09-15', [[r.draws, 6000, 0], [r.checking, 0, 6000]]);
  decPriorTxn = await post(T.schc, C.schc, '2025-12-20', [[r.draws, 5000, 0], [r.checking, 0, 5000]]);
  janQ4Txn = await post(T.schc, C.schc, '2027-01-15', [[r.draws, '7046.10', 0], [r.checking, 0, '7046.10']]);

  // ── tenant 2: Maria Designs Inc (1120S): 138,000 − officer 54,000 − rent 4,000 = 80,000 ──
  T.scorp = await mkTenant('TE10 Maria Designs');
  C.scorp = await mkCompany(T.scorp, 'Maria Designs Inc', { accountingMethod: 'accrual', entityType: 's_corp' });
  await setProfile(T.scorp, C.scorp, '1120S', 'business');
  const s = {
    checking: await mkAccount(T.scorp, C.scorp, '1010', 'Operating', 'asset', { detailType: 'checking' }),
    sales: await mkAccount(T.scorp, C.scorp, '4000', 'Design Fees', 'revenue'),
    officer: await mkAccount(T.scorp, C.scorp, '6010', 'Officer Compensation', 'expense'),
    rent: await mkAccount(T.scorp, C.scorp, '6300', 'Rent', 'expense'),
  };
  await assign(T.scorp, C.scorp, s.sales, 'business', '100');
  await assign(T.scorp, C.scorp, s.officer, 'business', '200');
  for (let m = 1; m <= 12; m++) {
    const d = `2026-${mm(m)}-10`;
    const rent = m === 12 ? '333.37' : '333.33';
    await post(T.scorp, C.scorp, d, [[s.checking, 11500, 0], [s.sales, 0, 11500]]);
    await post(T.scorp, C.scorp, d, [[s.officer, 4500, 0], [s.checking, 0, 4500]]);
    await post(T.scorp, C.scorp, d, [[s.rent, rent, 0], [s.checking, 0, rent]]);
  }

  // ── tenant 3: Oak Street Rentals LP (1065 rental): 8,000 net rent ──
  T.lp = await mkTenant('TE10 Oak Street');
  C.lp = await mkCompany(T.lp, 'Oak Street Rentals LP', { accountingMethod: 'cash', entityType: 'partnership' });
  await setProfile(T.lp, C.lp, '1065', 'rental');
  const l = {
    checking: await mkAccount(T.lp, C.lp, '1010', 'Checking', 'asset', { detailType: 'checking' }),
    rents: await mkAccount(T.lp, C.lp, '4100', 'Gross Rents', 'revenue'),
  };
  await assign(T.lp, C.lp, l.rents, 'rental', '502');
  for (let m = 1; m <= 12; m++) {
    const amt = m === 12 ? '666.63' : '666.67';
    await post(T.lp, C.lp, `2026-${mm(m)}-01`, [[l.checking, amt, 0], [l.rents, 0, amt]]);
  }

  // ── tenant 4: another firm's client ──
  T.other = await mkTenant('TE10 Other Firm Client');
  C.other = await mkCompany(T.other, 'Other Firm Co', { accountingMethod: 'cash', entityType: 'sole_prop' });

  scopeA = { firmId: FIRM_A, firmRole: 'firm_staff', allowedTenantIds: [T.schc, T.scorp, T.lp], viewer: UNRESTRICTED_VIEWER };
  scopeB = { firmId: FIRM_B, firmRole: 'firm_staff', allowedTenantIds: [T.other, T.schc], viewer: UNRESTRICTED_VIEWER };
  actor = { tenantId: T.schc, userId };

  // ── taxpayer setup through the services ──
  const tp = await createTaxpayer(scopeA, actor, { displayName: 'Carlos & Maria Rivera', filingStatus: 'mfj', residentState: 'MO' });
  taxpayerId = tp.id;
  carlosId = (await upsertPerson(scopeA, actor, taxpayerId, 'primary', { firstName: 'Carlos', lastName: 'Rivera', dateOfBirth: '1981-05-10', isBlind: false })).id;
  mariaId = (await upsertPerson(scopeA, actor, taxpayerId, 'spouse', { firstName: 'Maria', lastName: 'Rivera', dateOfBirth: '1983-09-22', isBlind: false })).id;
  const link = (input: Parameters<typeof upsertLink>[3]) => upsertLink(scopeA, actor, taxpayerId, input);
  await link({ personRole: 'primary', taxYear: 2026, tenantId: T.schc, companyId: C.schc, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
  await link({ personRole: 'spouse', taxYear: 2026, tenantId: T.scorp, companyId: C.scorp, profitPct: 50, lossPct: 50, isOfficer: true, activityType: 'active', activeParticipation: false });
  await link({ personRole: 'primary', taxYear: 2026, tenantId: T.lp, companyId: C.lp, profitPct: 100, lossPct: 100, partnerSeStatus: 'limited', isOfficer: false, activityType: 'rental', activeParticipation: false });

  await putTreatments(scopeA, T.schc, C.schc, [
    { accountId: r.health, treatment: 'owner_sehi', nonRecurring: false },
    { accountId: r.meals, treatment: 'nondeductible_pct', pct: '50', nonRecurring: false },
    { accountId: r.draws, treatment: 'estimated_tax_payment', paymentTaxpayerId: taxpayerId, paymentPersonId: carlosId, paymentJurisdiction: 'federal', nonRecurring: false },
  ]);
  await putTreatments(scopeA, T.scorp, C.scorp, [
    { accountId: s.officer, treatment: 'w2_wages', paymentTaxpayerId: taxpayerId, paymentPersonId: mariaId, nonRecurring: false },
  ]);

  const year = await upsertYear(scopeA, actor, taxpayerId, 2026, {
    priorYearTax: '31500', priorYearAgi: '182000', priorYearTwelveMonths: true, priorYearFiled: true,
    creditsNonrefundable: '2200', withholding: { federal: 6000, states: { MO: 2000 } },
    personInputs: { primary: { retirementPlanType: 'sep' }, spouse: { retirementPlanType: 'none' } },
  });
  baseScenarioId = year.scenarios.find((x) => x.isBase)!.id;

  const types = await listAdjustmentTypes(scopeA);
  const typeId = (code: string) => types.find((t) => t.code === code)!.id;
  await createAdjustment(scopeA, actor, baseScenarioId, { adjustmentTypeId: typeId('interest_income'), label: 'Interest income', amount: '2400', cadence: 'annual', startMonth: 1, endMonth: 12, glLinked: false, nonRecurring: false });
  await createAdjustment(scopeA, actor, baseScenarioId, { adjustmentTypeId: typeId('sep_solo_401k'), label: 'SEP contribution', personId: carlosId, amount: '15000', cadence: 'annual', startMonth: 1, endMonth: 12, glLinked: false, nonRecurring: false });

  await replaceStateRows(scopeA, actor, baseScenarioId, { rows: [
    { residency: 'resident', state: 'MO', effectiveRate: 0.04, base: 'federal_agi', sourcedManual: false, priorYearTax: '7050' },
    { residency: 'nonresident', state: 'AR', effectiveRate: 0.039, base: 'federal_agi', sourcedManual: true, sourcedIncome: '8000', priorYearTax: '300' },
  ] });
  return { T, C, scopeA, scopeB, actor, taxpayerId, baseScenarioId, carlosId, mariaId, q1Txn, decPriorTxn, janQ4Txn };
}
