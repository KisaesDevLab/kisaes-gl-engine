// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Tenant archive export (U-05 step 33c).
 *
 * One dedicated connection holds a session-level shared advisory lock on
 * the tenant for the whole job. Inside one REPEATABLE READ, READ ONLY
 * snapshot every archived table is streamed through a server-side cursor
 * that returns two strings per row: the archive projection line (hashed,
 * then encrypted into the part) and the canonical projection line (hashed
 * into the content digest). JS never parses or edits a row. Files are read
 * after the rows, the trial balance, counters and fingerprint come from the
 * same snapshot, and the manifest is the last entry. The file is written as
 * `<archiveId>.partial` and renamed on success. On success one
 * `tenant_archive` audit row is written in the exported tenant (S-e); a
 * failed export writes none.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { isDesktop } from '../../desktop/profile.js';
import { isWorkspaceTenant } from '../../desktop/workspace.js';
import { readSchemaInfo } from '../../startup/schema-info.js';
import { getCurrentVersion } from '../updates.service.js';
import { getProviderForTenant } from '../storage/storage-provider.factory.js';
import type { StorageProvider } from '../storage/storage-provider.interface.js';
import { AppError } from '../../utils/errors.js';
import { decrypt } from '../../utils/encryption.js';
import { errorSummaryForLog } from '../../utils/log-safe.js';
import { ArchiveZipWriter, sha256File } from './archive-container.js';
import { assertPassphraseStrong, createEnvelopeAsync, NoncePrefixRegistry, withScrubbedPassphrase } from './archive-crypto.js';
import { ArchiveError } from './errors.js';
import { resolveForExport } from './files.js';
import { computeTenantFingerprint, computeTrialBalance, countUnbalancedTransactions, ledgerVersionSum } from './fingerprint.js';
import {
  HOST_MAX_BYTES, IDENTITY_ENTRIES, MANIFEST_ENTRY, filePartName, tablePartName,
  type ArchiveManifest, type ManifestFile, type ManifestTable,
} from './format.js';
import { ARCHIVE_PASSWORD_PLACEHOLDER, usersProjectionSql } from './identity.js';
import type { JobProgress } from './jobs.js';
import {
  ARCHIVE_AUDIT_ENTITY_TYPE, EXCLUDED_TENANT_ARCHIVE_TABLES, NATURAL_KEYS, getPortabilityPlan, scopeSql,
  type PortabilityPlan, type TablePlan,
} from './plan.js';
import { digestFor, fieldString, pkOfLine, rewriteField } from './remap.js';
import { activeJobResources } from './jobs.js';
import { acquireSharedTenantLock, applyArchiveSession, releaseSharedTenantLock, tryExclusiveTenantLock, withArchiveConnection, type ArchiveClient } from './session.js';

export interface ExportOptions {
  includeAttachments?: boolean;
  includeAudit?: boolean;
  host?: Record<string, unknown>;
  passphrase: string;
  /** Pre-assigned archive id (the route returns it with the job id). */
  archiveId?: string;
}

export interface ExportResult {
  archiveId: string;
  fileName: string;
  /** Absolute path of the archive file (the routes expose it on desktop only). */
  path: string;
  bytes: number;
  /** SHA-256 of the archive file (ciphertext). */
  sha256: string;
  manifestSummary: {
    tables: number;
    rows: number;
    files: number;
    fileBytes: number;
    schema: ArchiveManifest['schema'];
    source: ArchiveManifest['source'];
    unbalancedTransactions: number;
  };
  warnings: string[];
}

const FETCH_SIZE = 1000;

/** Directory that holds archives: CL_ARCHIVE_DIR (desktop) or DATA_DIR/tenant-archives. */
export function archiveDir(): string {
  return process.env['CL_ARCHIVE_DIR'] || path.join(process.env['DATA_DIR'] || '/data', 'tenant-archives');
}

export function archiveFileName(archiveId: string): string {
  return `${archiveId}.zip`;
}

/** Test hooks (never set in production). */
export const _exportTestHooks: {
  /** Called after the snapshot rows are written, before the file is finalized. */
  beforeFinalize?: (ctx: { tenantId: string }) => Promise<void> | void;
  /** Called while the shared lock is held, after the file is complete. */
  whileLocked?: (ctx: { tenantId: string }) => Promise<void> | void;
  /** Makes the success audit insert fail (AUDIT_NOT_WRITTEN path). */
  failAudit?: boolean;
} = {};

function orderBySql(t: TablePlan): string {
  if (t.pk === 'uuid' || t.pk === 'omit-pk') return `a."${t.pkColumn}"`;
  return t.archive.map((c) => `a."${c.name}"::text`).join(', ');
}

/** The two-projection cursor query for a table. */
export function tableCursorSql(plan: PortabilityPlan, t: TablePlan, includeAudit: boolean): string {
  const scope = t.name === 'audit_log' && !includeAudit ? 'false' : scopeSql(plan, t.name, 'a');
  const archive = t.archive.map((c) => c.select).join(', ');
  const canonical = t.canonical.map((c) => `a."${c}"`).join(', ');
  return `SELECT row_to_json(a)::text AS line, row_to_json(c)::text AS canon
          FROM (SELECT ${archive} FROM "${t.name}" a WHERE ${scope}) a
          CROSS JOIN LATERAL (SELECT ${canonical}) c
          ORDER BY ${orderBySql(t)}`;
}

interface FileRef {
  table: string;
  column: string;
  rowId: string;
  value: string | null;
  row: Record<string, string | null>;
}

interface GlobalRefCollector {
  /** target table -> set of referenced ids */
  byTable: Map<string, Set<string>>;
}

/**
 * Streams one table into the archive. Returns the manifest entry. Also
 * collects file references and referenced global ids from the line text.
 */
async function writeTable(
  client: ArchiveClient,
  writer: ArchiveZipWriter,
  plan: PortabilityPlan,
  t: TablePlan,
  tenantId: string,
  includeAudit: boolean,
  files: FileRef[],
  globals: GlobalRefCollector,
  warnings: string[],
): Promise<ManifestTable> {
  const cursor = `c_${t.name}`;
  await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${tableCursorSql(plan, t, includeAudit)}`, [tenantId]);
  const pass = new PassThrough();
  const written = writer.writePart(tablePartName(t.name), pass);
  const digest = digestFor(t.pk);
  let rows = 0;
  const fileCols = t.fileColumns.filter((f) => f.rule.resolver !== 'provider-path-mirror');
  const extraCols = new Set<string>();
  for (const f of fileCols) {
    for (const c of [f.rule.fallbackPathColumn, f.rule.sizeColumn, f.rule.sha256Column]) if (c) extraCols.add(c);
  }
  const globalCols = [
    ...t.globalFks.filter((g) => g.strategy === 'map-by-natural-key').map((g) => ({ column: g.column, target: g.refTable })),
    ...t.softRefs.filter((s) => s.cls.startsWith('global-ref:') && s.cls !== 'global-ref:null').map((s) => ({ column: s.column, target: s.cls.slice('global-ref:'.length) })),
    ...t.softRefs.filter((s) => s.cls.startsWith('mixed-ref:')).map((s) => ({ column: s.column, target: s.cls.slice('mixed-ref:'.length) })),
  ];
  try {
    for (;;) {
      const r = await client.query(`FETCH ${FETCH_SIZE} FROM ${cursor}`);
      const batch = r.rows as Array<{ line: string; canon: string }>;
      if (batch.length === 0) break;
      let chunk = '';
      for (const row of batch) {
        // Re-encrypted columns (M5): the install-key ciphertext becomes the
        // plaintext value inside the passphrase-encrypted archive; a value
        // this install cannot decrypt travels as NULL with a warning.
        for (const c of t.reencryptColumns) {
          const v = fieldString(row.line, c);
          if (v === null) continue;
          try {
            row.line = rewriteField(row.line, c, JSON.stringify(decrypt(v)));
          } catch {
            row.line = rewriteField(row.line, c, 'null');
            warnings.push(`TIN_UNREADABLE:${t.name}.${c}:${t.pkColumn ? pkOfLine(row.line, t.pkColumn) : '?'}`);
          }
        }
        chunk += `${row.line}\n`;
        digest.add(row.canon);
        rows++;
        if (fileCols.length > 0 && t.pkColumn) {
          const rowId = pkOfLine(row.line, t.pkColumn);
          const extra: Record<string, string | null> = {};
          for (const c of extraCols) extra[c] = fieldString(row.line, c);
          for (const f of fileCols) files.push({ table: t.name, column: f.column, rowId, value: fieldString(row.line, f.column), row: extra });
        }
        for (const g of globalCols) {
          const v = fieldString(row.line, g.column);
          if (v) {
            if (!globals.byTable.has(g.target)) globals.byTable.set(g.target, new Set());
            globals.byTable.get(g.target)!.add(v.toLowerCase());
          }
        }
      }
      if (!pass.write(chunk)) await new Promise<void>((resolve) => pass.once('drain', resolve));
    }
    pass.end();
    const part = await written;
    return {
      name: t.name, bucket: t.bucket, pk: t.pk, rows, sha256: part.sha256, contentDigest: digest.hex(),
      columns: t.archive.map((c) => [c.name, c.type]), bytes: part.bytes,
    };
  } finally {
    await client.query(`CLOSE ${cursor}`).catch(() => undefined);
  }
}

async function writeIdentityPart(writer: ArchiveZipWriter, partName: string, lines: string[]): Promise<{ sha256: string; bytes: number; rows: number }> {
  const body = Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8');
  const part = await writer.writePart(partName, body);
  return { ...part, rows: lines.length };
}

/** Natural-key values of the referenced global/system rows, so the import can map them. */
async function collectGlobalRows(client: ArchiveClient, plan: PortabilityPlan, globals: GlobalRefCollector): Promise<Record<string, Record<string, Record<string, unknown>>>> {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [table, ids] of globals.byTable) {
    const nk = NATURAL_KEYS[table];
    if (!nk || ids.size === 0) continue;
    const cols = nk.columns.map((c) => `"${c}"`).join(', ');
    const mixed = plan.live.tables.get(table)?.columns.some((c) => c.name === 'tenant_id');
    const r = await client.query(
      `SELECT id, ${cols} FROM "${table}" WHERE id = ANY($1::uuid[])${mixed ? ' AND tenant_id IS NULL' : ''}`,
      [[...ids]],
    );
    out[table] = {};
    for (const row of r.rows as Array<Record<string, unknown>>) {
      const { id, ...rest } = row;
      out[table]![String(id)] = rest;
    }
  }
  return out;
}

/** Export checks that refuse or warn: firm-owned references, server-feature rows, dangling tenant references. */
async function exportChecks(client: ArchiveClient, plan: PortabilityPlan, tenantId: string, warnings: string[]): Promise<void> {
  // Rule 4a: NOT NULL FK columns into a mixed-ownership table must point at rows in scope.
  for (const t of plan.tables) {
    for (const fk of plan.live.fks.filter((f) => f.table === t.name)) {
      const target = plan.byName.get(fk.refTable);
      if (!target || fk.columns.length !== 1) continue;
      const targetLive = plan.live.tables.get(fk.refTable)!;
      const mixed = targetLive.columns.some((c) => c.name === 'tenant_id' && c.nullable);
      if (!mixed) continue;
      const col = fk.columns[0]!;
      const nullable = t.columns.find((c) => c.name === col)?.nullable ?? true;
      const r = await client.query(
        `SELECT count(*)::int AS n FROM "${t.name}" a WHERE ${scopeSql(plan, t.name, 'a')} AND a."${col}" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "${fk.refTable}" x WHERE x."${fk.refColumns[0]}" = a."${col}" AND ${scopeSql(plan, fk.refTable, 'x')})`,
        [tenantId],
      );
      const n = (r.rows[0] as { n: number }).n;
      if (n > 0 && !nullable) {
        throw new ArchiveError('ARCHIVE_UNSUPPORTED_REFERENCE', `${t.name}.${col} references rows outside the company (${fk.refTable}); this company cannot be archived.`, { table: t.name, column: col, target: fk.refTable, rows: n });
      }
      if (n > 0) warnings.push(`OUTSIDE_REFERENCE:${t.name}.${col}:${n}`);
    }
  }
  // Rule 1 (N6): server-feature rows in scope make the archive ineligible for delete.
  const serverFeature: string[] = [];
  for (const [name, e] of Object.entries(EXCLUDED_TENANT_ARCHIVE_TABLES)) {
    if (e.category !== 'server-feature' || e.scope === 'none') continue;
    const r = await client.query(`SELECT count(*)::int AS n FROM "${name}" a WHERE ${scopeSql(plan, name, 'a')}`, [tenantId]);
    if ((r.rows[0] as { n: number }).n > 0) serverFeature.push(name);
  }
  if (serverFeature.length > 0) warnings.push(`SERVER_FEATURE_ROWS:${serverFeature.sort().join(',')}`);
  // Rule 4b: dangling tenant references are warnings.
  for (const t of plan.tables) {
    for (const s of t.softRefs) {
      if (!s.cls.startsWith('tenant-ref:') || s.isArray) continue;
      const target = s.cls.slice('tenant-ref:'.length);
      const r = await client.query(
        `SELECT count(*)::int AS n FROM "${t.name}" a WHERE ${scopeSql(plan, t.name, 'a')} AND a."${s.column}" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "${target}" x WHERE x.id = a."${s.column}" AND ${scopeSql(plan, target, 'x')})`,
        [tenantId],
      );
      const n = (r.rows[0] as { n: number }).n;
      if (n > 0) warnings.push(`DANGLING_REFERENCE:${t.name}.${s.column}:${n}`);
    }
  }
}

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Runs an export. Throws ArchiveError / AppError; the caller wraps it in a job. */
export async function runExport(tenantId: string, userId: string, options: ExportOptions, progress?: JobProgress): Promise<ExportResult> {
  const includeAttachments = options.includeAttachments ?? true;
  const includeAudit = options.includeAudit ?? true;
  const host = options.host ?? {};
  if (Buffer.byteLength(JSON.stringify(host), 'utf8') > HOST_MAX_BYTES) throw AppError.badRequest('host metadata is too large (16 KiB)', 'VALIDATION_ERROR');
  if (await isWorkspaceTenant(tenantId)) throw new ArchiveError('WORKSPACE_TENANT', 'The workspace is never archived.');
  assertPassphraseStrong(options.passphrase);
  const archiveId = options.archiveId ?? crypto.randomUUID();
  return withScrubbedPassphrase(options.passphrase, () => exportLocked(tenantId, userId, { includeAttachments, includeAudit, host, passphrase: options.passphrase, archiveId }, progress));
}

async function exportLocked(
  tenantId: string,
  userId: string,
  o: { includeAttachments: boolean; includeAudit: boolean; host: Record<string, unknown>; passphrase: string; archiveId: string },
  progress?: JobProgress,
): Promise<ExportResult> {
  const plan = await getPortabilityPlan();
  const archiveId = o.archiveId;
  progress?.claim(tenantId);
  progress?.claim(archiveId);
  const dir = path.join(archiveDir(), tenantId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = path.join(dir, `${archiveId}.partial`);
  const finalPath = path.join(dir, archiveFileName(archiveId));
  const warnings: string[] = [];
  const step = (s: string, p: number) => progress?.set(s, p);

  return withArchiveConnection(async (client) => {
    await acquireSharedTenantLock(client, tenantId);
    let writer: ArchiveZipWriter | null = null;
    try {
      step('snapshot', 1);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await applyArchiveSession(client);
      const tenantRow = (await client.query('SELECT id, name, is_workspace FROM tenants WHERE id = $1', [tenantId])).rows[0] as { id: string; name: string; is_workspace: boolean } | undefined;
      if (!tenantRow) throw AppError.notFound('Company not found');
      if (tenantRow.is_workspace) throw new ArchiveError('WORKSPACE_TENANT', 'The workspace is never archived.');

      const registry = new NoncePrefixRegistry();
      const { envelope, key } = await createEnvelopeAsync(archiveId, o.passphrase, registry);
      writer = new ArchiveZipWriter(partial, key, archiveId);
      await writer.writeEnvelope(envelope);

      // Identity section (B6, S7).
      const tenantCols = plan.live.tables.get('tenants')!.columns.filter((c) => c.name !== 'is_workspace').map((c) => `t."${c.name}"`).join(', ');
      const tenantLine = (await client.query(`SELECT row_to_json(x)::text AS j FROM (SELECT ${tenantCols} FROM tenants t WHERE t.id = $1) x`, [tenantId])).rows[0] as { j: string };
      // Password hashes travel only for a super admin caller, and never a super admin's own (H4).
      const caller = (await client.query('SELECT is_super_admin FROM users WHERE id = $1', [userId])).rows[0] as { is_super_admin: boolean } | undefined;
      const includeHashes = caller?.is_super_admin === true;
      const userLines = (await client.query(
        `SELECT row_to_json(x)::text AS j, (x.password_hash = $3) AS omitted FROM (SELECT ${usersProjectionSql('$2')} FROM users u
           WHERE u.id IN (SELECT user_id FROM user_tenant_access WHERE tenant_id = $1) ORDER BY u.id) x`,
        [tenantId, includeHashes, ARCHIVE_PASSWORD_PLACEHOLDER],
      )).rows as Array<{ j: string; omitted: boolean }>;
      const omittedHashes = userLines.filter((r) => r.omitted).length;
      if (omittedHashes > 0) warnings.push(`PASSWORD_HASHES_OMITTED:${omittedHashes}`);
      const accessLines = (await client.query(
        `SELECT row_to_json(x)::text AS j FROM (SELECT a.* FROM user_tenant_access a WHERE a.tenant_id = $1 ORDER BY a.id) x`,
        [tenantId],
      )).rows as Array<{ j: string }>;
      const identityParts: ArchiveManifest['identity']['parts'] = {};
      identityParts[IDENTITY_ENTRIES.tenant] = await writeIdentityPart(writer, IDENTITY_ENTRIES.tenant, [tenantLine.j]);
      identityParts[IDENTITY_ENTRIES.users] = await writeIdentityPart(writer, IDENTITY_ENTRIES.users, userLines.map((r) => r.j));
      identityParts[IDENTITY_ENTRIES.access] = await writeIdentityPart(writer, IDENTITY_ENTRIES.access, accessLines.map((r) => r.j));

      // Tables in FK order.
      const files: FileRef[] = [];
      const globals: GlobalRefCollector = { byTable: new Map() };
      const tables: ManifestTable[] = [];
      let totalRows = 0;
      for (let i = 0; i < plan.tables.length; i++) {
        const t = plan.tables[i]!;
        step(`table:${t.name}`, 2 + Math.round((i / plan.tables.length) * 60));
        const mt = await writeTable(client, writer, plan, t, tenantId, o.includeAudit, files, globals, warnings);
        tables.push(mt);
        totalRows += mt.rows;
      }
      if (!o.includeAudit) warnings.push('AUDIT_NOT_INCLUDED');

      // Totals, counters, fingerprint and checks in the same snapshot.
      step('totals', 64);
      const trialBalance = await computeTrialBalance(client, tenantId);
      const unbalancedTransactions = await countUnbalancedTransactions(client, tenantId);
      const fingerprint = await computeTenantFingerprint(client, plan, tenantId, trialBalance);
      const ledgerVersion = await ledgerVersionSum(client, tenantId);
      await exportChecks(client, plan, tenantId, warnings);
      const globalRows = await collectGlobalRows(client, plan, globals);
      const schema = await readSchemaInfo();

      // Files (rule 7), read after the rows.
      step('files', 70);
      const manifestFiles: ManifestFile[] = [];
      let provider: StorageProvider | null = null;
      const providerFor = async () => provider ?? (provider = await getProviderForTenant(tenantId));
      const uploadDir = process.env['UPLOAD_DIR'] || '/data/uploads';
      let fileBytes = 0;
      const desktop = isDesktop();
      if (!o.includeAttachments) warnings.push('ATTACHMENTS_NOT_INCLUDED');
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        if (f.table === 'attachments' && !o.includeAttachments) continue;
        const rule = plan.byName.get(f.table)!.fileColumns.find((c) => c.column === f.column)!.rule;
        const read = resolveForExport(rule, { uploadDir, provider: providerFor }, f.value, f.row);
        if (read.kind === 'external') {
          warnings.push(`EXTERNAL_FILE:${f.table}.${f.column}:${f.rowId}`);
          continue;
        }
        if (read.kind !== 'bundle') continue;
        let bytes: Buffer;
        try {
          bytes = await read.read!();
        } catch (err) {
          if (desktop) {
            const code = err instanceof ArchiveError && err.code === 'FILE_SIZE_MISMATCH' ? 'FILE_SIZE_MISMATCH' : 'FILE_MISSING';
            throw new ArchiveError(code, `A file of ${f.table} could not be read.`, { table: f.table, rowId: f.rowId });
          }
          warnings.push(`FILE_MISSING:${f.table}.${f.column}:${f.rowId}`);
          continue;
        }
        if (rule.sizeColumn) {
          const declared = f.row[rule.sizeColumn];
          if (declared !== null && declared !== undefined && Number(declared) !== bytes.length) {
            if (desktop) throw new ArchiveError('FILE_SIZE_MISMATCH', `A file of ${f.table} does not match its recorded size.`, { table: f.table, rowId: f.rowId });
            warnings.push(`FILE_SIZE_MISMATCH:${f.table}.${f.column}:${f.rowId}`);
            continue;
          }
        }
        const part = await writer.writePart(filePartName(f.table, f.column, f.rowId), bytes);
        manifestFiles.push({ table: f.table, column: f.column, rowId: f.rowId, resolver: rule.resolver, bytes: part.bytes, sha256: part.sha256 });
        fileBytes += part.bytes;
        if (i % 50 === 0) step('files', 70 + Math.round((i / files.length) * 20));
      }

      const manifest: ArchiveManifest = {
        format: 'mybooks-tenant-archive',
        formatVersion: 1,
        archiveId,
        engine: { version: getCurrentVersion(), commit: process.env['ENGINE_COMMIT'] || null },
        schema: { version: schema.version, tag: schema.tag },
        createdAt: new Date().toISOString(),
        source: { tenantId, name: tenantRow.name, ledgerVersion },
        options: { includeAttachments: o.includeAttachments, includeAudit: o.includeAudit },
        host: o.host,
        tables,
        identity: { ...IDENTITY_ENTRIES, parts: identityParts },
        files: manifestFiles,
        trialBalance,
        unbalancedTransactions,
        fingerprint,
        excludedTables: Object.fromEntries(Object.entries(EXCLUDED_TENANT_ARCHIVE_TABLES).map(([n, e]) => [n, { category: e.category, reason: e.reason }])),
        redactedColumns: plan.redactedColumns,
        nulledReferences: Object.fromEntries(plan.tables.flatMap((t) => t.nulledReferences.map((n) => [`${t.name}.${n.column}`, `references excluded or global table ${n.target}`]))),
        warnings: [...new Set(warnings)].sort(),
        globalRows,
        canonical: Object.fromEntries(plan.tables.map((t) => [t.name, t.canonical])),
      };
      await _exportTestHooks.beforeFinalize?.({ tenantId });
      step('manifest', 92);
      await writer.writePart(MANIFEST_ENTRY.slice(0, -'.enc'.length), Buffer.from(JSON.stringify(manifest), 'utf8'));
      await writer.finalize();
      writer = null;
      await client.query('COMMIT');
      fsyncFile(partial);
      fs.renameSync(partial, finalPath);
      const stat = fs.statSync(finalPath);
      const sha256 = await sha256File(finalPath);

      // Success audit row, in its own short transaction while the lock is held (S-e).
      step('audit', 97);
      const resultWarnings = [...manifest.warnings];
      try {
        if (_exportTestHooks.failAudit) throw new Error('audit insert failed (test hook)');
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, after_data)
           VALUES ($1, $2, 'create', $3, $4, $5::jsonb)`,
          [tenantId, userId, ARCHIVE_AUDIT_ENTITY_TYPE, archiveId, JSON.stringify({
            archiveId, sha256, bytes: stat.size, includeAttachments: o.includeAttachments, includeAudit: o.includeAudit, userId,
          })],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.warn(`[tenant-archive] export ${archiveId}: audit row not written (${errorSummaryForLog(err)})`);
        resultWarnings.push('AUDIT_NOT_WRITTEN');
      }
      await _exportTestHooks.whileLocked?.({ tenantId });
      return {
        archiveId,
        fileName: archiveFileName(archiveId),
        path: finalPath,
        bytes: stat.size,
        sha256,
        manifestSummary: {
          tables: tables.length, rows: totalRows, files: manifestFiles.length, fileBytes,
          schema: manifest.schema, source: manifest.source, unbalancedTransactions,
        },
        warnings: resultWarnings,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (writer) {
        try {
          writer.abort();
        } catch { /* best effort */ }
      }
      fs.rmSync(partial, { force: true });
      throw err;
    } finally {
      await releaseSharedTenantLock(client, tenantId).catch(() => undefined);
    }
  });
}

/**
 * True when nobody holds the tenant's advisory lock in any mode right now:
 * an export (shared session lock) or an import (exclusive transaction
 * lock) in another process makes the probe fail. The probe's own lock is
 * released with the rollback.
 */
export async function tenantLockIsFree(tenantId: string): Promise<boolean> {
  if (!UUID_DIR_RE.test(tenantId)) return true;
  return withArchiveConnection(async (client) => {
    await client.query('BEGIN');
    try {
      return await tryExclusiveTenantLock(client, tenantId);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  });
}

const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Removes `.partial` archives left by a crash (boot and hourly sweep). A
 * partial of a running job is never touched (M2): the sweep skips every
 * tenant id and archive id an in-process job has claimed, and then every
 * tenant whose advisory lock is held (an export in another process).
 */
export async function sweepPartialArchives(root = archiveDir()): Promise<number> {
  let removed = 0;
  if (!fs.existsSync(root)) return 0;
  const active = activeJobResources();
  for (const tenantDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!tenantDir.isDirectory()) continue;
    if (active.has(tenantDir.name.toLowerCase())) continue;
    const dir = path.join(root, tenantDir.name);
    const partials = fs.readdirSync(dir).filter((f) => f.endsWith('.partial') && !active.has(f.slice(0, -'.partial'.length).toLowerCase()));
    if (partials.length === 0) continue;
    if (!(await tenantLockIsFree(tenantDir.name))) continue;
    for (const f of partials) {
      fs.rmSync(path.join(dir, f), { force: true });
      removed++;
    }
  }
  return removed;
}
