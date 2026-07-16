// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// New backup-config fields: DB-only cadence, local mirror dir, and the
// scheduler passphrase presence flag (never the value).

import { describe, it, expect, afterEach } from 'vitest';
import {
  getBackupRemoteConfig,
  saveBackupRemoteConfig,
  setSetting,
} from './admin.service.js';
import { encrypt, decrypt } from '../utils/encryption.js';

afterEach(async () => {
  await setSetting('backup_db_schedule', 'none');
  await setSetting('backup_local_mirror_dir', '');
  await setSetting('backup_scheduled_passphrase', '');
});

describe('backup remote config — new fields', () => {
  it('round-trips backupDbSchedule and backupLocalMirrorDir', async () => {
    await saveBackupRemoteConfig({ backupDbSchedule: 'daily', backupLocalMirrorDir: '/data/backup-mirror' });
    const cfg = await getBackupRemoteConfig();
    expect(cfg.backupDbSchedule).toBe('daily');
    expect(cfg.backupLocalMirrorDir).toBe('/data/backup-mirror');
  });

  it('defaults backupDbSchedule to none and mirror dir to empty', async () => {
    const cfg = await getBackupRemoteConfig();
    expect(cfg.backupDbSchedule).toBe('none');
    expect(cfg.backupLocalMirrorDir).toBe('');
  });

  it('reports hasScheduledPassphrase without ever exposing the value', async () => {
    let cfg = await getBackupRemoteConfig();
    expect(cfg.hasScheduledPassphrase).toBe(false);

    // Route stores it encrypted; the scheduler decrypts it.
    await setSetting('backup_scheduled_passphrase', encrypt('correct horse battery staple'));
    cfg = await getBackupRemoteConfig();
    expect(cfg.hasScheduledPassphrase).toBe(true);
    // The config object never carries the passphrase (encrypted or plain).
    expect(JSON.stringify(cfg)).not.toContain('correct horse');
  });

  it('the stored passphrase decrypts back to the original', async () => {
    await setSetting('backup_scheduled_passphrase', encrypt('my-passphrase-123'));
    const raw = (await import('./admin.service.js')).getSetting;
    const stored = await raw('backup_scheduled_passphrase');
    expect(stored).toBeTruthy();
    expect(decrypt(stored!)).toBe('my-passphrase-123');
  });
});
