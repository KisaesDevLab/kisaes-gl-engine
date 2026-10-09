// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The pack download name renders the pack's filename template with the
// tenant name, company and the run's date range.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, reportPacks, reportPackRuns } from '../db/schema/index.js';

vi.mock('./storage/storage-provider.factory.js', () => ({
  getProviderForTenant: async () => ({ download: async () => Buffer.from('%PDF-1.4') }),
}));

import { readRunArtifact } from './report-pack.service.js';

let tenantId = '';
let companyId = '';
let packId = '';

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'TimberStone LLC', slug: `pack-fn-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'TimberStone' }).returning();
  companyId = c!.id;
  const [p] = await db.insert(reportPacks).values({
    tenantId, companyId, name: 'Month End', createdBy: tenantId, filenameTemplate: '{tenant} - {range}',
  }).returning();
  packId = p!.id;
});

afterAll(async () => {
  await db.delete(reportPackRuns).where(eq(reportPackRuns.tenantId, tenantId));
  await db.delete(reportPacks).where(eq(reportPacks.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

async function mkRun(v: { rangeStart?: string; rangeEnd?: string; asOfDate?: string }) {
  const [r] = await db.insert(reportPackRuns).values({
    packId, tenantId, companyId, status: 'succeeded', transientKey: 'k',
    expiresAt: new Date(Date.now() + 60_000), ...v,
  }).returning();
  return r!.id;
}

describe('report pack download filename', () => {
  it('renders the tenant name and the run\'s date range', async () => {
    const runId = await mkRun({ rangeStart: '2026-09-01', rangeEnd: '2026-09-30' });
    const { filename } = await readRunArtifact(tenantId, runId);
    expect(filename).toBe('TimberStone_LLC_-_2026-09-01_to_2026-09-30.pdf');
  });

  it('uses the as-of date for a point-in-time run', async () => {
    const runId = await mkRun({ asOfDate: '2026-12-31' });
    const { filename } = await readRunArtifact(tenantId, runId);
    expect(filename).toBe('TimberStone_LLC_-_2026-12-31.pdf');
  });
});
