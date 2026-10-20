// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// File resolvers (U-05 rule 7): each resolver round-trips bytes, path
// containment is enforced, logos get unique names.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptBuffer, decryptBuffer } from '../../utils/encryption.js';
import type { StorageProvider } from '../storage/storage-provider.interface.js';
import { resolveForExport, resolveForImport, containedPath } from './files.js';
import { FILE_COLUMNS } from './plan.js';
import { ArchiveError } from './errors.js';

const NEW_TENANT = '3b1d2f40-1111-4222-8333-444444444444';
const OLD_TENANT = '9a9a9a9a-1111-4222-8333-444444444444';
let uploadDir = '';

/** In-memory provider standing in for the tenant's storage provider. */
function memoryProvider(): StorageProvider & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    name: 'memory',
    requiresOAuth: false,
    files,
    async upload(key, data) {
      files.set(key, Buffer.from(data));
      return { key, sizeBytes: data.length };
    },
    async download(key) {
      const b = files.get(key);
      if (!b) throw new Error(`File not found: ${key}`);
      return b;
    },
    async delete(key) {
      files.delete(key);
    },
    async exists(key) {
      return files.has(key);
    },
    async getTemporaryUrl() {
      return null;
    },
    async checkHealth() {
      return { status: 'healthy', latencyMs: 0 };
    },
    async getUsage() {
      return { usedBytes: 0, totalBytes: null };
    },
  };
}

beforeAll(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-files-test-'));
});

afterAll(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

async function readBundle(r: ReturnType<typeof resolveForExport>): Promise<Buffer> {
  expect(r.kind).toBe('bundle');
  return r.read!();
}

describe('provider-key', () => {
  it('reads by key, writes a new tenant-rooted key and mirrors the /uploads path', async () => {
    const src = memoryProvider();
    const dst = memoryProvider();
    const bytes = crypto.randomBytes(1000);
    const oldKey = `${OLD_TENANT}/attachments/abc.pdf`;
    src.files.set(oldKey, bytes);
    const rule = FILE_COLUMNS['attachments.storage_key']!;
    const read = resolveForExport(rule, { uploadDir, provider: async () => src }, oldKey, { file_path: `/uploads/${oldKey}` });
    expect((await readBundle(read)).equals(bytes)).toBe(true);
    const rowId = crypto.randomUUID();
    const target = resolveForImport(rule, { uploadDir, provider: async () => dst }, NEW_TENANT, rowId, oldKey, true);
    expect(target.value).toBe(`${NEW_TENANT}/attachments/${rowId}.pdf`);
    await target.write!(bytes);
    expect(dst.files.get(target.value!)!.equals(bytes)).toBe(true);
    const mirror = resolveForImport(FILE_COLUMNS['attachments.file_path']!, { uploadDir }, NEW_TENANT, rowId, `/uploads/${oldKey}`, false, { storage_key: target.value });
    expect(mirror.value).toBe(`/uploads/${target.value}`);
  });

  it('falls back to the legacy /uploads path when the key is NULL, and treats http keys as external', async () => {
    const src = memoryProvider();
    const legacy = `${OLD_TENANT}/attachments/legacy.txt`;
    fs.mkdirSync(path.join(uploadDir, OLD_TENANT, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, legacy), 'legacy bytes');
    const rule = FILE_COLUMNS['attachments.storage_key']!;
    const read = resolveForExport(rule, { uploadDir, provider: async () => src }, null, { file_path: `/uploads/${legacy}` });
    expect((await readBundle(read)).toString()).toBe('legacy bytes');
    expect(resolveForExport(rule, { uploadDir }, 'https://drive.example/x', {}).kind).toBe('external');
    expect(resolveForExport(rule, { uploadDir }, null, { file_path: null }).kind).toBe('none');
    // A legacy path escaping the upload dir is refused.
    const bad = resolveForExport(rule, { uploadDir, provider: async () => src }, null, { file_path: '/uploads/../../etc/passwd' });
    await expect(bad.read!()).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe('upload-encrypted (check signatures)', () => {
  it('decrypts on export, checks the recorded sha256, and re-encrypts on import under this install key', async () => {
    const image = crypto.randomBytes(512);
    const rel = path.join('signatures', OLD_TENANT, 'sig-1234.enc');
    fs.mkdirSync(path.join(uploadDir, 'signatures', OLD_TENANT), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, rel), encryptBuffer(image));
    const rule = FILE_COLUMNS['check_signatures.file_path']!;
    const sha = crypto.createHash('sha256').update(image).digest('hex');
    const read = resolveForExport(rule, { uploadDir }, rel, { sha256: sha });
    expect((await readBundle(read)).equals(image)).toBe(true);
    const bad = resolveForExport(rule, { uploadDir }, rel, { sha256: 'f'.repeat(64) });
    await expect(bad.read!()).rejects.toMatchObject({ code: 'FILE_SIZE_MISMATCH' });
    const rowId = crypto.randomUUID();
    const target = resolveForImport(rule, { uploadDir }, NEW_TENANT, rowId, rel, true);
    expect(target.value).toBe(path.join('signatures', NEW_TENANT, `${rowId}.enc`));
    await target.write!(image);
    expect(decryptBuffer(fs.readFileSync(target.localPath!, 'utf8')).equals(image)).toBe(true);
  });
});

describe('upload-relative (payroll files)', () => {
  it('reads an absolute path inside UPLOAD_DIR and writes under payroll/<tenant>/', async () => {
    const bytes = Buffer.from('a,b,c\n1,2,3\n');
    fs.mkdirSync(path.join(uploadDir, 'payroll'), { recursive: true });
    const abs = path.join(uploadDir, 'payroll', 'x.csv');
    fs.writeFileSync(abs, bytes);
    const rule = FILE_COLUMNS['payroll_import_sessions.file_path']!;
    expect((await readBundle(resolveForExport(rule, { uploadDir }, abs, {}))).equals(bytes)).toBe(true);
    const outside = path.join(os.tmpdir(), 'cl-files-outside.csv');
    fs.writeFileSync(outside, 'x');
    await expect(resolveForExport(rule, { uploadDir }, outside, {}).read!()).rejects.toMatchObject({ code: 'FILE_MISSING' });
    await expect(resolveForExport(rule, { uploadDir }, '../x.csv', {}).read!()).rejects.toMatchObject({ code: 'FILE_MISSING' });
    const rowId = crypto.randomUUID();
    const target = resolveForImport(rule, { uploadDir }, NEW_TENANT, rowId, abs, true);
    expect(target.value).toBe(path.join(path.resolve(uploadDir), 'payroll', NEW_TENANT, `${rowId}.csv`));
    await target.write!(bytes);
    expect(fs.readFileSync(target.value!).equals(bytes)).toBe(true);
    fs.rmSync(outside, { force: true });
  });
});

describe('logo-url', () => {
  it('bundles /uploads/logos/<name>, gives each import a unique name, and keeps external URLs', async () => {
    const png = crypto.randomBytes(64);
    fs.mkdirSync(path.join(uploadDir, 'logos'), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, 'logos', 'logo-a.png'), png);
    const rule = FILE_COLUMNS['companies.logo_url']!;
    expect((await readBundle(resolveForExport(rule, { uploadDir }, '/uploads/logos/logo-a.png', {}))).equals(png)).toBe(true);
    expect(resolveForExport(rule, { uploadDir }, 'https://cdn.example/logo.png', {}).kind).toBe('external');
    await expect(resolveForExport(rule, { uploadDir }, '/uploads/logos/../../secret', {}).read!()).rejects.toMatchObject({ code: 'FILE_MISSING' });
    const names = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const t = resolveForImport(rule, { uploadDir }, NEW_TENANT, crypto.randomUUID(), '/uploads/logos/logo-a.png', true);
      expect(t.value).toMatch(/^\/uploads\/logos\/[0-9a-f-]{36}\.png$/);
      await t.write!(png);
      names.add(t.value!);
    }
    expect(names.size).toBe(3);
    // The source logo is untouched.
    expect(fs.readFileSync(path.join(uploadDir, 'logos', 'logo-a.png')).equals(png)).toBe(true);
    expect(resolveForImport(rule, { uploadDir }, NEW_TENANT, crypto.randomUUID(), 'https://cdn.example/logo.png', false).value).toBe('https://cdn.example/logo.png');
  });
});

describe('H2: an archived value never reaches a local path column', () => {
  it('drops a non-bundled value for every local resolver, with a tenant-rooted placeholder', () => {
    const rowId = crypto.randomUUID();
    const cases: Array<[string, string]> = [
      ['check_signatures.file_path', '../../etc/passwd'],
      ['check_signatures.file_path', `signatures/${OLD_TENANT}/x.enc`],
      ['payroll_import_sessions.file_path', '/etc/passwd'],
      ['payroll_import_sessions.companion_file_path', `${uploadDir}/payroll/x.csv`],
      ['companies.logo_url', '/uploads/logos/../../x'],
      ['companies.logo_url', '/uploads/logos/legit.png'],
      ['attachments.storage_key', `${OLD_TENANT}/attachments/a.pdf`],
      ['attachments.storage_key', '../../../etc/passwd'],
    ];
    for (const [col, value] of cases) {
      const t = resolveForImport(FILE_COLUMNS[col]!, { uploadDir }, NEW_TENANT, rowId, value, false);
      expect(t.value, `${col} ${value}`).toBeNull();
      expect(t.nulled, `${col} ${value}`).toBe(true);
      expect(t.write).toBeUndefined();
      // Logos live in the shared logos/ folder; every other placeholder sits in the new tenant's folder.
      if (col !== 'companies.logo_url') expect(t.placeholder, `${col} ${value}`).toContain(NEW_TENANT);
      else expect(t.placeholder, `${col} ${value}`).toMatch(/^\/uploads\/logos\/[0-9a-f-]{36}\.missing$/);
      expect(t.placeholder, `${col} ${value}`).toContain(rowId);
      expect(t.placeholder, `${col} ${value}`).not.toContain('..');
    }
    // A NULL archived value is simply NULL (not a dropped value).
    const n = resolveForImport(FILE_COLUMNS['check_signatures.file_path']!, { uploadDir }, NEW_TENANT, rowId, null, false);
    expect(n.value).toBeNull();
    expect(n.nulled).toBeFalsy();
  });

  it('derives the attachments path mirror from the new key only, never from the archived path', () => {
    const rowId = crypto.randomUUID();
    const rule = FILE_COLUMNS['attachments.file_path']!;
    const withKey = resolveForImport(rule, { uploadDir }, NEW_TENANT, rowId, '/uploads/../../etc/passwd', false, { storage_key: `${NEW_TENANT}/attachments/${rowId}.pdf` });
    expect(withKey.value).toBe(`/uploads/${NEW_TENANT}/attachments/${rowId}.pdf`);
    const noKey = resolveForImport(rule, { uploadDir }, NEW_TENANT, rowId, '/uploads/../../etc/passwd', false, { storage_key: null });
    expect(noKey.value).toBeNull();
    expect(noKey.nulled).toBe(true);
    expect(noKey.placeholder).toBe(`/uploads/${NEW_TENANT}/attachments/${rowId}.missing`);
  });
});

describe('null, external, not-a-file and containment', () => {
  it('nulls cache columns and keeps opaque values', () => {
    expect(resolveForImport(FILE_COLUMNS['attachments.local_cache_path']!, { uploadDir }, NEW_TENANT, crypto.randomUUID(), '/tmp/x', false).value).toBeNull();
    expect(resolveForImport(FILE_COLUMNS['vendor_enrichment_cache.source_url']!, { uploadDir }, NEW_TENANT, crypto.randomUUID(), 'https://x', false).value).toBe('https://x');
    expect(resolveForExport(FILE_COLUMNS['report_pack_runs.transient_key']!, { uploadDir }, 'k', {}).kind).toBe('none');
  });

  it('containedPath refuses escapes, NUL bytes and directories', () => {
    fs.mkdirSync(path.join(uploadDir, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, 'ok.txt'), 'ok');
    expect(containedPath(uploadDir, 'ok.txt')).toBe(fs.realpathSync(path.join(uploadDir, 'ok.txt')));
    for (const bad of ['../ok.txt', path.join(os.tmpdir(), 'cl-files-outside.csv'), 'dir', 'nope.txt', 'ok\0.txt']) {
      expect(() => containedPath(uploadDir, bad), bad).toThrow(ArchiveError);
    }
  });
});
