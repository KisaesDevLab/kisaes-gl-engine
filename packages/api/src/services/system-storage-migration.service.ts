// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// System-level storage migration: copy every locally-stored file blob to
// the SYSTEM remote storage provider (Admin > System > File Storage), for
// every tenant that resolves to the system default. Unlike the per-tenant
// migration (storage-migration.service.ts, attachments only), this walks
// FILE_EXPORT_REGISTRY so extraction pages, portal receipts, report PDFs
// etc. all move too — the same file universe a DR bundle covers.
//
// Idempotent by design: a file already on the remote is skipped, so a
// failed/cancelled run can simply be re-run. Local copies are left in
// place (the LocalFallbackProvider ignores them once the remote hit
// succeeds; they cost disk, not correctness).
//
// Progress lives in-process (single fire-and-forget run, like the tenant
// migration); the final summary is persisted to system_settings so the
// admin UI can show the last outcome across restarts. A restart mid-run
// loses only the progress display — re-running resumes the copy.

import fs from 'fs';
import path from 'path';
import { sql, eq, and, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { storageProviders } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { FILE_EXPORT_REGISTRY } from './backup-file-registry.js';
import { getSetting, setSetting } from './admin.service.js';
import { getSystemStorageProvider } from './storage/storage-provider.factory.js';
import { LocalFallbackProvider } from './storage/local-fallback.provider.js';
import type { StorageProvider } from './storage/storage-provider.interface.js';

const LAST_RUN_SETTING = 'storage_system_migration_last';
const MAX_LOGGED_ERRORS = 50;

export interface SystemMigrationStatus {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  provider: string | null;
  totalFiles: number;
  processed: number;
  /** Uploaded to the remote this run. */
  migrated: number;
  /** Already present on the remote — nothing to do. */
  alreadyRemote: number;
  /** No local blob found (e.g. uploaded straight to the remote, or on a
   *  tenant-level provider) — informational, not a failure. */
  missingLocal: number;
  failed: number;
  errors: Array<{ table: string; id: string; error: string }>;
  startedAt: string | null;
  completedAt: string | null;
}

interface WorkItem {
  table: string;
  rowId: string;
  /** Storage key on the remote (and relative path under UPLOAD_DIR). */
  key: string;
  /** The value as stored in the DB — extra local-read candidate for
   *  historical path shapes (absolute paths, '/uploads/' URLs). */
  rawKey: string;
  fileName: string;
  mimeType: string;
  /** attachments rows get their storage_provider/storage_key re-pointed. */
  repointAttachment: boolean;
}

let current: SystemMigrationStatus | null = null;
let cancelRequested = false;

function idleStatus(): SystemMigrationStatus {
  return {
    status: 'idle', provider: null, totalFiles: 0, processed: 0, migrated: 0,
    alreadyRemote: 0, missingLocal: 0, failed: 0, errors: [], startedAt: null, completedAt: null,
  };
}

export function isSystemMigrationRunning(): boolean {
  return current?.status === 'running';
}

export async function getSystemMigrationStatus(): Promise<SystemMigrationStatus> {
  if (current) return current;
  const raw = await getSetting(LAST_RUN_SETTING);
  if (raw) {
    try { return JSON.parse(raw) as SystemMigrationStatus; } catch { /* fall through */ }
  }
  return idleStatus();
}

export function cancelSystemMigration(): void {
  if (current?.status === 'running') cancelRequested = true;
}

/** Tenants that resolve to the system default: everyone except tenants
 *  with their own active non-local provider (their blobs live on THEIR
 *  provider — copying local leftovers to the system remote would be
 *  noise; their history is the per-tenant migration's job). */
async function tenantsUsingSystemDefault(): Promise<Set<string>> {
  const allTenants = await db.execute(sql`SELECT id FROM tenants`);
  const scope = new Set((allTenants.rows as Array<{ id: string }>).map((r) => r.id));
  const ownProvider = await db
    .select({ tenantId: storageProviders.tenantId })
    .from(storageProviders)
    .where(and(eq(storageProviders.isActive, true), ne(storageProviders.provider, 'local')));
  for (const r of ownProvider) scope.delete(r.tenantId);
  return scope;
}

/** Normalize an attachments file_path/storage_key to a provider key
 *  (strip the historical '/uploads/' URL prefix and any leading slash). */
function toStorageKey(p: string): string {
  return p.replace(/^\/uploads\//, '').replace(/^\/+/, '');
}

/** Read a local blob for a key, tolerating the attachments dual scheme
 *  (same candidate order as the DR bundler's readLocal). */
function readLocalBlob(uploadDir: string, key: string, rawKey: string): Buffer | null {
  for (const c of [path.join(uploadDir, key), rawKey, path.join(uploadDir, rawKey)]) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return fs.readFileSync(c);
    } catch { /* skip unreadable */ }
  }
  return null;
}

async function collectWorkItems(scope: Set<string>): Promise<WorkItem[]> {
  const items: WorkItem[] = [];

  for (const entry of FILE_EXPORT_REGISTRY) {
    if (entry.source === 'localPath') continue; // genuinely local artifacts (payroll import files)

    // Table/column names come from the static registry — not user input.
    let rows: Array<Record<string, unknown>>;
    if (entry.table === 'attachments') {
      const res = await db.execute(sql.raw(
        `SELECT id, tenant_id, storage_key, file_path, storage_provider, mime_type, file_name FROM attachments`,
      ));
      rows = res.rows as Array<Record<string, unknown>>;
      for (const row of rows) {
        if (!scope.has(row['tenant_id'] as string)) continue;
        // Only local-stamped rows migrate; rows stamped with a remote
        // provider (system or tenant) already live elsewhere.
        if (((row['storage_provider'] as string | null) || 'local') !== 'local') continue;
        const rawKey = (row['storage_key'] as string | null) || (row['file_path'] as string | null);
        if (!rawKey) continue; // metadata-only row
        items.push({
          table: 'attachments',
          rowId: row['id'] as string,
          key: toStorageKey(rawKey),
          rawKey,
          fileName: (row['file_name'] as string | null) || path.basename(rawKey),
          mimeType: (row['mime_type'] as string | null) || 'application/octet-stream',
          repointAttachment: true,
        });
      }
      continue;
    }

    if (entry.tenantColumn) {
      const res = await db.execute(sql.raw(
        `SELECT id, tenant_id, ${entry.columns.join(', ')} FROM ${entry.table}`,
      ));
      rows = res.rows as Array<Record<string, unknown>>;
    } else if (entry.tenantVia) {
      const res = await db.execute(sql.raw(
        `SELECT c.id, p.tenant_id, ${entry.columns.map((c) => `c.${c}`).join(', ')} ` +
        `FROM ${entry.table} c JOIN ${entry.tenantVia.parentTable} p ON c.${entry.tenantVia.fkColumn} = p.id`,
      ));
      rows = res.rows as Array<Record<string, unknown>>;
    } else {
      continue;
    }

    for (const row of rows) {
      const tenantId = row['tenant_id'] as string | null;
      if (!tenantId || !scope.has(tenantId)) continue;
      for (const col of entry.columns) {
        const key = row[col] as string | null;
        if (!key) continue;
        items.push({
          table: entry.table,
          rowId: row['id'] as string,
          key: toStorageKey(key),
          rawKey: key,
          fileName: path.basename(key),
          mimeType: 'application/octet-stream',
          repointAttachment: false,
        });
      }
    }
  }

  return items;
}

async function persistStatus(status: SystemMigrationStatus): Promise<void> {
  try {
    await setSetting(LAST_RUN_SETTING, JSON.stringify(status));
  } catch (err) {
    console.error('[SystemStorageMigration] Failed to persist status:', err instanceof Error ? err.message : err);
  }
}

/**
 * Start a system storage migration. Throws if one is already running or
 * the system provider is local. Runs to completion (call fire-and-forget
 * from the route, like the per-tenant migration).
 *
 * `overrides` exists for tests: inject the remote provider / upload dir
 * without standing up real system settings or a real bucket.
 */
export async function runSystemStorageMigration(
  overrides?: { remote?: StorageProvider; uploadDir?: string },
): Promise<SystemMigrationStatus> {
  if (current?.status === 'running') throw new Error('A system storage migration is already running');

  let remote = overrides?.remote;
  if (!remote) {
    const system = await getSystemStorageProvider();
    remote = system instanceof LocalFallbackProvider ? system.remote : system;
    if (remote.name === 'local') throw new Error('System file storage is local — configure a remote provider first');
  }
  const uploadDir = overrides?.uploadDir || env.UPLOAD_DIR;

  cancelRequested = false;
  const status: SystemMigrationStatus = {
    ...idleStatus(),
    status: 'running',
    provider: remote.name,
    startedAt: new Date().toISOString(),
  };
  current = status;

  try {
    const scope = await tenantsUsingSystemDefault();
    const items = await collectWorkItems(scope);
    status.totalFiles = items.length;

    for (const item of items) {
      if (cancelRequested) {
        status.status = 'cancelled';
        break;
      }
      try {
        const onRemote = await remote.exists(item.key);
        if (onRemote) {
          status.alreadyRemote++;
        } else {
          const data = readLocalBlob(uploadDir, item.key, item.rawKey);
          if (!data) {
            status.missingLocal++;
            status.processed++;
            continue;
          }
          await remote.upload(item.key, data, {
            fileName: item.fileName,
            mimeType: item.mimeType,
            sizeBytes: data.length,
          });
          status.migrated++;
        }
        // Re-point local-stamped attachments even when the blob was
        // already remote (repairs a previous partial run's stamps).
        if (item.repointAttachment) {
          await db.execute(sql`
            UPDATE attachments SET storage_provider = ${remote.name}, storage_key = ${item.key}
            WHERE id = ${item.rowId}
          `);
        }
      } catch (err) {
        status.failed++;
        if (status.errors.length < MAX_LOGGED_ERRORS) {
          status.errors.push({ table: item.table, id: item.rowId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      status.processed++;
    }

    if (status.status === 'running') status.status = 'completed';
  } catch (err) {
    status.status = 'failed';
    if (status.errors.length < MAX_LOGGED_ERRORS) {
      status.errors.push({ table: '_run', id: '_run', error: err instanceof Error ? err.message : String(err) });
    }
  }

  status.completedAt = new Date().toISOString();
  await persistStatus(status);
  console.log(
    `[SystemStorageMigration] ${status.status}: ${status.migrated} migrated, ` +
    `${status.alreadyRemote} already remote, ${status.missingLocal} missing locally, ${status.failed} failed ` +
    `(of ${status.totalFiles})`,
  );
  current = null;
  return status;
}
