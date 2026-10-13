// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q46 prior-year trend projection, end to end on a seeded tenant: the prior year is read through the
// SAME P&L provider (estimator treatment map: owner health routed out of entity profit; a transaction
// flagged non-recurring left out), split at the current through month, applied by the engine;
// fallback + readiness line on incomplete prior-year books; C corporations refused; the estimate
// cache re-keys on the method and on the prior-year figures; snapshots freeze both; another firm 404s.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { taxEstTaxpayers } from '../../db/schema/index.js';
import { closeTbRedis } from '../tb/tb-redis.js';
import { UNRESTRICTED_VIEWER, type FirmScope } from './firm-scope.service.js';
import { syncShippedSeeds } from './tax-parameters.service.js';
import { syncShippedStateRules } from './tax-state-rules.service.js';
import { createTaxpayer, upsertPerson, upsertLink } from './taxpayers.service.js';
import { putTreatments, putTransactionFlags } from './treatments.service.js';
import { upsertYear } from './years.service.js';
import { upsertYearInputs } from './entity-settings.service.js';
import { computeEstimate, getEstimateReadiness } from './estimate.service.js';
import { createSnapshot } from './estimate-snapshots.service.js';
import { loadPriorYearTrendInputs } from './prior-year-trend.service.js';
import { mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';

const FIRM_A = '00000000-0000-0000-0000-0000000a4600';
const FIRM_B = '00000000-0000-0000-0000-0000000b4600';
const TODAY = new Date('2026-10-12T12:00:00Z');
const mm = (m: number) => String(m).padStart(2, '0');
const T = { a: '', b: '', other: '' };
const C = { a: '', b: '', other: '' };
const A = { checking: '', revenue: '', supplies: '', health: '' };
let scopeA: FirmScope;
let scopeB: FirmScope;
let actor = { tenantId: '', userId: '00000000-0000-0000-0000-0000000004a6' };
let taxpayerId = '';
let scenarioId = '';

beforeAll(async () => {
  await syncShippedSeeds();
  await syncShippedStateRules();

  // Company A (Sch C, cash): 2025 complete and seasonal; 2026 through September.
  T.a = await mkTenant('TE46 Seasonal Landscaping');
  C.a = await mkCompany(T.a, 'Seasonal Landscaping LLC', { accountingMethod: 'cash', entityType: 'single_member_llc' });
  await setProfile(T.a, C.a, '1040', 'business');
  A.checking = await mkAccount(T.a, C.a, '1010', 'Checking', 'asset', { detailType: 'checking' });
  A.revenue = await mkAccount(T.a, C.a, '4000', 'Landscaping Revenue', 'revenue');
  A.supplies = await mkAccount(T.a, C.a, '6100', 'Supplies', 'expense');
  A.health = await mkAccount(T.a, C.a, '6200', 'Owner Health Insurance', 'expense');
  let oneOff = '';
  for (let m = 1; m <= 12; m++) {
    const d = `2025-${mm(m)}-15`;
    const rev = m <= 9 ? 10000 : 20000; // PY recurring ordinary: Jan–Sep 9 × 9,000 = 81,000; Oct–Dec 3 × 19,000 = 57,000
    await post(T.a, C.a, d, [[A.checking, rev, 0], [A.revenue, 0, rev]]);
    await post(T.a, C.a, d, [[A.supplies, 1000, 0], [A.checking, 0, 1000]]);
    await post(T.a, C.a, d, [[A.health, 500, 0], [A.checking, 0, 500]]); // owner SEHI: routed to the owner, not entity ordinary
  }
  oneOff = await post(T.a, C.a, '2025-11-20', [[A.checking, 50000, 0], [A.revenue, 0, 50000]]); // flagged non-recurring below
  for (let m = 1; m <= 9; m++) {
    const d = `2026-${mm(m)}-15`; // CY recurring ordinary 11,000 / month → 99,000 through September
    await post(T.a, C.a, d, [[A.checking, 12000, 0], [A.revenue, 0, 12000]]);
    await post(T.a, C.a, d, [[A.supplies, 1000, 0], [A.checking, 0, 1000]]);
    await post(T.a, C.a, d, [[A.health, 500, 0], [A.checking, 0, 500]]);
  }

  // Company B (Sch C): books start June 2025 → prior year incomplete.
  T.b = await mkTenant('TE46 New Shop');
  C.b = await mkCompany(T.b, 'New Shop LLC', { accountingMethod: 'cash', entityType: 'single_member_llc' });
  await setProfile(T.b, C.b, '1040', 'business');
  const bChecking = await mkAccount(T.b, C.b, '1010', 'Checking', 'asset', { detailType: 'checking' });
  const bRevenue = await mkAccount(T.b, C.b, '4000', 'Sales', 'revenue');
  for (let m = 6; m <= 12; m++) await post(T.b, C.b, `2025-${mm(m)}-10`, [[bChecking, 3000, 0], [bRevenue, 0, 3000]]);
  for (let m = 1; m <= 9; m++) await post(T.b, C.b, `2026-${mm(m)}-10`, [[bChecking, 3000, 0], [bRevenue, 0, 3000]]);

  T.other = await mkTenant('TE46 Other Firm Client');
  C.other = await mkCompany(T.other, 'Other Firm Co', { accountingMethod: 'cash' });

  scopeA = { firmId: FIRM_A, firmRole: 'firm_staff', allowedTenantIds: [T.a, T.b], viewer: UNRESTRICTED_VIEWER };
  scopeB = { firmId: FIRM_B, firmRole: 'firm_staff', allowedTenantIds: [T.other], viewer: UNRESTRICTED_VIEWER };
  actor = { tenantId: T.a, userId: actor.userId };

  await putTreatments(scopeA, T.a, C.a, [{ accountId: A.health, treatment: 'owner_sehi', nonRecurring: false }]);
  await putTransactionFlags(scopeA, T.a, C.a, { flags: [{ transactionId: oneOff, nonRecurring: true }] });

  const tp = await createTaxpayer(scopeA, actor, { displayName: 'Ana & Ben Delgado', filingStatus: 'mfj', residentState: 'MO' });
  taxpayerId = tp.id;
  await upsertPerson(scopeA, actor, taxpayerId, 'primary', { firstName: 'Ana', lastName: 'Delgado', dateOfBirth: '1980-06-06', isBlind: false });
  await upsertLink(scopeA, actor, taxpayerId, { personRole: 'primary', taxYear: 2026, tenantId: T.a, companyId: C.a, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
  const year = await upsertYear(scopeA, actor, taxpayerId, 2026, {});
  scenarioId = year.scenarios.find((x) => x.isBase)!.id;
}, 180_000);

afterAll(async () => {
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B]));
  await purgeTenants([T.a, T.b, T.other]);
  await closeTbRedis();
  await pool.end();
});

const estimate = (extra: { refresh?: boolean } = {}, scope = scopeA) =>
  computeEstimate(scope, { taxpayerId, taxYear: 2026, scenarioId, throughMonth: '2026-09', refresh: true, ...extra }, { today: TODAY, skipProviderCache: true });
const entityA = (r: Awaited<ReturnType<typeof estimate>>) => r.federal.entities.find((e) => e.companyId === C.a)!;

describe('prior-year figures through the P&L provider', () => {
  it('12 months of recurring ordinary: owner health routed out, the flagged one-off excluded', async () => {
    const py = await loadPriorYearTrendInputs(scopeA, T.a, C.a, 2026, 'sch_c', { today: TODAY, skipCache: true });
    expect(py.reason).toBeNull();
    expect(py.figures!.taxYear).toBe(2025);
    expect(py.figures!.recurringOrdinary.map(Number)).toEqual([...Array(9).fill(9000), 19000, 19000, 19000]);
    expect(py.figures!.active.every(Boolean)).toBe(true);
    const b = await loadPriorYearTrendInputs(scopeA, T.b, C.b, 2026, 'sch_c', { today: TODAY, skipCache: true });
    expect(b.figures!.active.filter(Boolean)).toHaveLength(7);
    expect(await loadPriorYearTrendInputs(scopeA, T.a, C.a, 2026, 'c_corp')).toEqual({ figures: null, reason: 'not_supported_entity' });
  });

  it('another firm cannot read the prior year (scope guard before any books query)', async () => {
    expect(await loadPriorYearTrendInputs(scopeB, T.a, C.a, 2026, 'sch_c')).toEqual({ figures: null, reason: 'py_unreadable' });
  });
});

describe('estimate under each method', () => {
  it('run rate (default): no projection block; 99,000 + 99,000 ÷ 9 × 3 = 132,000', async () => {
    const r = await estimate();
    expect(entityA(r).projected.ordinary).toBe('132000');
    expect(entityA(r)).not.toHaveProperty('projection');
    expect(r.entities.find((e) => e.companyId === C.a)).not.toHaveProperty('projectionMethod');
    expect(r.engineVersion).toBe('1.0.0-rc.9');
  });

  it('scaled: 99,000 + 57,000 × (99,000 ÷ 81,000); dollar: 99,000 + 57,000; the cache re-keys on the method', async () => {
    await upsertYearInputs(scopeA, T.a, C.a, 2026, { projectionMethod: 'prior_year_scaled' });
    const s = await estimate();
    const p = entityA(s).projection!;
    expect(entityA(s).projected.ordinary).toBe('168667');
    expect(p).toMatchObject({ method: 'prior_year_scaled', applied: 'prior_year_scaled', fallbackReason: null, factor: '1.2222', runRateOrdinary: '132000', projectedOrdinary: '168667' });
    expect(p.priorYear).toEqual({ taxYear: 2025, throughMonth: 9, sameMonthsOrdinary: '81000', remainingOrdinary: '57000', fullYearOrdinary: '138000', monthsWithActivity: 12 });
    expect(s.entities.find((e) => e.companyId === C.a)!.projectionMethod).toBe('prior_year_scaled');
    expect(JSON.stringify(s.assumptions)).toContain('Prior-year seasonal (scaled)');
    // Schedule AI columns are period actuals: computed, never trend-projected.
    expect(s.scheduleAi.filter((c) => c.source !== 'unavailable').length).toBeGreaterThan(0);

    expect((await estimate({ refresh: false })).cached).toBe(true);
    await upsertYearInputs(scopeA, T.a, C.a, 2026, { projectionMethod: 'prior_year_dollar' });
    const d = await estimate({ refresh: false });
    expect(d.cached).toBe(false);
    expect(entityA(d).projected.ordinary).toBe('156000');
    expect(d.inputsHash).not.toBe(s.inputsHash);
  });

  it('a prior-year GL change re-keys the cache (the PY figures are in the key)', async () => {
    await upsertYearInputs(scopeA, T.a, C.a, 2026, { projectionMethod: 'prior_year_dollar' });
    await estimate({ refresh: false }); // warm the cache for this configuration
    const before = await estimate({ refresh: false });
    expect(before.cached).toBe(true);
    const txn = await post(T.a, C.a, '2025-12-20', [[A.checking, 3000, 0], [A.revenue, 0, 3000]]);
    const after = await estimate({ refresh: false });
    expect(after.cached).toBe(false);
    expect(entityA(after).projected.ordinary).toBe('159000');
    expect(entityA(after).projection!.priorYear!.remainingOrdinary).toBe('60000');
    await putTransactionFlags(scopeA, T.a, C.a, { flags: [{ transactionId: txn, nonRecurring: true }] });
    expect(entityA(await estimate()).projected.ordinary).toBe('156000'); // flagged → excluded again
  });

  it('a snapshot freezes the method and the prior-year figures', async () => {
    await upsertYearInputs(scopeA, T.a, C.a, 2026, { projectionMethod: 'prior_year_scaled' });
    const snap = await createSnapshot(scopeA, actor, { taxpayerId, taxYear: 2026, scenarioId, throughMonth: '2026-09' }, { today: TODAY, skipProviderCache: true });
    const company = (snap.payload.inputs.companies as Array<{ companyId: string; projectionMethod?: string; priorYear?: { figures: { recurringOrdinary: string[] } } }>).find((c) => c.companyId === C.a)!;
    expect(company.projectionMethod).toBe('prior_year_scaled');
    expect(company.priorYear!.figures.recurringOrdinary.map(Number).slice(9)).toEqual([19000, 19000, 19000]);
    expect(snap.payload.result.federal.entities.find((e) => e.companyId === C.a)!.projection!.factor).toBe('1.2222');
  });
});

describe('fallback, readiness and entity rules', () => {
  it('incomplete prior-year books → run rate with TE_PY_TREND_FALLBACK in the estimate and on readiness', async () => {
    await upsertLink(scopeA, actor, taxpayerId, { personRole: 'primary', taxYear: 2026, tenantId: T.b, companyId: C.b, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
    await upsertYearInputs(scopeA, T.b, C.b, 2026, { projectionMethod: 'prior_year_scaled' });
    const r = await estimate();
    const b = r.federal.entities.find((e) => e.companyId === C.b)!;
    expect(b.projected.ordinary).toBe('36000'); // run rate: 27,000 + 3,000 × 3
    expect(b.projection).toMatchObject({ applied: 'run_rate', fallbackReason: 'py_books_incomplete' });
    expect(r.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TE_PY_TREND_FALLBACK', details: expect.objectContaining({ reason: 'py_books_incomplete' }) })]));
    const rd = await getEstimateReadiness(scopeA, taxpayerId, 2026, { today: TODAY, throughMonth: '2026-09' });
    expect(rd.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TE_PY_TREND_FALLBACK', severity: 'warning', details: expect.objectContaining({ companyId: C.b, reason: 'py_books_incomplete' }) })]));
    expect(rd.warnings.filter((w) => w.code === 'TE_PY_TREND_FALLBACK' && (w.details as { companyId?: string }).companyId === C.a)).toEqual([]);
  });

  it('a C corporation cannot select a prior-year method (422); an entity that became one falls back with a warning', async () => {
    const corpT = T.b;
    await setProfile(corpT, C.b, '1120', 'business'); // the TB profile decides the entity type (D3)
    await expect(upsertYearInputs(scopeA, corpT, C.b, 2026, { projectionMethod: 'prior_year_dollar' })).rejects.toMatchObject({ statusCode: 422, code: 'TE_PROJECTION_METHOD_NOT_SUPPORTED' });
    const r = await estimate(); // the stored prior_year_scaled from before the type change
    expect(r.entities.find((e) => e.companyId === C.b)!.path).toBe('c_corp');
    expect(r.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TE_PY_TREND_FALLBACK', details: expect.objectContaining({ companyId: C.b, reason: 'not_supported_entity' }) })]));
    await setProfile(corpT, C.b, '1040', 'business');
  });

  it('another firm: the year-inputs write and the estimate are 404', async () => {
    await expect(upsertYearInputs(scopeB, T.a, C.a, 2026, { projectionMethod: 'run_rate' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(estimate({}, scopeB)).rejects.toMatchObject({ statusCode: 404 });
  });
});
