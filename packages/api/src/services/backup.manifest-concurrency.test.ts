// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Regression: the remote backup manifest is a single JSON blob under one
// settings key. uploadBackupToRemote appends under withManifestLock, but the
// GFS purge and single-delete paths used to do an UNLOCKED read-modify-write
// against a stale snapshot — so a manifest entry appended by an in-flight
// (fire-and-forget) upload AFTER purge/delete read its snapshot, but BEFORE it
// saved, was silently clobbered. For a multi-part .vmx that drops one part from
// tracking: invisible to listRemoteBackups, never GFS-purged, restore set
// silently incomplete. These tests prove purge/delete now save under the lock
// against a FRESH read, preserving a concurrently-appended entry.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// The concurrent "upload" append the mocked provider.delete performs mid-flight.
let onDelete: ((key: string) => Promise<void>) | null = null;

vi.mock('./storage/s3.provider.js', () => {
  class S3Provider {
    readonly name = 's3';
    readonly requiresOAuth = false;
    constructor(_opts: unknown) {}
    async upload() { return { key: '', sizeBytes: 0 }; }
    async download() { return Buffer.alloc(0); }
    async delete(key: string) { if (onDelete) await onDelete(key); }
    async exists() { return true; }
    async getTemporaryUrl() { return null; }
    async checkHealth() { return { status: 'healthy' as const, latencyMs: 0 }; }
    async getUsage() { return { usedBytes: 0, totalBytes: null }; }
  }
  return { S3Provider };
});

let svc: typeof import('./backup.service.js');
let admin: typeof import('./admin.service.js');

const MANIFEST_KEY = 'backup_remote_manifest';

function entry(key: string, daysAgo: number, tiers: string[]) {
  return {
    key,
    fileName: key.split('/').pop(),
    size: 10,
    uploadedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    tenantId: '_system',
    tiers,
  };
}

async function readManifest(): Promise<Array<{ key: string }>> {
  const raw = await admin.getSetting(MANIFEST_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function writeManifest(entries: unknown[]): Promise<void> {
  await admin.setSetting(MANIFEST_KEY, JSON.stringify(entries));
}

beforeAll(async () => {
  svc = await import('./backup.service.js');
  admin = await import('./admin.service.js');
  // Point the system remote provider at our mocked S3 provider.
  await admin.setSetting('backup_remote_provider', 's3');
  await admin.setSetting('backup_remote_config', JSON.stringify({ bucket: 'b', accessKeyId: 'k', region: 'us' }));
});

afterEach(async () => {
  onDelete = null;
  await writeManifest([]);
});

describe('remote manifest concurrency (purge/delete never clobber a concurrent append)', () => {
  it('purgeExpiredRemoteBackups preserves an entry appended by an in-flight upload during the purge', async () => {
    // Old daily entry (past its 14-day daily window) → will be purged.
    await writeManifest([entry('backups/_system/old.vmb', 40, ['daily'])]);

    // The instant the provider deletes the old key, a concurrent fire-and-forget
    // upload lands its own entry into the manifest (as uploadBackupToRemote would,
    // under the lock). Purge's stale snapshot pre-dates this entry.
    onDelete = async () => {
      const m = await readManifest();
      m.push(entry('backups/_system/inflight.part02of03.vmb', 0, ['daily', 'weekly']) as never);
      await writeManifest(m);
    };

    const deleted = await svc.purgeExpiredRemoteBackups({
      dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12, yearlyYears: 7,
    });

    expect(deleted).toBe(1);
    const keys = (await readManifest()).map((e) => e.key);
    expect(keys).not.toContain('backups/_system/old.vmb');      // expired one removed
    expect(keys).toContain('backups/_system/inflight.part02of03.vmb'); // concurrent append survived
  });

  it('deleteRemoteBackup preserves an entry appended by an in-flight upload during the delete', async () => {
    await writeManifest([entry('backups/_system/target.vmb', 1, ['daily'])]);

    onDelete = async (key) => {
      if (key !== 'backups/_system/target.vmb') return;
      const m = await readManifest();
      m.push(entry('backups/_system/inflight.vmb', 0, ['daily']) as never);
      await writeManifest(m);
    };

    await svc.deleteRemoteBackup('backups/_system/target.vmb');

    const keys = (await readManifest()).map((e) => e.key);
    expect(keys).not.toContain('backups/_system/target.vmb');
    expect(keys).toContain('backups/_system/inflight.vmb');
  });
});
