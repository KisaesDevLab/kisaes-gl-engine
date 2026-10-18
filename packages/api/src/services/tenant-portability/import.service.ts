// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Tenant archive import (U-05 step 35b).
 *
 * 1. Verify before touching the database: container, passphrase, every
 *    part and file hash, then schema compatibility (fail closed).
 * 2. Build the id map: a new tenant id and a fresh uuid for every pk of
 *    every uuid-pk table, plus natural-key and identity mappings.
 * 3. One transaction under an exclusive advisory lock on the new id:
 *    cl_idmap, the tenants row, identity, every table in FK order through
 *    json_populate_recordset (rows substituted as text, never parsed),
 *    deferred FK columns, files under a `.import-pending` marker, then
 *    the content verification; the import audit row, the fingerprint and
 *    the provenance row are written after verification, and COMMIT.
 *    Any failure rolls back and removes the written files.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceTenantId } from '../../desktop/workspace.js';
import { readSchemaInfo } from '../../startup/schema-info.js';
import { getProviderForTenant } from '../storage/storage-provider.factory.js';
import type { StorageProvider } from '../storage/storage-provider.interface.js';
import { decryptBuffer } from '../../utils/encryption.js';
import { AppError } from '../../utils/errors.js';
import { ArchiveReader } from './archive-reader.js';
import { withScrubbedPassphrase } from './archive-crypto.js';
import { sha256File } from './archive-container.js';
import { checkSchemaCompatibility, type CompatResult } from './compat.js';
import { ArchiveError } from './errors.js';
import { resolveForImport } from './files.js';
import { computeTenantFingerprint } from './fingerprint.js';
import { IDENTITY_ENTRIES, filePartName, tablePartName, type ArchiveManifest, type ManifestTable } from './format.js';
import { applyIdentity, parseIdentityLine, type ArchivedAccess, type ArchivedUser } from './identity.js';
import type { JobProgress } from './jobs.js';
import { NATURAL_KEYS, getPortabilityPlan, type PortabilityPlan, type TablePlan } from './plan.js';
import { IdMap, fieldString, pkOfLine, rewriteField } from './remap.js';
import { applyArchiveSession, withArchiveConnection, xactLockTenantExclusive, type ArchiveClient } from './session.js';
import { verifyImport, type VerificationSummary, type WrittenFile } from './verify.js';

export interface ImportOptions {
  filePath: string;
  passphrase: string;
  name?: string;
  scratch?: boolean;
  callerUserId: string;
}

export interface ImportResult {
  tenantId: string;
  name: string;
  scratch: false;
  archiveId: string;
  sourceTenantId: string;
  verification: VerificationSummary;
  /** The archive manifest's opaque `host` object, echoed so the client can restore its own metadata. */
  host: Record<string, unknown>;
  warnings: string[];
}

/** Test hooks (never set in production). */
export const _importTestHooks: {
  /** Runs inside the transaction after every insert and file, before verification. */
  beforeVerify?: (ctx: { client: ArchiveClient; newTenantId: string; idMap: IdMap }) => Promise<void> | void;
} = {};

const BATCH_ROWS = 500;
const BATCH_BYTES = 4 * 1024 * 1024;

interface PendingFile {
  part: string;
  bytes: number;
  sha256: string;
  table: string;
  column: string;
  rowId: string;
  write: (bytes: Buffer) => Promise<void>;
  readBack: () => Promise<Buffer>;
  cleanup: () => Promise<void>;
}

function restoredName(source: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${source} (restored ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())})`;
}

function freshSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'company';
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Maps referenced global rows by natural key; unresolved ids are nulled on import. */
async function mapGlobalRows(client: ArchiveClient, plan: PortabilityPlan, manifest: ArchiveManifest, idMap: IdMap, warnings: string[]): Promise<Set<string>> {
  const unresolved = new Set<string>();
  for (const [table, rows] of Object.entries(manifest.globalRows ?? {})) {
    const nk = NATURAL_KEYS[table];
    if (!nk || !plan.live.tables.has(table)) {
      for (const old of Object.keys(rows)) unresolved.add(old.toLowerCase());
      continue;
    }
    const mixed = plan.live.tables.get(table)!.columns.some((c) => c.name === 'tenant_id');
    for (const [old, key] of Object.entries(rows)) {
      const where = nk.columns.map((c, i) => `"${c}" IS NOT DISTINCT FROM $${i + 1}`).join(' AND ');
      const r = await client.query(
        `SELECT id FROM "${table}" WHERE ${where}${mixed ? ' AND tenant_id IS NULL' : ''} ORDER BY ${nk.orderBy ?? 'id'} LIMIT 1`,
        nk.columns.map((c) => key[c] ?? null),
      );
      const hit = r.rows[0] as { id: string } | undefined;
      if (hit) {
        if (hit.id.toLowerCase() !== old.toLowerCase() && !idMap.has(old)) idMap.set(old, hit.id);
      } else {
        unresolved.add(old.toLowerCase());
        warnings.push(`GLOBAL_ROW_MISSING:${table}`);
      }
    }
  }
  return unresolved;
}

export async function runImport(options: ImportOptions, progress?: JobProgress): Promise<ImportResult> {
  if (options.scratch) throw new ArchiveError('SCRATCH_NOT_AVAILABLE', 'Scratch (test-restore) imports are not available yet.');
  return withScrubbedPassphrase(options.passphrase, () => importArchive(options, progress));
}

async function importArchive(options: ImportOptions, progress?: JobProgress): Promise<ImportResult> {
  const step = (s: string, p: number) => progress?.set(s, p);
  step('verify-archive', 1);
  const reader = await ArchiveReader.open(options.filePath, options.passphrase);
  await reader.verifyAll((done, total) => step('verify-archive', 1 + Math.round((done / total) * 15)));
  const manifest = reader.manifest;
  const plan = await getPortabilityPlan();
  const schema = await readSchemaInfo();
  const compat: CompatResult = checkSchemaCompatibility(manifest.tables, plan, manifest.schema.version, schema.version);
  const warnings: string[] = [...compat.warnings];
  const archiveSha256 = await sha256File(options.filePath);

  // Only a super admin creates user rows (H1): decided from the caller's own
  // row, never from the request, so the service enforces it in every mode.
  const callerRow = (await withArchiveConnection((c) => c.query('SELECT is_super_admin, is_active FROM users WHERE id = $1', [options.callerUserId]))).rows[0] as
    { is_super_admin: boolean; is_active: boolean | null } | undefined;
  if (!callerRow || callerRow.is_active === false) throw AppError.forbidden('The importing user is not active.', 'IMPORT_NOT_ALLOWED');
  const createUsers = callerRow.is_super_admin === true;

  // Step 2: id map.
  step('id-map', 17);
  const idMap = new IdMap();
  const newTenantId = idMap.fresh(manifest.source.tenantId);
  progress?.claim(newTenantId);
  const skipped = new Set(compat.skippedTables);
  const tablesInOrder: ManifestTable[] = [];
  for (const t of plan.tables) {
    const mt = manifest.tables.find((m) => m.name === t.name);
    if (mt && !skipped.has(mt.name)) tablesInOrder.push(mt);
  }
  for (const mt of tablesInOrder) {
    const t = plan.byName.get(mt.name)!;
    if (mt.pk !== 'uuid' || !t.pkColumn) continue;
    for await (const line of reader.lines(tablePartName(mt.name))) idMap.fresh(pkOfLine(line, t.pkColumn));
  }
  const accessLinesRaw: string[] = [];
  for await (const line of reader.lines(IDENTITY_ENTRIES.access)) accessLinesRaw.push(line);
  for (const line of accessLinesRaw) idMap.fresh(pkOfLine(line, 'id'));
  const userLinesRaw: string[] = [];
  for await (const line of reader.lines(IDENTITY_ENTRIES.users)) userLinesRaw.push(line);
  const tenantLinesRaw: string[] = [];
  for await (const line of reader.lines(IDENTITY_ENTRIES.tenant)) tenantLinesRaw.push(line);
  if (tenantLinesRaw.length !== 1) throw new ArchiveError('ARCHIVE_CORRUPT', 'The archive is damaged (tenant row).');
  const fileIndex = new Map(manifest.files.map((f) => [`${f.table}/${f.column}/${f.rowId.toLowerCase()}`, f]));
  const files: FileRewriteContext = {
    index: fileIndex,
    explained: explainedAbsences(manifest),
    includeAttachments: manifest.options.includeAttachments,
    notBundled: new Map(),
  };
  const workspaceTenantId = await getWorkspaceTenantId();
  const uploadDir = process.env['UPLOAD_DIR'] || '/data/uploads';
  let provider: StorageProvider | null = null;
  const providerFor = async () => provider ?? (provider = await getProviderForTenant(newTenantId));

  const pendingMarker = path.join(uploadDir, newTenantId, '.import-pending');
  const written: PendingFile[] = [];
  const cleanupFiles = async () => {
    for (const f of written) await f.cleanup().catch(() => undefined);
    fs.rmSync(path.join(uploadDir, newTenantId), { recursive: true, force: true });
    fs.rmSync(path.join(uploadDir, 'signatures', newTenantId), { recursive: true, force: true });
    fs.rmSync(path.join(uploadDir, 'payroll', newTenantId), { recursive: true, force: true });
  };

  return withArchiveConnection(async (client) => {
    try {
      await client.query('BEGIN');
      await applyArchiveSession(client);
      await client.query("SET LOCAL lock_timeout = '5s'");
      await xactLockTenantExclusive(client, newTenantId);
      const unresolved = await mapGlobalRows(client, plan, manifest, idMap, warnings);

      // Tenant row (B6).
      step('tenant', 20);
      const archivedTenant = JSON.parse(idMap.substitute(tenantLinesRaw[0]!)) as Record<string, unknown>;
      const name = options.name?.trim() || restoredName(manifest.source.name);
      await client.query(
        `INSERT INTO tenants (id, name, slug, report_settings, practice_settings, share_settings, is_workspace, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, false, COALESCE($7::timestamptz, now()), now())`,
        [
          newTenantId, name, freshSlug(name),
          archivedTenant['report_settings'] == null ? null : JSON.stringify(archivedTenant['report_settings']),
          archivedTenant['practice_settings'] == null ? null : JSON.stringify(archivedTenant['practice_settings']),
          archivedTenant['share_settings'] == null ? null : JSON.stringify(archivedTenant['share_settings']),
          archivedTenant['created_at'] ?? null,
        ],
      );

      // Identity (owner decision 3).
      step('identity', 22);
      const archivedUsers = userLinesRaw.map((l) => parseIdentityLine<ArchivedUser>(idMap.substitute(l), ['id', 'email', 'password_hash']));
      const archivedAccess = accessLinesRaw.map((l) => parseIdentityLine<ArchivedAccess>(idMap.substitute(l), ['id', 'user_id', 'tenant_id', 'role']));
      const identity = await applyIdentity(client, { idMap, newTenantId, workspaceTenantId, users: archivedUsers, access: archivedAccess, callerUserId: options.callerUserId, createUsers });
      if (identity.skipped.length > 0) warnings.push(`USERS_NOT_CREATED:${identity.skipped.length}`);
      await idMap.loadInto(client);

      // Tables in FK order.
      const deferred: Array<{ table: string; column: string; id: string; value: string }> = [];
      for (let i = 0; i < tablesInOrder.length; i++) {
        const mt = tablesInOrder[i]!;
        const t = plan.byName.get(mt.name)!;
        step(`insert:${mt.name}`, 25 + Math.round((i / tablesInOrder.length) * 45));
        await insertTable(client, reader, plan, t, mt, compat, idMap, newTenantId, unresolved, files, { uploadDir, providerFor }, written, deferred, identity.skipped.length > 0);
      }
      for (const [col, n] of files.notBundled) warnings.push(`FILE_NOT_BUNDLED:${col}:${n}`);
      for (const d of deferred) {
        await client.query(`UPDATE "${d.table}" SET "${d.column}" = $2 WHERE id = $1`, [d.id, d.value]);
      }

      // Files, under the pending marker.
      step('files', 72);
      fs.mkdirSync(path.dirname(pendingMarker), { recursive: true });
      fs.writeFileSync(pendingMarker, JSON.stringify({ archiveId: manifest.archiveId, startedAt: new Date().toISOString() }));
      for (let i = 0; i < written.length; i++) {
        const f = written[i]!;
        await f.write(await reader.readPart(f.part, f.bytes));
        if (i % 20 === 0) step('files', 72 + Math.round((i / written.length) * 10));
      }

      await _importTestHooks.beforeVerify?.({ client, newTenantId, idMap });

      // Verification (B9).
      step('verify-content', 83);
      const verification = await verifyImport({
        client, plan, manifest, compat, idMap, newTenantId,
        files: written.map((f): WrittenFile => ({ table: f.table, column: f.column, rowId: f.rowId, sha256: f.sha256, readBack: f.readBack })),
        identity, archivedUsers, archivedAccess, archivedTenant, callerUserId: options.callerUserId,
      });
      warnings.push(...verification.warnings);

      // After verification: audit row, fingerprint, provenance.
      step('commit', 95);
      await client.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, after_data)
         VALUES ($1, $2, 'create', 'tenant_import', $3, $4::jsonb)`,
        [newTenantId, options.callerUserId, manifest.archiveId, JSON.stringify({
          archiveId: manifest.archiveId, archiveSha256, sourceTenantId: manifest.source.tenantId, sourceName: manifest.source.name, userId: options.callerUserId,
        })],
      );
      const fingerprint = await computeTenantFingerprint(client, plan, newTenantId);
      await client.query(
        `INSERT INTO tenant_archive_imports (tenant_id, scratch, source_tenant_id, archive_id, archive_sha256, fingerprint, created_user_ids, imported_by)
         VALUES ($1, false, $2, $3, $4, $5::jsonb, $6::uuid[], $7)`,
        [newTenantId, manifest.source.tenantId, manifest.archiveId, archiveSha256, JSON.stringify(fingerprint), identity.created, options.callerUserId],
      );
      await client.query('COMMIT');
      fs.rmSync(pendingMarker, { force: true });
      return {
        tenantId: newTenantId,
        name,
        scratch: false,
        archiveId: manifest.archiveId,
        sourceTenantId: manifest.source.tenantId,
        verification,
        host: manifest.host,
        warnings: [...new Set(warnings)].sort(),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      await cleanupFiles();
      throw err;
    }
  });
}

interface FileRewriteContext {
  /** `table/column/rowId` -> manifest file entry. */
  index: Map<string, ArchiveManifest['files'][number]>;
  /** `table.column:rowId` keys whose absence the exporting engine recorded (warnings). */
  explained: Set<string>;
  includeAttachments: boolean;
  /** `table.column` -> rows whose file value was dropped with an explanation. */
  notBundled: Map<string, number>;
}

/** The file absences the manifest explains: a missing/mismatched/external file warning, per row. */
function explainedAbsences(manifest: ArchiveManifest): Set<string> {
  const out = new Set<string>();
  for (const w of manifest.warnings) {
    const m = /^(FILE_MISSING|FILE_SIZE_MISMATCH|EXTERNAL_FILE):([a-z0-9_]+\.[a-z0-9_]+):([0-9a-f-]{36})$/i.exec(w);
    if (m) out.add(`${m[2]!.toLowerCase()}:${m[3]!.toLowerCase()}`);
  }
  return out;
}

async function insertTable(
  client: ArchiveClient,
  reader: ArchiveReader,
  plan: PortabilityPlan,
  t: TablePlan,
  mt: ManifestTable,
  compat: CompatResult,
  idMap: IdMap,
  newTenantId: string,
  unresolved: Set<string>,
  files: FileRewriteContext,
  fileCtx: { uploadDir: string; providerFor: () => Promise<StorageProvider> },
  written: PendingFile[],
  deferred: Array<{ table: string; column: string; id: string; value: string }>,
  usersSkipped: boolean,
): Promise<void> {
  const tc = compat.tables.find((c) => c.table === mt.name)!;
  const archiveCols = new Set(mt.columns.map(([c]) => c));
  const cols = tc.insertColumns.filter((c) => archiveCols.has(c));
  const selectList = [...cols.map((c) => `r."${c}"`), ...tc.backfill.map((b) => `(${b.expression})`)].join(', ');
  const colList = [...cols, ...tc.backfill.map((b) => b.column)].map((c) => `"${c}"`).join(', ');
  const sql = `INSERT INTO "${mt.name}" (${colList}) SELECT ${selectList} FROM json_populate_recordset(NULL::"${mt.name}", $1::json) r`;
  const globalCols = new Set<string>([
    ...t.globalFks.filter((g) => g.strategy === 'map-by-natural-key').map((g) => g.column),
    ...t.softRefs.filter((s) => s.cls.startsWith('global-ref:') || s.cls.startsWith('mixed-ref:')).map((s) => s.column),
  ]);
  const nullCols = t.nullOnImport.filter((c) => archiveCols.has(c));
  const deferredCols = t.deferredColumns.filter((c) => archiveCols.has(c));
  // provider-key columns first so path mirrors can see the new key.
  const fileCols = [...t.fileColumns].sort((a, b) => (a.rule.resolver === 'provider-path-mirror' ? 1 : 0) - (b.rule.resolver === 'provider-path-mirror' ? 1 : 0))
    .filter((f) => archiveCols.has(f.column));
  let batch: string[] = [];
  let batchBytes = 0;
  let inserted = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    let r: { rowCount: number | null };
    try {
      r = await client.query(sql, [`[${batch.join(',')}]`]);
    } catch (err) {
      // A row that belongs to a user this caller could not create (a NOT NULL
      // FK to users) cannot be restored without creating the user: say so
      // instead of surfacing the constraint error.
      const pgErr = err as { code?: string; constraint?: string };
      if (usersSkipped && pgErr.code === '23503' && /user/.test(pgErr.constraint ?? '')) {
        throw new ArchiveError('IMPORT_NEEDS_SUPER_ADMIN', `The archive holds rows of users this import could not create (${mt.name}); the owner must restore it.`, { table: mt.name });
      }
      throw err;
    }
    inserted += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) !== batch.length) throw new ArchiveError('ARCHIVE_VERIFY_FAILED', 'Row count mismatch during insert.', { table: mt.name });
    batch = [];
    batchBytes = 0;
  };
  const hasTenantId = archiveCols.has('tenant_id') && t.columns.some((c) => c.name === 'tenant_id');
  for await (const raw of reader.lines(tablePartName(mt.name))) {
    let line = idMap.substitute(raw);
    const oldPk = t.pkColumn && mt.pk === 'uuid' ? pkOfLine(raw, t.pkColumn) : null;
    const newPk = oldPk ? idMap.get(oldPk)! : null;
    // Every row belongs to the new tenant, whatever the archive line says (M1).
    if (hasTenantId) line = rewriteField(line, 'tenant_id', JSON.stringify(newTenantId));
    for (const c of globalCols) {
      const v = fieldString(line, c);
      if (v && unresolved.has(v.toLowerCase())) line = rewriteField(line, c, 'null');
    }
    for (const c of nullCols) line = rewriteField(line, c, 'null');
    for (const c of deferredCols) {
      const v = fieldString(line, c);
      if (v && newPk) {
        deferred.push({ table: mt.name, column: c, id: newPk, value: v });
        line = rewriteField(line, c, 'null');
      }
    }
    // File columns are rewritten on every row, whatever the pk shape (H2): a
    // row that cannot address a bundled file (no uuid pk) simply has none.
    if (fileCols.length > 0) {
      const siblings: Record<string, string | null> = {};
      const rowId = newPk ?? crypto.randomUUID();
      for (const f of fileCols) {
        let oldValue = fieldString(line, f.column);
        // Legacy rows keep the key only in the path column: use it for the extension.
        if (oldValue === null && f.rule.fallbackPathColumn) oldValue = fieldString(raw, f.rule.fallbackPathColumn);
        const bundled = oldPk ? files.index.get(`${mt.name}/${f.column}/${oldPk}`) : undefined;
        const target = resolveForImport(f.rule, { uploadDir: fileCtx.uploadDir, provider: fileCtx.providerFor }, newTenantId, rowId, oldValue, bundled !== undefined, siblings);
        let value = target.value;
        if (target.nulled) {
          const key = `${mt.name}.${f.column}`;
          // A path mirror follows its key column, which was judged just before it.
          const explained = f.rule.resolver === 'provider-path-mirror'
            || (mt.name === 'attachments' && !files.includeAttachments)
            || (oldPk !== null && files.explained.has(`${key}:${oldPk}`));
          if (!explained) {
            throw new ArchiveError('ARCHIVE_CORRUPT', `The archive is damaged (${key}: a file value without a bundled file).`, { table: mt.name, column: f.column });
          }
          const nullable = t.columns.find((c) => c.name === f.column)?.nullable ?? true;
          value = nullable ? null : (target.placeholder ?? null);
          if (!nullable && value === null) throw new ArchiveError('FILE_MISSING', `A file of ${mt.name} is missing from the archive.`, { table: mt.name, column: f.column });
          files.notBundled.set(key, (files.notBundled.get(key) ?? 0) + 1);
        }
        siblings[f.column] = value;
        line = rewriteField(line, f.column, value === null ? 'null' : JSON.stringify(value));
        if (bundled && target.write && newPk) {
          const value = target.value!;
          const localPath = target.localPath;
          const isSignature = f.rule.resolver === 'upload-encrypted';
          const readBack = async (): Promise<Buffer> => {
            if (f.rule.resolver === 'provider-key') return (await fileCtx.providerFor()).download(value);
            const bytes = await fs.promises.readFile(localPath!);
            return isSignature ? decryptBuffer(bytes.toString('utf8')) : bytes;
          };
          const cleanup = async (): Promise<void> => {
            if (f.rule.resolver === 'provider-key') await (await fileCtx.providerFor()).delete(value).catch(() => undefined);
            if (localPath) fs.rmSync(localPath, { force: true });
          };
          written.push({ part: filePartName(mt.name, f.column, oldPk!), bytes: bundled.bytes, sha256: bundled.sha256, table: mt.name, column: f.column, rowId: newPk, write: target.write, readBack, cleanup });
        }
      }
    }
    batch.push(line);
    batchBytes += line.length;
    if (batch.length >= BATCH_ROWS || batchBytes >= BATCH_BYTES) await flush();
  }
  await flush();
  if (inserted !== mt.rows) throw new ArchiveError('ARCHIVE_VERIFY_FAILED', 'Row count mismatch during insert.', { table: mt.name, expected: mt.rows, actual: inserted });
}

/**
 * Removes `.import-pending` upload dirs whose tenant row does not exist
 * (boot and hourly sweep). A running import has no tenant row yet either
 * (it commits last), so the sweep skips every id an in-process job has
 * claimed and every tenant id whose advisory lock is held (M2).
 */
export async function sweepImportPending(uploadDir = process.env['UPLOAD_DIR'] || '/data/uploads'): Promise<number> {
  if (!fs.existsSync(uploadDir)) return 0;
  const { db } = await import('../../db/index.js');
  const { sql } = await import('drizzle-orm');
  const { activeJobResources } = await import('./jobs.js');
  const { tenantLockIsFree } = await import('./export.service.js');
  const active = activeJobResources();
  let removed = 0;
  for (const d of fs.readdirSync(uploadDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^[0-9a-f-]{36}$/.test(d.name)) continue;
    if (active.has(d.name.toLowerCase())) continue;
    const marker = path.join(uploadDir, d.name, '.import-pending');
    if (!fs.existsSync(marker)) continue;
    const exists = (await db.execute(sql`SELECT 1 FROM tenants WHERE id = ${d.name}`)).rows.length > 0;
    if (exists) continue;
    if (!(await tenantLockIsFree(d.name))) continue;
    fs.rmSync(path.join(uploadDir, d.name), { recursive: true, force: true });
    fs.rmSync(path.join(uploadDir, 'signatures', d.name), { recursive: true, force: true });
    fs.rmSync(path.join(uploadDir, 'payroll', d.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Uploaded archives are deleted when their job ends; one older than this with no job is a leftover. */
export const STALE_UPLOAD_MS = 60 * 60 * 1000;

/** Removes `*.upload.zip` files in the imports directory that no job claims and that are older than STALE_UPLOAD_MS. */
export async function sweepStaleUploads(importsDir: string, now = Date.now()): Promise<number> {
  if (!fs.existsSync(importsDir)) return 0;
  const { activeJobResources } = await import('./jobs.js');
  const active = activeJobResources();
  let removed = 0;
  for (const f of fs.readdirSync(importsDir)) {
    if (!f.endsWith('.upload.zip')) continue;
    const full = path.join(importsDir, f);
    if (active.has(full.toLowerCase()) || active.has(path.resolve(full).toLowerCase())) continue;
    let mtime: number;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime < STALE_UPLOAD_MS) continue;
    fs.rmSync(full, { force: true });
    removed++;
  }
  return removed;
}
