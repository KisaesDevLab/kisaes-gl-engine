// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 13 acceptance (PHASES.md "PDF for each entity type"): the one estimate PDF
// renderer prints an individual with a Sch C + an S corp owner + a limited partner
// (Rivera), and a Sch F farmer with a linked C corporation — every PDF printed from a
// frozen snapshot. Plus the Report Pack `tax-estimate` section: firm/flag/link gates,
// snapshot reason 'report_pack', the worker-side scope re-derivation, and the
// as-of → tax year / through-month rule.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { db, pool } from '../../db/index.js';
import {
  auditLog, firms, firmUsers, taxEstFirmSettings, taxEstSnapshots, taxEstTaxpayers, tenantFeatureFlags, tenantFirmAssignments,
  userTenantAccess, users,
} from '../../db/schema/index.js';
import { closeTbRedis } from '../tb/tb-redis.js';
import type { FirmScope } from './firm-scope.service.js';
import { assign, mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from './rivera.test-fixtures.js';
import { createTaxpayer, upsertLink, upsertPerson } from './taxpayers.service.js';
import { upsertYear } from './years.service.js';
import { issueEstimatePdf, packPeriod, renderPackSection, resolvePackScope, resolvePackScopeForUser, listPackTaxpayers } from './estimate-documents.service.js';
import { REPORT_PACK_DOCUMENT_RENDERERS, type DocumentSectionContext } from '../report-pack-documents.js';

const FIRM_A = randomUUID();
const FIRM_B = randomUUID();
const USER = randomUUID();
const OPTS = { today: new Date('2026-10-12T12:00:00Z'), skipProviderCache: true };
const mm = (m: number) => String(m).padStart(2, '0');

let fx: RiveraFixture;
const extra = { farmT: '', farmC: '', ccT: '', ccC: '' };
let farmTaxpayer = '';
let farmScenario = '';
let farmScope: FirmScope;

async function pdfInfo(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return { pages: doc.getPageCount(), title: doc.getTitle() ?? '' };
}

beforeAll(async () => {
  await db.insert(firms).values([{ id: FIRM_A, name: 'Rivera CPA LLC', slug: `te13-a-${FIRM_A.slice(0, 8)}` }, { id: FIRM_B, name: 'Other Firm', slug: `te13-b-${FIRM_B.slice(0, 8)}` }]);
  fx = await seedRivera(FIRM_A, FIRM_B, USER);
  // Real firm wiring for the Report Pack gates: firm A manages the three Rivera tenants.
  await db.insert(tenantFirmAssignments).values([fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })));
  await db.insert(tenantFirmAssignments).values({ tenantId: fx.T.other, firmId: FIRM_B });
  await db.insert(users).values({ id: USER, tenantId: fx.T.schc, email: `te13-${USER}@example.com`, passwordHash: 'x', displayName: 'Staff', role: 'accountant' });
  await db.insert(firmUsers).values({ firmId: FIRM_A, userId: USER, firmRole: 'firm_staff' });
  await db.insert(userTenantAccess).values([fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ userId: USER, tenantId, role: 'accountant' })));
  await db.insert(tenantFeatureFlags).values({ tenantId: fx.T.schc, flagKey: 'TAX_ESTIMATOR_V1', enabled: true });

  // Hank: a Sch F farmer with a linked C corporation (the Phase 9 paths).
  extra.farmT = await mkTenant('TE13 Farm');
  extra.farmC = await mkCompany(extra.farmT, 'Hank Family Farm', { accountingMethod: 'cash', entityType: 'sole_prop' });
  await setProfile(extra.farmT, extra.farmC, '1040', 'farm');
  const f = {
    checking: await mkAccount(extra.farmT, extra.farmC, '1010', 'Checking', 'asset', { detailType: 'checking' }),
    sales: await mkAccount(extra.farmT, extra.farmC, '4000', 'Cattle Sales', 'revenue'),
    feed: await mkAccount(extra.farmT, extra.farmC, '6000', 'Feed', 'expense'),
  };
  await assign(extra.farmT, extra.farmC, f.sales, 'farm', '604');
  extra.ccT = await mkTenant('TE13 C Corp');
  extra.ccC = await mkCompany(extra.ccT, 'Hank Holdings Inc', { accountingMethod: 'accrual', entityType: 'c_corp' });
  await setProfile(extra.ccT, extra.ccC, '1120', 'business');
  const k = {
    checking: await mkAccount(extra.ccT, extra.ccC, '1010', 'Operating', 'asset', { detailType: 'checking' }),
    sales: await mkAccount(extra.ccT, extra.ccC, '4000', 'Sales', 'revenue'),
    costs: await mkAccount(extra.ccT, extra.ccC, '6000', 'Costs', 'expense'),
  };
  await assign(extra.ccT, extra.ccC, k.sales, 'business', '100');
  for (let m = 1; m <= 12; m++) {
    const d = `2026-${mm(m)}-05`;
    await post(extra.farmT, extra.farmC, d, [[f.checking, 10000, 0], [f.sales, 0, 10000]]);
    await post(extra.farmT, extra.farmC, d, [[f.feed, 4000, 0], [f.checking, 0, 4000]]);
    await post(extra.ccT, extra.ccC, d, [[k.checking, 5000, 0], [k.sales, 0, 5000]]);
    await post(extra.ccT, extra.ccC, d, [[k.costs, 1000, 0], [k.checking, 0, 1000]]);
  }
  farmScope = { ...fx.scopeA, allowedTenantIds: [...fx.scopeA.allowedTenantIds, extra.farmT, extra.ccT] };
  const tp = await createTaxpayer(farmScope, fx.actor, { displayName: 'Hank Farmer', filingStatus: 'single', residentState: 'MO' });
  farmTaxpayer = tp.id;
  await upsertPerson(farmScope, fx.actor, tp.id, 'primary', { firstName: 'Hank', lastName: 'Farmer', dateOfBirth: '1975-03-03', isBlind: false });
  await upsertLink(farmScope, fx.actor, tp.id, { personRole: 'primary', taxYear: 2026, tenantId: extra.farmT, companyId: extra.farmC, profitPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
  await upsertLink(farmScope, fx.actor, tp.id, { personRole: 'primary', taxYear: 2026, tenantId: extra.ccT, companyId: extra.ccC, profitPct: 100, isOfficer: false, activityType: 'investment', activeParticipation: false });
  const y = await upsertYear(farmScope, fx.actor, tp.id, 2026, { priorYearTax: '15000', priorYearAgi: '70000' });
  farmScenario = y.scenarios[0]!.id;
}, 300_000);

afterAll(async () => {
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B])); // cascades snapshots
  await db.delete(auditLog).where(eq(auditLog.userId, USER));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other, extra.farmT, extra.ccT]);
  await db.delete(firms).where(inArray(firms.id, [FIRM_A, FIRM_B]));
  await closeTbRedis();
  await pool.end();
});

describe('one PDF renderer for every entity type (printed from a snapshot)', () => {
  it('Rivera: Sch C owner + S corp officer + limited partner (rental)', async () => {
    const pdf = await issueEstimatePdf(fx.scopeA, fx.actor, { taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: fx.baseScenarioId, throughMonth: '2026-09', reason: 'pdf' }, OPTS);
    expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    const info = await pdfInfo(pdf.bytes);
    expect(info.pages).toBeGreaterThanOrEqual(3); // summary pages + the assumptions page
    expect(info.title).toContain('2026 Tax Estimate');
    expect(pdf.filename).toBe('tax-estimate-2026-Carlos-Maria-Rivera.pdf');
    const [snap] = await db.select().from(taxEstSnapshots).where(eq(taxEstSnapshots.id, pdf.snapshotId));
    expect(snap?.reason).toBe('pdf');
    expect(snap?.tenantIds.sort()).toEqual([fx.T.schc, fx.T.scorp, fx.T.lp].sort());
  }, 180_000);

  it('Hank: Sch F farmer (single installment) + C corporation at entity level', async () => {
    const pdf = await issueEstimatePdf(farmScope, fx.actor, { taxpayerId: farmTaxpayer, taxYear: 2026, scenarioId: farmScenario, throughMonth: '2026-12', reason: 'pdf' }, OPTS);
    expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect((await pdfInfo(pdf.bytes)).pages).toBeGreaterThanOrEqual(2);
  }, 180_000);
});

describe('Report Pack tax-estimate section', () => {
  it('as-of → tax year; a month-end as-of sets the through month', () => {
    expect(packPeriod('2026-09-30')).toEqual({ taxYear: 2026, throughMonth: '2026-09' });
    expect(packPeriod('2026-02-28')).toEqual({ taxYear: 2026, throughMonth: '2026-02' });
    expect(packPeriod('2026-10-12')).toEqual({ taxYear: 2026 });
    expect(() => packPeriod('')).toThrow();
  });

  it('pack scope: the active tenant\'s managing firm, flag on (here or in a firm tenant in scope, QA D9), tenant in the requester\'s scope — else 404', async () => {
    const scope = await resolvePackScope(fx.T.schc, USER, false);
    expect(scope.firmId).toBe(FIRM_A);
    expect(scope.allowedTenantIds.sort()).toEqual([fx.T.schc, fx.T.scorp, fx.T.lp].sort());
    await expect(resolvePackScope(fx.T.other, USER, false)).rejects.toMatchObject({ statusCode: 404 }); // another firm's client
    // QA D9: the flag is OFF on the S corp's own tenant but ON in another tenant of the same firm in
    // the caller's scope (the practice tenant pattern), so the section is offered there too...
    expect((await resolvePackScope(fx.T.scorp, USER, false)).firmId).toBe(FIRM_A);
    // ...and with the flag off everywhere in the firm's scope, it is not.
    await db.update(tenantFeatureFlags).set({ enabled: false }).where(and(eq(tenantFeatureFlags.tenantId, fx.T.schc), eq(tenantFeatureFlags.flagKey, 'TAX_ESTIMATOR_V1')));
    try {
      await expect(resolvePackScope(fx.T.scorp, USER, false)).rejects.toMatchObject({ statusCode: 404 });
      await expect(resolvePackScope(fx.T.schc, USER, false)).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await db.update(tenantFeatureFlags).set({ enabled: true }).where(and(eq(tenantFeatureFlags.tenantId, fx.T.schc), eq(tenantFeatureFlags.flagKey, 'TAX_ESTIMATOR_V1')));
    }
    await expect(resolvePackScope(fx.T.schc, randomUUID(), false)).rejects.toMatchObject({ statusCode: 404 }); // not a member
    await expect(resolvePackScopeForUser(fx.T.schc, randomUUID())).rejects.toMatchObject({ statusCode: 404 }); // no such user
  });

  it('option choices list only the firm\'s taxpayers linked to the pack company', async () => {
    const scope = await resolvePackScope(fx.T.schc, USER, false);
    const choices = await listPackTaxpayers(scope, fx.T.schc, fx.C.schc);
    expect(choices.map(({ scenarios: _s, ...t }) => t)).toEqual([{ id: fx.taxpayerId, displayName: 'Carlos & Maria Rivera', years: [2026] }]);
    // QA D10: the scenarios of the linked years ride along (Base first) for the builder's picker.
    expect(choices[0]!.scenarios![0]).toMatchObject({ id: fx.baseScenarioId, taxYear: 2026, isBase: true });
    expect(await listPackTaxpayers(scope, fx.T.other, fx.C.other)).toEqual([]);
  });

  it('renders through the same renderer with a report_pack snapshot; unlinked company / missing taxpayer refused', async () => {
    const scope = await resolvePackScope(fx.T.schc, USER, false);
    const actor = { tenantId: fx.T.schc, userId: USER };
    const pdf = await renderPackSection(scope, actor, { tenantId: fx.T.schc, companyId: fx.C.schc, taxpayerId: fx.taxpayerId, asOfDate: '2026-09-30' }, OPTS);
    expect((await pdfInfo(pdf.bytes)).pages).toBeGreaterThanOrEqual(3);
    const [snap] = await db.select().from(taxEstSnapshots).where(eq(taxEstSnapshots.id, pdf.snapshotId));
    expect(snap?.reason).toBe('report_pack');
    expect(snap?.scenarioId).toBe(fx.baseScenarioId);
    // Hank is a firm-A taxpayer but not linked to Rivera Plumbing.
    await expect(renderPackSection(scope, actor, { tenantId: fx.T.schc, companyId: fx.C.schc, taxpayerId: farmTaxpayer, asOfDate: '2026-09-30' }, OPTS))
      .rejects.toMatchObject({ statusCode: 404, code: 'TE_TAXPAYER_NOT_LINKED' });
    // No 2025 links.
    await expect(renderPackSection(scope, actor, { tenantId: fx.T.schc, companyId: fx.C.schc, taxpayerId: fx.taxpayerId, asOfDate: '2025-12-31' }, OPTS))
      .rejects.toMatchObject({ code: 'TE_TAXPAYER_NOT_LINKED' });
    await expect(renderPackSection(scope, actor, { tenantId: fx.T.schc, companyId: fx.C.schc, taxpayerId: null, asOfDate: '2026-09-30' }, OPTS))
      .rejects.toMatchObject({ code: 'TE_PACK_TAXPAYER_REQUIRED' });
  }, 180_000);

  it('the pack worker renderer: refused without the run grant; re-derives the scope from requested_by', async () => {
    const render = REPORT_PACK_DOCUMENT_RENDERERS['tax-estimate']!;
    const ctx: DocumentSectionContext = {
      tenantId: fx.T.schc, companyId: fx.C.schc, companyName: 'Rivera Plumbing LLC', rangeStart: '2026-07-01', rangeEnd: '2026-09-30', asOfDate: '2026-09-30',
      options: { taxpayerId: fx.taxpayerId }, allowAttachments: false, allowTransactions: false, renderHtml: async () => new Uint8Array(),
      allowTaxEstimate: false, requestedBy: USER,
    };
    await expect(render(ctx)).rejects.toThrow(/Tax Estimator access/);
    const bytes = await render({ ...ctx, allowTaxEstimate: true });
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    // Access removed between create and render: the flag goes off → the section fails.
    await db.update(tenantFeatureFlags).set({ enabled: false }).where(and(eq(tenantFeatureFlags.tenantId, fx.T.schc), eq(tenantFeatureFlags.flagKey, 'TAX_ESTIMATOR_V1')));
    await expect(render({ ...ctx, allowTaxEstimate: true })).rejects.toMatchObject({ statusCode: 404 });
    await db.update(tenantFeatureFlags).set({ enabled: true }).where(and(eq(tenantFeatureFlags.tenantId, fx.T.schc), eq(tenantFeatureFlags.flagKey, 'TAX_ESTIMATOR_V1')));
  }, 180_000);
});
