// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report-instance lifecycle hardening:
//   - H3: explicit status machine — published/archived never fall back
//     to draft (Duplicate is the escape hatch)
//   - H6: published→published with a missing PDF retries the render
//     without bumping the version or re-stamping publishedAt
//   - H2/M2: generateInstance / computeInstance / patchSnapshot /
//     generateAiSummary all reject published AND archived snapshots
//   - M5: published instances can never be hard-deleted; allowed hard
//     deletes clean up the stored PDF blob
//   - M1: publishing a snapshot with errored blocks returns warnings
//     (does not block)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  transactions, journalLines,
  reportTemplates, reportInstances, reportComments, reportAiSummaries, kpiDefinitions,
} from '../db/schema/index.js';
import * as svc from './portal-reports.service.js';

// PDF render + storage are mocked: publish tests exercise the status
// machine, not Chromium. htmlToPdf resolves a fake buffer by default;
// individual tests flip it to reject to simulate a failed publish render.
const htmlToPdfMock = vi.hoisted(() => vi.fn(async () => Buffer.from('%PDF-fake')));
vi.mock('./portal-pdf.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portal-pdf.service.js')>();
  return { ...actual, htmlToPdf: htmlToPdfMock };
});

const storageUpload = vi.hoisted(() => vi.fn(async () => undefined));
const storageDelete = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./storage/storage-provider.factory.js', () => ({
  getProviderForTenant: async () => ({
    upload: storageUpload,
    download: vi.fn(async () => Buffer.from('%PDF-fake')),
    delete: storageDelete,
  }),
  invalidateProviderCache: () => undefined,
}));

let tenantId: string;
let userId: string;
let companyId: string;

// Tenant-scoped cleanup — unscoped deletes would nuke concurrently-
// running suites' data (and trip over their FKs). Only touch our tenant.
async function cleanDb() {
  if (!tenantId) return;
  // report_ai_summaries / report_comments have no tenant column —
  // key them off this tenant's report instances.
  const instanceIds = db
    .select({ id: reportInstances.id })
    .from(reportInstances)
    .where(eq(reportInstances.tenantId, tenantId));
  await db.delete(reportAiSummaries).where(inArray(reportAiSummaries.instanceId, instanceIds));
  await db.delete(reportComments).where(inArray(reportComments.instanceId, instanceIds));
  await db.delete(reportInstances).where(eq(reportInstances.tenantId, tenantId));
  await db.delete(reportTemplates).where(eq(reportTemplates.tenantId, tenantId));
  await db.delete(kpiDefinitions).where(eq(kpiDefinitions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  // sessions has no tenant column — key it off this tenant's users
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const [t] = await db.insert(tenants).values({ name: 'Status T', slug: `status-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [u] = await db.insert(users).values({
    tenantId,
    email: `status-${Date.now()}@example.com`,
    passwordHash: 'not-a-real-hash',
    displayName: 'Status Tester',
    role: 'owner',
  }).returning();
  userId = u!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Status Co' }).returning();
  companyId = co!.id;
}

async function makeInstance(): Promise<string> {
  const { id } = await svc.createInstance(tenantId, userId, {
    templateId: null,
    companyId,
    periodStart: '2026-04-01',
    periodEnd: '2026-06-30',
  });
  return id;
}

async function statusOf(id: string) {
  const inst = await svc.getInstance(tenantId, id);
  return inst.status;
}

beforeEach(async () => {
  await cleanDb();
  await setup();
  htmlToPdfMock.mockClear();
  htmlToPdfMock.mockImplementation(async () => Buffer.from('%PDF-fake'));
  storageUpload.mockClear();
  storageDelete.mockClear();
});

afterEach(async () => {
  await cleanDb();
});

describe('H3 — status transition matrix', () => {
  it('allows draft→review, review→draft, draft→published, review→published, published→archived, archived→published', async () => {
    const a = await makeInstance();
    await svc.setStatus(tenantId, a, userId, 'review');
    expect(await statusOf(a)).toBe('review');
    await svc.setStatus(tenantId, a, userId, 'draft');
    expect(await statusOf(a)).toBe('draft');
    await svc.setStatus(tenantId, a, userId, 'published');
    expect(await statusOf(a)).toBe('published');
    await svc.setStatus(tenantId, a, userId, 'archived');
    expect(await statusOf(a)).toBe('archived');
    const republished = await svc.setStatus(tenantId, a, userId, 'published');
    expect(await statusOf(a)).toBe('published');
    expect(republished.version).toBe(2); // republish bumps the version

    const b = await makeInstance();
    await svc.setStatus(tenantId, b, userId, 'review');
    const pub = await svc.setStatus(tenantId, b, userId, 'published');
    expect(pub.version).toBe(1);
    expect(await statusOf(b)).toBe('published');
  });

  it('rejects published→draft and archived→draft with a Duplicate hint', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    await expect(svc.setStatus(tenantId, id, userId, 'draft')).rejects.toThrow(/Duplicate/);
    await expect(svc.setStatus(tenantId, id, userId, 'review')).rejects.toThrow(/cannot move/i);

    await svc.setStatus(tenantId, id, userId, 'archived');
    await expect(svc.setStatus(tenantId, id, userId, 'draft')).rejects.toThrow(/Duplicate/);
    expect(await statusOf(id)).toBe('archived');
  });

  it('same-status call is a no-op when the PDF exists', async () => {
    const id = await makeInstance();
    const first = await svc.setStatus(tenantId, id, userId, 'published');
    expect(first.pdfRendered).toBe(true);
    const before = await svc.getInstance(tenantId, id);

    const again = await svc.setStatus(tenantId, id, userId, 'published');
    expect(again.pdfRendered).toBe(false);
    expect(again.version).toBe(first.version);
    const after = await svc.getInstance(tenantId, id);
    expect(after.publishedAt?.getTime()).toBe(before.publishedAt?.getTime());
    expect(htmlToPdfMock).toHaveBeenCalledTimes(1);
  });
});

describe('H6 — failed publish-time PDF is recoverable', () => {
  it('published→published with a null pdfUrl re-renders without a version bump', async () => {
    const id = await makeInstance();
    htmlToPdfMock.mockRejectedValueOnce(new Error('chromium exploded'));
    const first = await svc.setStatus(tenantId, id, userId, 'published');
    expect(first.pdfRendered).toBe(false);
    expect(first.pdfError).toMatch(/chromium exploded/);

    const broken = await svc.getInstance(tenantId, id);
    expect(broken.status).toBe('published');
    expect(broken.pdfUrl).toBeNull();
    const publishedAt = broken.publishedAt;

    const retry = await svc.setStatus(tenantId, id, userId, 'published');
    expect(retry.pdfRendered).toBe(true);
    expect(retry.pdfError).toBeNull();
    expect(retry.version).toBe(first.version); // NO bump on retry

    const fixed = await svc.getInstance(tenantId, id);
    expect(fixed.pdfUrl).toMatch(/\.pdf$/);
    expect(fixed.version).toBe(broken.version);
    // publishedAt is the ORIGINAL publish moment, not re-stamped.
    expect(fixed.publishedAt?.getTime()).toBe(publishedAt?.getTime());
  });
});

describe('H2/M2 — snapshot writes are locked on published AND archived', () => {
  it('generateInstance rejects published and archived instances', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    await expect(
      svc.generateInstance(tenantId, id, userId, { kpis: { fake: '1' } }),
    ).rejects.toThrow(/PUBLISHED_LOCKED|cannot be edited/i);

    await svc.setStatus(tenantId, id, userId, 'archived');
    await expect(
      svc.generateInstance(tenantId, id, userId, { kpis: { fake: '1' } }),
    ).rejects.toThrow(/cannot be edited/i);

    // Snapshot unchanged.
    const inst = await svc.getInstance(tenantId, id);
    expect((inst.dataSnapshotJsonb as Record<string, unknown>)['kpis']).toBeUndefined();
  });

  it('patchSnapshot and computeInstance reject archived instances', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    await svc.setStatus(tenantId, id, userId, 'archived');
    await expect(
      svc.patchSnapshot(tenantId, id, userId, { aiSummary: 'sneaky edit' }),
    ).rejects.toThrow(/cannot be edited/i);
    await expect(svc.computeInstance(tenantId, id, userId)).rejects.toThrow(/cannot be edited/i);
  });

  it('generateInstance audit row carries key lists and value digests', async () => {
    const id = await makeInstance();
    await svc.generateInstance(tenantId, id, userId, { kpis: { x: '1' } });
    const rows = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const row = rows.find((r) => r.entityType === 'report_instance_data');
    expect(row).toBeDefined();
    // afterData is a jsonb column — drizzle may return it parsed.
    const after = (typeof row!.afterData === 'string'
      ? JSON.parse(row!.afterData)
      : row!.afterData) as Record<string, unknown>;
    expect(after['afterKeys']).toEqual(['kpis']);
    expect(String(after['beforeDigest'])).toMatch(/^[0-9a-f]{16}$/);
    expect(String(after['afterDigest'])).toMatch(/^[0-9a-f]{16}$/);
    expect(after['beforeDigest']).not.toBe(after['afterDigest']);
  });
});

describe('M5 — published instances cannot be hard-deleted', () => {
  it('refuses delete of a published instance even with force=true', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    await expect(svc.deleteInstance(tenantId, id, userId, true)).rejects.toThrow(/Archive/i);
    expect(await statusOf(id)).toBe('published');
  });

  it('deleting an archived instance best-effort removes the PDF blob', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    await svc.setStatus(tenantId, id, userId, 'archived');
    const inst = await svc.getInstance(tenantId, id);
    expect(inst.pdfUrl).toBeTruthy();

    await svc.deleteInstance(tenantId, id, userId, true);
    expect(storageDelete).toHaveBeenCalledWith(inst.pdfUrl);
    await expect(svc.getInstance(tenantId, id)).rejects.toThrow(/not found/i);
  });

  it('a storage failure never blocks the row delete', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    await svc.setStatus(tenantId, id, userId, 'archived');
    storageDelete.mockRejectedValueOnce(new Error('bucket offline'));
    await svc.deleteInstance(tenantId, id, userId, true);
    await expect(svc.getInstance(tenantId, id)).rejects.toThrow(/not found/i);
  });
});

describe('M1 — publish surfaces errored blocks as warnings', () => {
  it('returns warnings listing affected block labels; publish still succeeds', async () => {
    const id = await makeInstance();
    // Simulate a compute that failed for one block.
    await db.update(reportInstances).set({
      layoutSnapshotJsonb: [
        { type: 'block', name: 'top_customers', topN: 5 },
        { type: 'block', name: 'ap_aging' },
      ] as never,
      dataSnapshotJsonb: {
        kpis: {},
        blocks: {
          top_customers: { type: 'top_customers', data: [] },
          ap_aging: { type: 'block', error: 'relation "secret_table" does not exist' },
        },
      } as never,
    }).where(eq(reportInstances.id, id));

    const result = await svc.setStatus(tenantId, id, userId, 'published');
    expect(result.pdfRendered).toBe(true);
    expect(result.warnings).toEqual(['ap aging']);
    expect(await statusOf(id)).toBe('published');
  });

  it('omits warnings when every block resolved', async () => {
    const id = await makeInstance();
    const result = await svc.setStatus(tenantId, id, userId, 'published');
    expect(result.warnings).toBeUndefined();
  });
});
