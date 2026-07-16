// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Local mirror directory: each backup is copied to an extra local path (an
// external drive bind-mounted into the container), and retention prunes it
// alongside BACKUP_DIR. BACKUP_DIR is captured at module load, so set it
// before importing the service.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let backupDir = '';
let mirrorDir = '';
let svc: typeof import('./backup.service.js');
let admin: typeof import('./admin.service.js');

beforeAll(async () => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-bk-'));
  mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-mirror-'));
  process.env['BACKUP_DIR'] = backupDir;
  svc = await import('./backup.service.js');
  admin = await import('./admin.service.js');
});

afterEach(async () => {
  await admin.setSetting('backup_local_mirror_dir', '');
  for (const d of [backupDir, mirrorDir]) {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d) : []) fs.rmSync(path.join(d, e), { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const d of [backupDir, mirrorDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function writeBackup(base: string, tenant: string, name: string, bytes = 'x'): string {
  const dir = path.join(base, tenant);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('mirrorBackupFiles', () => {
  it('copies a backup to the mirror dir preserving its path relative to BACKUP_DIR', async () => {
    await admin.setSetting('backup_local_mirror_dir', mirrorDir);
    const src = writeBackup(backupDir, '_system', 'kis-books-backup-2026-01-01T00-00-00-000Z.vmb', 'dr-bytes');
    await svc.mirrorBackupFiles([src]);
    const mirrored = path.join(mirrorDir, '_system', 'kis-books-backup-2026-01-01T00-00-00-000Z.vmb');
    expect(fs.existsSync(mirrored)).toBe(true);
    expect(fs.readFileSync(mirrored, 'utf8')).toBe('dr-bytes');
  });

  it('is a no-op when no mirror dir is configured', async () => {
    const src = writeBackup(backupDir, '_system', 'kis-books-backup-2026-01-02T00-00-00-000Z.vmb');
    await svc.mirrorBackupFiles([src]); // mirror unset — must not throw or create anything
    expect(fs.readdirSync(mirrorDir)).toHaveLength(0);
  });

  it('never throws and skips paths outside BACKUP_DIR', async () => {
    await admin.setSetting('backup_local_mirror_dir', mirrorDir);
    await expect(svc.mirrorBackupFiles(['/etc/hostname'])).resolves.toBeUndefined();
    expect(fs.readdirSync(mirrorDir)).toHaveLength(0);
  });
});

describe('purgeExpiredLocalBackups', () => {
  it('prunes aged files in BACKUP_DIR but NEVER touches the archival mirror', async () => {
    await admin.setSetting('backup_local_mirror_dir', mirrorDir);
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
    const a = writeBackup(backupDir, '_system', 'kis-books-backup-old-a.vmb');
    const mirrored = writeBackup(mirrorDir, '_system', 'kis-books-backup-old-b.vmb');
    const fresh = writeBackup(backupDir, '_system', 'kis-books-backup-fresh.vmb');
    fs.utimesSync(a, new Date(old), new Date(old));
    fs.utimesSync(mirrored, new Date(old), new Date(old));

    const deleted = await svc.purgeExpiredLocalBackups(30);
    // Only the app-owned BACKUP_DIR is pruned; the external/durable mirror is
    // the operator's to manage and must never be auto-deleted.
    expect(deleted).toBe(1);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(mirrored)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('honors an absolute mirror path only (relative paths are ignored)', async () => {
    await admin.setSetting('backup_local_mirror_dir', 'relative-mirror');
    const src = writeBackup(backupDir, '_system', 'kis-books-backup-rel.vmb', 'x');
    await svc.mirrorBackupFiles([src]); // relative dir → no-op, must not throw or write to cwd
    expect(fs.existsSync(path.join(process.cwd(), 'relative-mirror'))).toBe(false);
  });
});
