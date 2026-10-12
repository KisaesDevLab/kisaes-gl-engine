// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// R3 service-layer review regressions (features/tax-estimator/docs/reviews/R3-services.md).
// One test per finding, built from the reviewer's probes (§4) against kisbooks_test +
// the test Redis (D13). Every tenant / taxpayer made here is purged afterwards.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db, pool } from '../../db/index.js';
import { companies, accounts, taxEstTaxpayers } from '../../db/schema/index.js';
import { reconciliations } from '../../db/schema/banking.js';
import { closeTbRedis } from '../tb/tb-redis.js';
import { tenantInScopeSql, type FirmScope } from './firm-scope.service.js';
import { getParameters, syncShippedSeeds } from './tax-parameters.service.js';
import { getStateRules, syncShippedStateRules } from './tax-state-rules.service.js';
import { createTaxpayer, upsertPerson, upsertLink } from './taxpayers.service.js';
import { putTreatments, listTreatments } from './treatments.service.js';
import { upsertYear } from './years.service.js';
import { createAdjustment } from './adjustments.service.js';
import { listAdjustmentTypes } from './adjustment-types.service.js';
import { upsertEntitySettings } from './entity-settings.service.js';
import { createScenario, deleteScenario } from './scenarios.service.js';
import { createPayment, getPaymentLedger, paymentWindow } from './payments.service.js';
import { replaceStateRows } from './state-rows.service.js';
import { listSummaries } from './tax-state-rules.service.js';
import { computeEstimate } from './estimate.service.js';
import { createSnapshot, compareSnapshot } from './estimate-snapshots.service.js';
import { captureSnapshots } from './sch-ai-snapshots.service.js';
import { mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';

const FIRM = '00000000-0000-4000-8000-000000000f73';
const FIRM_B = '00000000-0000-4000-8000-000000000f74';
const USER = '00000000-0000-4000-8000-000000000073';
const TODAY = new Date('2026-10-12T12:00:00Z');
const mm = (m: number) => String(m).padStart(2, '0');

const T = { linked: '', unlinked: '', farm: '', cc: '' };
const C = { linked: '', unlinked: '', gone: '', farm: '', cc: '' };
const A = { chk: '', draws: '', exp2: '' };
let scopeFull: FirmScope;
let scopePartial: FirmScope;
let actor = { tenantId: '', userId: USER };
let taxpayerId = '';
let primaryId = '';
let baseId = '';
const taxpayers: string[] = [];
let janTxn = '';
let marTxn = '';

async function mkTp(name: string, scope: FirmScope = scopeFull) {
  const id = (await createTaxpayer(scope, actor, { displayName: name, filingStatus: 'single', residentState: 'MO' })).id;
  taxpayers.push(id);
  const p = await upsertPerson(scope, actor, id, 'primary', { firstName: 'R', lastName: name, dateOfBirth: '1980-01-01', isBlind: false });
  return { id, personId: p.id };
}

beforeAll(async () => {
  await syncShippedSeeds();
  await syncShippedStateRules();
  T.linked = await mkTenant('R3 linked');
  T.unlinked = await mkTenant('R3 unlinked');
  C.linked = await mkCompany(T.linked, 'R3 Linked Co', { accountingMethod: 'cash', entityType: 'sole_prop' });
  C.unlinked = await mkCompany(T.unlinked, 'R3 Unlinked Co', { accountingMethod: 'cash', entityType: 'sole_prop' });
  A.chk = await mkAccount(T.linked, C.linked, '1010', 'Checking', 'asset', { detailType: 'checking' });
  const rev1 = await mkAccount(T.linked, C.linked, '4000', 'Revenue', 'revenue');
  A.draws = await mkAccount(T.linked, C.linked, '3020', 'Owner Draws', 'equity', { detailType: 'owners_draw' });
  const chk2 = await mkAccount(T.unlinked, C.unlinked, '1010', 'Checking', 'asset', { detailType: 'checking' });
  A.exp2 = await mkAccount(T.unlinked, C.unlinked, '6500', 'Secret expense', 'expense');
  for (let m = 1; m <= 12; m++) {
    await post(T.linked, C.linked, `2026-${mm(m)}-15`, [[A.chk, 10000, 0], [rev1, 0, 10000]]);
    await post(T.unlinked, C.unlinked, `2026-${mm(m)}-15`, [[A.exp2, 1000, 0], [chk2, 0, 1000]]);
  }
  scopeFull = { firmId: FIRM, firmRole: 'firm_staff', allowedTenantIds: [T.linked, T.unlinked] };
  scopePartial = { firmId: FIRM, firmRole: 'firm_staff', allowedTenantIds: [T.linked] };
  actor = { tenantId: T.linked, userId: USER };

  const tp = await mkTp('R3 Probe');
  taxpayerId = tp.id; primaryId = tp.personId;
  for (const y of [2026, 2027]) {
    await upsertLink(scopeFull, actor, taxpayerId, { personRole: 'primary', taxYear: y, tenantId: T.linked, companyId: C.linked, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
  }
  await putTreatments(scopeFull, T.linked, C.linked, [{ accountId: A.draws, treatment: 'estimated_tax_payment', paymentTaxpayerId: taxpayerId, paymentPersonId: primaryId, paymentJurisdiction: 'federal', nonRecurring: false }]);
  const year = await upsertYear(scopeFull, actor, taxpayerId, 2026, { priorYearTax: '10000', priorYearAgi: '90000' });
  baseId = year.scenarios.find((s) => s.isBase)!.id;
  await upsertYear(scopeFull, actor, taxpayerId, 2027, {});
  const otherDed = (await listAdjustmentTypes(scopeFull)).find((t) => t.code === 'other_deduction')!.id;
  // GL-linked adjustment reading an account in the UNLINKED tenant (in scopeFull only).
  await createAdjustment(scopeFull, actor, baseId, { adjustmentTypeId: otherDed, label: 'T2 secret', amount: null, cadence: 'monthly', startMonth: 1, endMonth: 12, glLinked: true, tenantId: T.unlinked, companyId: C.unlinked, accountId: A.exp2, nonRecurring: false });

  // Payments around the year boundary (R3-02 / R3-11).
  janTxn = await post(T.linked, C.linked, '2027-01-15', [[A.draws, 2500, 0], [A.chk, 0, 2500]]);
  marTxn = await post(T.linked, C.linked, '2027-03-01', [[A.draws, 800, 0], [A.chk, 0, 800]]);
}, 180_000);

afterAll(async () => {
  if (taxpayers.length) await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.id, taxpayers));
  await purgeTenants([T.linked, T.unlinked, T.farm, T.cc]);
  await closeTbRedis();
  await pool.end();
});

describe('R3-01 — the estimate cache is per tenant scope (D1)', () => {
  it('a member who cannot reach T2 never gets the cached result that read T2', async () => {
    const req = { taxpayerId, taxYear: 2026, scenarioId: baseId, throughMonth: '2026-08' };
    const full = await computeEstimate(scopeFull, { ...req, refresh: true }, { today: TODAY });
    expect(full.adjustments!.find((a) => a.label === 'T2 secret')!.fullYearAmount).toBe('12000');
    const partial = await computeEstimate(scopePartial, req, { today: TODAY });
    expect(partial.cached).toBe(false);
    expect(partial.inputsHash).not.toBe(full.inputsHash);
    expect(Number(partial.adjustments!.find((a) => a.label === 'T2 secret')!.fullYearAmount)).toBe(0);
    expect(partial.warnings.some((w) => w.code === 'TE_TENANT_NOT_MANAGED')).toBe(true);
    // The same scope still hits its own entry.
    expect((await computeEstimate(scopePartial, req, { today: TODAY })).cached).toBe(true);
  });
});

describe('R3-03 — reconciliation state is part of the cache key', () => {
  it('completing a reconciliation moves the default range end on the next (non-refresh) call', async () => {
    const req = { taxpayerId, taxYear: 2026, scenarioId: baseId };
    const before = await computeEstimate(scopeFull, { ...req, refresh: true }, { today: TODAY });
    expect(before.entities[0]!.throughMonth).toBe('2026-09');
    expect(before.entities[0]!.throughMonthSource).toBe('last_complete_month');
    const [rec] = await db.insert(reconciliations).values({ tenantId: T.linked, companyId: C.linked, accountId: A.chk, statementDate: '2026-06-30', statementEndingBalance: '60000', beginningBalance: '0', status: 'complete', completedAt: new Date() }).returning();
    try {
      const after = await computeEstimate(scopeFull, req, { today: TODAY });
      expect(after.cached).toBe(false);
      expect(after.entities[0]!.throughMonth).toBe('2026-06');
      expect(after.entities[0]!.throughMonthSource).toBe('last_closed_month');
    } finally {
      await db.delete(reconciliations).where(eq(reconciliations.id, rec!.id));
    }
  });
});

describe('R3-02 / R3-11 — one booked payment, one tax year', () => {
  it('the January Q4 payment is credited to 2026 only; consecutive windows do not overlap', async () => {
    const [w26, w27] = await Promise.all([paymentWindow(2026), paymentWindow(2027)]);
    expect(w26.end < w27.start).toBe(true);
    const l26 = await getPaymentLedger(scopeFull, taxpayerId, 2026, null);
    const l27 = await getPaymentLedger(scopeFull, taxpayerId, 2027, null);
    expect(l26.payments.filter((p) => p.transactionId === janTxn)).toHaveLength(1);
    expect(l27.payments.some((p) => p.transactionId === janTxn)).toBe(false);
    // A March payment (after the 2026 Q4 cutoff, before the first 2027 installment) is 2027's, flagged.
    expect(l26.payments.some((p) => p.transactionId === marTxn)).toBe(false);
    expect(l27.payments.filter((p) => p.transactionId === marTxn)).toHaveLength(1);
    expect(l27.warnings.some((w) => w.code === 'TE_PAYMENT_YEAR_ASSUMED' && (w.details as { transactionId?: string }).transactionId === marTxn)).toBe(true);
  });

  it('pinning a transaction to another year removes it from its default year, and a second year is refused', async () => {
    const pin = await createPayment(scopeFull, actor, taxpayerId, 2026, { jurisdiction: 'federal', date: '2027-03-01', amount: '800', source: 'gl', tenantId: T.linked, transactionId: marTxn, memo: 'late Q4' });
    try {
      const l26 = await getPaymentLedger(scopeFull, taxpayerId, 2026, null);
      const l27 = await getPaymentLedger(scopeFull, taxpayerId, 2027, null);
      expect(l26.payments.filter((p) => p.transactionId === marTxn).map((p) => p.stored)).toEqual([true]);
      expect(l27.payments.some((p) => p.transactionId === marTxn)).toBe(false);
      expect(l27.warnings.some((w) => w.code === 'TE_PAYMENT_PINNED_OTHER_YEAR')).toBe(true);
      await expect(createPayment(scopeFull, actor, taxpayerId, 2027, { jurisdiction: 'federal', date: '2027-03-01', amount: '800', source: 'gl', tenantId: T.linked, transactionId: marTxn }))
        .rejects.toMatchObject({ statusCode: 409, code: 'TE_PAYMENT_OTHER_YEAR' });
    } finally {
      await db.execute(sql`DELETE FROM tax_est_payments WHERE id = ${pin.id}`);
    }
  });

  it('R3-11: a pin under a corrected jurisdiction supersedes the GL row of that transaction (never counted twice)', async () => {
    const pin = await createPayment(scopeFull, actor, taxpayerId, 2026, { jurisdiction: 'MO', date: '2027-01-15', amount: '2500', source: 'gl', tenantId: T.linked, transactionId: janTxn });
    try {
      const l26 = await getPaymentLedger(scopeFull, taxpayerId, 2026, null);
      const rows = l26.payments.filter((p) => p.transactionId === janTxn);
      expect(rows.map((p) => [p.jurisdiction, p.stored])).toEqual([['MO', true]]);
      expect(l26.duplicatesDropped.map((p) => [p.transactionId, p.jurisdiction])).toEqual([[janTxn, 'federal']]);
      expect(l26.warnings.some((w) => w.code === 'TE_PAYMENT_JURISDICTION_CHANGED')).toBe(true);
    } finally {
      await db.execute(sql`DELETE FROM tax_est_payments WHERE id = ${pin.id}`);
    }
  });
});

describe('R3-04 — fallback-year dates are rolled to the requested year', () => {
  it('federal: return due date, installment dates and holidays move by (year − fallback year)', async () => {
    const latest = await getParameters(2026);
    expect(latest.isFallback).toBe(false);
    const year = 2031; // never seeded
    const dto = await getParameters(year);
    expect(dto.isFallback).toBe(true);
    const shift = year - dto.fallbackYear!;
    const value = (d: typeof dto, k: string) => d.parameters.find((p) => p.key === k)?.value;
    const fbase = await getParameters(dto.fallbackYear!);
    const rdd = String(value(dto, 'return_due_date'));
    expect(rdd.slice(0, 4)).toBe(String(Number(String(value(fbase, 'return_due_date')).slice(0, 4)) + shift));
    expect(rdd).toMatch(new RegExp(`^${year + 1}-04-1[5-9]$`)); // Apr 15 (business-day adjusted)
    const due = value(dto, 'installments.due_dates') as string[];
    expect(due[0]!.slice(0, 4)).toBe(String(year));
    expect(due[3]!.slice(0, 4)).toBe(String(year + 1));
    for (const h of value(dto, 'holidays') as string[]) expect([String(year), String(year + 1)]).toContain(h.slice(0, 4));
    // Non-date values are served unchanged.
    expect(value(dto, 'se.ss_rate')).toEqual(value(fbase, 'se.ss_rate'));
    const w = await paymentWindow(year);
    expect(w.end.slice(0, 4)).toBe(String(year + 1));
    expect(w.returnDueDate).toBe(rdd);
  });

  it('state: a fallback year rolls the due dates of MO', async () => {
    const dto = await getStateRules(2031, 'MO');
    expect(dto.isFallback).toBe(true);
    const due = dto.rules.find((r) => r.key === 'installments.due_dates')!.value as string[];
    expect(due[0]!.slice(0, 4)).toBe('2031');
    expect(due[due.length - 1]!.slice(0, 4)).toBe('2032');
  });

  it('R6-03: an estimate for a year with no MO rules warns TE_STATE_RULES_FALLBACK_YEAR, and the admin summary says the same (status fallback)', async () => {
    const latestShipped = 2026; // the newest shipped MO rule set
    const year = 2027; // the fixture has a 2027 year; no 2027 state rules ship yet
    const mo = await getStateRules(year, 'MO');
    if (!mo.isFallback) return; // 2027 MO rules have shipped: nothing to fall back from
    expect(mo.fallbackYear).toBe(latestShipped);
    const y = await upsertYear(scopeFull, actor, taxpayerId, year, {});
    const scenarioId = y.scenarios.find((s) => s.isBase)!.id;
    await replaceStateRows(scopeFull, actor, scenarioId, { rows: [{ residency: 'resident', state: 'MO', effectiveRate: 0.04, base: 'federal_agi', sourcedManual: false }] });
    const r = await computeEstimate(scopeFull, { taxpayerId, taxYear: year, scenarioId, throughMonth: `${year}-01`, refresh: true }, { today: new Date(`${year}-02-15T12:00:00Z`) });
    const w = r.warnings.find((x) => x.code === 'TE_STATE_RULES_FALLBACK_YEAR');
    expect(w).toBeDefined();
    expect(w!.details).toMatchObject({ state: 'MO', fallbackYear: mo.fallbackYear });
    expect(r.warnings.some((x) => x.code === 'TE_PARAMS_FALLBACK_YEAR')).toBe(true);
    // the rules the engine used are MO's, provisional, with the dates derived for the year
    expect(r.rulesUsed.filter((u) => u.state === 'MO').every((u) => u.status === 'provisional')).toBe(true);
    const summary = (await listSummaries(year)).find((s) => s.state === 'MO')!;
    expect(summary).toMatchObject({ status: 'fallback', fallbackYear: mo.fallbackYear, usesFederalFallback: false });
    expect(r.stateEstimates.find((s) => s.jurisdiction === 'MO')?.usesFederalFallback).toBe(false);
  });
});

describe('R3-05 / R3-09 — farmer override and the prior-year books leg', () => {
  let farmTp = '';
  let farmBase = '';
  beforeAll(async () => {
    T.farm = await mkTenant('R3 farm');
    C.farm = await mkCompany(T.farm, 'R3 Farm', { accountingMethod: 'cash', entityType: 'sole_prop' });
    await setProfile(T.farm, C.farm, '1040', 'farm');
    const chk = await mkAccount(T.farm, C.farm, '1010', 'Checking', 'asset', { detailType: 'checking' });
    const crops = await mkAccount(T.farm, C.farm, '4000', 'Crop sales', 'revenue');
    for (let m = 1; m <= 12; m++) {
      await post(T.farm, C.farm, `2026-${mm(m)}-10`, [[chk, 8000, 0], [crops, 0, 8000]]);
      await post(T.farm, C.farm, `2025-${mm(m)}-10`, [[chk, 7000, 0], [crops, 0, 7000]]);
    }
    scopeFull = { ...scopeFull, allowedTenantIds: [...scopeFull.allowedTenantIds, T.farm] };
    const tp = await mkTp('R3 Farmer');
    farmTp = tp.id;
    await upsertLink(scopeFull, actor, farmTp, { personRole: 'primary', taxYear: 2026, tenantId: T.farm, companyId: C.farm, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
    const y = await upsertYear(scopeFull, actor, farmTp, 2026, { priorYearTax: '9000', priorYearAgi: '50000' });
    farmBase = y.scenarios.find((s) => s.isBase)!.id;
  }, 120_000);

  const run = () => computeEstimate(scopeFull, { taxpayerId: farmTp, taxYear: 2026, scenarioId: farmBase, throughMonth: '2026-09', refresh: true }, { today: TODAY });

  it('R3-09: without manual figures the prior-year test uses the books farming gross', async () => {
    await upsertEntitySettings(scopeFull, T.farm, C.farm, { farmerOverride: null }, USER);
    const r = await run();
    expect(r.farmer).not.toBeNull();
    expect(r.farmer!.tests.map((t) => t.year).sort()).toEqual(['current', 'prior']);
    const prior = r.farmer!.tests.find((t) => t.year === 'prior')!;
    expect(Number(prior.farmingAndFishing)).toBe(84000);
    expect(Number(prior.totalGross)).toBe(84000 + 50000);
    expect(r.warnings.some((w) => w.code === 'TE_FARMER_PRIOR_GROSS_FROM_BOOKS')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'TE_FARMER_PRIOR_GROSS_MISSING')).toBe(false);
  });

  it('R3-05: farmerOverride = false turns the farmer rules off (quarterly schedule)', async () => {
    const on = await run();
    expect(on.farmer!.qualifies).toBe(true); // all income is farming (assumed) → passes
    await upsertEntitySettings(scopeFull, T.farm, C.farm, { farmerOverride: false }, USER);
    try {
      const off = await run();
      expect(off.farmer).not.toBeNull();
      expect(off.farmer!.qualifies).toBe(false);
      expect(off.farmer!.basis).toBe('override');
      expect(off.federalEstimates.installments).toHaveLength(4);
    } finally {
      await upsertEntitySettings(scopeFull, T.farm, C.farm, { farmerOverride: null }, USER);
    }
  });
});

describe('R3-10 — a GL-linked adjustment into a deleted company degrades to a warning', () => {
  it('the estimate still computes and the adjustment uses its manual amount', async () => {
    C.gone = await mkCompany(T.linked, 'R3 Soon Gone');
    const acct = await mkAccount(T.linked, null, '6900', 'Tenant-level expense', 'expense');
    const tp = await mkTp('R3 Gone');
    await upsertLink(scopeFull, actor, tp.id, { personRole: 'primary', taxYear: 2026, tenantId: T.linked, companyId: C.linked, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
    const y = await upsertYear(scopeFull, actor, tp.id, 2026, {});
    const base = y.scenarios.find((s) => s.isBase)!.id;
    const otherDed = (await listAdjustmentTypes(scopeFull)).find((t) => t.code === 'other_deduction')!.id;
    await createAdjustment(scopeFull, actor, base, { adjustmentTypeId: otherDed, label: 'Gone co', amount: '1200', cadence: 'annual', startMonth: 1, endMonth: 12, glLinked: true, tenantId: T.linked, companyId: C.gone, accountId: acct, nonRecurring: false });
    await db.delete(companies).where(eq(companies.id, C.gone));
    const r = await computeEstimate(scopeFull, { taxpayerId: tp.id, taxYear: 2026, scenarioId: base, throughMonth: '2026-09', refresh: true }, { today: TODAY });
    expect(r.warnings.some((w) => w.code === 'TE_ADJUSTMENT_ACCOUNT_UNREADABLE')).toBe(true);
    expect(r.adjustments!.find((a) => a.label === 'Gone co')!.fullYearAmount).toBe('1200');
    await db.delete(accounts).where(eq(accounts.id, acct));
  });
});

describe('R7-05 — a non-recurring GL-linked adjustment is never run-rated', () => {
  it('run-rate from GL on a one-time March amount: actuals only when flagged non-recurring', async () => {
    const co = await mkCompany(T.linked, 'R7-05 Recovery Co', { accountingMethod: 'cash', entityType: 'sole_prop' });
    const chk = await mkAccount(T.linked, co, '1705', 'R7-05 Checking', 'asset', { detailType: 'checking' });
    const recovery = await mkAccount(T.linked, co, '6950', 'Insurance recovery', 'expense');
    await post(T.linked, co, '2026-03-10', [[recovery, 30000, 0], [chk, 0, 30000]]);
    const tp = await mkTp('R7-05');
    await upsertLink(scopeFull, actor, tp.id, { personRole: 'primary', taxYear: 2026, tenantId: T.linked, companyId: C.linked, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
    const y = await upsertYear(scopeFull, actor, tp.id, 2026, {});
    const base = y.scenarios.find((s) => s.isBase)!.id;
    const otherDed = (await listAdjustmentTypes(scopeFull)).find((t) => t.code === 'other_deduction')!.id;
    const gl = { adjustmentTypeId: otherDed, amount: null, cadence: 'monthly' as const, startMonth: 1, endMonth: 12, glLinked: true, tenantId: T.linked, companyId: co, accountId: recovery };
    await createAdjustment(scopeFull, actor, base, { ...gl, label: 'One-time recovery', nonRecurring: true });
    await createAdjustment(scopeFull, actor, base, { ...gl, label: 'Same, recurring', nonRecurring: false });
    const r = await computeEstimate(scopeFull, { taxpayerId: tp.id, taxYear: 2026, scenarioId: base, throughMonth: '2026-09', refresh: true }, { today: TODAY });
    const amt = (label: string) => Math.abs(Number(r.adjustments!.find((a) => a.label === label)!.fullYearAmount));
    // Recurring: 30,000 + 3 × round(30,000 ÷ 9 = 3,333.33) = 39,999.99 (run-rated). Non-recurring: the 30,000 actual, no phantom ~10,000 for Oct–Dec.
    expect(amt('Same, recurring')).toBe(39999.99);
    expect(amt('One-time recovery')).toBe(30000);
  });
});

describe('R3-08 — Schedule AI capture skips a fiscal-year C corp instead of failing', () => {
  it('captures the individual entity and lists the C corp as skipped', async () => {
    T.cc = await mkTenant('R3 C corp');
    C.cc = await mkCompany(T.cc, 'R3 FY Corp', { accountingMethod: 'accrual', entityType: 'c_corp', fyStartMonth: 7 });
    await setProfile(T.cc, C.cc, '1120', 'business');
    const scope: FirmScope = { ...scopeFull, allowedTenantIds: [...scopeFull.allowedTenantIds, T.cc] };
    const tp = await mkTp('R3 SchAI', scope);
    for (const [t, c] of [[T.linked, C.linked], [T.cc, C.cc]] as const) {
      await upsertLink(scope, actor, tp.id, { personRole: 'primary', taxYear: 2026, tenantId: t, companyId: c, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
    }
    const out = await captureSnapshots(scope, actor, tp.id, 2026, { replace: false }, { today: TODAY });
    expect(out.captured.filter((s) => s.companyId === C.linked)).toHaveLength(3);
    expect(out.captured.some((s) => s.companyId === C.cc)).toBe(false);
    expect(out.skipped.some((w) => w.code === 'TE_SCH_AI_ENTITY_SKIPPED' && (w.details as { companyId?: string }).companyId === C.cc)).toBe(true);
  });
});

describe('R3-14 — tenantInScopeSql binds every tenant id as a parameter', () => {
  it('no id is inlined, and the fragment filters correctly', async () => {
    const q = new PgDialect().sqlToQuery(sql`SELECT 1 FROM tenants WHERE ${tenantInScopeSql(scopeFull, sql`id`)}`);
    expect(q.params).toEqual(scopeFull.allowedTenantIds);
    for (const id of scopeFull.allowedTenantIds) expect(q.sql).not.toContain(id);
    const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM tenants WHERE ${tenantInScopeSql(scopePartial, sql`id`)}`);
    expect((res.rows as Array<{ n: number }>)[0]!.n).toBe(1);
    const none = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM tenants WHERE ${tenantInScopeSql({ ...scopePartial, allowedTenantIds: [] }, sql`id`)}`);
    expect((none.rows as Array<{ n: number }>)[0]!.n).toBe(0);
  });
});

describe('R3-17 — a firm sharing the books cannot re-point another firm\'s payment mapping', () => {
  it('firm B sees the row without firm A ids and gets 409 on a change', async () => {
    const scopeB: FirmScope = { firmId: FIRM_B, firmRole: 'firm_staff', allowedTenantIds: [T.linked] };
    const tpB = (await createTaxpayer(scopeB, actor, { displayName: 'Firm B client', filingStatus: 'single', residentState: 'MO' })).id;
    taxpayers.push(tpB);
    const listed = await listTreatments(scopeB, T.linked, C.linked, { limit: 50, offset: 0 });
    const row = listed.items.find((i) => i.accountId === A.draws)!;
    expect(row.targetOtherFirm).toBe(true);
    expect(row.paymentTaxpayerId).toBeNull();
    expect(row.paymentPersonId).toBeNull();
    await expect(putTreatments(scopeB, T.linked, C.linked, [{ accountId: A.draws, treatment: 'estimated_tax_payment', paymentTaxpayerId: tpB, paymentJurisdiction: 'federal', nonRecurring: false }]))
      .rejects.toMatchObject({ statusCode: 409, code: 'TE_TREATMENT_OTHER_FIRM' });
    // Firm A still owns it.
    const mine = (await listTreatments(scopeFull, T.linked, C.linked, { limit: 50, offset: 0 })).items.find((i) => i.accountId === A.draws)!;
    expect(mine.paymentTaxpayerId).toBe(taxpayerId);
    expect(mine.targetOtherFirm).toBeUndefined();
  });
});

describe('R3-18 — compare after the scenario was deleted', () => {
  it('returns the frozen side with liveUnavailable instead of a 404', async () => {
    const s = await createScenario(scopeFull, actor, taxpayerId, 2026, 'What-if R3');
    const snap = await createSnapshot(scopeFull, actor, { taxpayerId, taxYear: 2026, scenarioId: s.id, throughMonth: '2026-08' }, { today: TODAY });
    await deleteScenario(scopeFull, actor, s.id);
    const c = await compareSnapshot(scopeFull, snap.id, { today: TODAY });
    expect(c.liveUnavailable?.code).toBe('TE_SCENARIO_NOT_FOUND');
    expect(c.liveComputedAt).toBeNull();
    expect(c.summary.live).toBeNull();
    expect(c.summary.snapshot.total).toBe(snap.summary!.total);
    expect(c.differences).toEqual([]);
  });
});
