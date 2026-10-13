// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q49 per-tax-year entity type override, end to end on a seeded 1065 LLC: the resolver precedence
// (override > TB profile > estimator setting > company type; per year; null = unchanged), the
// estimate under an S corp override (no SE tax on the K-1, officer wages, GP treatment ignored with a
// warning, officer link allowed for that year only), a C corp override moving the entity to the
// entity-level path, byte-identical results once cleared, cache re-key, snapshot freezing, readiness,
// the prior-year trend reading the prior year with THIS year's type, and another firm's 404.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { taxEstTaxpayers } from '../../db/schema/index.js';
import { buildCalcSections, type EstimateResultDTO } from '@kis-books/shared';
import { closeTbRedis } from '../tb/tb-redis.js';
import { UNRESTRICTED_VIEWER, type FirmScope } from './firm-scope.service.js';
import { syncShippedSeeds } from './tax-parameters.service.js';
import { syncShippedStateRules } from './tax-state-rules.service.js';
import { createTaxpayer, listLinks, resolveEntityKind, upsertLink, upsertPerson } from './taxpayers.service.js';
import { putTreatments, validateTreatmentRules } from './treatments.service.js';
import { upsertYear } from './years.service.js';
import { getEntitySettings, upsertEntitySettings, upsertYearInputs } from './entity-settings.service.js';
import { resolveEntityTax } from './entity-type.service.js';
import { getReadiness } from './readiness.service.js';
import { getTaxBasisPl } from './pl-provider.service.js';
import { loadPriorYearTrendInputs } from './prior-year-trend.service.js';
import { computeEstimate } from './estimate.service.js';
import { createSnapshot } from './estimate-snapshots.service.js';
import { mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';

const FIRM_A = '00000000-0000-0000-0000-0000000a4900';
const FIRM_B = '00000000-0000-0000-0000-0000000b4900';
const TODAY = new Date('2026-10-12T12:00:00Z');
const mm = (m: number) => String(m).padStart(2, '0');
const T = { p: '', other: '' };
const C = { p: '', other: '' };
const A = { checking: '', revenue: '', supplies: '', gp: '', wages: '' };
let scopeA: FirmScope;
let scopeB: FirmScope;
let actor = { tenantId: '', userId: '00000000-0000-0000-0000-0000000004a9' };
let taxpayerId = '';
let personId = '';
let scenarioId = '';

beforeAll(async () => {
  await syncShippedSeeds();
  await syncShippedStateRules();

  // An LLC filing 1065 (TB profile) that elects S corporation status for 2026.
  T.p = await mkTenant('TE49 Summit Partners');
  C.p = await mkCompany(T.p, 'Summit Partners LLC', { accountingMethod: 'cash', entityType: 'partnership' });
  await setProfile(T.p, C.p, '1065', 'business');
  A.checking = await mkAccount(T.p, C.p, '1010', 'Checking', 'asset', { detailType: 'checking' });
  A.revenue = await mkAccount(T.p, C.p, '4000', 'Consulting Revenue', 'revenue');
  A.supplies = await mkAccount(T.p, C.p, '6100', 'Supplies', 'expense');
  A.gp = await mkAccount(T.p, C.p, '6050', 'Guaranteed Payments', 'expense');
  A.wages = await mkAccount(T.p, C.p, '6000', 'Officer Salaries', 'expense');
  for (const y of [2025, 2026]) {
    for (let m = 1; m <= (y === 2025 ? 12 : 9); m++) {
      const d = `${y}-${mm(m)}-15`;
      await post(T.p, C.p, d, [[A.checking, 20000, 0], [A.revenue, 0, 20000]]);
      await post(T.p, C.p, d, [[A.supplies, 2000, 0], [A.checking, 0, 2000]]);
      await post(T.p, C.p, d, [[A.gp, 1000, 0], [A.checking, 0, 1000]]);
      await post(T.p, C.p, d, [[A.wages, 3000, 0], [A.checking, 0, 3000]]);
    }
  }
  T.other = await mkTenant('TE49 Other Firm Client');
  C.other = await mkCompany(T.other, 'Other Firm Co', { accountingMethod: 'cash' });

  scopeA = { firmId: FIRM_A, firmRole: 'firm_staff', allowedTenantIds: [T.p], viewer: UNRESTRICTED_VIEWER };
  scopeB = { firmId: FIRM_B, firmRole: 'firm_staff', allowedTenantIds: [T.other], viewer: UNRESTRICTED_VIEWER };
  actor = { tenantId: T.p, userId: actor.userId };

  const tp = await createTaxpayer(scopeA, actor, { displayName: 'Dana Summit', filingStatus: 'single', residentState: 'MO' });
  taxpayerId = tp.id;
  personId = (await upsertPerson(scopeA, actor, taxpayerId, 'primary', { firstName: 'Dana', lastName: 'Summit', dateOfBirth: '1979-04-04', isBlind: false })).id;
  await upsertLink(scopeA, actor, taxpayerId, { personRole: 'primary', taxYear: 2026, tenantId: T.p, companyId: C.p, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
  await putTreatments(scopeA, T.p, C.p, [{ accountId: A.gp, treatment: 'guaranteed_payment', paymentTaxpayerId: taxpayerId, paymentPersonId: personId, nonRecurring: false }]);
  const year = await upsertYear(scopeA, actor, taxpayerId, 2026, {});
  scenarioId = year.scenarios.find((x) => x.isBase)!.id;
}, 180_000);

afterAll(async () => {
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B]));
  await purgeTenants([T.p, T.other]);
  await closeTbRedis();
  await pool.end();
});

const estimate = (extra: { refresh?: boolean } = {}, scope = scopeA) =>
  computeEstimate(scope, { taxpayerId, taxYear: 2026, scenarioId, throughMonth: '2026-09', refresh: true, ...extra }, { today: TODAY, skipProviderCache: true });
const fedP = (r: EstimateResultDTO) => r.federal.entities.find((e) => e.companyId === C.p);
const dtoP = (r: EstimateResultDTO) => r.entities.find((e) => e.companyId === C.p)!;
const person = (r: EstimateResultDTO) => r.federal.persons.find((p) => p.personId === personId)!;
const codes = (r: EstimateResultDTO) => r.warnings.map((w) => w.code);

describe('resolver precedence (D3 + Q49)', () => {
  it('null override = the pre-Q49 resolution exactly; the override wins over the TB profile for its year only', async () => {
    const yearless = await resolveEntityTax(scopeA, T.p, C.p);
    const y2026 = await resolveEntityTax(scopeA, T.p, C.p, 2026);
    expect(y2026).toEqual(yearless); // nothing stored yet: byte-identical
    expect(yearless).toMatchObject({ entityType: 'partnership', entityTypeSource: 'tb_profile', tbReturnForm: '1065' });

    await upsertYearInputs(scopeA, T.p, C.p, 2026, { entityTypeOverride: 's_corp' });
    const r26 = await resolveEntityTax(scopeA, T.p, C.p, 2026);
    expect(r26).toMatchObject({
      entityType: 's_corp', entityTypeSource: 'estimator_override', tbReturnForm: '1065',
      entityTypeOverride: { taxYear: 2026, overrideType: 's_corp', baseEntityType: 'partnership', baseEntityTypeSource: 'tb_profile', tbReturnForm: '1065' },
    });
    expect(r26.warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'TE_ENTITY_TYPE_OVERRIDDEN', severity: 'info', message: 'Summit Partners LLC: Entity type overridden for 2026: S corp (TB profile says 1065).',
    })]));
    // Per-year isolation: 2025 and the year-less resolution keep the TB profile.
    expect(await resolveEntityTax(scopeA, T.p, C.p, 2025)).toEqual(yearless);
    expect(await resolveEntityTax(scopeA, T.p, C.p)).toEqual(yearless);

    // The override wins over the estimator setting too, and replaces the "setting ignored" note.
    await upsertEntitySettings(scopeA, T.p, C.p, { taxEntityType: 'c_corp' });
    const both = await resolveEntityTax(scopeA, T.p, C.p, 2026);
    expect(both.entityType).toBe('s_corp');
    expect(both.warnings.map((w) => w.code)).not.toContain('TE_ENTITY_TYPE_SETTING_IGNORED');
    const r25 = await resolveEntityTax(scopeA, T.p, C.p, 2025);
    expect(r25.entityType).toBe('partnership');
    expect(r25.warnings.find((w) => w.code === 'TE_ENTITY_TYPE_SETTING_IGNORED')!.message)
      .toBe("The Trial Balance tax profile (1065) decides the entity type; the estimator setting (c_corp) is ignored; use 'Override entity type for 2025' on the business's year inputs to change it.");
    await upsertEntitySettings(scopeA, T.p, C.p, { taxEntityType: null });

    // Settings + readiness resolve per year.
    expect((await getEntitySettings(scopeA, T.p, C.p, 2026)).resolved.entityTypeSource).toBe('estimator_override');
    expect((await getReadiness(scopeA, { tenantId: T.p, companyId: C.p, taxYear: 2026, throughMonth: '2026-09' }, { today: TODAY })).entity.entityType).toBe('s_corp');
    expect((await getReadiness(scopeA, { tenantId: T.p, companyId: C.p, taxYear: 2025, throughMonth: '2025-12' }, { today: TODAY })).entity.entityType).toBe('partnership');
    await upsertYearInputs(scopeA, T.p, C.p, 2026, { entityTypeOverride: null });
    expect(await resolveEntityTax(scopeA, T.p, C.p, 2026)).toEqual(yearless);
  });

  it('treatment validation accepts a treatment that fits ANY of the entity\'s types (treatments are not per year)', () => {
    const gp = [{ accountId: 'a', treatment: 'guaranteed_payment' as const, paymentPersonId: 'p', nonRecurring: false }];
    const types = new Map([['a', 'expense']]);
    expect(() => validateTreatmentRules(gp, types, 's_corp')).toThrow(/partnership entities only/);
    expect(() => validateTreatmentRules(gp, types, 's_corp', ['partnership'])).not.toThrow();
    expect(() => validateTreatmentRules([{ ...gp[0]!, paymentPersonId: undefined }], types, 'partnership', ['s_corp'])).toThrow(/needs the partner/);
  });
});

describe('estimate under the override', () => {
  let baseline: EstimateResultDTO;

  it('1065 baseline: partnership, the general partner pays SE tax on ordinary + GP', async () => {
    baseline = await estimate();
    expect(fedP(baseline)!.entityType).toBe('partnership');
    expect(Number(person(baseline).seTax)).toBeGreaterThan(0);
    expect(dtoP(baseline)).not.toHaveProperty('entityTypeOverride');
    expect(dtoP(baseline)).not.toHaveProperty('entityTypeSource');
  });

  it('S corp override: no SE tax on the K-1, GP treatment ignored with a warning, chip + assumptions line; the cache re-keys', async () => {
    expect((await estimate({ refresh: false })).cached).toBe(true);
    await upsertYearInputs(scopeA, T.p, C.p, 2026, { entityTypeOverride: 's_corp' });
    const r = await estimate({ refresh: false });
    expect(r.cached).toBe(false);
    expect(r.inputsHash).not.toBe(baseline.inputsHash);
    expect(fedP(r)!.entityType).toBe('s_corp');
    expect(person(r).seTax).toBe('0');
    expect(codes(r)).toEqual(expect.arrayContaining(['TE_ENTITY_TYPE_OVERRIDDEN', 'TE_TREATMENT_NOT_FOR_ENTITY']));
    expect(dtoP(r)).toMatchObject({ entityType: 's_corp', path: 'individual', entityTypeSource: 'estimator_override', entityTypeOverride: { tbReturnForm: '1065', baseEntityType: 'partnership' } });
    const chips = buildCalcSections(r).flatMap((s) => s.lines).find((l) => l.key === `inc.${C.p}`)!.chips!;
    expect(chips).toContainEqual({ text: 'Entity type overridden: S corp (TB profile says 1065)', tone: 'info', review: true });
    const readiness = r.assumptions!.sections.find((s) => s.id === 'readiness')!;
    expect(readiness.items[0]).toMatchObject({ code: 'Q49', label: 'Summit Partners LLC — entity type' });
    expect(JSON.stringify(r.assumptions!.sections.find((s) => s.id === 'projection'))).not.toContain('overridden');
  });

  it('officer link allowed for the overridden year only; officer wages reach the owner\'s W-2 wages', async () => {
    await expect(upsertLink(scopeA, actor, taxpayerId, { personRole: 'primary', taxYear: 2025, tenantId: T.p, companyId: C.p, profitPct: 100, lossPct: 100, isOfficer: true, activityType: 'active', activeParticipation: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'TE_OFFICER_ONLY_SCORP' });
    await upsertLink(scopeA, actor, taxpayerId, { personRole: 'primary', taxYear: 2026, tenantId: T.p, companyId: C.p, profitPct: 100, lossPct: 100, isOfficer: true, activityType: 'active', activeParticipation: false });
    expect((await listLinks(scopeA, taxpayerId, 2026)).data[0]!.entityKind).toBe('s_corp');
    expect((await resolveEntityKind(T.p, C.p)).kind).toBe('partnership');
    expect((await resolveEntityKind(T.p, C.p, undefined, 2026)).kind).toBe('s_corp');

    await putTreatments(scopeA, T.p, C.p, [{ accountId: A.wages, treatment: 'w2_wages', paymentTaxpayerId: taxpayerId, paymentPersonId: personId, nonRecurring: false }]);
    const r = await estimate();
    expect(Number(person(r).totalWages)).toBe(36000); // 3,000 × 12 officer W-2 wages
    expect(person(r).seTax).toBe('0');
    expect(codes(r)).not.toContain('TE_OFFICER_WAGES_NOT_S_CORP');
  });

  it('a snapshot freezes the effective type and its source', async () => {
    const snap = await createSnapshot(scopeA, actor, { taxpayerId, taxYear: 2026, scenarioId, throughMonth: '2026-09' }, { today: TODAY, skipProviderCache: true });
    expect(snap.payload.result.entities.find((e) => e.companyId === C.p)).toMatchObject({ entityType: 's_corp', entityTypeSource: 'estimator_override' });
    const company = (snap.payload.inputs.companies as Array<{ companyId: string; settings: { resolved: { entityType: string; entityTypeSource: string } } }>).find((c) => c.companyId === C.p)!;
    expect(company.settings.resolved).toMatchObject({ entityType: 's_corp', entityTypeSource: 'estimator_override' });
  });

  it('partnership override with S corp inputs left behind: warnings, the estimate still computes', async () => {
    await upsertYearInputs(scopeA, T.p, C.p, 2026, { entityTypeOverride: 'partnership' });
    const r = await estimate();
    expect(fedP(r)!.entityType).toBe('partnership');
    expect(codes(r)).toEqual(expect.arrayContaining(['TE_LINK_FLAG_NOT_FOR_ENTITY', 'TE_OFFICER_WAGES_NOT_S_CORP']));
    expect(Number(person(r).seTax)).toBeGreaterThan(0);
  });

  it('C corp override moves the business to the entity-level path; a stored prior-year method falls back', async () => {
    await upsertYearInputs(scopeA, T.p, C.p, 2026, { entityTypeOverride: 'sch_c', projectionMethod: 'prior_year_dollar' });
    await expect(upsertYearInputs(scopeA, T.p, C.p, 2026, { entityTypeOverride: 'c_corp', projectionMethod: 'prior_year_scaled' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'TE_PROJECTION_METHOD_NOT_SUPPORTED' });
    await upsertYearInputs(scopeA, T.p, C.p, 2026, { entityTypeOverride: 'c_corp' }); // the stored prior_year_dollar stays
    const r = await estimate();
    expect(dtoP(r)).toMatchObject({ entityType: 'c_corp', path: 'c_corp', entityTypeSource: 'estimator_override' });
    expect(fedP(r)).toBeUndefined();
    expect(r.ccorps.length).toBe(1);
    expect(r.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TE_PY_TREND_FALLBACK', details: expect.objectContaining({ reason: 'not_supported_entity' }) }),
      expect.objectContaining({ code: 'TE_LINK_FLAG_NOT_FOR_ENTITY' }),
    ]));
    // The prior-year trend reads 2025's books with 2026's (overridden) type.
    expect(await loadPriorYearTrendInputs(scopeA, T.p, C.p, 2026, null, { today: TODAY, skipCache: true })).toEqual({ figures: null, reason: 'not_supported_entity' });
    expect((await getTaxBasisPl(scopeA, { tenantId: T.p, companyId: C.p, taxYear: 2025, throughMonth: '2025-12' }, { today: TODAY, skipCache: true })).entityType).toBe('partnership');
    expect((await getTaxBasisPl(scopeA, { tenantId: T.p, companyId: C.p, taxYear: 2025, throughMonth: '2025-12' }, { today: TODAY, entityTypeYear: 2026 })).entityType).toBe('c_corp');

    // And back: an S corp override puts it on the individual path again.
    await upsertYearInputs(scopeA, T.p, C.p, 2026, { entityTypeOverride: 's_corp', projectionMethod: 'run_rate' });
    const back = await estimate();
    expect(dtoP(back).path).toBe('individual');
    expect(back.ccorps).toEqual([]);
  });

  it('clearing the override restores byte-identical results (same inputs as the baseline)', async () => {
    await upsertLink(scopeA, actor, taxpayerId, { personRole: 'primary', taxYear: 2026, tenantId: T.p, companyId: C.p, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
    await putTreatments(scopeA, T.p, C.p, [{ accountId: A.wages, treatment: null, nonRecurring: false }]);
    await upsertYearInputs(scopeA, T.p, C.p, 2026, { entityTypeOverride: null });
    const r = await estimate();
    expect(r.federal).toEqual(baseline.federal);
    expect(r.entities).toEqual(baseline.entities);
    expect(r.warnings).toEqual(baseline.warnings);
    expect(r.ccorps).toEqual(baseline.ccorps);
  });

  it('another firm: the override write and the estimate are 404', async () => {
    await expect(upsertYearInputs(scopeB, T.p, C.p, 2026, { entityTypeOverride: 's_corp' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveEntityTax(scopeB, T.p, C.p, 2026)).rejects.toMatchObject({ statusCode: 404 });
    await expect(estimate({}, scopeB)).rejects.toMatchObject({ statusCode: 404 });
  });
});
