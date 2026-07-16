// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Local-disk / mounted-drive restore discovery: bundle scanning + grouping
// of multi-part series + the anti-traversal path guard. RESTORE_LOCAL_ROOTS
// captures BACKUP_DIR/BACKUP_MIRROR_DIR at module load, so set them first.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let backups = '';
let drive = '';
let mod: typeof import('./setup.routes.js');

beforeAll(async () => {
  backups = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-bk-'));
  drive = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-drive-'));
  process.env['BACKUP_DIR'] = backups;
  process.env['BACKUP_MIRROR_DIR'] = drive;
  mod = await import('./setup.routes.js');
});

afterAll(() => {
  for (const d of [backups, drive]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function put(base: string, sub: string, name: string, bytes = 'x'): string {
  const dir = path.join(base, sub);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('scanLocalBundles', () => {
  it('lists single .vmb/.vmx bundles', () => {
    put(backups, '_system', 'kis-books-backup-2026-01-01.vmb');
    put(backups, 'tenant-a', 'kis-books-backup-2026-01-02.vmx');
    const found = mod.scanLocalBundles('backups', backups);
    const labels = found.map((b) => b.label).sort();
    expect(labels).toContain('kis-books-backup-2026-01-01.vmb');
    expect(labels).toContain('kis-books-backup-2026-01-02.vmx');
    expect(found.every((b) => b.kind === 'single' && b.partCount === 1)).toBe(true);
  });

  it('groups a COMPLETE multi-part series into one part-ordered bundle', () => {
    put(drive, '_system', 'kis-books-backup-x.part02of03.vmx');
    put(drive, '_system', 'kis-books-backup-x.part01of03.vmx');
    put(drive, '_system', 'kis-books-backup-x.part03of03.vmx');
    const found = mod.scanLocalBundles('drive', drive);
    const multi = found.find((b) => b.kind === 'multipart');
    expect(multi).toBeDefined();
    expect(multi!.partCount).toBe(3);
    expect(multi!.files).toHaveLength(3);
    // Files are part-ordered 1,2,3.
    expect(multi!.files.map((f) => path.basename(f))).toEqual([
      'kis-books-backup-x.part01of03.vmx',
      'kis-books-backup-x.part02of03.vmx',
      'kis-books-backup-x.part03of03.vmx',
    ]);
  });

  it('excludes an INCOMPLETE multi-part series (a missing part is unrestorable)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-incomplete-'));
    put(d, '_system', 'kis-books-backup-y.part01of03.vmx');
    put(d, '_system', 'kis-books-backup-y.part03of03.vmx'); // part 2 missing
    const found = mod.scanLocalBundles('drive', d);
    expect(found.find((b) => b.kind === 'multipart')).toBeUndefined();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('returns [] for a non-existent root', () => {
    expect(mod.scanLocalBundles('drive', '/nonexistent/path/xyz')).toEqual([]);
  });
});

describe('assertPathsWithinRoots (anti-traversal)', () => {
  it('accepts real paths inside the allowed roots', () => {
    const a = put(backups, '_system', 'guard-a.vmb');
    const b = put(drive, '_system', 'guard-b.vmx');
    expect(() => mod.assertPathsWithinRoots([a])).not.toThrow();
    expect(() => mod.assertPathsWithinRoots([b])).not.toThrow();
  });

  it('rejects paths outside the roots (traversal / arbitrary files)', () => {
    expect(() => mod.assertPathsWithinRoots(['/etc/passwd'])).toThrow(/outside the allowed|does not exist/i);
    expect(() => mod.assertPathsWithinRoots([path.join(backups, '..', '..', 'etc', 'passwd')])).toThrow(/outside the allowed|does not exist/i);
  });

  it('rejects a symlink whose TARGET escapes the root, but lists one whose target stays inside', () => {
    // Escaping symlink → not listed, and rejected by the path guard.
    const evil = path.join(backups, '_system', 'evil.vmb');
    fs.mkdirSync(path.dirname(evil), { recursive: true });
    try { fs.symlinkSync('/etc/hostname', evil); } catch { return; } // skip if symlink unsupported
    expect(() => mod.assertPathsWithinRoots([evil])).toThrow(/outside the allowed/i);
    expect(mod.scanLocalBundles('backups', backups).some((b) => b.label === 'evil.vmb')).toBe(false);
    fs.unlinkSync(evil);

    // Legit symlink whose target is a real bundle INSIDE the root → listed.
    const realTarget = put(backups, 'store', 'real-bundle.vmb');
    const good = path.join(backups, '_system', 'linked.vmb');
    fs.mkdirSync(path.dirname(good), { recursive: true });
    fs.symlinkSync(realTarget, good);
    expect(mod.scanLocalBundles('backups', backups).some((b) => b.label === 'linked.vmb')).toBe(true);
    expect(() => mod.assertPathsWithinRoots([good])).not.toThrow();
    fs.unlinkSync(good);
  });
});

describe('assertSafeEndpoint (SSRF guard)', () => {
  it('accepts normal cloud + LAN https endpoints and DNS names', () => {
    expect(() => mod.assertSafeEndpoint('https://s3.us-west-004.backblazeb2.com')).not.toThrow();
    expect(() => mod.assertSafeEndpoint('https://192.168.1.50:9000')).not.toThrow();       // LAN MinIO — allowed
    expect(() => mod.assertSafeEndpoint('https://10.storage.example.com')).not.toThrow();   // DNS starting with 10. — allowed
  });
  it('rejects http, loopback, and the cloud-metadata/link-local range', () => {
    expect(() => mod.assertSafeEndpoint('http://s3.us-west-004.backblazeb2.com')).toThrow(/https/i);
    expect(() => mod.assertSafeEndpoint('https://localhost:9000')).toThrow(/not allowed/i);
    expect(() => mod.assertSafeEndpoint('https://127.0.0.1:9000')).toThrow(/not allowed/i);
    expect(() => mod.assertSafeEndpoint('https://169.254.169.254/latest/meta-data')).toThrow(/not allowed/i);
    expect(() => mod.assertSafeEndpoint('not-a-url')).toThrow(/valid https/i);
  });

  it('blocks the metadata IP smuggled as IPv4-mapped IPv6 or a decimal/hex integer', () => {
    expect(() => mod.assertSafeEndpoint('https://[::ffff:169.254.169.254]/latest/meta-data')).toThrow(/not allowed/i);
    expect(() => mod.assertSafeEndpoint('https://[::1]:9000')).toThrow(/not allowed/i);
    expect(() => mod.assertSafeEndpoint('https://2852039166/')).toThrow(/not allowed/i);   // decimal 169.254.169.254
    expect(() => mod.assertSafeEndpoint('https://0xA9FEA9FE/')).toThrow(/not allowed/i);    // hex 169.254.169.254
  });
});

describe('scanLocalBundles symlink-directory safety', () => {
  it('does not infinitely recurse or crash on a directory symlink looping to an ancestor', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-loop-'));
    put(rootDir, '_system', 'kis-books-backup-real.vmb');
    // A directory symlink pointing back at the root (an rsync/snapshot shape).
    try { fs.symlinkSync(rootDir, path.join(rootDir, '_system', 'loop')); } catch { fs.rmSync(rootDir, { recursive: true, force: true }); return; }
    // Must return (not throw RangeError) and still find the real bundle once.
    let found: ReturnType<typeof mod.scanLocalBundles>;
    expect(() => { found = mod.scanLocalBundles('backups', rootDir); }).not.toThrow();
    expect(found!.filter((b) => b.label === 'kis-books-backup-real.vmb')).toHaveLength(1);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
