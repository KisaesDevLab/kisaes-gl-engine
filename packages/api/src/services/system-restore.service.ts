// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Dynamic, FK-ordered database restore for disaster-recovery bundles.
//
// The old restore hardcoded a handful of INSERTs and swallowed every per-row
// failure, so an FK arriving before its parent silently dropped rows and the
// operator never learned. This engine instead:
//   1. topologically orders the bundle's tables by the LIVE database's
//      foreign-key graph (parents first),
//   2. inserts with ON CONFLICT DO NOTHING, distinguishing genuine inserts
//      from conflict-skips (expected against seeded rows like coa_templates),
//   3. re-attempts failed rows in multiple passes until a pass makes no
//      progress (handles FK cycles and intra-table self-references), and
//   4. reports every remaining failure per table — nothing is swallowed.

import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import type { db as DbType } from '../db/index.js';
import { decodeFileEntryId } from './backup-file-registry.js';

type Db = Pick<typeof DbType, 'execute'>;

const MAX_RESTORE_PASSES = 10;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export interface TableRestoreStats {
  attempted: number;
  inserted: number;
  conflicts: number;
  failed: number;
  sampleErrors: string[];
}

export interface RestoreReport {
  perTable: Record<string, TableRestoreStats>;
  totals: { attempted: number; inserted: number; conflicts: number; failed: number };
  /** Tables that were part of an FK cycle (ordering best-effort, fixpoint covers them). */
  orderingCycles: string[];
  passes: number;
}

/**
 * Insert rows into one table. Column list comes from each row; conflicts
 * skip (restore never overwrites); failures are RETURNED, not swallowed.
 */
export async function restoreTableRows(
  dbi: Db,
  tableName: string,
  rows: Record<string, unknown>[],
): Promise<{ inserted: number; conflicts: number; failed: Array<{ row: Record<string, unknown>; error: string }> }> {
  const out = { inserted: 0, conflicts: 0, failed: [] as Array<{ row: Record<string, unknown>; error: string }> };
  if (!rows.length || !IDENT_RE.test(tableName)) return out;

  for (const row of rows) {
    const cols = Object.keys(row).filter((k) => IDENT_RE.test(k));
    if (cols.length === 0) continue;

    const colNames = cols.map((c) => sql.identifier(c));
    const values = cols.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return sql`NULL`;
      if (typeof v === 'object') return sql`${JSON.stringify(v)}::jsonb`;
      return sql`${String(v)}`;
    });

    try {
      const colList = sql.join(colNames, sql`, `);
      const valList = sql.join(values, sql`, `);
      const res = await dbi.execute(
        sql`INSERT INTO ${sql.identifier(tableName)} (${colList}) VALUES (${valList}) ON CONFLICT DO NOTHING`,
      );
      if (((res as { rowCount?: number | null }).rowCount ?? 0) > 0) out.inserted += 1;
      else out.conflicts += 1;
    } catch (err) {
      out.failed.push({ row, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** FK edges (child → parent) between public-schema tables, from the live DB. */
export async function getPublicFkEdges(dbi: Db): Promise<Array<{ child: string; parent: string }>> {
  const res = await dbi.execute(sql`
    SELECT DISTINCT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
    FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace
  `);
  return (res.rows as { child: string; parent: string }[])
    .filter((e) => IDENT_RE.test(e.child) && IDENT_RE.test(e.parent) && e.child !== e.parent);
}

/**
 * Kahn's algorithm, parents first, alphabetical tie-break for determinism.
 * Tables caught in an FK cycle come back in `cyclic` and are appended
 * alphabetically — the multi-pass fixpoint in restoreDatabaseSections
 * resolves their rows.
 */
export function topoOrderTables(
  tables: string[],
  edges: Array<{ child: string; parent: string }>,
): { order: string[]; cyclic: string[] } {
  const inSet = new Set(tables);
  const dependsOn = new Map<string, Set<string>>(); // child -> parents (within set)
  const children = new Map<string, Set<string>>(); // parent -> children (within set)
  for (const t of tables) dependsOn.set(t, new Set());
  for (const e of edges) {
    if (!inSet.has(e.child) || !inSet.has(e.parent)) continue;
    dependsOn.get(e.child)!.add(e.parent);
    if (!children.has(e.parent)) children.set(e.parent, new Set());
    children.get(e.parent)!.add(e.child);
  }

  const order: string[] = [];
  let ready = tables.filter((t) => dependsOn.get(t)!.size === 0).sort();
  const done = new Set<string>();
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    done.add(next);
    const newlyReady: string[] = [];
    for (const child of children.get(next) ?? []) {
      const deps = dependsOn.get(child)!;
      deps.delete(next);
      if (deps.size === 0 && !done.has(child)) newlyReady.push(child);
    }
    if (newlyReady.length > 0) ready = [...ready, ...newlyReady].sort();
  }

  const cyclic = tables.filter((t) => !done.has(t)).sort();
  return { order: [...order, ...cyclic], cyclic };
}

/**
 * Merge every section of a system bundle into one `table → rows[]` map.
 * Handles both v2 bundles (`global_tables`) and v1 bundles, whose
 * `system_config` section (ai_config / system_settings — including the SMTP
 * settings) was exported but never applied by the old restore code.
 */
export function mergeBundleSections(content: {
  tenants?: unknown;
  users?: unknown;
  user_tenant_access?: unknown;
  tenant_data?: Record<string, Record<string, unknown[]>>;
  global_tables?: Record<string, unknown[]>;
  system_config?: Record<string, unknown[]>;
}): Record<string, Record<string, unknown>[]> {
  const sections: Record<string, Record<string, unknown>[]> = {};
  const appendRows = (table: string, rows: unknown) => {
    if (!Array.isArray(rows) || rows.length === 0 || !IDENT_RE.test(table)) return;
    (sections[table] ??= []).push(...(rows as Record<string, unknown>[]));
  };
  appendRows('tenants', content.tenants);
  appendRows('users', content.users);
  appendRows('user_tenant_access', content.user_tenant_access);
  for (const tables of Object.values(content.tenant_data || {})) {
    for (const [tableName, rows] of Object.entries(tables)) appendRows(tableName, rows);
  }
  if (content.global_tables) {
    for (const [tableName, rows] of Object.entries(content.global_tables)) appendRows(tableName, rows);
  } else if (content.system_config) {
    for (const [tableName, rows] of Object.entries(content.system_config)) appendRows(tableName, rows);
  }
  return sections;
}

/**
 * Restore a merged `table → rows[]` map: topo-order by live FK metadata,
 * then multi-pass — each pass re-attempts only the rows that failed the
 * previous one, stopping at fixpoint or MAX_RESTORE_PASSES.
 */
export async function restoreDatabaseSections(
  dbi: Db,
  sections: Record<string, Record<string, unknown>[]>,
): Promise<RestoreReport> {
  const tables = Object.keys(sections).filter((t) => IDENT_RE.test(t) && (sections[t]?.length ?? 0) > 0);
  const { order, cyclic } = topoOrderTables(tables, await getPublicFkEdges(dbi));

  const perTable: Record<string, TableRestoreStats> = {};
  for (const t of tables) {
    perTable[t] = { attempted: sections[t]!.length, inserted: 0, conflicts: 0, failed: 0, sampleErrors: [] };
  }

  let pending: Record<string, Array<{ row: Record<string, unknown>; error: string }>> = {};
  for (const t of order) pending[t] = (sections[t] ?? []).map((row) => ({ row, error: '' }));

  let passes = 0;
  for (let pass = 1; pass <= MAX_RESTORE_PASSES; pass++) {
    passes = pass;
    let progress = false;
    const nextPending: typeof pending = {};
    for (const t of order) {
      const rows = pending[t];
      if (!rows || rows.length === 0) continue;
      const res = await restoreTableRows(dbi, t, rows.map((r) => r.row));
      perTable[t]!.inserted += res.inserted;
      perTable[t]!.conflicts += res.conflicts;
      if (res.inserted > 0 || res.conflicts > 0) progress = true;
      if (res.failed.length > 0) nextPending[t] = res.failed;
    }
    pending = nextPending;
    if (!progress || Object.keys(pending).length === 0) break;
  }

  for (const [t, failed] of Object.entries(pending)) {
    perTable[t]!.failed = failed.length;
    perTable[t]!.sampleErrors = [...new Set(failed.map((f) => f.error))].slice(0, 3);
  }

  const totals = { attempted: 0, inserted: 0, conflicts: 0, failed: 0 };
  for (const s of Object.values(perTable)) {
    totals.attempted += s.attempted;
    totals.inserted += s.inserted;
    totals.conflicts += s.conflicts;
    totals.failed += s.failed;
  }
  return { perTable, totals, orderingCycles: cyclic, passes };
}

/**
 * Resync every column-owned sequence to the max of its column. Restored rows
 * arrive with their original ids, but a plain INSERT does not advance the
 * table's serial/identity sequence — so the first post-restore write to a
 * serial-PK table (audit_log on the very first login, for instance) collides
 * with a restored id and fails with duplicate-key. Iterating pg_depend covers
 * every owned sequence generically, so a future serial table cannot
 * reintroduce the bug. Idempotent; safe on tables with zero rows.
 */
export async function resyncOwnedSequences(dbi: Db): Promise<void> {
  await dbi.execute(sql`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        -- Schema-qualify both sides: owned sequences are not limited to
        -- public (drizzle's own __drizzle_migrations lives in the drizzle
        -- schema), and an unqualified name would resolve via search_path.
        SELECT seqns.nspname AS seqschema, seq.relname AS seqname,
               tabns.nspname AS tabschema, tab.relname AS tabname,
               attr.attname AS colname
        FROM pg_class seq
        JOIN pg_namespace seqns ON seqns.oid = seq.relnamespace
        JOIN pg_depend d ON d.objid = seq.oid AND d.deptype = 'a'
        JOIN pg_class tab ON d.refobjid = tab.oid
        JOIN pg_namespace tabns ON tabns.oid = tab.relnamespace
        JOIN pg_attribute attr ON attr.attrelid = tab.oid AND attr.attnum = d.refobjsubid
        WHERE seq.relkind = 'S'
      LOOP
        -- Resync each sequence in its OWN subtransaction (the inner BEGIN …
        -- EXCEPTION block). Bumping a sequence to its column's max is a
        -- best-effort convenience so post-restore inserts don't collide with
        -- restored ids — it must NEVER be able to abort the whole DR restore.
        -- A single un-settable sequence (e.g. a value out of the sequence's
        -- bounds, or a column type that can't feed setval) previously rolled
        -- back the entire restore. Now it is logged and skipped so the rest of
        -- the restore stands, and the WARNING names the exact culprit + reason.
        BEGIN
          EXECUTE format(
            'SELECT setval(%L, GREATEST(COALESCE((SELECT MAX(%I) FROM %I.%I), 0), 1), COALESCE((SELECT MAX(%I) FROM %I.%I), 0) > 0)',
            quote_ident(r.seqschema) || '.' || quote_ident(r.seqname),
            r.colname, r.tabschema, r.tabname,
            r.colname, r.tabschema, r.tabname
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'resyncOwnedSequences: skipped %.% (owned by %.%.%): % (SQLSTATE %)',
            r.seqschema, r.seqname, r.tabschema, r.tabname, r.colname, SQLERRM, SQLSTATE;
        END;
      END LOOP;
    END $$;
  `);
}

// ─── Truthful post-restore checklist ────────────────────────────────

export interface ChecklistItem {
  status: 'ok' | 'warning';
  message: string;
}

async function firstRow(dbi: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await dbi.execute(q);
    return (res.rows as Record<string, unknown>[])[0];
  } catch {
    return undefined;
  }
}

/**
 * Build the post-restore checklist from what was ACTUALLY restored, instead
 * of the previous hardcoded "not configured" literals that ignored the data.
 */
export async function buildRestoreChecklist(dbi: Db): Promise<Record<string, ChecklistItem>> {
  const checklist: Record<string, ChecklistItem> = {};

  const smtp = await firstRow(dbi, sql`SELECT value FROM system_settings WHERE key = 'smtp_host'`);
  checklist['smtp'] = smtp?.['value']
    ? { status: 'ok', message: 'SMTP settings restored' }
    : { status: 'warning', message: 'SMTP not configured — email features unavailable' };

  const plaid = await firstRow(dbi, sql`SELECT client_id_encrypted FROM plaid_config LIMIT 1`);
  checklist['plaid'] = plaid?.['client_id_encrypted']
    ? { status: 'ok', message: 'Plaid configuration restored' }
    : { status: 'warning', message: 'Plaid not configured — bank feeds unavailable' };

  const ai = await firstRow(dbi, sql`
    SELECT anthropic_api_key_encrypted, openai_api_key_encrypted, gemini_api_key_encrypted,
           openai_compat_api_key_encrypted, glm_ocr_api_key_encrypted, ollama_base_url
    FROM ai_config LIMIT 1
  `);
  checklist['ai'] = ai && Object.values(ai).some((v) => v)
    ? { status: 'ok', message: 'AI configuration restored' }
    : { status: 'warning', message: 'AI not configured — AI features unavailable' };

  const sms = await firstRow(dbi, sql`
    SELECT sms_twilio_account_sid_encrypted, sms_textlink_api_key_encrypted FROM tfa_config LIMIT 1
  `);
  checklist['sms'] = sms && Object.values(sms).some((v) => v)
    ? { status: 'ok', message: 'SMS provider settings restored' }
    : { status: 'warning', message: 'SMS not configured — text-message features unavailable' };

  // Probe-decrypt one restored credential: verbatim *_encrypted columns are
  // only usable when this server's PLAID_ENCRYPTION_KEY matches the source
  // server's (a proper DR restore recovers it via /data/.env.recovery).
  // Sample across several credential tables so the probe still fires when
  // only some are configured.
  const storage = await firstRow(dbi, sql`SELECT access_token_encrypted FROM storage_providers WHERE access_token_encrypted IS NOT NULL LIMIT 1`);
  const firm = await firstRow(dbi, sql`SELECT api_key_encrypted FROM firm_integrations WHERE api_key_encrypted IS NOT NULL LIMIT 1`);
  const probe =
    (plaid?.['client_id_encrypted'] as string | undefined) ||
    (ai && (Object.entries(ai).find(([k, v]) => k.endsWith('_encrypted') && v)?.[1] as string | undefined)) ||
    (sms && (Object.values(sms).find((v) => v) as string | undefined)) ||
    (storage?.['access_token_encrypted'] as string | undefined) ||
    (firm?.['api_key_encrypted'] as string | undefined);
  if (probe) {
    try {
      const { decrypt } = await import('../utils/encryption.js');
      decrypt(probe);
      checklist['encryption'] = { status: 'ok', message: 'Restored credentials decrypt with this server’s key' };
    } catch {
      checklist['encryption'] = {
        status: 'warning',
        message:
          'Restored credentials were encrypted under a different PLAID_ENCRYPTION_KEY — restore the original key (see /data/.env.recovery) or re-enter provider credentials',
      };
    }
  }

  const users = await firstRow(dbi, sql`SELECT COUNT(*)::int AS cnt FROM users`);
  const tenants = await firstRow(dbi, sql`SELECT COUNT(*)::int AS cnt FROM tenants`);
  checklist['users'] = { status: 'ok', message: `${Number(users?.['cnt'] ?? 0)} user accounts restored` };
  checklist['tenants'] = { status: 'ok', message: `${Number(tenants?.['cnt'] ?? 0)} companies restored` };

  return checklist;
}

// ─── Bundle file write-back ─────────────────────────────────────────

export interface FileRestoreReport {
  perTable: Record<string, { restored: number; failed: number }>;
  unknownEntries: number;
  sampleErrors: string[];
}

interface FileTarget {
  kind: 'provider' | 'localPath';
  tenantId?: string;
  key: string; // storage key or absolute local path
}

/**
 * Write every bundled file back where it belongs: storage-provider keys
 * upload through the owning tenant's provider; payroll localPath files land
 * under UPLOAD_DIR (never outside it). `sections` is the merged
 * table → rows[] map the DB restore ran from — it carries the rows that
 * resolve each bundle entry to its tenant + destination.
 */
export async function writeBackBundleFiles(
  sections: Record<string, Record<string, unknown>[]>,
  packageAttachments: () => AsyncGenerator<{ id: string; buffer: Buffer }>,
): Promise<FileRestoreReport> {
  const uploadDir = process.env['UPLOAD_DIR'] || '/data/uploads';
  const report: FileRestoreReport = { perTable: {}, unknownEntries: 0, sampleErrors: [] };
  const bump = (table: string, ok: boolean, err?: string) => {
    report.perTable[table] ??= { restored: 0, failed: 0 };
    if (ok) report.perTable[table]!.restored += 1;
    else {
      report.perTable[table]!.failed += 1;
      if (err && report.sampleErrors.length < 5) report.sampleErrors.push(`${table}: ${err}`);
    }
  };

  // Legacy bare-id entries → attachments rows (provider key, file_path fallback).
  const attachmentTargets = new Map<string, FileTarget>();
  for (const att of sections['attachments'] ?? []) {
    const key = (att['storage_key'] as string | null) || (att['file_path'] as string | null);
    const tenantId = att['tenant_id'] as string | undefined;
    if (key && tenantId) attachmentTargets.set(att['id'] as string, { kind: 'provider', tenantId, key });
  }

  // Parent-hop tenant lookup (portal_question_attachments → portal_questions).
  const questionTenant = new Map<string, string>();
  for (const q of sections['portal_questions'] ?? []) {
    questionTenant.set(q['id'] as string, q['tenant_id'] as string);
  }

  // `f:`-prefixed entries → registry rows.
  const registryTargets = new Map<string, FileTarget>();
  const indexRows = (table: string, rows: Record<string, unknown>[], columns: string[], resolve: (row: Record<string, unknown>) => FileTarget | null) => {
    for (const row of rows) {
      for (const column of columns) {
        const value = row[column] as string | null | undefined;
        if (!value) continue;
        const target = resolve(row);
        if (target) registryTargets.set(`f:${table}:${column}:${row['id'] as string}`, { ...target, key: value });
      }
    }
  };
  indexRows('extraction_pages', sections['extraction_pages'] ?? [], ['image_ref'], (r) =>
    r['tenant_id'] ? { kind: 'provider', tenantId: r['tenant_id'] as string, key: '' } : null);
  indexRows('extraction_jobs', sections['extraction_jobs'] ?? [], ['storage_key'], (r) =>
    r['tenant_id'] ? { kind: 'provider', tenantId: r['tenant_id'] as string, key: '' } : null);
  indexRows('portal_receipts', sections['portal_receipts'] ?? [], ['storage_key'], (r) =>
    r['tenant_id'] ? { kind: 'provider', tenantId: r['tenant_id'] as string, key: '' } : null);
  indexRows('report_instances', sections['report_instances'] ?? [], ['pdf_url'], (r) =>
    r['tenant_id'] ? { kind: 'provider', tenantId: r['tenant_id'] as string, key: '' } : null);
  indexRows('portal_question_attachments', sections['portal_question_attachments'] ?? [], ['storage_key'], (r) => {
    const tenantId = questionTenant.get(r['question_id'] as string);
    return tenantId ? { kind: 'provider', tenantId, key: '' } : null;
  });
  indexRows('payroll_import_sessions', sections['payroll_import_sessions'] ?? [], ['file_path', 'companion_file_path'], () =>
    ({ kind: 'localPath', key: '' }));

  const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
  const providerByTenant = new Map<string, Awaited<ReturnType<typeof getProviderForTenant>>>();
  const providerFor = async (tenantId: string) => {
    let p = providerByTenant.get(tenantId);
    if (!p) {
      p = await getProviderForTenant(tenantId);
      providerByTenant.set(tenantId, p);
    }
    return p;
  };

  for await (const { id, buffer } of packageAttachments()) {
    const decoded = decodeFileEntryId(id);
    const table = decoded?.table ?? 'attachments';
    const target = decoded ? registryTargets.get(id) : attachmentTargets.get(id);
    if (!target) {
      report.unknownEntries += 1;
      continue;
    }
    try {
      if (target.kind === 'localPath') {
        // Payroll files recorded absolute paths under UPLOAD_DIR; never
        // write outside it — remap foreign prefixes to UPLOAD_DIR/payroll.
        let dest = path.resolve(target.key);
        if (!dest.startsWith(path.resolve(uploadDir) + path.sep)) {
          dest = path.join(uploadDir, 'payroll', path.basename(target.key));
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buffer);
      } else {
        const provider = await providerFor(target.tenantId!);
        await provider.upload(target.key, buffer, {
          fileName: path.basename(target.key) || id,
          mimeType: 'application/octet-stream',
          sizeBytes: buffer.length,
        });
      }
      bump(table, true);
    } catch (err) {
      bump(table, false, err instanceof Error ? err.message : String(err));
    }
  }
  return report;
}
