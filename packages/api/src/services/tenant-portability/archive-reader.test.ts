// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Archive reader (U-05 step 34a): container checks, passphrase, inventory
// (unknown entries, zip-slip), tamper detection and schema compatibility.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { db } from '../../db/index.js';
import { ArchiveZipWriter, sha256File } from './archive-container.js';
import { createEnvelope, encryptEntryBuffer, NoncePrefixRegistry } from './archive-crypto.js';
import { ArchiveReader, ARCHIVE_MAX_ENTRIES } from './archive-reader.js';
import {
  ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION, ENVELOPE_ENTRY, IDENTITY_ENTRIES, MANIFEST_ENTRY, filePartName, tablePartName, zipEntryName,
  type ArchiveManifest, type ManifestTable,
} from './format.js';
import { ArchiveError } from './errors.js';
import { buildPortabilityPlan, TYPE_CHANGES, type PortabilityPlan } from './plan.js';
import { BACKFILL, COMPAT_BASELINE_SCHEMA_VERSION, DROPPED_COLUMNS, DROPPED_TABLES, checkSchemaCompatibility } from './compat.js';

const PASS = 'reader test passphrase 2026';
let dir = '';
let plan: PortabilityPlan;
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

function sha(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}

interface Spec {
  tables?: Record<string, { lines: string[]; columns: Array<[string, string]>; pk?: 'uuid' | 'omit-pk' | 'no-pk' }>;
  files?: Array<{ table: string; column: string; rowId: string; bytes: Buffer }>;
  schemaVersion?: number;
  host?: Record<string, unknown>;
  extraEntries?: Array<{ name: string; bytes: Buffer }>;
  mutateManifest?: (m: ArchiveManifest) => void;
  passphrase?: string;
  sourceName?: string;
}

/** Builds a small but complete archive. */
async function buildArchive(name: string, spec: Spec): Promise<{ filePath: string; archiveId: string; manifest: ArchiveManifest }> {
  const filePath = path.join(dir, name);
  const archiveId = crypto.randomUUID();
  const registry = new NoncePrefixRegistry();
  const { envelope, key } = createEnvelope(archiveId, spec.passphrase ?? PASS, registry);
  const w = new ArchiveZipWriter(filePath, key, archiveId);
  await w.writeEnvelope(envelope);
  const tables: ManifestTable[] = [];
  const identityParts: ArchiveManifest['identity']['parts'] = {};
  for (const partName of Object.values(IDENTITY_ENTRIES)) {
    const body = Buffer.from(partName === IDENTITY_ENTRIES.tenant ? '{"id":"x"}\n' : '', 'utf8');
    const r = await w.writePart(partName, body);
    identityParts[partName] = { sha256: r.sha256, bytes: r.bytes, rows: body.length ? 1 : 0 };
  }
  for (const [t, v] of Object.entries(spec.tables ?? {})) {
    const body = Buffer.from(v.lines.map((l) => `${l}\n`).join(''), 'utf8');
    const r = await w.writePart(tablePartName(t), body);
    tables.push({ name: t, bucket: 'tenant', pk: v.pk ?? 'uuid', rows: v.lines.length, sha256: r.sha256, contentDigest: sha(body), columns: v.columns, bytes: r.bytes });
  }
  const files: ArchiveManifest['files'] = [];
  for (const f of spec.files ?? []) {
    const r = await w.writePart(filePartName(f.table, f.column, f.rowId), f.bytes);
    files.push({ table: f.table, column: f.column, rowId: f.rowId, resolver: 'provider-key', bytes: r.bytes, sha256: r.sha256 });
  }
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    archiveId,
    engine: { version: 'test', commit: null },
    schema: { version: spec.schemaVersion ?? 218, tag: null },
    createdAt: new Date().toISOString(),
    source: { tenantId: crypto.randomUUID(), name: spec.sourceName ?? 'Src', ledgerVersion: '0' },
    options: { includeAttachments: true, includeAudit: true },
    host: spec.host ?? {},
    tables,
    identity: { ...IDENTITY_ENTRIES, parts: identityParts },
    files,
    trialBalance: { definition: 'x', rows: [], totals: { debit: '0', credit: '0' } },
    unbalancedTransactions: 0,
    fingerprint: { algorithm: 'fp1', tenantRow: '', tables: {}, trialBalance: '' },
    excludedTables: {},
    redactedColumns: {},
    nulledReferences: {},
    warnings: [],
  };
  spec.mutateManifest?.(manifest);
  for (const e of spec.extraEntries ?? []) {
    await w.writePart(e.name, e.bytes);
  }
  await w.writePart(MANIFEST_ENTRY.slice(0, -'.enc'.length), Buffer.from(JSON.stringify(manifest), 'utf8'));
  await w.finalize();
  return { filePath, archiveId, manifest };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<ArchiveError> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `expected ${code}`).toBeInstanceOf(ArchiveError);
  expect((err as ArchiveError).code).toBe(code);
  return err as ArchiveError;
}

/** Rewrites one zip entry's bytes (keeps the other entries), producing a new file. */
async function rewriteZip(src: string, dst: string, edit: (name: string, bytes: Buffer) => Buffer | null, extra: Array<{ name: string; bytes: Buffer }> = []): Promise<void> {
  const unzipper = await import('unzipper');
  const d = await unzipper.Open.file(src);
  const out = archiver('zip', { store: true });
  const stream = fs.createWriteStream(dst);
  const done = new Promise<void>((resolve, reject) => {
    stream.on('close', resolve);
    out.on('error', reject);
  });
  out.pipe(stream);
  for (const f of d.files) {
    const bytes = edit(f.path, await f.buffer());
    if (bytes) out.append(bytes, { name: f.path });
  }
  for (const e of extra) out.append(e.bytes, { name: e.name });
  await out.finalize();
  await done;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archive-reader-'));
  plan = await buildPortabilityPlan(db);
}, 60_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('container', () => {
  it('opens a good archive, verifies every part and file, and reads lines', async () => {
    const rowId = crypto.randomUUID();
    const big = crypto.randomBytes(200_000);
    const a = await buildArchive('good.zip', {
      tables: { contacts: { lines: ['{"id":"a","display_name":"A"}', '{"id":"b","display_name":"B"}'], columns: [['id', 'uuid'], ['display_name', 'character varying(255)']] }, empty: { lines: [], columns: [['id', 'uuid']] } },
      files: [{ table: 'attachments', column: 'storage_key', rowId, bytes: big }, { table: 'attachments', column: 'storage_key', rowId: crypto.randomUUID(), bytes: Buffer.alloc(0) }],
      host: { app: 'ClientLedger', kind: 'backup' },
    });
    const r = await ArchiveReader.open(a.filePath, PASS);
    expect(r.manifest.archiveId).toBe(a.archiveId);
    expect(r.manifest.host).toEqual({ app: 'ClientLedger', kind: 'backup' });
    const report = await r.verifyAll();
    expect(report).toEqual({ parts: 5, files: 2, plaintextBytes: expect.any(Number) });
    const lines: string[] = [];
    for await (const l of r.lines(tablePartName('contacts'))) lines.push(l);
    expect(lines).toEqual(['{"id":"a","display_name":"A"}', '{"id":"b","display_name":"B"}']);
    const none: string[] = [];
    for await (const l of r.lines(tablePartName('empty'))) none.push(l);
    expect(none).toEqual([]);
    expect((await r.readPart(filePartName('attachments', 'storage_key', rowId), big.length)).equals(big)).toBe(true);
    expect(r.declaredFileBytes()).toBe(big.length);
    // No plaintext leaks in the raw zip.
    const raw = fs.readFileSync(a.filePath);
    expect(raw.includes('display_name')).toBe(false);
    expect(raw.includes('ClientLedger')).toBe(false);
    expect(raw.includes(PASS)).toBe(false);
    expect(raw.includes(ENVELOPE_ENTRY)).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(await sha256File(a.filePath))).toBe(true);
  });

  it('refuses a wrong passphrase before anything else is read, and a non-archive file', async () => {
    const a = await buildArchive('pass.zip', {});
    await expectCode(ArchiveReader.open(a.filePath, 'not the passphrase 123'), 'ARCHIVE_PASSPHRASE_INVALID');
    const junk = path.join(dir, 'junk.zip');
    fs.writeFileSync(junk, 'not a zip at all');
    await expectCode(ArchiveReader.open(junk, PASS), 'ARCHIVE_CORRUPT');
    // A zip without an envelope.
    const noEnv = path.join(dir, 'noenv.zip');
    await rewriteZip(a.filePath, noEnv, (n, b) => (n === ENVELOPE_ENTRY ? null : b));
    await expectCode(ArchiveReader.open(noEnv, PASS), 'ARCHIVE_UNSUPPORTED');
  }, 60_000);

  it('detects a flipped ciphertext byte in a part and in a file (tamper)', async () => {
    const rowId = crypto.randomUUID();
    const a = await buildArchive('tamper.zip', {
      tables: { contacts: { lines: ['{"id":"a"}'], columns: [['id', 'uuid']] } },
      files: [{ table: 'attachments', column: 'storage_key', rowId, bytes: crypto.randomBytes(70_000) }],
    });
    for (const target of [zipEntryName(tablePartName('contacts')), zipEntryName(filePartName('attachments', 'storage_key', rowId))]) {
      const dst = path.join(dir, `tamper-${crypto.randomUUID()}.zip`);
      await rewriteZip(a.filePath, dst, (n, b) => {
        if (n !== target) return b;
        const c = Buffer.from(b);
        c[c.length - 20] = c[c.length - 20]! ^ 0x40;
        return c;
      });
      const r = await ArchiveReader.open(dst, PASS);
      await expectCode(r.verifyAll(), 'ARCHIVE_CORRUPT');
    }
  }, 60_000);

  it('rejects unknown entries, zip-slip names, a missing part and a manifest from another archive', async () => {
    const a = await buildArchive('inv.zip', { tables: { contacts: { lines: ['{"id":"a"}'], columns: [['id', 'uuid']] } } });
    const extra = path.join(dir, 'extra.zip');
    await rewriteZip(a.filePath, extra, (_n, b) => b, [{ name: 'host/meta.json', bytes: Buffer.from('{}') }]);
    await expectCode(ArchiveReader.open(extra, PASS), 'ARCHIVE_CORRUPT');
    const slip = path.join(dir, 'slip.zip');
    await rewriteZip(a.filePath, slip, (_n, b) => b, [{ name: '../../etc/passwd.enc', bytes: Buffer.from('x') }]);
    await expectCode(ArchiveReader.open(slip, PASS), 'ARCHIVE_CORRUPT');
    const abs = path.join(dir, 'abs.zip');
    await rewriteZip(a.filePath, abs, (_n, b) => b, [{ name: '/data/contacts.ndjson.enc', bytes: Buffer.from('x') }]);
    await expectCode(ArchiveReader.open(abs, PASS), 'ARCHIVE_CORRUPT');
    const missing = path.join(dir, 'missing.zip');
    await rewriteZip(a.filePath, missing, (n, b) => (n === zipEntryName(tablePartName('contacts')) ? null : b));
    await expectCode(ArchiveReader.open(missing, PASS), 'ARCHIVE_CORRUPT');
    // Manifest copied from another archive made with the same passphrase.
    const b = await buildArchive('inv2.zip', { tables: { contacts: { lines: ['{"id":"a"}'], columns: [['id', 'uuid']] } } });
    const bManifest = (await (await import('unzipper')).Open.file(b.filePath)).files.find((f) => f.path === MANIFEST_ENTRY)!;
    const bytes = await bManifest.buffer();
    const swapped = path.join(dir, 'swapped.zip');
    await rewriteZip(a.filePath, swapped, (n, orig) => (n === MANIFEST_ENTRY ? bytes : orig));
    await expectCode(ArchiveReader.open(swapped, PASS), 'ARCHIVE_CORRUPT');
    // A manifest whose archiveId differs from the envelope (re-encrypted under the right key).
    const mismatch = await buildArchive('mismatch.zip', { mutateManifest: (m) => { m.archiveId = crypto.randomUUID(); } });
    await expectCode(ArchiveReader.open(mismatch.filePath, PASS), 'ARCHIVE_CORRUPT');
  }, 120_000);

  it('a renamed .clbackup opens byte-for-byte and the host object is capped', async () => {
    const a = await buildArchive('rename.zip', { host: { app: 'ClientLedger' } });
    const cl = path.join(dir, 'rename.clbackup');
    fs.copyFileSync(a.filePath, cl);
    expect((await ArchiveReader.open(cl, PASS)).manifest.host).toEqual({ app: 'ClientLedger' });
    const huge = await buildArchive('hugehost.zip', { host: { pad: 'x'.repeat(17 * 1024) } });
    await expectCode(ArchiveReader.open(huge.filePath, PASS), 'ARCHIVE_CORRUPT');
    // source.name becomes the restored label: bounded and free of control characters.
    const longName = await buildArchive('longname.zip', { sourceName: 'n'.repeat(256) });
    await expectCode(ArchiveReader.open(longName.filePath, PASS), 'ARCHIVE_CORRUPT');
    const ctl = await buildArchive('ctlname.zip', { sourceName: 'Acme\u0007 Co' });
    await expectCode(ArchiveReader.open(ctl.filePath, PASS), 'ARCHIVE_CORRUPT');
    const ok = await buildArchive('okname.zip', { sourceName: 'Ärger & Söhne (2026) — books' });
    expect((await ArchiveReader.open(ok.filePath, PASS)).manifest.source.name).toBe('Ärger & Söhne (2026) — books');
    expect(ARCHIVE_MAX_ENTRIES).toBe(1_000_000);
  }, 60_000);

  it('a declared size smaller than the real part is a corruption (bounded read)', async () => {
    const a = await buildArchive('size.zip', {
      tables: { contacts: { lines: ['{"id":"a"}'], columns: [['id', 'uuid']] } },
      mutateManifest: (m) => { m.tables[0]!.bytes = 2; },
    });
    const r = await ArchiveReader.open(a.filePath, PASS);
    await expectCode(r.verifyAll(), 'ARCHIVE_CORRUPT');
    // encryptEntryBuffer helper agrees with the streaming writer on format.
    const k = crypto.randomBytes(32);
    expect(encryptEntryBuffer(k, a.archiveId, 'data/x.ndjson', Buffer.from('x'), new NoncePrefixRegistry()).length).toBe(8 + 5 + 1 + 16);
  }, 60_000);
});

describe('schema compatibility (MT7, B8)', () => {
  const liveVersion = 300;

  function tableFor(name: string): ManifestTable {
    const t = plan.byName.get(name)!;
    return { name, bucket: t.bucket, pk: t.pk, rows: 0, sha256: '0'.repeat(64), contentDigest: '0'.repeat(64), columns: t.archive.map((c) => [c.name, c.type]), bytes: 0 };
  }

  it('accepts the live projection and refuses a newer schema', () => {
    const r = checkSchemaCompatibility([tableFor('contacts'), tableFor('audit_log')], plan, 250, liveVersion);
    expect(r.tables[0]!.insertColumns).toEqual(plan.byName.get('contacts')!.insert);
    expect(r.tables[1]!.insertColumns).not.toContain('id');
    expect(r.warnings).toEqual([]);
    expect(() => checkSchemaCompatibility([tableFor('contacts')], plan, liveVersion + 1, liveVersion)).toThrow(expect.objectContaining({ code: 'ARCHIVE_TOO_NEW' }));
  });

  it('unknown table and column fail closed unless a versioned allowlist covers them', () => {
    const unknownTable: ManifestTable = { ...tableFor('contacts'), name: 'zz_gone' };
    expect(() => checkSchemaCompatibility([unknownTable], plan, 250, liveVersion)).toThrow(expect.objectContaining({ code: 'ARCHIVE_TABLE_UNKNOWN' }));
    DROPPED_TABLES['zz_gone'] = { droppedIn: 260 };
    try {
      const r = checkSchemaCompatibility([unknownTable], plan, 250, liveVersion);
      expect(r.skippedTables).toEqual(['zz_gone']);
      expect(() => checkSchemaCompatibility([unknownTable], plan, 265, liveVersion)).toThrow(expect.objectContaining({ code: 'ARCHIVE_TABLE_UNKNOWN' }));
    } finally {
      delete DROPPED_TABLES['zz_gone'];
    }
    const withCol: ManifestTable = { ...tableFor('contacts'), columns: [...tableFor('contacts').columns, ['zz_old', 'text']] };
    expect(() => checkSchemaCompatibility([withCol], plan, 250, liveVersion)).toThrow(expect.objectContaining({ code: 'ARCHIVE_COLUMN_UNKNOWN' }));
    DROPPED_COLUMNS['contacts.zz_old'] = { droppedIn: 260 };
    try {
      const r = checkSchemaCompatibility([withCol], plan, 250, liveVersion);
      expect(r.tables[0]!.skippedColumns).toEqual(['zz_old']);
      expect(r.warnings).toEqual(['COLUMN_DROPPED:contacts.zz_old']);
    } finally {
      delete DROPPED_COLUMNS['contacts.zz_old'];
    }
  });

  it('a missing NOT NULL no-default column needs a BACKFILL; nullable ones take their default', () => {
    const t = tableFor('journal_lines');
    const without = { ...t, columns: t.columns.filter(([c]) => c !== 'is_void_reversal' && c !== 'description') };
    const liveCol = plan.byName.get('journal_lines')!.columns.find((c) => c.name === 'is_void_reversal')!;
    expect(liveCol.nullable).toBe(false);
    if (liveCol.hasDefault) {
      // The live column is defaulted: it is simply listed.
      const r = checkSchemaCompatibility([without], plan, 250, liveVersion);
      expect(r.tables[0]!.defaulted).toEqual(expect.arrayContaining(['is_void_reversal', 'description']));
    }
    const req = plan.byName.get('journal_lines')!.columns.find((c) => !c.nullable && !c.hasDefault && c.name !== 'id')!;
    const missingReq = { ...t, columns: t.columns.filter(([c]) => c !== req.name) };
    expect(() => checkSchemaCompatibility([missingReq], plan, 250, liveVersion)).toThrow(expect.objectContaining({ code: 'ARCHIVE_COLUMN_MISSING' }));
    BACKFILL[`journal_lines.${req.name}`] = { addedIn: 260, expression: 'gen_random_uuid()' };
    try {
      const r = checkSchemaCompatibility([missingReq], plan, 250, liveVersion);
      expect(r.tables[0]!.backfill).toEqual([{ column: req.name, expression: 'gen_random_uuid()' }]);
    } finally {
      delete BACKFILL[`journal_lines.${req.name}`];
    }
  });

  it('a retyped column fails closed; a listed widening passes (no silent rounding)', () => {
    const t = tableFor('journal_lines');
    const narrowed = { ...t, columns: t.columns.map(([c, ty]) => (c === 'debit' ? [c, 'numeric(12,2)'] : [c, ty]) as [string, string]) };
    expect(() => checkSchemaCompatibility([narrowed], plan, 250, liveVersion)).toThrow(expect.objectContaining({ code: 'ARCHIVE_COLUMN_TYPE_CHANGED' }));
    TYPE_CHANGES['journal_lines.debit'] = { from: 'numeric(12,2)', to: 'numeric(19,4)' };
    try {
      const r = checkSchemaCompatibility([narrowed], plan, 250, liveVersion);
      expect(r.tables[0]!.widened).toEqual([{ column: 'debit', from: 'numeric(12,2)', to: 'numeric(19,4)' }]);
    } finally {
      delete TYPE_CHANGES['journal_lines.debit'];
    }
    // An archive declaring MORE precision than live is never widened silently.
    const wider = { ...t, columns: t.columns.map(([c, ty]) => (c === 'debit' ? [c, 'numeric(22,6)'] : [c, ty]) as [string, string]) };
    TYPE_CHANGES['journal_lines.debit'] = { from: 'numeric(22,6)', to: 'numeric(19,4)' };
    try {
      expect(() => checkSchemaCompatibility([wider], plan, 250, liveVersion)).toThrow(expect.objectContaining({ code: 'ARCHIVE_COLUMN_TYPE_CHANGED' }));
    } finally {
      delete TYPE_CHANGES['journal_lines.debit'];
    }
  });

  it('every non-additive migration after the E5 baseline has a compat entry (migration-policy note)', () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    const covered = new Set<number>([
      ...Object.values(DROPPED_TABLES).map((d) => d.droppedIn),
      ...Object.values(DROPPED_COLUMNS).map((d) => d.droppedIn),
      ...Object.values(BACKFILL).map((d) => d.addedIn),
    ]);
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && !f.endsWith('.rollback.sql'));
    const offenders: string[] = [];
    for (const e of journal.entries) {
      const version = e.idx + 1; // schema version after this migration
      if (version <= COMPAT_BASELINE_SCHEMA_VERSION) continue;
      const file = files.find((f) => f.startsWith(e.tag) || f === `allow-non-additive_${e.tag}.sql`);
      if (!file) continue;
      const head = readFileSync(path.join(MIGRATIONS, file), 'utf8').split('\n').slice(0, 10).join('\n');
      const nonAdditive = file.startsWith('allow-non-additive_') || head.includes('-- migration-policy: non-additive-exception');
      if (nonAdditive && !covered.has(version)) offenders.push(e.tag);
    }
    expect(offenders).toEqual([]);
    // The baseline is fixed at E5; later migrations only add entries.
    expect(journal.entries.length).toBeGreaterThanOrEqual(COMPAT_BASELINE_SCHEMA_VERSION);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });
});
