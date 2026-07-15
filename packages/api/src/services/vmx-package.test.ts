// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeTenantPackage, readTenantPackage, isPackageFormat, type PackageAttachment } from './vmx-package.js';

const tmpFiles: string[] = [];
function tmp(): string {
  const p = path.join(os.tmpdir(), `vmx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.vmx`);
  tmpFiles.push(p);
  return p;
}
afterEach(() => { for (const f of tmpFiles.splice(0)) { try { fs.unlinkSync(f); } catch { /* ignore */ } } });

async function* atts(items: PackageAttachment[]): AsyncGenerator<PackageAttachment> {
  for (const it of items) yield it;
}

describe('vmx-package v2 container', () => {
  const passphrase = 'a-very-strong-passphrase-123';
  const data = { company: { name: 'Acme' }, transactions: [{ id: 't1', amount: '100.0000' }], nested: { a: [1, 2, 3] } };
  const attachments: PackageAttachment[] = [
    { id: '11111111-1111-1111-1111-111111111111', buffer: Buffer.from('receipt-one-binary') },
    { id: '22222222-2222-2222-2222-222222222222', buffer: Buffer.from([0, 1, 2, 3, 255, 254]) },
  ];

  it('round-trips data and per-file-encrypted attachments', async () => {
    const file = tmp();
    const res = await writeTenantPackage(file, passphrase, data, atts(attachments), { companyName: 'Acme' });
    expect(res.attachmentCount).toBe(2);
    expect(res.size).toBeGreaterThan(0);

    // File is a real zip (PK magic).
    const head = fs.readFileSync(file).subarray(0, 4);
    expect(isPackageFormat(head)).toBe(true);

    const pkg = await readTenantPackage(file, passphrase);
    expect(pkg.manifest['version']).toBe(2);
    expect(pkg.manifest['companyName']).toBe('Acme');
    expect(pkg.data).toEqual(data);
    expect(pkg.attachmentIds.sort()).toEqual(attachments.map((a) => a.id).sort());

    const got: Record<string, Buffer> = {};
    for await (const a of pkg.attachments()) got[a.id] = a.buffer;
    for (const a of attachments) expect(got[a.id]!.equals(a.buffer)).toBe(true);
  });

  it('rejects a wrong passphrase', async () => {
    const file = tmp();
    await writeTenantPackage(file, passphrase, data, atts([]), {});
    await expect(readTenantPackage(file, 'wrong-passphrase-000')).rejects.toThrow(/passphrase|corrupt/i);
  });

  it('works with zero attachments', async () => {
    const file = tmp();
    const res = await writeTenantPackage(file, passphrase, data, atts([]), {});
    expect(res.attachmentCount).toBe(0);
    const pkg = await readTenantPackage(file, passphrase);
    expect(pkg.data).toEqual(data);
    expect(pkg.attachmentIds).toEqual([]);
  });

  it('aborts reading an entry that inflates past the size cap (deflate-bomb guard)', async () => {
    // A real DEFLATE bomb: a compressed zip whose data.json.enc entry
    // inflates far past the cap. archiver with default compression turns a
    // highly-repetitive buffer into a tiny stored size but a huge inflated
    // one — exactly the shape the central-directory size can't be trusted on.
    const archiver = (await import('archiver')).default;
    const file = tmp();
    const out = fs.createWriteStream(file);
    const archive = archiver('zip', { zlib: { level: 9 } }); // COMPRESSED, not stored
    archive.pipe(out);
    archive.append(Buffer.from(JSON.stringify({ format: 'vmx', version: 2, kdf: { salt: 'aa'.repeat(16) } })), { name: 'manifest.json' });
    // ~1.5 GB of zeros → a few KB compressed, well past MAX_PACKAGE_ENTRY_BYTES inflated.
    archive.append(Buffer.alloc(1536 * 1024 * 1024), { name: 'data.json.enc' });
    await archive.finalize();
    await new Promise((r) => out.on('close', r));

    await expect(readTenantPackage(file, passphrase)).rejects.toThrow(/exceeds the maximum allowed size/i);
  }, 60000);
});
