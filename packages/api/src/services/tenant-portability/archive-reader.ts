// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Tenant archive reader (U-05 import step 1): container checks, passphrase
 * proof, manifest decryption, entry-name validation (zip-slip, unknown
 * entries), size caps, and decrypt-and-hash verification of every part and
 * file against the manifest. Nothing here touches the database.
 */

import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { EntryDecryptor, openEnvelopeAsync, validateEnvelope, type ArchiveEnvelope } from './archive-crypto.js';
import { openArchiveZip, readBounded, type ZipEntry } from './archive-container.js';
import { ArchiveError } from './errors.js';
import {
  ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION, ENVELOPE_ENTRY, HOST_MAX_BYTES, IDENTITY_ENTRIES, MANIFEST_ENTRY,
  filePartName, parseEntryName, tablePartName, zipEntryName, type ArchiveManifest, type ManifestFile, type ManifestTable,
} from './format.js';

const ENVELOPE_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024 * 1024;
/** Hard cap on the declared plaintext of one archive (parts + files). */
export const ARCHIVE_MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024 * 1024;
/** Hard cap on zip entries, checked before the envelope is read (a central directory is attacker-controlled). */
export const ARCHIVE_MAX_ENTRIES = 1_000_000;
const SOURCE_NAME_MAX = 255;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function corrupt(why: string): ArchiveError {
  return new ArchiveError('ARCHIVE_CORRUPT', `The archive is damaged (${why}).`);
}

function validateTable(raw: unknown, i: number): ManifestTable {
  if (!isObject(raw)) throw corrupt(`tables[${i}]`);
  const name = raw['name'];
  if (typeof name !== 'string' || !TABLE_RE.test(name)) throw corrupt(`tables[${i}].name`);
  if (raw['bucket'] !== 'tenant' && raw['bucket'] !== 'child') throw corrupt(`${name}: bucket`);
  if (raw['pk'] !== 'uuid' && raw['pk'] !== 'omit-pk' && raw['pk'] !== 'no-pk') throw corrupt(`${name}: pk`);
  if (!Number.isInteger(raw['rows']) || (raw['rows'] as number) < 0) throw corrupt(`${name}: rows`);
  if (!Number.isInteger(raw['bytes']) || (raw['bytes'] as number) < 0) throw corrupt(`${name}: bytes`);
  if (typeof raw['sha256'] !== 'string' || !SHA_RE.test(raw['sha256'])) throw corrupt(`${name}: sha256`);
  if (typeof raw['contentDigest'] !== 'string' || !SHA_RE.test(raw['contentDigest'])) throw corrupt(`${name}: contentDigest`);
  const columns = raw['columns'];
  if (!Array.isArray(columns) || columns.length === 0) throw corrupt(`${name}: columns`);
  for (const c of columns) {
    if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'string' || !TABLE_RE.test(c[0]) || typeof c[1] !== 'string' || c[1].length === 0 || c[1].length > 100) {
      throw corrupt(`${name}: column declaration`);
    }
  }
  return raw as unknown as ManifestTable;
}

function validateFile(raw: unknown, i: number): ManifestFile {
  if (!isObject(raw)) throw corrupt(`files[${i}]`);
  for (const k of ['table', 'column'] as const) {
    if (typeof raw[k] !== 'string' || !TABLE_RE.test(raw[k] as string)) throw corrupt(`files[${i}].${k}`);
  }
  if (typeof raw['rowId'] !== 'string' || !UUID_RE.test(raw['rowId'])) throw corrupt(`files[${i}].rowId`);
  if (typeof raw['resolver'] !== 'string') throw corrupt(`files[${i}].resolver`);
  if (!Number.isInteger(raw['bytes']) || (raw['bytes'] as number) < 0) throw corrupt(`files[${i}].bytes`);
  if (typeof raw['sha256'] !== 'string' || !SHA_RE.test(raw['sha256'])) throw corrupt(`files[${i}].sha256`);
  return raw as unknown as ManifestFile;
}

/** Structural validation of a decrypted manifest. Values are checked for shape only. */
export function validateManifest(raw: unknown, envelope: ArchiveEnvelope): ArchiveManifest {
  if (!isObject(raw)) throw corrupt('manifest is not an object');
  if (raw['format'] !== ARCHIVE_FORMAT || raw['formatVersion'] !== ARCHIVE_FORMAT_VERSION) throw corrupt('manifest format');
  if (raw['archiveId'] !== envelope.archiveId) throw corrupt('manifest archiveId differs from the envelope');
  const schema = raw['schema'];
  if (!isObject(schema) || !Number.isInteger(schema['version'])) throw corrupt('manifest schema');
  const source = raw['source'];
  if (!isObject(source) || typeof source['tenantId'] !== 'string' || !UUID_RE.test(source['tenantId']) || typeof source['name'] !== 'string') throw corrupt('manifest source');
  // The name becomes the restored tenant's label: bounded, printable, no control characters.
  if (source['name'].length > SOURCE_NAME_MAX || /[\u0000-\u001f\u007f]/.test(source['name'])) throw corrupt('manifest source.name');
  const options = raw['options'];
  if (!isObject(options) || typeof options['includeAttachments'] !== 'boolean' || typeof options['includeAudit'] !== 'boolean') throw corrupt('manifest options');
  const host = raw['host'];
  if (!isObject(host) || Buffer.byteLength(JSON.stringify(host), 'utf8') > HOST_MAX_BYTES) throw corrupt('manifest host');
  if (!Array.isArray(raw['tables'])) throw corrupt('manifest tables');
  const tables = (raw['tables'] as unknown[]).map(validateTable);
  if (new Set(tables.map((t) => t.name)).size !== tables.length) throw corrupt('duplicate table');
  if (!Array.isArray(raw['files'])) throw corrupt('manifest files');
  const files = (raw['files'] as unknown[]).map(validateFile);
  const identity = raw['identity'];
  if (!isObject(identity) || identity['tenant'] !== IDENTITY_ENTRIES.tenant || identity['users'] !== IDENTITY_ENTRIES.users || identity['access'] !== IDENTITY_ENTRIES.access || !isObject(identity['parts'])) {
    throw corrupt('manifest identity');
  }
  for (const name of Object.values(IDENTITY_ENTRIES)) {
    const p = (identity['parts'] as Record<string, unknown>)[name];
    if (!isObject(p) || typeof p['sha256'] !== 'string' || !SHA_RE.test(p['sha256']) || !Number.isInteger(p['bytes']) || !Number.isInteger(p['rows'])) throw corrupt(`identity part ${name}`);
  }
  if (!isObject(raw['trialBalance']) || !Array.isArray((raw['trialBalance'] as Record<string, unknown>)['rows'])) throw corrupt('manifest trialBalance');
  if (!Number.isInteger(raw['unbalancedTransactions'])) throw corrupt('manifest unbalancedTransactions');
  const fp = raw['fingerprint'];
  if (!isObject(fp) || fp['algorithm'] !== 'fp1' || !isObject(fp['tables'])) throw corrupt('manifest fingerprint');
  if (!Array.isArray(raw['warnings']) || !(raw['warnings'] as unknown[]).every((w) => typeof w === 'string')) throw corrupt('manifest warnings');
  for (const k of ['excludedTables', 'redactedColumns', 'nulledReferences'] as const) if (!isObject(raw[k])) throw corrupt(`manifest ${k}`);
  for (const k of ['globalRows', 'canonical'] as const) if (raw[k] !== undefined && !isObject(raw[k])) throw corrupt(`manifest ${k}`);
  const declared = tables.reduce((s, t) => s + t.bytes, 0) + files.reduce((s, f) => s + f.bytes, 0);
  if (declared > ARCHIVE_MAX_PLAINTEXT_BYTES) throw new ArchiveError('ARCHIVE_TOO_LARGE', 'The archive declares more data than this engine accepts.');
  return raw as unknown as ArchiveManifest;
}

export interface VerifyReport {
  parts: number;
  files: number;
  plaintextBytes: number;
}

export class ArchiveReader {
  private constructor(
    public readonly filePath: string,
    public readonly envelope: ArchiveEnvelope,
    public readonly manifest: ArchiveManifest,
    private readonly key: Buffer,
    private readonly entries: Map<string, ZipEntry>,
  ) {}

  /**
   * Opens an archive: envelope (closed parameter sets), passphrase
   * (keyCheck), manifest, and the entry inventory, which must be exactly
   * what the manifest names (no unknown entries, no missing parts, no
   * zip-slip names).
   */
  static async open(filePath: string, passphrase: string): Promise<ArchiveReader> {
    const list = await openArchiveZip(filePath);
    if (list.length > ARCHIVE_MAX_ENTRIES) throw new ArchiveError('ARCHIVE_TOO_LARGE', 'The archive holds more entries than this engine accepts.');
    const entries = new Map<string, ZipEntry>();
    for (const e of list) {
      if (entries.has(e.name)) throw corrupt('duplicate entry');
      entries.set(e.name, e);
    }
    const envelopeEntry = entries.get(ENVELOPE_ENTRY);
    if (!envelopeEntry) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'This file is not a tenant archive (no envelope).');
    let rawEnvelope: unknown;
    try {
      rawEnvelope = JSON.parse((await readBounded(envelopeEntry.stream(), ENVELOPE_MAX_BYTES, 'envelope')).toString('utf8'));
    } catch (err) {
      if (err instanceof ArchiveError) throw err;
      throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'This file is not a tenant archive (envelope unreadable).');
    }
    const envelope = validateEnvelope(rawEnvelope);
    const key = await openEnvelopeAsync(envelope, passphrase);

    const manifestEntry = entries.get(MANIFEST_ENTRY);
    if (!manifestEntry) throw corrupt('manifest missing');
    const manifestBytes = await ArchiveReader.decryptEntry(key, envelope.archiveId, MANIFEST_ENTRY.slice(0, -'.enc'.length), manifestEntry, MANIFEST_MAX_BYTES);
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw corrupt('manifest is not JSON');
    }
    const manifest = validateManifest(rawManifest, envelope);

    // Inventory: every entry must be known, every known part must exist.
    const expected = new Set<string>([ENVELOPE_ENTRY, MANIFEST_ENTRY]);
    for (const name of Object.values(IDENTITY_ENTRIES)) expected.add(zipEntryName(name));
    for (const t of manifest.tables) expected.add(zipEntryName(tablePartName(t.name)));
    for (const f of manifest.files) expected.add(zipEntryName(filePartName(f.table, f.column, f.rowId)));
    for (const name of entries.keys()) {
      if (!parseEntryName(name) || !expected.has(name)) throw corrupt(`unknown entry`);
    }
    for (const name of expected) {
      if (!entries.has(name)) throw corrupt(`missing entry`);
    }
    return new ArchiveReader(filePath, envelope, manifest, key, entries);
  }

  private static async decryptEntry(key: Buffer, archiveId: string, partName: string, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
    const dec = new EntryDecryptor(key, archiveId, partName);
    const chunks: Buffer[] = [];
    let total = 0;
    await pipeline(entry.stream(), dec, async function* (source) {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > maxBytes) throw new ArchiveError('ARCHIVE_TOO_LARGE', `${partName} exceeds its size limit`);
        chunks.push(chunk);
      }
    });
    return Buffer.concat(chunks);
  }

  private entryFor(partName: string): ZipEntry {
    const e = this.entries.get(zipEntryName(partName));
    if (!e) throw corrupt(`missing entry`);
    return e;
  }

  /** Decrypted plaintext stream of a part. */
  partStream(partName: string): NodeJS.ReadableStream {
    const dec = new EntryDecryptor(this.key, this.envelope.archiveId, partName);
    const src = this.entryFor(partName).stream();
    src.on('error', (err) => dec.destroy(err as Error));
    return src.pipe(dec);
  }

  /** Whole plaintext of a part, bounded. */
  async readPart(partName: string, maxBytes: number): Promise<Buffer> {
    return ArchiveReader.decryptEntry(this.key, this.envelope.archiveId, partName, this.entryFor(partName), maxBytes);
  }

  /** Lines of an NDJSON part, without their newline. */
  async *lines(partName: string): AsyncGenerator<string> {
    let rest = '';
    for await (const chunk of this.partStream(partName) as AsyncIterable<Buffer>) {
      rest += chunk.toString('utf8');
      let nl = rest.indexOf('\n');
      while (nl >= 0) {
        yield rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        nl = rest.indexOf('\n');
      }
    }
    if (rest.length > 0) yield rest;
  }

  /** Declared plaintext size of a part (table, identity or file). */
  declaredBytes(partName: string): number {
    for (const t of this.manifest.tables) if (tablePartName(t.name) === partName) return t.bytes;
    for (const f of this.manifest.files) if (filePartName(f.table, f.column, f.rowId) === partName) return f.bytes;
    const id = this.manifest.identity.parts[partName];
    if (id) return id.bytes;
    throw corrupt('unknown part');
  }

  /** Decrypts and hashes one part against the manifest; returns its plaintext size. */
  async verifyPart(partName: string, expectedSha256: string, expectedBytes: number): Promise<number> {
    const hash = crypto.createHash('sha256');
    let total = 0;
    await pipeline(this.partStream(partName), async function* (source) {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > expectedBytes) throw corrupt(`${partName}: more bytes than declared`);
        hash.update(chunk);
      }
    });
    if (total !== expectedBytes || hash.digest('hex') !== expectedSha256) throw corrupt(`${partName}: hash mismatch`);
    return total;
  }

  /** Decrypt-and-hash every part and file (GCM, final-chunk rules, hashes). */
  async verifyAll(onProgress?: (done: number, total: number) => void): Promise<VerifyReport> {
    const work: Array<{ part: string; sha256: string; bytes: number; isFile: boolean }> = [];
    for (const [name, p] of Object.entries(this.manifest.identity.parts)) work.push({ part: name, sha256: p.sha256, bytes: p.bytes, isFile: false });
    for (const t of this.manifest.tables) work.push({ part: tablePartName(t.name), sha256: t.sha256, bytes: t.bytes, isFile: false });
    for (const f of this.manifest.files) work.push({ part: filePartName(f.table, f.column, f.rowId), sha256: f.sha256, bytes: f.bytes, isFile: true });
    const report: VerifyReport = { parts: 0, files: 0, plaintextBytes: 0 };
    let i = 0;
    for (const w of work) {
      report.plaintextBytes += await this.verifyPart(w.part, w.sha256, w.bytes);
      if (w.isFile) report.files++;
      else report.parts++;
      onProgress?.(++i, work.length);
    }
    return report;
  }

  /** Total plaintext bytes of the bundled files (for a free-space check). */
  declaredFileBytes(): number {
    return this.manifest.files.reduce((s, f) => s + f.bytes, 0);
  }
}
