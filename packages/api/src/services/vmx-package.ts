// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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

// Hard ceiling on the inflated size of ANY single package entry. Legitimate
// entries are written with `store: true` (no compression), so this only
// trips on a crafted deflate bomb. The ZIP central directory's declared
// uncompressedSize is attacker-controlled and unzipper doesn't enforce it,
// so we bound the ACTUAL bytes read off the stream instead of trusting it.
export const MAX_PACKAGE_ENTRY_BYTES = 600 * 1024 * 1024;

export class PackageEntryTooLargeError extends Error {
  constructor(path: string) {
    super(`Package entry ${path} exceeds the maximum allowed size`);
    this.name = 'PackageEntryTooLargeError';
  }
}

// unzipper's File objects expose stream() at runtime, but @types/unzipper
// omits it — describe just what we use.
type UnzipperEntry = {
  path: string;
  uncompressedSize?: number;
  buffer: () => Promise<Buffer>;
  stream?: () => NodeJS.ReadableStream;
};

// Read a zip entry into a Buffer, aborting if the decompressed stream
// exceeds MAX_PACKAGE_ENTRY_BYTES — the only real defense against a deflate
// bomb (the declared size can lie; the byte count as we read cannot).
async function bufferEntryBounded(
  file: UnzipperEntry,
  maxBytes = MAX_PACKAGE_ENTRY_BYTES,
): Promise<Buffer> {
  // Fall back to buffer() only if a build ever lacks stream() (stream() is
  // undocumented in @types/unzipper). The declared uncompressedSize is
  // attacker-controlled so it's not a real bound, but on the fallback path
  // it's a cheap first gate; buffer() then throws if the actual bytes still
  // overflow. Fail closed — never buffer unbounded silently.
  if (typeof file.stream !== 'function') {
    if ((file.uncompressedSize ?? 0) > maxBytes) throw new PackageEntryTooLargeError(file.path);
    const buf = await file.buffer();
    if (buf.length > maxBytes) throw new PackageEntryTooLargeError(file.path);
    return buf;
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = file.stream!();
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        (stream as unknown as { destroy: (e?: Error) => void }).destroy();
        reject(new PackageEntryTooLargeError(file.path));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export interface PackageAttachment {
  id: string;
  buffer: Buffer;
  /** Set when this entry could not be decrypted/verified. The consumer records
   *  it and moves on instead of the whole iteration throwing — one corrupt
   *  attachment must never abort restoring the rest. `buffer` is empty then. */
  error?: string;
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
    // Fail LOUDLY at write time if an attachment exceeds what the reader can
    // load back (MAX_PACKAGE_ENTRY_BYTES) — otherwise this single-file
    // package would be silently unrestorable. Callers that can segment
    // (the multi-part writer) or pre-filter (createBackup's perEntryMaxBytes)
    // never hit this; it's a backstop for any other caller.
    if (att.buffer.length > MAX_PACKAGE_ENTRY_BYTES - ENTRY_CRYPTO_OVERHEAD) {
      output.destroy();
      throw new PackageEntryTooLargeError(`attachments/${att.id}.enc`);
    }
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
  const manifest = JSON.parse((await bufferEntryBounded(manifestFile)).toString('utf8')) as Record<string, unknown>;
  // Guard: a single-file read of a genuine MULTI-PART series (>1 part) would
  // restore only this one part's data, silently. Refuse it — the caller must
  // assemble the full series (readTenantPackageMulti / staged restore).
  //
  // The per-part manifest carries `multipart` (with partIndex) but NOT the
  // total partCount — that lives only in the encrypted `series.json.enc`,
  // which the writer appends to the FINAL/ONLY part. So the reliable,
  // passphrase-free distinguisher is series presence:
  //   • 1-of-1 (everything fit one part): marker + series present → complete,
  //     reads fine.
  //   • non-final part of N>1: marker present, series ABSENT → partial data;
  //     refuse it here.
  //   • final part of N>1: marker + series present but no data.json.enc (that
  //     lives in part 1) → falls through and fails naturally below.
  const mp = manifest['multipart'] as { partIndex?: number } | undefined;
  if (mp && !find('series.json.enc')) {
    throw new Error(
      `This is part ${mp.partIndex ?? '?'} of a multi-part backup — restore ALL parts together, not a single part.`,
    );
  }
  const kdf = manifest['kdf'] as { salt?: string } | undefined;
  const saltHex = kdf?.salt ?? '';
  if (!saltHex) throw new Error('Package manifest is missing its encryption salt');
  const key = derivePackageKey(passphrase, Buffer.from(saltHex, 'hex'));

  const dataFile = find('data.json.enc');
  if (!dataFile) throw new Error('Package is missing its data payload');
  let dataBuf: Buffer;
  try {
    dataBuf = decryptEntry(key, await bufferEntryBounded(dataFile));
  } catch (err) {
    if (err instanceof PackageEntryTooLargeError) throw err;
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
      // Yield a per-entry error marker instead of throwing: a single
      // undecryptable/corrupt attachment must not abort restoring the rest.
      try {
        const buffer = decryptEntry(key, await bufferEntryBounded(f));
        yield { id, buffer };
      } catch (err) {
        yield { id, buffer: Buffer.alloc(0), error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  return { manifest, data, attachmentIds, attachments };
}

// ─── Multi-part packages (vmx-multi v1) ─────────────────────────────
//
// A disaster-recovery bundle can exceed per-request upload ceilings between
// the operator and the appliance (Cloudflare proxies a body up to 100 MB on
// most plans). Instead of one monolithic .vmx, a multi-part backup is a
// SERIES of .vmx files, each independently a valid ZIP with its own
// plaintext manifest and its own PBKDF2 salt:
//
//   <base>.part01of03.vmx
//     manifest.json     plaintext { format:'vmx', version, kdf:{salt},
//                                   multipart:{ backupId, partIndex } }
//     data.json.enc     (or data.segKKKofNNN.enc when the DB payload alone
//                        exceeds the per-part budget)
//     attachments/<id>.enc            whole attachment, or
//     attachments/<id>.segKKKofNNN.enc  segments of an oversized attachment
//     part.json.enc     encrypted inventory of every OTHER entry in this
//                       part: { backupId, partIndex, entries:[{name, sha256,
//                       bytes}] } — appended last
//   <base>.part03of03.vmx additionally carries, just before part.json.enc:
//     series.json.enc   { backupId, partCount, entriesPerPart, ... }
//
// Integrity model: every entry is AES-256-GCM (content tamper fails the
// auth tag), but ZIP entry NAMES are not covered by GCM — so the encrypted
// per-part inventory binds name → ciphertext sha256 → size, and the
// encrypted series binds the set of parts. A dropped part, duplicated part,
// renamed/reordered segment, or injected entry is therefore always
// detectable, and none of it is trustable without the passphrase.
//
// Loss containment: parts are self-contained — data.json lands in part 1
// and each attachment (or segment run) is packed sequentially. If an
// operator loses a part, every attachment wholly contained in surviving
// parts is still recoverable by hand even though a full validated restore
// refuses to run.

/** Series/inventory schema version for forward compatibility. */
export const MULTIPART_VERSION = 1;

/** Per-entry ZIP bookkeeping estimate (local header + central dir + slack). */
const ZIP_ENTRY_OVERHEAD = 512;
/** Fixed per-part reserve for manifest.json + part.json.enc + ZIP EOCD. */
const PART_FIXED_RESERVE = 16 * 1024;
/** encryptEntry framing: IV(12) + GCM tag(16). */
const ENTRY_CRYPTO_OVERHEAD = 28;

export interface MultiPartFile {
  fileName: string;
  path: string;
  size: number;
  partIndex: number;
}

export interface WriteMultiResult {
  backupId: string;
  partCount: number;
  files: MultiPartFile[];
  totalSize: number;
  attachmentCount: number;
}

interface InventoryEntry { name: string; sha256: string; bytes: number }

interface PartState {
  index: number;
  tmpPath: string;
  archive: ReturnType<typeof archiver>;
  done: Promise<void>;
  key: Buffer;
  inventory: InventoryEntry[];
  /** Estimated bytes committed to this part so far (entries + overheads). */
  bytes: number;
  /** Running size of the inventory JSON itself, which also lives in the part. */
  inventoryBytes: number;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function segEntryName(prefix: string, k: number, n: number): string {
  const w = Math.max(3, String(n).length);
  return `${prefix}.seg${String(k).padStart(w, '0')}of${String(n).padStart(w, '0')}.enc`;
}

/** Parse `.segKKKofNNN` out of an entry name; null when not segmented. */
function parseSegName(name: string): { base: string; k: number; n: number } | null {
  const m = /^(.*)\.seg(\d+)of(\d+)\.enc$/.exec(name);
  if (!m) return null;
  return { base: m[1]!, k: parseInt(m[2]!, 10), n: parseInt(m[3]!, 10) };
}

/**
 * Write a backup as one or more self-contained .vmx part files.
 *
 * `partMaxBytes` bounds each part file's size (choose it below the smallest
 * upload ceiling between operators and appliances — 90 MB clears Cloudflare's
 * 100 MB with form-encoding headroom). Entries larger than the budget are
 * split into `.segKofN.enc` segments so ANY input fits. Produces a single
 * plain `<base>.vmx` when everything fits in one part — that file remains
 * readable by the classic single-file reader.
 */
export async function writeTenantPackageMulti(opts: {
  outDir: string;
  baseName: string;
  passphrase: string;
  data: unknown;
  attachments: AsyncIterable<PackageAttachment>;
  partMaxBytes: number;
  manifestMeta?: Record<string, unknown>;
  /** Series identity; defaults to a fresh UUID. Pass the caller's backup id
   *  so audit logs and the on-disk series agree. */
  backupId?: string;
}): Promise<WriteMultiResult> {
  const { outDir, baseName, passphrase, data, attachments, manifestMeta = {} } = opts;
  const partMaxBytes = Math.floor(opts.partMaxBytes);
  if (!Number.isFinite(partMaxBytes) || partMaxBytes < 1024 * 1024) {
    throw new Error('partMaxBytes must be at least 1 MiB');
  }
  // The largest plaintext chunk that still fits a part alongside the fixed
  // structural entries — AND never larger than the read-time per-entry cap
  // (minus crypto overhead so the encrypted entry stays under it). Without
  // the clamp, raising BACKUP_PART_MAX_MB above MAX_PACKAGE_ENTRY_BYTES
  // would let a large attachment be written whole into a segment the
  // reader then rejects, making the backup unrestorable.
  const segMaxPlain = Math.min(
    partMaxBytes - PART_FIXED_RESERVE - ZIP_ENTRY_OVERHEAD - ENTRY_CRYPTO_OVERHEAD - 64 * 1024,
    MAX_PACKAGE_ENTRY_BYTES - ENTRY_CRYPTO_OVERHEAD - 64 * 1024,
  );

  const backupId = opts.backupId ?? crypto.randomUUID();
  const parts: PartState[] = [];
  const closedParts: Array<{ index: number; tmpPath: string; entryCount: number }> = [];
  let attachmentCount = 0;

  function newPart(index: number): PartState {
    const salt = crypto.randomBytes(PACKAGE_SALT_LENGTH);
    const key = derivePackageKey(passphrase, salt);
    const tmpPath = `${outDir}/.${baseName}.tmp-part${index}`;
    const output = fs.createWriteStream(tmpPath);
    const archive = archiver('zip', { store: true });
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
      multipart: { multipartVersion: MULTIPART_VERSION, backupId, partIndex: index },
      ...manifestMeta,
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest));
    archive.append(manifestBuf, { name: 'manifest.json' });
    const part: PartState = {
      index,
      tmpPath,
      archive,
      done,
      key,
      inventory: [],
      bytes: manifestBuf.length + ZIP_ENTRY_OVERHEAD + PART_FIXED_RESERVE,
      inventoryBytes: 256,
    };
    parts.push(part);
    return part;
  }

  /** Close out a part: append its encrypted inventory last, finalize, await. */
  async function closePart(part: PartState): Promise<void> {
    const inventory = { backupId, partIndex: part.index, entries: part.inventory };
    part.archive.append(encryptEntry(part.key, Buffer.from(JSON.stringify(inventory))), {
      name: 'part.json.enc',
    });
    await part.archive.finalize();
    await part.done;
    closedParts.push({ index: part.index, tmpPath: part.tmpPath, entryCount: part.inventory.length });
  }

  let cur = newPart(1);

  /** Append one encrypted entry, rotating to a new part when it won't fit. */
  async function appendEntry(name: string, plain: Buffer): Promise<void> {
    const enc = encryptEntry(cur.key, plain);
    const cost = enc.length + ZIP_ENTRY_OVERHEAD + name.length;
    const inventoryGrowth = name.length + 96; // {"name":..,"sha256":<64>,"bytes":n}
    if (cur.inventory.length > 0 && cur.bytes + cur.inventoryBytes + cost + inventoryGrowth > partMaxBytes) {
      await closePart(cur);
      cur = newPart(cur.index + 1);
      // Re-encrypt under the new part's key — each part has its own salt.
      await appendEntry(name, plain);
      return;
    }
    cur.inventory.push({ name, sha256: sha256Hex(enc), bytes: enc.length });
    cur.bytes += cost;
    cur.inventoryBytes += inventoryGrowth;
    cur.archive.append(enc, { name });
  }

  /** Append a logical payload, segmenting when it exceeds the part budget. */
  async function appendPayload(prefix: string, wholeName: string, plain: Buffer): Promise<void> {
    if (plain.length <= segMaxPlain) {
      await appendEntry(wholeName, plain);
      return;
    }
    const n = Math.ceil(plain.length / segMaxPlain);
    for (let k = 1; k <= n; k++) {
      await appendEntry(segEntryName(prefix, k, n), plain.subarray((k - 1) * segMaxPlain, k * segMaxPlain));
    }
  }

  await appendPayload('data', 'data.json.enc', Buffer.from(JSON.stringify(data)));

  for await (const att of attachments) {
    await appendPayload(`attachments/${att.id}`, `attachments/${att.id}.enc`, att.buffer);
    attachmentCount += 1;
  }

  // The current part is the final one: embed the series descriptor (counted
  // in its own inventory), then close it.
  const partCount = cur.index;
  const entriesPerPart = [
    ...closedParts.map((p) => ({ partIndex: p.index, entryCount: p.entryCount })),
    { partIndex: cur.index, entryCount: cur.inventory.length + 1 }, // + series itself
  ];
  const series = {
    multipartVersion: MULTIPART_VERSION,
    backupId,
    partCount,
    attachmentCount,
    entriesPerPart,
    createdAt: new Date().toISOString(),
  };
  const seriesEnc = encryptEntry(cur.key, Buffer.from(JSON.stringify(series)));
  cur.inventory.push({ name: 'series.json.enc', sha256: sha256Hex(seriesEnc), bytes: seriesEnc.length });
  cur.archive.append(seriesEnc, { name: 'series.json.enc' });
  await closePart(cur);

  // Rename temp files to their final names, which encode index + count.
  const width = Math.max(2, String(partCount).length);
  const files: MultiPartFile[] = [];
  for (const p of closedParts.sort((a, b) => a.index - b.index)) {
    const fileName = partCount === 1
      ? `${baseName}.vmx`
      : `${baseName}.part${String(p.index).padStart(width, '0')}of${String(partCount).padStart(width, '0')}.vmx`;
    const finalPath = `${outDir}/${fileName}`;
    fs.renameSync(p.tmpPath, finalPath);
    files.push({ fileName, path: finalPath, size: fs.statSync(finalPath).size, partIndex: p.index });
  }
  return {
    backupId,
    partCount,
    files,
    totalSize: files.reduce((s, f) => s + f.size, 0),
    attachmentCount,
  };
}

export interface OpenedMultiPackage {
  manifest: Record<string, unknown>;
  series: Record<string, unknown> | null;
  backupId: string | null;
  partCount: number;
  data: unknown;
  attachmentIds: string[];
  attachments(): AsyncGenerator<PackageAttachment>;
}

interface OpenedPart {
  index: number;
  directory: Awaited<ReturnType<typeof unzipper.Open.file>>;
  key: Buffer;
  inventory: InventoryEntry[];
  shaByName: Map<string, InventoryEntry>;
}

/** Read the plaintext manifest of a part file without needing the passphrase. */
export async function peekPackageManifest(filePath: string): Promise<Record<string, unknown>> {
  const directory = await unzipper.Open.file(filePath);
  const manifestFile = directory.files.find((f) => f.path === 'manifest.json');
  if (!manifestFile) throw new Error('Not a Vibe MyBooks package (manifest.json missing)');
  return JSON.parse((await bufferEntryBounded(manifestFile)).toString('utf8')) as Record<string, unknown>;
}

/**
 * Open and fully cross-validate ONE part of a multi-part series (or a classic
 * single file — `multipart` absent). Proves the passphrase, decrypts the
 * inventory, and verifies the ZIP's actual entries match it exactly in both
 * directions. Used by the staged-restore upload endpoint to reject a bad part
 * at upload time instead of at final assembly.
 */
export async function openAndVerifyPart(filePath: string, passphrase: string): Promise<{
  multipart: { backupId: string; partIndex: number } | null;
  hasSeries: boolean;
  series: Record<string, unknown> | null;
  manifest: Record<string, unknown>;
}> {
  const part = await openPart(filePath, passphrase);
  if (part === null) {
    // Classic single-file package — prove the passphrase the classic way.
    await readTenantPackage(filePath, passphrase);
    const manifest = await peekPackageManifest(filePath);
    return { multipart: null, hasSeries: false, series: null, manifest };
  }
  const seriesEntry = part.shaByName.get('series.json.enc');
  let series: Record<string, unknown> | null = null;
  if (seriesEntry) {
    const f = part.directory.files.find((x) => x.path === 'series.json.enc')!;
    const buf = await bufferEntryBounded(f);
    if (sha256Hex(buf) !== seriesEntry.sha256) throw new Error('series.json.enc does not match its inventory hash');
    series = JSON.parse(decryptEntry(part.key, buf).toString('utf8')) as Record<string, unknown>;
    if (series['backupId'] !== part.inventoryBackupId) throw new Error('series backupId mismatch within part');
  }
  const manifestFile = part.directory.files.find((f) => f.path === 'manifest.json')!;
  const manifest = JSON.parse((await bufferEntryBounded(manifestFile)).toString('utf8')) as Record<string, unknown>;
  return {
    multipart: { backupId: part.inventoryBackupId, partIndex: part.index },
    hasSeries: !!seriesEntry,
    series,
    manifest,
  };
}

type OpenedPartInternal = OpenedPart & { inventoryBackupId: string };

/** Open one part: derive its key, decrypt + verify its inventory. Returns
 *  null when the file is a classic (non-multipart) package. */
async function openPart(filePath: string, passphrase: string): Promise<OpenedPartInternal | null> {
  const directory = await unzipper.Open.file(filePath);
  const find = (name: string) => directory.files.find((f) => f.path === name);

  const manifestFile = find('manifest.json');
  if (!manifestFile) throw new Error(`${filePath}: not a Vibe MyBooks package (manifest.json missing)`);
  const manifest = JSON.parse((await bufferEntryBounded(manifestFile)).toString('utf8')) as Record<string, unknown>;
  const multipart = manifest['multipart'] as { backupId?: string; partIndex?: number } | undefined;
  if (!multipart || typeof multipart.partIndex !== 'number') return null;

  const kdf = manifest['kdf'] as { salt?: string } | undefined;
  if (!kdf?.salt) throw new Error(`${filePath}: manifest is missing its encryption salt`);
  const key = derivePackageKey(passphrase, Buffer.from(kdf.salt, 'hex'));

  const invFile = find('part.json.enc');
  if (!invFile) throw new Error(`${filePath}: part inventory (part.json.enc) missing`);
  let invBuf: Buffer;
  try {
    invBuf = decryptEntry(key, await bufferEntryBounded(invFile));
  } catch (err) {
    if (err instanceof PackageEntryTooLargeError) throw err;
    throw new Error('Incorrect passphrase or corrupted package');
  }
  const inventory = JSON.parse(invBuf.toString('utf8')) as {
    backupId: string;
    partIndex: number;
    entries: InventoryEntry[];
  };
  if (typeof inventory.backupId !== 'string' || !Array.isArray(inventory.entries)) {
    throw new Error(`${filePath}: malformed part inventory`);
  }
  if (inventory.partIndex !== multipart.partIndex || (multipart.backupId && inventory.backupId !== multipart.backupId)) {
    throw new Error(`${filePath}: plaintext manifest disagrees with the authenticated inventory`);
  }

  // Exact two-way match between the authenticated inventory and the actual
  // ZIP contents (manifest.json and part.json.enc excluded — they frame it).
  const actual = directory.files.filter((f) => f.path !== 'manifest.json' && f.path !== 'part.json.enc');
  const actualNames = new Set(actual.map((f) => f.path));
  const invNames = new Set(inventory.entries.map((e) => e.name));
  if (actualNames.size !== actual.length) throw new Error(`${filePath}: duplicate ZIP entry names`);
  if (invNames.size !== inventory.entries.length) throw new Error(`${filePath}: duplicate inventory entry names`);
  for (const n of actualNames) if (!invNames.has(n)) throw new Error(`${filePath}: unexpected entry not in inventory: ${n}`);
  for (const n of invNames) if (!actualNames.has(n)) throw new Error(`${filePath}: entry listed in inventory but missing from file: ${n}`);

  const shaByName = new Map(inventory.entries.map((e) => [e.name, e]));
  return { index: inventory.partIndex, directory, key, inventory: inventory.entries, shaByName, inventoryBackupId: inventory.backupId };
}

/**
 * Open a complete multi-part series (all part files) — or a classic
 * single-file package, to which this transparently falls back — and fully
 * validate it: passphrase, per-part inventories, series completeness
 * (every part present exactly once), and per-entry hashes on consumption.
 */
export async function readTenantPackageMulti(paths: string[], passphrase: string): Promise<OpenedMultiPackage> {
  if (paths.length === 0) throw new Error('No backup files provided');

  const first = await openPart(paths[0]!, passphrase);
  if (first === null) {
    if (paths.length > 1) {
      throw new Error('Multiple files provided but the first is not a multi-part backup');
    }
    const classic = await readTenantPackage(paths[0]!, passphrase);
    return {
      manifest: classic.manifest,
      series: null,
      backupId: null,
      partCount: 1,
      data: classic.data,
      attachmentIds: classic.attachmentIds,
      attachments: classic.attachments,
    };
  }

  const opened: OpenedPartInternal[] = [first];
  for (const p of paths.slice(1)) {
    const part = await openPart(p, passphrase);
    if (part === null) throw new Error(`${p}: not part of a multi-part backup`);
    opened.push(part);
  }

  const backupId = first.inventoryBackupId;
  for (const p of opened) {
    if (p.inventoryBackupId !== backupId) {
      throw new Error('The provided files belong to different backups (backupId mismatch)');
    }
  }
  const byIndex = new Map<number, OpenedPartInternal>();
  for (const p of opened) {
    if (byIndex.has(p.index)) throw new Error(`Duplicate part ${p.index} provided`);
    byIndex.set(p.index, p);
  }

  // Locate the series descriptor (must exist in exactly one part).
  let series: { partCount: number; entriesPerPart?: Array<{ partIndex: number; entryCount: number }> } & Record<string, unknown> | null = null;
  for (const p of opened) {
    const inv = p.shaByName.get('series.json.enc');
    if (!inv) continue;
    if (series) throw new Error('Multiple series descriptors found across parts');
    const f = p.directory.files.find((x) => x.path === 'series.json.enc')!;
    const buf = await bufferEntryBounded(f);
    if (sha256Hex(buf) !== inv.sha256) throw new Error('series.json.enc does not match its inventory hash');
    series = JSON.parse(decryptEntry(p.key, buf).toString('utf8'));
  }
  if (!series) {
    const have = [...byIndex.keys()].sort((a, b) => a - b).join(', ');
    throw new Error(`The final part of this backup is missing (have part(s) ${have}, none carries the series descriptor). Upload every part before restoring.`);
  }
  if (series['backupId'] !== backupId) throw new Error('Series descriptor belongs to a different backup');
  const partCount = series.partCount;
  if (!Number.isInteger(partCount) || partCount < 1) throw new Error('Series descriptor is malformed');
  const missing: number[] = [];
  for (let i = 1; i <= partCount; i++) if (!byIndex.has(i)) missing.push(i);
  if (missing.length) throw new Error(`Missing part(s) ${missing.join(', ')} of ${partCount}. Upload every part before restoring.`);
  if (byIndex.size !== partCount) {
    throw new Error(`Backup has ${partCount} part(s) but ${byIndex.size} were provided`);
  }
  for (const epp of series.entriesPerPart ?? []) {
    const p = byIndex.get(epp.partIndex);
    if (p && p.inventory.length !== epp.entryCount) {
      throw new Error(`Part ${epp.partIndex} entry count does not match the series descriptor`);
    }
  }

  const orderedParts = [...byIndex.values()].sort((a, b) => a.index - b.index);

  /** Read one entry from a part, verifying its hash against the inventory. */
  async function readVerified(p: OpenedPartInternal, name: string): Promise<Buffer> {
    const inv = p.shaByName.get(name)!;
    const f = p.directory.files.find((x) => x.path === name);
    if (!f) throw new Error(`Part ${p.index}: missing entry ${name}`);
    const raw = await bufferEntryBounded(f);
    if (raw.length !== inv.bytes || sha256Hex(raw) !== inv.sha256) {
      throw new Error(`Part ${p.index}: entry ${name} does not match its authenticated inventory (corrupted or tampered)`);
    }
    return decryptEntry(p.key, raw);
  }

  // Assemble the data payload (whole or segmented, possibly across parts).
  const dataChunks: Array<{ k: number; n: number; part: OpenedPartInternal; name: string }> = [];
  let wholeData: { part: OpenedPartInternal; name: string } | null = null;
  for (const p of orderedParts) {
    for (const e of p.inventory) {
      if (e.name === 'data.json.enc') wholeData = { part: p, name: e.name };
      const seg = parseSegName(e.name);
      if (seg && seg.base === 'data') dataChunks.push({ k: seg.k, n: seg.n, part: p, name: e.name });
    }
  }
  let dataBuf: Buffer;
  if (wholeData) {
    dataBuf = await readVerified(wholeData.part, wholeData.name);
  } else if (dataChunks.length > 0) {
    const n = dataChunks[0]!.n;
    if (dataChunks.length !== n || new Set(dataChunks.map((c) => c.k)).size !== n) {
      throw new Error('Data payload segments are incomplete');
    }
    dataChunks.sort((a, b) => a.k - b.k);
    const bufs: Buffer[] = [];
    for (const c of dataChunks) bufs.push(await readVerified(c.part, c.name));
    dataBuf = Buffer.concat(bufs);
  } else {
    throw new Error('Backup is missing its data payload');
  }
  const data = JSON.parse(dataBuf.toString('utf8'));

  // Attachment iteration plan: whole entries yield directly; segmented ones
  // reassemble (segments are written contiguously, so at most one attachment
  // is buffered at a time in practice; completeness is enforced regardless).
  const attachmentIdSet = new Set<string>();
  for (const p of orderedParts) {
    for (const e of p.inventory) {
      if (!e.name.startsWith('attachments/')) continue;
      const seg = parseSegName(e.name);
      if (seg) attachmentIdSet.add(seg.base.slice('attachments/'.length));
      else attachmentIdSet.add(e.name.slice('attachments/'.length, -'.enc'.length));
    }
  }

  async function* attachments(): AsyncGenerator<PackageAttachment> {
    const pending = new Map<string, { of: number; got: Map<number, Buffer> }>();
    for (const p of orderedParts) {
      for (const e of p.inventory) {
        if (!e.name.startsWith('attachments/')) continue;
        const seg = parseSegName(e.name);
        if (!seg) {
          const id = e.name.slice('attachments/'.length, -'.enc'.length);
          yield { id, buffer: await readVerified(p, e.name) };
          continue;
        }
        const id = seg.base.slice('attachments/'.length);
        let st = pending.get(id);
        if (!st) { st = { of: seg.n, got: new Map() }; pending.set(id, st); }
        if (st.of !== seg.n) throw new Error(`Attachment ${id}: inconsistent segment counts`);
        if (st.got.has(seg.k)) throw new Error(`Attachment ${id}: duplicate segment ${seg.k}`);
        st.got.set(seg.k, await readVerified(p, e.name));
        if (st.got.size === st.of) {
          const bufs: Buffer[] = [];
          for (let k = 1; k <= st.of; k++) {
            const b = st.got.get(k);
            if (!b) throw new Error(`Attachment ${id}: missing segment ${k} of ${st.of}`);
            bufs.push(b);
          }
          pending.delete(id);
          yield { id, buffer: Buffer.concat(bufs) };
        }
      }
    }
    if (pending.size > 0) {
      const ids = [...pending.keys()].slice(0, 5).join(', ');
      throw new Error(`Backup ended with incomplete segmented attachment(s): ${ids}`);
    }
  }

  const manifestFile = first.directory.files.find((f) => f.path === 'manifest.json')!;
  const manifest = JSON.parse((await bufferEntryBounded(manifestFile)).toString('utf8')) as Record<string, unknown>;

  return {
    manifest,
    series,
    backupId,
    partCount,
    data,
    attachmentIds: [...attachmentIdSet],
    attachments,
  };
}
