// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// System storage migration (Admin > File Storage > Migrate Now):
//   - copies local-stamped attachment blobs to the system remote and
//     re-points storage_provider/storage_key
//   - derives the key from historical '/uploads/...' file_path rows
//   - covers non-attachment registry tables (extraction_jobs here)
//   - skips files already on the remote (idempotent re-run) but still
//     repairs the attachment stamp
//   - counts blobs with no local file as missingLocal, not failures,
//     and leaves those rows untouched
//   - leaves tenants with their own active remote provider alone

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, attachments, storageProviders, extractionJobs } from '../db/schema/index.js';
import { runSystemStorageMigration } from './system-storage-migration.service.js';
import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage/storage-provider.interface.js';

class FakeRemote implements StorageProvider {
  readonly name = 'b2';
  readonly requiresOAuth = false;
  objects = new Map<string, Buffer>();
  uploads: string[] = [];
  async upload(key: string, data: Buffer, _m: FileMetadata): Promise<StorageResult> {
    this.objects.set(key, data);
    this.uploads.push(key);
    return { key, sizeBytes: data.length };
  }
  async download(key: string): Promise<Buffer> {
    const b = this.objects.get(key);
    if (!b) throw new Error(`not found: ${key}`);
    return b;
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
  async exists(key: string): Promise<boolean> { return this.objects.has(key); }
  async getTemporaryUrl(): Promise<string | null> { return null; }
  async checkHealth(): Promise<HealthResult> { return { status: 'healthy', latencyMs: 1 }; }
  async getUsage() { return { usedBytes: 0, totalBytes: null }; }
}

const uploadDir = mkdtempSync(join(tmpdir(), 'vibe-sysmig-'));
const uniq = Date.now() + '-' + Math.random().toString(36).slice(2, 6);

let tenantA = ''; // uses system default — in scope
let tenantB = ''; // has own active dropbox provider — out of scope
const ids = { migrated: '', legacyPath: '', already: '', missing: '', foreign: '', job: '' };

function seedFile(key: string, content: string) {
  const p = join(uploadDir, key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

beforeAll(async () => {
  const [a] = await db.insert(tenants).values({ name: 'SysMig A', slug: 'sysmig-a-' + uniq }).returning();
  const [b] = await db.insert(tenants).values({ name: 'SysMig B', slug: 'sysmig-b-' + uniq }).returning();
  tenantA = a!.id; tenantB = b!.id;

  await db.insert(storageProviders).values({
    tenantId: tenantB, provider: 'dropbox', isActive: true, config: {}, displayName: 'Dropbox',
  });

  const att = (over: Partial<typeof attachments.$inferInsert>) => ({
    tenantId: tenantA, fileName: 'f.pdf', filePath: '/uploads/x', attachableType: 'transaction',
    attachableId: '00000000-0000-0000-0000-000000000001', storageProvider: 'local' as string | null,
    mimeType: 'application/pdf', ...over,
  });

  const keyOf = (n: string) => `${tenantA}/attachments/${n}-${uniq}.pdf`;

  // 1. normal local row with storage_key + blob on disk
  seedFile(keyOf('migrate'), 'blob-migrate');
  const [m] = await db.insert(attachments).values(att({ storageKey: keyOf('migrate'), filePath: `/uploads/${keyOf('migrate')}` })).returning();
  ids.migrated = m!.id;

  // 2. legacy row: NULL storage_key, only a '/uploads/...' file_path
  seedFile(keyOf('legacy'), 'blob-legacy');
  const [l] = await db.insert(attachments).values(att({ storageKey: null, filePath: `/uploads/${keyOf('legacy')}` })).returning();
  ids.legacyPath = l!.id;

  // 3. blob already on the remote, row still stamped local
  const [al] = await db.insert(attachments).values(att({ storageKey: keyOf('already'), filePath: `/uploads/${keyOf('already')}` })).returning();
  ids.already = al!.id;

  // 4. local-stamped row whose blob exists nowhere
  const [mi] = await db.insert(attachments).values(att({ storageKey: keyOf('missing'), filePath: `/uploads/${keyOf('missing')}` })).returning();
  ids.missing = mi!.id;

  // 5. tenant B (own provider) — must not be touched even though a local blob exists
  const foreignKey = `${tenantB}/attachments/foreign-${uniq}.pdf`;
  seedFile(foreignKey, 'blob-foreign');
  const [f] = await db.insert(attachments).values(att({ tenantId: tenantB, storageKey: foreignKey, filePath: `/uploads/${foreignKey}` })).returning();
  ids.foreign = f!.id;

  // 6. non-attachment registry table: extraction job with a local blob
  const jobKey = `${tenantA}/extraction/job-${uniq}.pdf`;
  seedFile(jobKey, 'blob-job');
  const [j] = await db.insert(extractionJobs).values({
    tenantId: tenantA, docType: 'receipt', fileHash: 'h'.repeat(64).slice(0, 64), storageKey: jobKey,
  }).returning();
  ids.job = j!.id;
});

afterAll(async () => {
  rmSync(uploadDir, { recursive: true, force: true });
  for (const t of [tenantA, tenantB]) {
    if (!t) continue;
    await db.delete(attachments).where(eq(attachments.tenantId, t));
    await db.delete(extractionJobs).where(eq(extractionJobs.tenantId, t));
    await db.delete(storageProviders).where(eq(storageProviders.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
});

describe('runSystemStorageMigration', () => {
  it('copies local blobs to the remote and re-points attachment rows', async () => {
    const remote = new FakeRemote();
    const alreadyKey = `${tenantA}/attachments/already-${uniq}.pdf`;
    remote.objects.set(alreadyKey, Buffer.from('pre-existing'));

    const status = await runSystemStorageMigration({ remote, uploadDir });

    expect(status.status).toBe('completed');

    // 1 + 2: blobs uploaded and rows stamped b2
    const migratedKey = `${tenantA}/attachments/migrate-${uniq}.pdf`;
    const legacyKey = `${tenantA}/attachments/legacy-${uniq}.pdf`;
    expect((await remote.download(migratedKey)).toString()).toBe('blob-migrate');
    expect((await remote.download(legacyKey)).toString()).toBe('blob-legacy');
    const m = await db.query.attachments.findFirst({ where: eq(attachments.id, ids.migrated) });
    expect(m?.storageProvider).toBe('b2');
    const l = await db.query.attachments.findFirst({ where: eq(attachments.id, ids.legacyPath) });
    expect(l?.storageProvider).toBe('b2');
    expect(l?.storageKey).toBe(legacyKey); // derived from '/uploads/...' file_path

    // 3: not re-uploaded, but the stale 'local' stamp is repaired
    expect(remote.uploads).not.toContain(alreadyKey);
    const al = await db.query.attachments.findFirst({ where: eq(attachments.id, ids.already) });
    expect(al?.storageProvider).toBe('b2');

    // 4: missing blob → counted, row untouched
    expect(status.missingLocal).toBeGreaterThanOrEqual(1);
    const mi = await db.query.attachments.findFirst({ where: eq(attachments.id, ids.missing) });
    expect(mi?.storageProvider).toBe('local');

    // 5: tenant with own provider untouched
    const f = await db.query.attachments.findFirst({ where: eq(attachments.id, ids.foreign) });
    expect(f?.storageProvider).toBe('local');
    expect(remote.uploads.find((k) => k.includes('foreign'))).toBeUndefined();

    // 6: non-attachment registry blob copied (no DB column to re-point)
    const jobKey = `${tenantA}/extraction/job-${uniq}.pdf`;
    expect((await remote.download(jobKey)).toString()).toBe('blob-job');

    expect(status.failed).toBe(0);
    expect(status.migrated).toBeGreaterThanOrEqual(3);
  });

  it('re-run is a no-op for everything already migrated', async () => {
    const remote = new FakeRemote();
    // Simulate the remote state after the first run
    for (const n of ['migrate', 'legacy', 'already']) {
      remote.objects.set(`${tenantA}/attachments/${n}-${uniq}.pdf`, Buffer.from('x'));
    }
    remote.objects.set(`${tenantA}/extraction/job-${uniq}.pdf`, Buffer.from('x'));

    const status = await runSystemStorageMigration({ remote, uploadDir });
    expect(status.status).toBe('completed');
    // Rows now stamped 'b2' are out of scope entirely; the extraction job
    // key already exists → nothing gets uploaded again.
    expect(remote.uploads.filter((k) => k.includes(uniq))).toHaveLength(0);
  });
});
