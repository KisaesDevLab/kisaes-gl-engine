// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import {
  writeTenantPackage,
  writeTenantPackageMulti,
  readTenantPackage,
  readTenantPackageMulti,
  openAndVerifyPart,
  type PackageAttachment,
} from './vmx-package.js';

const PASS = 'correct horse battery staple 42';
// Small budget so modest fixtures force multiple parts AND segmentation.
const PART_MAX = 1024 * 1024; // 1 MiB (writer-enforced minimum)

let dir: string;

function att(id: string, bytes: number): PackageAttachment {
  // Deterministic-ish content, unique per id, incompressible.
  return { id, buffer: crypto.randomBytes(bytes) };
}

async function* gen(list: PackageAttachment[]): AsyncGenerator<PackageAttachment> {
  for (const a of list) yield a;
}

const DATA = {
  metadata: { backup_type: 'system', format: 'kis-books-system-v1' },
  tenants: [{ id: 't1', name: 'Firm', slug: 'firm' }],
  rows: Array.from({ length: 500 }, (_, i) => ({ i, memo: `row ${i}` })),
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmx-multi-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Rewrite one part ZIP applying an entry-level mutation (rename/drop/replace). */
async function mutatePart(
  srcPath: string,
  mutate: (name: string, buf: Buffer) => Array<{ name: string; buf: Buffer }> | null,
): Promise<string> {
  const directory = await unzipper.Open.file(srcPath);
  const outPath = srcPath + '.mut';
  const output = fs.createWriteStream(outPath);
  const archive = archiver('zip', { store: true });
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    archive.on('error', reject);
  });
  archive.pipe(output);
  for (const f of directory.files) {
    const buf = await f.buffer();
    const result = mutate(f.path, buf);
    if (result === null) continue; // drop entry
    for (const r of result) archive.append(r.buf, { name: r.name });
  }
  await archive.finalize();
  await done;
  return outPath;
}

describe('multi-part vmx: round trip', () => {
  it('splits into multiple parts, segments oversized entries, and restores byte-identical', async () => {
    const attachments = [
      att('a-small', 10 * 1024),
      att('b-oversized', Math.floor(2.4 * PART_MAX)), // forces segmentation
      att('c-medium', 400 * 1024),
      att('d-medium', 500 * 1024),
      att('e-small', 5 * 1024),
    ];
    const byId = new Map(attachments.map((a) => [a.id, a.buffer]));

    const result = await writeTenantPackageMulti({
      outDir: dir,
      baseName: 'roundtrip',
      passphrase: PASS,
      data: DATA,
      attachments: gen(attachments),
      partMaxBytes: PART_MAX,
    });

    expect(result.partCount).toBeGreaterThanOrEqual(3);
    expect(result.files).toHaveLength(result.partCount);
    expect(result.attachmentCount).toBe(attachments.length);
    for (const f of result.files) {
      // Every part respects the budget (small slack for ZIP framing).
      expect(f.size).toBeLessThanOrEqual(PART_MAX + 64 * 1024);
      expect(f.fileName).toMatch(/^roundtrip\.part\d+of\d+\.vmx$/);
    }

    const pkg = await readTenantPackageMulti(result.files.map((f) => f.path), PASS);
    expect(pkg.partCount).toBe(result.partCount);
    expect(pkg.data).toEqual(DATA);
    expect(new Set(pkg.attachmentIds)).toEqual(new Set(byId.keys()));

    const seen = new Map<string, Buffer>();
    for await (const a of pkg.attachments()) seen.set(a.id, a.buffer);
    expect(seen.size).toBe(attachments.length);
    for (const [id, original] of byId) {
      expect(seen.get(id)!.equals(original), `attachment ${id} restored byte-identical`).toBe(true);
    }
  });

  it('produces a single classic-readable .vmx when everything fits one part', async () => {
    const result = await writeTenantPackageMulti({
      outDir: dir,
      baseName: 'single',
      passphrase: PASS,
      data: DATA,
      attachments: gen([att('only', 2048)]),
      partMaxBytes: 64 * 1024 * 1024,
    });
    expect(result.partCount).toBe(1);
    expect(result.files[0]!.fileName).toBe('single.vmx');

    // New single-part file remains readable by the CLASSIC reader.
    const classic = await readTenantPackage(result.files[0]!.path, PASS);
    expect(classic.data).toEqual(DATA);

    // And by the multi reader.
    const multi = await readTenantPackageMulti([result.files[0]!.path], PASS);
    expect(multi.data).toEqual(DATA);
  });

  it('reads a legacy single-file package via classic fallback', async () => {
    const legacyPath = path.join(dir, 'legacy.vmx');
    await writeTenantPackage(legacyPath, PASS, DATA, gen([att('x', 1000)]));
    const pkg = await readTenantPackageMulti([legacyPath], PASS);
    expect(pkg.partCount).toBe(1);
    expect(pkg.backupId).toBeNull();
    expect(pkg.data).toEqual(DATA);
    const got: string[] = [];
    for await (const a of pkg.attachments()) got.push(a.id);
    expect(got).toEqual(['x']);
  });
});

describe('multi-part vmx: failure detection (nothing silently lost)', () => {
  let files: Array<{ fileName: string; path: string; partIndex: number }>;

  beforeAll(async () => {
    const result = await writeTenantPackageMulti({
      outDir: dir,
      baseName: 'tamper',
      passphrase: PASS,
      data: DATA,
      attachments: gen([att('t1', 600 * 1024), att('t2', 600 * 1024), att('t3', Math.floor(1.5 * PART_MAX))]),
      partMaxBytes: PART_MAX,
    });
    expect(result.partCount).toBeGreaterThanOrEqual(3);
    files = result.files;
  });

  it('rejects a wrong passphrase with a clear error', async () => {
    await expect(readTenantPackageMulti(files.map((f) => f.path), 'wrong-passphrase-entirely'))
      .rejects.toThrow(/passphrase|corrupted/i);
  });

  it('refuses to restore when a middle part is missing', async () => {
    const subset = files.filter((f) => f.partIndex !== 2).map((f) => f.path);
    await expect(readTenantPackageMulti(subset, PASS)).rejects.toThrow(/Missing part\(s\) 2/);
  });

  it('refuses to restore when the final (series-bearing) part is missing', async () => {
    const subset = files.slice(0, -1).map((f) => f.path);
    await expect(readTenantPackageMulti(subset, PASS)).rejects.toThrow(/final part|series/i);
  });

  it('rejects a duplicated part', async () => {
    const dup = [...files.map((f) => f.path), files[0]!.path];
    await expect(readTenantPackageMulti(dup, PASS)).rejects.toThrow(/Duplicate part/);
  });

  it('rejects mixing parts from two different backups', async () => {
    const other = await writeTenantPackageMulti({
      outDir: dir,
      baseName: 'other',
      passphrase: PASS,
      data: DATA,
      attachments: gen([att('o1', 600 * 1024), att('o2', 900 * 1024)]),
      partMaxBytes: PART_MAX,
    });
    const mixed = [other.files[0]!.path, ...files.slice(1).map((f) => f.path)];
    await expect(readTenantPackageMulti(mixed, PASS)).rejects.toThrow(/different backups|backupId/i);
  });

  it('detects segment ciphertexts swapped across parts (ordering attack)', async () => {
    // Segments of one oversized attachment land in different parts by
    // construction (each segment nearly fills a part). The reordering attack
    // is therefore cross-part: keep each part's entry NAMES intact (so the
    // name-set check passes) but exchange the segment CIPHERTEXTS between
    // two parts. The per-part inventory binds name → sha256, so the swap
    // must be caught when the segment is consumed.
    const segLocations: Array<{ file: string; name: string; buf: Buffer }> = [];
    for (const f of files) {
      const d = await unzipper.Open.file(f.path);
      for (const entry of d.files) {
        if (/attachments\/t3\.seg\d+of\d+\.enc/.test(entry.path)) {
          segLocations.push({ file: f.path, name: entry.path, buf: await entry.buffer() });
        }
      }
    }
    expect(segLocations.length).toBeGreaterThanOrEqual(2);
    const [s1, s2] = segLocations as [typeof segLocations[0], typeof segLocations[0]];
    expect(s1.file).not.toBe(s2.file);

    const mutA = await mutatePart(s1.file, (name, buf) =>
      name === s1.name ? [{ name, buf: s2.buf }] : [{ name, buf }]);
    const mutB = await mutatePart(s2.file, (name, buf) =>
      name === s2.name ? [{ name, buf: s1.buf }] : [{ name, buf }]);
    const paths = files.map((f) => (f.path === s1.file ? mutA : f.path === s2.file ? mutB : f.path));

    const pkg = await readTenantPackageMulti(paths, PASS).catch((e) => e);
    if (pkg instanceof Error) {
      expect(pkg.message).toMatch(/inventory|tampered|corrupted/i);
    } else {
      await expect((async () => { for await (const a of pkg.attachments()) void a; })())
        .rejects.toThrow(/inventory|tampered|corrupted/i);
    }
  });

  it('detects an injected entry not present in the inventory', async () => {
    const injected = await mutatePart(files[0]!.path, (name, buf) => {
      if (name === 'manifest.json') {
        return [{ name, buf }, { name: 'attachments/evil.enc', buf: crypto.randomBytes(64) }];
      }
      return [{ name, buf }];
    });
    const paths = files.map((f, i) => (i === 0 ? injected : f.path));
    await expect(readTenantPackageMulti(paths, PASS)).rejects.toThrow(/not in inventory/);
  });

  it('detects a dropped entry that the inventory promises', async () => {
    // Drop the first attachment-ish entry from part 1.
    const d = await unzipper.Open.file(files[0]!.path);
    const victim = d.files.map((x) => x.path).find((n) => n.startsWith('attachments/'))!;
    const dropped = await mutatePart(files[0]!.path, (name, buf) => (name === victim ? null : [{ name, buf }]));
    const paths = files.map((f, i) => (i === 0 ? dropped : f.path));
    await expect(readTenantPackageMulti(paths, PASS)).rejects.toThrow(/missing from file/);
  });

  it('detects corrupted entry bytes', async () => {
    const d = await unzipper.Open.file(files[1]!.path);
    const victim = d.files.map((x) => x.path).find((n) => n.startsWith('attachments/'))!;
    const corrupted = await mutatePart(files[1]!.path, (name, buf) => {
      if (name === victim) {
        const b = Buffer.from(buf);
        b[b.length - 1] = b[b.length - 1]! ^ 0xff;
        return [{ name, buf: b }];
      }
      return [{ name, buf }];
    });
    const paths = files.map((f, i) => (i === 1 ? corrupted : f.path));
    const pkg = await readTenantPackageMulti(paths, PASS).catch((e) => e);
    if (pkg instanceof Error) {
      expect(pkg.message).toMatch(/inventory|tampered|corrupted/i);
    } else {
      await expect((async () => { for await (const a of pkg.attachments()) void a; })())
        .rejects.toThrow(/inventory|tampered|corrupted/i);
    }
  });

  it('openAndVerifyPart validates an individual part and reports series presence', async () => {
    const first = await openAndVerifyPart(files[0]!.path, PASS);
    expect(first.multipart).not.toBeNull();
    expect(first.multipart!.partIndex).toBe(1);
    expect(first.hasSeries).toBe(false);
    const last = await openAndVerifyPart(files[files.length - 1]!.path, PASS);
    expect(last.hasSeries).toBe(true);
    expect((last.series as { partCount: number }).partCount).toBe(files.length);
    await expect(openAndVerifyPart(files[0]!.path, 'nope')).rejects.toThrow(/passphrase|corrupted/i);
  });
});
