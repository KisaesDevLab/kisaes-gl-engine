// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Streamed, per-file-encrypted tenant export container (.vmx format v2).
//
// A package is a plain ZIP with three kinds of entries:
//   - manifest.json         plaintext: { format, version, kdf:{salt}, ...meta }
//   - data.json.enc         the ledger payload (no attachment binaries), encrypted
//   - attachments/<id>.enc  one entry per attachment file, each encrypted
//
// One AES-256 key is derived from the passphrase + the manifest salt, and each
// entry is encrypted independently (own IV) via portable-encryption's
// encryptEntry/decryptEntry. Attachments are written and read one file at a
// time so a multi-GB export never holds everything in memory and never
// base64-inflates into a single JSON string (the old design's crash).

import fs from 'fs';
import crypto from 'crypto';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import {
  PACKAGE_SALT_LENGTH,
  derivePackageKey,
  encryptEntry,
  decryptEntry,
} from './portable-encryption.service.js';

export const PACKAGE_FORMAT_VERSION = 2;

export interface PackageAttachment {
  id: string;
  buffer: Buffer;
}

export interface WritePackageResult {
  size: number;
  attachmentCount: number;
}

/**
 * Write a v2 package to `filePath`. `data` is JSON-serialized and encrypted as
 * a single entry; `attachments` is consumed lazily (one file at a time) so the
 * caller can read/download each source only when it's about to be written.
 */
export async function writeTenantPackage(
  filePath: string,
  passphrase: string,
  data: unknown,
  attachments: AsyncIterable<PackageAttachment>,
  manifestMeta: Record<string, unknown> = {},
): Promise<WritePackageResult> {
  const salt = crypto.randomBytes(PACKAGE_SALT_LENGTH);
  const key = derivePackageKey(passphrase, salt);

  const output = fs.createWriteStream(filePath);
  const archive = archiver('zip', { store: true }); // already-encrypted bytes don't compress

  const done = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (w) => { if (w.code !== 'ENOENT') reject(w); });
  });
  archive.pipe(output);

  const manifest = {
    format: 'vmx',
    version: PACKAGE_FORMAT_VERSION,
    kdf: { algo: 'pbkdf2-sha512-aes256gcm', salt: salt.toString('hex') },
    ...manifestMeta,
  };
  archive.append(Buffer.from(JSON.stringify(manifest)), { name: 'manifest.json' });
  archive.append(encryptEntry(key, Buffer.from(JSON.stringify(data))), { name: 'data.json.enc' });

  let attachmentCount = 0;
  for await (const att of attachments) {
    archive.append(encryptEntry(key, att.buffer), { name: `attachments/${att.id}.enc` });
    attachmentCount += 1;
  }

  await archive.finalize();
  await done;
  const size = fs.statSync(filePath).size;
  return { size, attachmentCount };
}

export interface OpenedPackage {
  manifest: Record<string, unknown>;
  data: unknown;
  attachmentIds: string[];
  /** Lazily decrypt each attachment, one at a time. */
  attachments(): AsyncGenerator<PackageAttachment>;
}

/** ZIP local-file-header magic — distinguishes a v2 package from a v1 blob. */
export function isPackageFormat(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * Open a v2 package for reading. The manifest and data payload are decrypted
 * eagerly (data has no binaries, so it's small); attachments are decrypted
 * lazily via the returned generator.
 */
export async function readTenantPackage(source: string | Buffer, passphrase: string): Promise<OpenedPackage> {
  const directory = typeof source === 'string'
    ? await unzipper.Open.file(source)
    : await unzipper.Open.buffer(source);

  const find = (name: string) => directory.files.find((f) => f.path === name);

  const manifestFile = find('manifest.json');
  if (!manifestFile) throw new Error('Not a Vibe MyBooks package (manifest.json missing)');
  const manifest = JSON.parse((await manifestFile.buffer()).toString('utf8')) as Record<string, unknown>;
  const kdf = manifest['kdf'] as { salt?: string } | undefined;
  const saltHex = kdf?.salt ?? '';
  if (!saltHex) throw new Error('Package manifest is missing its encryption salt');
  const key = derivePackageKey(passphrase, Buffer.from(saltHex, 'hex'));

  const dataFile = find('data.json.enc');
  if (!dataFile) throw new Error('Package is missing its data payload');
  let dataBuf: Buffer;
  try {
    dataBuf = decryptEntry(key, await dataFile.buffer());
  } catch {
    throw new Error('Incorrect passphrase or corrupted package');
  }
  const data = JSON.parse(dataBuf.toString('utf8'));

  const attachmentEntries = directory.files.filter(
    (f) => f.path.startsWith('attachments/') && f.path.endsWith('.enc'),
  );
  const attachmentIds = attachmentEntries.map((f) => f.path.slice('attachments/'.length, -'.enc'.length));

  async function* attachments(): AsyncGenerator<PackageAttachment> {
    for (const f of attachmentEntries) {
      const id = f.path.slice('attachments/'.length, -'.enc'.length);
      const buffer = decryptEntry(key, await f.buffer());
      yield { id, buffer };
    }
  }

  return { manifest, data, attachmentIds, attachments };
}
