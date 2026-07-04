// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Remote backup keys are tenant-rooted for NEW uploads
// ({tenantId}/backups/... and _system/backups/...), while enumeration
// (list/download/delete/GFS purge) runs off the backup_remote_manifest
// stored in system_settings — every entry carries its own key, so
// legacy backups/{tenantId}/... entries keep working with no migration.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import { eq, inArray } from 'drizzle-orm';

// Stub the Dropbox provider so uploadBackupToRemote exercises the real
// key construction + manifest bookkeeping without any network calls.
const recorded = vi.hoisted(() => ({ uploads: [] as string[], deletes: [] as string[] }));
vi.mock('./storage/dropbox.provider.js', () => ({
  DropboxProvider: class {
    readonly name = 'dropbox';
    readonly requiresOAuth = true;
    async upload(key: string, data: Buffer) {
      recorded.uploads.push(key);
      return { key, sizeBytes: data.length };
    }
    async download(_key: string): Promise<Buffer> {
      return Buffer.from('remote-bytes');
    }
    async delete(key: string) {
      recorded.deletes.push(key);
    }
    async exists() { return true; }
    async getTemporaryUrl() { return null; }
    async checkHealth() { return { status: 'healthy' as const, latencyMs: 1 }; }
    async getUsage() { return { usedBytes: 0, totalBytes: null }; }
  },
}));

import { db } from '../db/index.js';
import { systemSettings } from '../db/schema/index.js';
import { encrypt } from '../utils/encryption.js';
import {
  uploadBackupToRemote,
  listRemoteBackups,
  deleteRemoteBackup,
} from './backup.service.js';

const SETTING_KEYS = ['backup_remote_provider', 'backup_remote_config', 'backup_remote_manifest'];
let savedSettings: Array<{ key: string; value: string | null }> = [];

async function putSetting(key: string, value: string) {
  await db
    .insert(systemSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
}

beforeAll(async () => {
  // Save + replace the three settings this test drives.
  const rows = await db
    .select()
    .from(systemSettings)
    .where(inArray(systemSettings.key, SETTING_KEYS));
  savedSettings = SETTING_KEYS.map((key) => ({
    key,
    value: rows.find((r) => r.key === key)?.value ?? null,
  }));

  await putSetting('backup_remote_provider', 'dropbox');
  await putSetting(
    'backup_remote_config',
    JSON.stringify({ access_token_encrypted: encrypt('test-token'), root_folder: '/Test' }),
  );
  await putSetting('backup_remote_manifest', '[]');
});

afterAll(async () => {
  for (const { key, value } of savedSettings) {
    if (value === null) {
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
    } else {
      await putSetting(key, value);
    }
  }
});

describe('remote backup keys (tenant-rooted layout)', () => {
  const tenantId = crypto.randomUUID();

  it('tenant backups upload under {tenantId}/backups/', async () => {
    const fileName = 'kis-books-backup-2026-07-04T00-00-00-000Z.vmb';
    const result = await uploadBackupToRemote(fileName, Buffer.from('enc'), tenantId);

    expect(result.success).toBe(true);
    expect(recorded.uploads).toContain(`${tenantId}/backups/${fileName}`);

    const manifest = await listRemoteBackups();
    const entry = manifest.find((e) => e.key === `${tenantId}/backups/${fileName}`);
    expect(entry).toBeDefined();
    expect(entry!.tenantId).toBe(tenantId);
  });

  it('system backups upload under _system/backups/', async () => {
    const fileName = 'kis-books-backup-system-2026-07-04.vmb';
    const result = await uploadBackupToRemote(fileName, Buffer.from('enc'), '_system');

    expect(result.success).toBe(true);
    expect(recorded.uploads).toContain(`_system/backups/${fileName}`);
  });

  it('a legacy old-layout manifest entry lists and deletes by its stored key', async () => {
    // Simulate a backup uploaded before the layout change: the manifest
    // entry carries the OLD key and must keep working untouched.
    const legacyKey = `backups/${tenantId}/kis-books-backup-legacy.vmb`;
    const manifest = await listRemoteBackups();
    manifest.push({
      key: legacyKey,
      fileName: 'kis-books-backup-legacy.vmb',
      size: 3,
      uploadedAt: new Date().toISOString(),
      tenantId,
      tiers: ['daily'],
    });
    await putSetting('backup_remote_manifest', JSON.stringify(manifest));

    const listed = await listRemoteBackups();
    expect(listed.some((e) => e.key === legacyKey)).toBe(true);
    // New-layout entry from the earlier test coexists in the same list.
    expect(listed.some((e) => e.key.startsWith(`${tenantId}/backups/`))).toBe(true);

    await deleteRemoteBackup(legacyKey);
    expect(recorded.deletes).toContain(legacyKey);
    expect((await listRemoteBackups()).some((e) => e.key === legacyKey)).toBe(false);
  });
});
