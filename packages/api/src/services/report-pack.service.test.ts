// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

// Stub the BullMQ enqueue so createRun doesn't open a Redis socket.
const enqueueSpy = vi.fn(async (_data: { runId: string; tenantId: string }) => undefined);
vi.mock('./extraction/queue.js', () => ({
  enqueueReportPack: (data: { runId: string; tenantId: string }) => enqueueSpy(data),
}));

import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, auditLog,
  reportPacks, reportPackItems, reportPackRuns,
} from '../db/schema/index.js';
import * as packService from './report-pack.service.js';

let tenantId: string;
let companyId: string;

// Tenant-scoped cleanup — unscoped deletes would nuke concurrently
// running suites' rows on the shared test DB. Only touch our tenant.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(reportPackRuns).where(eq(reportPackRuns.tenantId, tenantId));
  // report_pack_items has no tenant_id — scope through the owning pack.
  await db.delete(reportPackItems).where(
    inArray(reportPackItems.packId, db.select({ id: reportPacks.id }).from(reportPacks).where(eq(reportPacks.tenantId, tenantId))),
  );
  await db.delete(reportPacks).where(eq(reportPacks.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  // sessions has no tenant_id — scope through this tenant's users.
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function seed() {
  const [tenant] = await db.insert(tenants).values({
    name: 'Pack Test', slug: `pack-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }).returning();
  tenantId = tenant!.id;
  const [company] = await db.insert(companies).values({
    tenantId, businessName: 'Pack Co',
  }).returning();
  companyId = company!.id;
}

const USER_ID = '00000000-0000-4000-8000-000000000001';

function baseInput(overrides: Partial<packService.CreatePackInput> = {}): packService.CreatePackInput {
  return {
    name: 'Monthly Close',
    periodPreset: 'last-month',
    items: [
      { reportId: 'profit-loss', options: { basis: 'accrual', showPct: true } },
      { reportId: 'balance-sheet' },
    ],
    ...overrides,
  };
}

describe('report-pack.service', () => {
  beforeEach(async () => {
    await cleanDb();
    await seed();
    enqueueSpy.mockClear();
  });

  it('creates a pack with ordered items', async () => {
    const pack = await packService.createPack(tenantId, companyId, USER_ID, baseInput());
    expect(pack.name).toBe('Monthly Close');
    expect(pack.companyId).toBe(companyId);
    expect(pack.items).toHaveLength(2);
    expect(pack.items.map((i) => i.reportId)).toEqual(['profit-loss', 'balance-sheet']);
    expect(pack.items[0]!.sortOrder).toBe(0);
    expect(pack.items[1]!.sortOrder).toBe(1);
  });

  it('persists a per-page footer (trimmed; blank → null)', async () => {
    const withFooter = await packService.createPack(tenantId, companyId, USER_ID, baseInput({ pageFooter: '  Confidential — Board Use Only  ' }));
    expect(withFooter.pageFooter).toBe('Confidential — Board Use Only');
    const blank = await packService.createPack(tenantId, companyId, USER_ID, baseInput({ name: 'NoFooter', pageFooter: '   ' }));
    expect(blank.pageFooter).toBeNull();
  });

  it('rejects an unknown report id', async () => {
    await expect(
      packService.createPack(tenantId, companyId, USER_ID, baseInput({ items: [{ reportId: 'not-real' }] })),
    ).rejects.toThrow(/Unknown report id/);
  });

  it('enforces PACK_MAX_COUNT (30)', async () => {
    const items = Array.from({ length: 31 }, () => ({ reportId: 'profit-loss' }));
    await expect(
      packService.createPack(tenantId, companyId, USER_ID, baseInput({ items })),
    ).rejects.toThrow(/at most 30/);
  });

  it('lists packs excluding soft-deleted', async () => {
    const a = await packService.createPack(tenantId, companyId, USER_ID, baseInput({ name: 'A' }));
    await packService.createPack(tenantId, companyId, USER_ID, baseInput({ name: 'B' }));
    let list = await packService.listPacks(tenantId, companyId);
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.name === 'A')?.itemCount).toBe(2);

    await packService.softDeletePack(tenantId, a.id, USER_ID);
    list = await packService.listPacks(tenantId, companyId);
    expect(list.map((p) => p.name)).toEqual(['B']);
    // getPack on a soft-deleted pack 404s.
    await expect(packService.getPack(tenantId, a.id)).rejects.toThrow(/not found/i);
  });

  it('updates a pack and reorders items', async () => {
    const pack = await packService.createPack(tenantId, companyId, USER_ID, baseInput());
    const updated = await packService.updatePack(tenantId, pack.id, USER_ID, baseInput({
      name: 'Renamed',
      items: [{ reportId: 'cash-flow' }, { reportId: 'trial-balance' }, { reportId: 'general-ledger' }],
    }));
    expect(updated.name).toBe('Renamed');
    expect(updated.items.map((i) => i.reportId)).toEqual(['cash-flow', 'trial-balance', 'general-ledger']);
    expect(updated.items.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
  });

  it('duplicates a pack with its items', async () => {
    const pack = await packService.createPack(tenantId, companyId, USER_ID, baseInput());
    const copy = await packService.duplicatePack(tenantId, pack.id, USER_ID);
    expect(copy.id).not.toBe(pack.id);
    expect(copy.name).toBe('Monthly Close (copy)');
    expect(copy.items.map((i) => i.reportId)).toEqual(['profit-loss', 'balance-sheet']);
  });

  it('creates a run resolving the preset into a concrete range and enqueues it', async () => {
    const pack = await packService.createPack(tenantId, companyId, USER_ID, baseInput({ periodPreset: 'last-month' }));
    const run = await packService.createRun(tenantId, companyId, pack.id, USER_ID, {});
    expect(run.status).toBe('queued');
    expect(run.rangeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(run.rangeEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // last-month range: start is the 1st, end is the last day of the prior month.
    expect(run.rangeStart!.endsWith('-01')).toBe(true);
    // as-of defaults to range end (asOfMode='range-end').
    expect(run.asOfDate).toBe(run.rangeEnd);
    expect(enqueueSpy).toHaveBeenCalledWith({ runId: run.id, tenantId });
  });

  it('createRun honors explicit range overrides', async () => {
    const pack = await packService.createPack(tenantId, companyId, USER_ID, baseInput());
    const run = await packService.createRun(tenantId, companyId, pack.id, USER_ID, {
      rangeStart: '2026-01-01', rangeEnd: '2026-03-31',
    });
    expect(run.rangeStart).toBe('2026-01-01');
    expect(run.rangeEnd).toBe('2026-03-31');
    expect(run.asOfDate).toBe('2026-03-31');
  });
});
