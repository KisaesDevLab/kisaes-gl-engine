// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// readSystemBackup streams a just-created _system backup for the one-click DR
// bundle. It must read only from BACKUP_DIR/_system, reject unsafe names, and
// 404 a missing file. BACKUP_DIR is captured at module load, so set it before
// importing the service.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmp = '';
let svc: typeof import('./backup.service.js');

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-drbundle-'));
  process.env['BACKUP_DIR'] = tmp;
  svc = await import('./backup.service.js');
});

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('readSystemBackup', () => {
  it('reads a backup from the _system directory', async () => {
    const dir = path.join(tmp, '_system');
    fs.mkdirSync(dir, { recursive: true });
    const name = 'kis-books-backup-2026-01-02T00-00-00-000Z.vmb';
    fs.writeFileSync(path.join(dir, name), Buffer.from('encrypted-dr-bytes'));
    const buf = await svc.readSystemBackup(name);
    expect(buf.toString()).toBe('encrypted-dr-bytes');
  });

  it('rejects a path-traversal file name', async () => {
    await expect(svc.readSystemBackup('../../etc/passwd')).rejects.toThrow(/invalid backup file name/i);
  });

  it('404s a missing (but well-formed) file name', async () => {
    await expect(svc.readSystemBackup('kis-books-backup-nope.vmb')).rejects.toThrow(/not found/i);
  });

  it('accepts .vmx (attachments-included) package names and resolves their path', () => {
    const dir = path.join(tmp, '_system');
    fs.mkdirSync(dir, { recursive: true });
    const name = 'kis-books-backup-2026-02-03T00-00-00-000Z.vmx';
    fs.writeFileSync(path.join(dir, name), Buffer.from('PK\x03\x04zip-bytes'));
    const resolved = svc.resolveSystemBackupPath(name);
    expect(resolved).toBe(path.resolve(path.join(dir, name)));
  });

  it('resolveSystemBackupPath rejects traversal and 404s missing files', () => {
    expect(() => svc.resolveSystemBackupPath('../../etc/passwd')).toThrow(/invalid backup file name/i);
    expect(() => svc.resolveSystemBackupPath('kis-books-backup-missing.vmx')).toThrow(/not found/i);
  });
});
