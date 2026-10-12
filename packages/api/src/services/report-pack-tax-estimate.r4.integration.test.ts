// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator R4 review regressions (features/tax-estimator/docs/reviews/R4-portal-pack.md),
// Report Pack generation and the worker path:
//   R4-01  a run carrying the Tax Estimate section is stored ENCRYPTED with a short TTL and
//          decrypts on download.
//   R4-04  the pack section is the CLIENT variant: no readiness codes, unverified-parameter
//          dumps, engine version or raw prior-year AGI; the staff standalone PDF keeps them.
//   R4-03  the worker re-checks the tax_estimator permission and user_type of requested_by;
//          a failed run loses its allow_tax_estimate grant.
//   R4-06  no base scenario → TE_SCENARIO_NOT_FOUND, never a what-if.
//   R4-09  report_pack / pdf snapshots with the same inputs on the same day are reused.
// Chromium is not needed: the section is pdf-lib; the browser handle is stubbed.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';

vi.mock('./pdf-merge.util.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pdf-merge.util.js')>();
  return {
    ...real,
    launchPdfBrowser: async () => ({ close: async () => {} }),
    htmlToPdfBytes: async () => {
      const d = await PDFDocument.create();
      d.addPage();
      return d.save();
    },
  };
});

import { db, pool } from '../db/index.js';
import {
  auditLog, firms, firmUsers, reportPackRuns, taxEstFirmSettings, taxEstSnapshots, taxEstTaxpayers, tenantFeatureFlags,
  tenantFirmAssignments, userPermissions, userTenantAccess, users,
} from '../db/schema/index.js';
import { taxEstScenarios } from '../db/schema/tax-estimator-years.js';
import { closeTbRedis } from './tb/tb-redis.js';
import { purgeTenants } from './tax-estimator/entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from './tax-estimator/rivera.test-fixtures.js';
import { pdfText } from './tax-estimator/pdf-text.test-fixtures.js';
import { issueEstimatePdf, renderPackSection, resolvePackScope } from './tax-estimator/estimate-documents.service.js';
import { REPORT_PACK_DOCUMENT_RENDERERS, type DocumentSectionContext } from './report-pack-documents.js';
import { createPack, readRunArtifact } from './report-pack.service.js';
import { portableOptions } from './report-pack-templates.service.js';
import { generateReportPackRun } from './report-pack-generate.service.js';
import { getProviderForTenant } from './storage/storage-provider.factory.js';

const FIRM_A = randomUUID();
const FIRM_B = randomUUID();
const USER = randomUUID();
const OPTS = { today: new Date('2026-10-12T12:00:00Z'), skipProviderCache: true };
let fx: RiveraFixture;
const ids: Record<string, string> = {};

async function mkFirmUser(key: string, role: string) {
  const id = randomUUID();
  ids[key] = id;
  await db.insert(users).values({ id, tenantId: fx.T.schc, email: `te-r4s-${key}-${id.slice(0, 8)}@example.com`, passwordHash: 'x', displayName: key, role });
  await db.insert(firmUsers).values({ firmId: FIRM_A, userId: id, firmRole: 'firm_staff' });
  await db.insert(userTenantAccess).values([fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ userId: id, tenantId, role })));
}

async function insertRun(packId: string, requestedBy: string) {
  const [run] = await db.insert(reportPackRuns).values({
    packId, tenantId: fx.T.schc, companyId: fx.C.schc, rangeStart: '2026-01-01', rangeEnd: '2026-09-30', asOfDate: '2026-09-30',
    status: 'queued', progress: 0, allowAttachments: false, allowTransactions: false, allowTaxEstimate: true, requestedBy,
  }).returning();
  return run!;
}

const reportPackSnaps = async () => (await db.select({ id: taxEstSnapshots.id }).from(taxEstSnapshots)
  .where(and(eq(taxEstSnapshots.taxpayerId, fx.taxpayerId), eq(taxEstSnapshots.reason, 'report_pack')))).length;

beforeAll(async () => {
  await db.insert(firms).values([{ id: FIRM_A, name: 'Rivera CPA LLC', slug: `te-r4s-a-${FIRM_A.slice(0, 8)}` }, { id: FIRM_B, name: 'Other Firm', slug: `te-r4s-b-${FIRM_B.slice(0, 8)}` }]);
  fx = await seedRivera(FIRM_A, FIRM_B, USER);
  await db.insert(tenantFirmAssignments).values([fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })));
  await db.insert(tenantFeatureFlags).values({ tenantId: fx.T.schc, flagKey: 'TAX_ESTIMATOR_V1', enabled: true });
  await mkFirmUser('staff', 'accountant');
  await mkFirmUser('limited', 'bookkeeper'); // tailored below: no tax_estimator resource
  await mkFirmUser('retyped', 'accountant'); // becomes user_type 'client' below
}, 300_000);

afterAll(async () => {
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, fx.T.schc));
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B]));
  await db.delete(auditLog).where(eq(auditLog.userId, USER));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other]);
  await db.delete(firmUsers).where(eq(firmUsers.firmId, FIRM_A));
  await db.delete(firms).where(inArray(firms.id, [FIRM_A, FIRM_B]));
  await closeTbRedis();
  await pool.end();
});

describe('R4-01 / R4-04 — the generated pack artifact', () => {
  it('is stored encrypted with a short TTL, decrypts on download, and prints the client variant', async () => {
    const pack = await createPack(fx.T.schc, fx.C.schc, ids['staff']!, {
      name: 'R4 encrypted', coverPage: false, toc: false, asOfMode: 'custom', asOfCustom: '2026-09-30', periodPreset: 'ytd',
      items: [{ reportId: 'tax-estimate', options: { taxpayerId: fx.taxpayerId } }],
    });
    const run = await insertRun(pack.id, ids['staff']!);
    const before = Date.now();
    await generateReportPackRun(run.id);
    const [done] = await db.select().from(reportPackRuns).where(eq(reportPackRuns.id, run.id));
    expect(done!.status).toBe('succeeded');
    // Retention: tax-bearing artifacts live at most 15 minutes (plain packs: 60).
    expect(done!.expiresAt!.getTime() - before).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    // At rest: ciphertext, not a PDF, and no taxpayer name.
    const stored = await (await getProviderForTenant(fx.T.schc)).download(done!.transientKey!);
    expect(stored.subarray(0, 5).toString('latin1')).not.toBe('%PDF-');
    expect(stored.toString('latin1')).not.toContain('Rivera');
    // Download decrypts.
    const { buffer } = await readRunArtifact(fx.T.schc, run.id);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = pdfText(buffer);
    expect(text).toContain('Prepared for Carlos & Maria Rivera');
    expect(text).toContain('Payment vouchers');
    expect(text).toMatch(/Disclaimer/);
    // R4-04: none of the preparer-only content.
    for (const banned of ['engine ', 'Readiness warnings', 'Unverified and provisional parameters', 'Engine approximations', 'Prior-year AGI', 'TE_', '[VERIFY]', '(verify)', '- unverified', '- verify']) {
      expect(text, banned).not.toContain(banned);
    }
  }, 300_000);

  it('the staff standalone PDF keeps the full preparer content', async () => {
    const pdf = await issueEstimatePdf(fx.scopeA, { tenantId: fx.T.schc, userId: ids['staff']! }, {
      taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: fx.baseScenarioId, throughMonth: '2026-09', reason: 'pdf',
    }, OPTS);
    const text = pdfText(pdf.bytes);
    expect(text).toContain('engine ');
    expect(text).toContain('Readiness warnings');
    expect(text).toContain('Engine approximations');
  }, 180_000);
});

describe('R4-03 — the worker re-derives the requester\'s Tax Estimator access', () => {
  const ctx = (requestedBy: string): DocumentSectionContext => ({
    tenantId: fx.T.schc, companyId: fx.C.schc, companyName: 'Rivera Plumbing LLC', rangeStart: '2026-07-01', rangeEnd: '2026-09-30', asOfDate: '2026-09-30',
    options: { taxpayerId: fx.taxpayerId }, allowAttachments: false, allowTransactions: false, renderHtml: async () => new Uint8Array(),
    allowTaxEstimate: true, requestedBy,
  });
  const render = () => REPORT_PACK_DOCUMENT_RENDERERS['tax-estimate']!;

  it('refuses when the tax_estimator resource was taken away after the run was requested', async () => {
    await db.insert(userPermissions).values({ tenantId: fx.T.schc, userId: ids['limited']!, overrides: { reports: 'view' } });
    await expect(render()(ctx(ids['limited']!))).rejects.toMatchObject({ statusCode: 404 });
  }, 120_000);

  it('refuses when the requester was re-typed to a client user', async () => {
    await db.update(users).set({ userType: 'client' }).where(eq(users.id, ids['retyped']!));
    await expect(render()(ctx(ids['retyped']!))).rejects.toMatchObject({ statusCode: 404 });
  }, 120_000);

  it('a failed run loses allow_tax_estimate, so a later re-claim cannot reuse the grant', async () => {
    const pack = await createPack(fx.T.schc, fx.C.schc, ids['staff']!, {
      name: 'R4 failing', coverPage: false, toc: false, onError: 'fail', asOfMode: 'custom', asOfCustom: '2026-09-30', periodPreset: 'ytd',
      items: [{ reportId: 'tax-estimate', options: { taxpayerId: randomUUID() } }], // not linked → the section throws
    });
    const run = await insertRun(pack.id, ids['staff']!);
    await expect(generateReportPackRun(run.id)).rejects.toBeTruthy();
    const [after] = await db.select().from(reportPackRuns).where(eq(reportPackRuns.id, run.id));
    expect(after!.status).toBe('failed');
    expect(after!.allowTaxEstimate).toBe(false);
  }, 120_000);
});

describe('R4-06 / R4-09 — scenario choice and snapshot reuse', () => {
  it('no base scenario and none requested → TE_SCENARIO_NOT_FOUND (never a what-if)', async () => {
    const scope = await resolvePackScope(fx.T.schc, ids['staff']!, false);
    await db.update(taxEstScenarios).set({ isBase: false }).where(eq(taxEstScenarios.id, fx.baseScenarioId));
    try {
      await expect(renderPackSection(scope, { tenantId: fx.T.schc, userId: ids['staff']! }, {
        tenantId: fx.T.schc, companyId: fx.C.schc, taxpayerId: fx.taxpayerId, asOfDate: '2026-09-30',
      }, OPTS)).rejects.toMatchObject({ code: 'TE_SCENARIO_NOT_FOUND' });
    } finally {
      await db.update(taxEstScenarios).set({ isBase: true }).where(eq(taxEstScenarios.id, fx.baseScenarioId));
    }
  }, 120_000);

  it('the same inputs on the same day reuse the report_pack / pdf snapshot instead of freezing another', async () => {
    const scope = await resolvePackScope(fx.T.schc, ids['staff']!, false);
    const actor = { tenantId: fx.T.schc, userId: ids['staff']! };
    const req = { tenantId: fx.T.schc, companyId: fx.C.schc, taxpayerId: fx.taxpayerId, asOfDate: '2026-09-30' };
    const n0 = await reportPackSnaps();
    const a = await renderPackSection(scope, actor, req, OPTS);
    const b = await renderPackSection(scope, actor, req, OPTS);
    expect(b.snapshotId).toBe(a.snapshotId);
    expect(await reportPackSnaps()).toBeLessThanOrEqual(n0 + 1);
    const p1 = await issueEstimatePdf(scope, actor, { taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: fx.baseScenarioId, throughMonth: '2026-09', reason: 'pdf' }, OPTS);
    const p2 = await issueEstimatePdf(scope, actor, { taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: fx.baseScenarioId, throughMonth: '2026-09', reason: 'pdf' }, OPTS);
    expect(p2.snapshotId).toBe(p1.snapshotId);
    // Reuse is per reason: a pdf issue never borrows a report_pack snapshot.
    expect(p1.snapshotId).not.toBe(a.snapshotId);
  }, 300_000);
});

describe('R4-01 — install-wide pack templates never carry a taxpayer', () => {
  it('portableOptions strips the Tax Estimate taxpayer / scenario ids', () => {
    expect(portableOptions({ taxpayerId: randomUUID(), scenarioId: randomUUID(), basis: 'cash' })).toEqual({ basis: 'cash' });
  });
});
