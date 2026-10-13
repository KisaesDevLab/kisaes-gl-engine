// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// v0.9.228 integration of Q49 (per-year entity type override), Q50 (owner splits) and Q52
// (dashboard cache peek), on one business: an LLC filing 1065 (TB profile) that is an S
// corporation for 2026 through the Q49 override, with two shareholder-officers linked for 2026.
//   (d) the owner pickers / split validation / P&L routing use the EFFECTIVE type of the year:
//       officer links are allowed only for the overridden year, the officer health (>2%
//       shareholder SEHI) and officer wages split 60 / 40 between the two linked owners, and
//       each owner's (separate) taxpayer estimate gets only their own portion.
//   (b) peekCachedEstimate builds exactly the compute path's cache key (taxYear-threaded entity
//       type, split rows): peek-after-compute hits; a split edit or an override change misses.
//   (a) the merged cache versions (te-estimate-v8, te:pl:v4).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { taxEstTaxpayers } from '../../db/schema/index.js';
import { buildPortalCalcSummary, type EstimateResultDTO } from '@kis-books/shared';
import { closeTbRedis } from '../tb/tb-redis.js';
import { UNRESTRICTED_VIEWER, type FirmScope } from './firm-scope.service.js';
import { syncShippedSeeds } from './tax-parameters.service.js';
import { syncShippedStateRules } from './tax-state-rules.service.js';
import { createTaxpayer, upsertLink, upsertPerson } from './taxpayers.service.js';
import { putTreatments } from './treatments.service.js';
import { listOwnerCandidates } from './treatment-splits.service.js';
import { upsertYear } from './years.service.js';
import { upsertYearInputs } from './entity-settings.service.js';
import { getTaxBasisPl, taxBasisCacheKey } from './pl-provider.service.js';
import { computeEstimate, estimateCacheKey, peekCachedEstimate } from './estimate.service.js';
import { mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';

const FIRM = '00000000-0000-0000-0000-0000000a9228';
const TODAY = new Date('2026-10-13T12:00:00Z');
const mm = (m: number) => String(m).padStart(2, '0');
let T = '';
let C = '';
const A = { checking: '', revenue: '', wages: '', health: '' };
let scope: FirmScope;
const actor = { tenantId: '', userId: '00000000-0000-0000-0000-0000000c9228' };
const owners: Record<'ann' | 'bob', { taxpayerId: string; personId: string; scenarioId: string }> = {
  ann: { taxpayerId: '', personId: '', scenarioId: '' },
  bob: { taxpayerId: '', personId: '', scenarioId: '' },
};

const link = (who: 'ann' | 'bob', taxYear: number, isOfficer: boolean) => upsertLink(scope, actor, owners[who].taxpayerId, {
  personRole: 'primary', taxYear, tenantId: T, companyId: C, profitPct: who === 'ann' ? 60 : 40, lossPct: who === 'ann' ? 60 : 40,
  isOfficer, activityType: 'active', activeParticipation: false,
});
const req = (who: 'ann' | 'bob') => ({ taxpayerId: owners[who].taxpayerId, taxYear: 2026, scenarioId: owners[who].scenarioId, throughMonth: '2026-12' });
const split = (annPct: string, bobPct: string) => [
  { personId: owners.ann.personId, pct: annPct }, { personId: owners.bob.personId, pct: bobPct },
];
const person = (r: EstimateResultDTO, who: 'ann' | 'bob') => r.federal.persons.find((p) => p.personId === owners[who].personId)!;

beforeAll(async () => {
  await syncShippedSeeds();
  await syncShippedStateRules();
  T = await mkTenant('TE228 Override Split LLC');
  actor.tenantId = T;
  C = await mkCompany(T, 'Ridge Partners LLC', { accountingMethod: 'cash', entityType: 'partnership' });
  await setProfile(T, C, '1065', 'business');
  A.checking = await mkAccount(T, C, '1010', 'Checking', 'asset', { detailType: 'checking' });
  A.revenue = await mkAccount(T, C, '4000', 'Consulting Revenue', 'revenue');
  A.wages = await mkAccount(T, C, '6000', 'Salaries - Officers', 'expense');
  A.health = await mkAccount(T, C, '6010', 'Officer health insurance', 'expense');
  for (let m = 1; m <= 12; m++) {
    const d = `2026-${mm(m)}-15`;
    await post(T, C, d, [[A.checking, 20000, 0], [A.revenue, 0, 20000]]);
    await post(T, C, d, [[A.wages, 3000, 0], [A.checking, 0, 3000]]);
    await post(T, C, d, [[A.health, 500, 0], [A.checking, 0, 500]]);
  }
  scope = { firmId: FIRM, firmRole: 'firm_staff', allowedTenantIds: [T], viewer: UNRESTRICTED_VIEWER };
  for (const [who, first] of [['ann', 'Ann'], ['bob', 'Bob']] as const) {
    const tp = await createTaxpayer(scope, actor, { displayName: `${first} Ridge`, filingStatus: 'single', residentState: 'MO' });
    owners[who].taxpayerId = tp.id;
    owners[who].personId = (await upsertPerson(scope, actor, tp.id, 'primary', { firstName: first, lastName: 'Ridge', dateOfBirth: '1975-05-05', isBlind: false })).id;
    owners[who].scenarioId = (await upsertYear(scope, actor, tp.id, 2026, {})).scenarios.find((s) => s.isBase)!.id;
  }
}, 180_000);

afterAll(async () => {
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM]));
  await purgeTenants([T]);
  await closeTbRedis();
  await pool.end();
});

describe('(d) Q50 × Q49: 1065 company overridden to S corp for 2026', () => {
  it('officer links follow the year\'s effective type: refused before the override, allowed after it', async () => {
    await expect(link('ann', 2026, true)).rejects.toMatchObject({ statusCode: 422, code: 'TE_OFFICER_ONLY_SCORP' });
    await upsertYearInputs(scope, T, C, 2026, { entityTypeOverride: 's_corp' });
    await link('ann', 2026, true);
    await link('bob', 2026, true);
    // 2025 stays a partnership year: an officer link there is still refused.
    await expect(link('ann', 2025, true)).rejects.toMatchObject({ statusCode: 422, code: 'TE_OFFICER_ONLY_SCORP' });
  });

  it('the owner pick list offers both linked officers with the default split from ownership', async () => {
    const r = await listOwnerCandidates(scope, T, C, 2026);
    const by = new Map(r.candidates.map((c) => [c.personId, c]));
    expect(by.get(owners.ann.personId)).toMatchObject({ taxpayerId: owners.ann.taxpayerId, isOfficer: true, defaultPct: '60' });
    expect(by.get(owners.bob.personId)).toMatchObject({ taxpayerId: owners.bob.taxpayerId, isOfficer: true, defaultPct: '40' });
  });

  it('officer SEHI and officer wages split 60 / 40 are accepted and route as S corp officer items for 2026', async () => {
    await putTreatments(scope, T, C, [
      { accountId: A.wages, treatment: 'w2_wages', nonRecurring: false, splitMode: 'pct', splits: split('60', '40') },
      { accountId: A.health, treatment: 'owner_sehi', nonRecurring: false, splitMode: 'pct', splits: split('60', '40') },
    ]);
    const pl = await getTaxBasisPl(scope, { tenantId: T, companyId: C, taxYear: 2026, throughMonth: '2026-12' }, { skipCache: true, today: TODAY });
    expect(pl.entityType).toBe('s_corp');
    const health = pl.accounts.find((a) => a.accountId === A.health)!;
    expect(health.route).toBe('officer_sehi');
    expect(health.splits!.map((s) => [s.personId, s.allocated])).toEqual([
      [owners.ann.personId, '3600.0000'], [owners.bob.personId, '2400.0000'],
    ]);
    const by = new Map(pl.ownerLevel.byPerson.map((p) => [p.personId, p]));
    expect(by.get(owners.ann.personId)).toMatchObject({ ownerSehi: '3600.0000', sehiAsW2Wages: '3600.0000' });
    expect(by.get(owners.bob.personId)).toMatchObject({ ownerSehi: '2400.0000', sehiAsW2Wages: '2400.0000' });
    expect(new Map(pl.w2Wages.byPerson.map((w) => [w.personId, w.ytd]))).toEqual(new Map([
      [owners.ann.personId, '21600.0000'], [owners.bob.personId, '14400.0000'],
    ]));
  });

  it('each owner\'s estimate gets their share: SS wages = officer wages, box 1 adds the health portion, no SE tax', async () => {
    const ann = await computeEstimate(scope, { ...req('ann'), refresh: true }, { today: TODAY });
    const bob = await computeEstimate(scope, { ...req('bob'), refresh: true }, { today: TODAY });
    expect(person(ann, 'ann').exact.socialSecurityWages).toBe('21600');
    expect(person(bob, 'bob').exact.socialSecurityWages).toBe('14400');
    expect(Number(person(ann, 'ann').totalWages)).toBe(25200);
    expect(Number(person(bob, 'bob').totalWages)).toBe(16800);
    expect(person(ann, 'ann').seTax).toBe('0');
    // The other shareholder's portions belong to their own taxpayer, never to this primary person.
    for (const r of [ann, bob]) expect(r.warnings.filter((w) => w.code === 'TE_UNKNOWN_PERSON')).toEqual([]);
    expect(ann.entities.find((e) => e.companyId === C)).toMatchObject({ entityType: 's_corp', entityTypeSource: 'estimator_override' });
  });

  it('(e) Q51 portal summary: the business line is the engine\'s own share (profit %), wages are only this owner\'s portion', async () => {
    const ann = await computeEstimate(scope, req('ann'), { today: TODAY });
    const sum = buildPortalCalcSummary(ann);
    // Entity profit 240,000 − officer wages 36,000 − shareholder health 6,000 (kept as the S corp's deduction) = 198,000; Ann 60%.
    expect(sum.businesses).toEqual([{ name: 'Ridge Partners LLC', amount: '118800' }]);
    expect(sum.otherIncome.find((x) => x.label === 'Wages')?.amount).toBe('25200');
  });
});

describe('(b) Q52 peekCachedEstimate = the compute path\'s key after Q49 / Q50 / Q51', () => {
  it('peek after compute hits (plain and with the portal / owner payments-as-of)', async () => {
    const live = await computeEstimate(scope, req('ann'), { today: TODAY });
    const hit = await peekCachedEstimate(scope, req('ann'), { today: TODAY });
    expect(hit).not.toBeNull();
    expect(hit!.computedAt).toBe(live.computedAt);
    expect(hit!.summary.total).toBe(live.summary.total);

    const asOf = TODAY.toISOString().slice(0, 10);
    const portal = await computeEstimate(scope, req('ann'), { today: TODAY, paymentsAsOf: asOf });
    expect((await peekCachedEstimate(scope, req('ann'), { today: TODAY, paymentsAsOf: asOf }))?.computedAt).toBe(portal.computedAt);
  });

  it('a split edit (Q50) misses until recomputed', async () => {
    await putTreatments(scope, T, C, [{ accountId: A.health, treatment: 'owner_sehi', nonRecurring: false, splitMode: 'pct', splits: split('50', '50') }]);
    expect(await peekCachedEstimate(scope, req('ann'), { today: TODAY })).toBeNull();
    const live = await computeEstimate(scope, req('ann'), { today: TODAY });
    expect((await peekCachedEstimate(scope, req('ann'), { today: TODAY }))?.computedAt).toBe(live.computedAt);
  });

  it('an entity type override change for the year (Q49) misses until recomputed', async () => {
    await upsertYearInputs(scope, T, C, 2026, { entityTypeOverride: 'partnership' });
    try {
      expect(await peekCachedEstimate(scope, req('ann'), { today: TODAY })).toBeNull();
      const live = await computeEstimate(scope, req('ann'), { today: TODAY });
      expect(live.entities.find((e) => e.companyId === C)).toMatchObject({ entityType: 'partnership' });
      expect((await peekCachedEstimate(scope, req('ann'), { today: TODAY }))?.computedAt).toBe(live.computedAt);
    } finally {
      await upsertYearInputs(scope, T, C, 2026, { entityTypeOverride: 's_corp' });
    }
  });
});

describe('(a) merged cache versions', () => {
  it('estimate te-estimate-v8, P&L provider te:pl:v4', () => {
    expect(estimateCacheKey(scope, req('ann'), 'h')).toMatch(/^te:estimate:te-estimate-v8:/);
    expect(taxBasisCacheKey({ tenantId: T, companyId: C, taxYear: 2026, basis: 'cash', throughMonth: '2026-12', glVersionStamp: 1, configVersion: 'x' }))
      .toMatch(/^te:pl:v4:/);
  });
});
