// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Anonymous share links for published financial reports:
//   - mint requires status='published' (drafts/review rejected)
//   - mint is idempotent (same token on repeat calls)
//   - the public lookup resolves ONLY a published report
//   - a draft token never resolves (404)
//   - archiving a published report makes its token stop resolving —
//     the critical security gate

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  transactions, journalLines,
  reportTemplates, reportInstances, reportComments, reportAiSummaries, kpiDefinitions,
} from '../db/schema/index.js';
import * as svc from './portal-reports.service.js';

// PDF render + storage are mocked so publish exercises the status machine,
// not Chromium. Mirrors portal-reports.status.test.ts.
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

async function cleanDb() {
  await db.delete(reportAiSummaries);
  await db.delete(reportComments);
  await db.delete(reportInstances);
  await db.delete(reportTemplates);
  await db.delete(kpiDefinitions);
  await db.delete(auditLog);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function setup() {
  const [t] = await db.insert(tenants).values({ name: 'Share T', slug: `share-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [u] = await db.insert(users).values({
    tenantId,
    email: `share-${Date.now()}@example.com`,
    passwordHash: 'not-a-real-hash',
    displayName: 'Share Tester',
    role: 'owner',
  }).returning();
  userId = u!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Share Co' }).returning();
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

beforeEach(async () => {
  await cleanDb();
  await setup();
  htmlToPdfMock.mockClear();
  htmlToPdfMock.mockImplementation(async () => Buffer.from('%PDF-fake'));
  storageUpload.mockClear();
});

afterEach(async () => {
  await cleanDb();
});

describe('generateReportShareToken', () => {
  it('rejects a non-published instance', async () => {
    const id = await makeInstance(); // draft
    await expect(svc.generateReportShareToken(tenantId, id, userId)).rejects.toThrow(
      /published/i,
    );
  });

  it('mints a token for a published instance and is idempotent', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    const first = await svc.generateReportShareToken(tenantId, id, userId);
    expect(first).toMatch(/^[A-Za-z0-9_-]{20,}$/); // base64url, 160-bit
    const second = await svc.generateReportShareToken(tenantId, id, userId);
    expect(second).toBe(first); // idempotent — same token, not re-minted
  });

  it('is tenant-scoped (another tenant cannot mint for this instance)', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    await expect(
      svc.generateReportShareToken('00000000-0000-0000-0000-000000000000', id, userId),
    ).rejects.toThrow(/not found/i);
  });
});

describe('getPublishedReportByShareToken', () => {
  it('resolves a published report and does not leak the tenantId', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    const token = await svc.generateReportShareToken(tenantId, id, userId);

    const payload = await svc.getPublishedReportByShareToken(token);
    expect(payload.companyName).toBe('Share Co');
    expect(payload.periodStart).toBe('2026-04-01');
    expect(payload.periodEnd).toBe('2026-06-30');
    expect(payload.version).toBe(1);
    // Security: the public payload must not carry tenant/instance ids.
    expect(Object.keys(payload)).not.toContain('tenantId');
    expect(Object.keys(payload)).not.toContain('id');
  });

  it('404s for an unknown / malformed token', async () => {
    await expect(svc.getPublishedReportByShareToken('nope-nope-nope')).rejects.toThrow(
      /not found/i,
    );
    await expect(svc.getPublishedReportByShareToken('')).rejects.toThrow(/not found/i);
  });

  it('archiving a published report makes its token stop resolving', async () => {
    const id = await makeInstance();
    await svc.setStatus(tenantId, id, userId, 'published');
    const token = await svc.generateReportShareToken(tenantId, id, userId);

    // Link resolves while published.
    await expect(svc.getPublishedReportByShareToken(token)).resolves.toBeTruthy();

    // Archive → the same token must now 404 (critical gate).
    await svc.setStatus(tenantId, id, userId, 'archived');
    await expect(svc.getPublishedReportByShareToken(token)).rejects.toThrow(/not found/i);

    // Republish → token resolves again (idempotent token survives).
    await svc.setStatus(tenantId, id, userId, 'published');
    await expect(svc.getPublishedReportByShareToken(token)).resolves.toBeTruthy();
  });
});
