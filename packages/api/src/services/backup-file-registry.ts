// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Registry of every table/column that references an uploaded or generated
// FILE, so system backups bundle (and restores write back) all of them —
// not just the attachments table. Adding a new upload category means adding
// one entry here; the bundler and the restore write-back both iterate this
// list.
//
// Deliberate omissions:
//   - report_pack_runs.transient_key — transient render artifact with an
//     expires_at, swept by design; regenerable from restored rows.
//   - storage_migrations — bookkeeping rows only, no blobs of its own.

export interface FileRegistryEntry {
  table: string;
  /** Key/path columns — one bundle entry per non-null value. */
  columns: string[];
  /**
   * How the blob is fetched/written:
   *  - 'provider': storage-provider key (getProviderForTenant download/upload)
   *  - 'localPath': absolute path on local disk (payroll import files)
   *  - 'provider_with_local_fallback': attachments' historical dual scheme
   */
  source: 'provider' | 'localPath' | 'provider_with_local_fallback';
  /** Column carrying the owning tenant, when the table has one. */
  tenantColumn?: 'tenant_id';
  /** Parent hop for tables without tenant_id (e.g. portal_question_attachments → portal_questions). */
  tenantVia?: { parentTable: string; fkColumn: string };
}

export const FILE_EXPORT_REGISTRY: FileRegistryEntry[] = [
  // NOTE: attachments entries keep emitting BARE row ids (attachments/<id>)
  // so bundles stay restorable by pre-registry restore code; every other
  // category uses the `f:` prefix, which old code skips harmlessly.
  { table: 'attachments', columns: ['storage_key', 'file_path'], source: 'provider_with_local_fallback', tenantColumn: 'tenant_id' },
  { table: 'extraction_jobs', columns: ['storage_key'], source: 'provider', tenantColumn: 'tenant_id' },
  // Rendered page images — a distinct durable provider blob (image_ref),
  // separate from the original document (extraction_jobs.storage_key), and an
  // audit invariant ("never discarded"). Must be bundled or a DR restore
  // loses them and re-extraction breaks.
  { table: 'extraction_pages', columns: ['image_ref'], source: 'provider', tenantColumn: 'tenant_id' },
  { table: 'portal_receipts', columns: ['storage_key'], source: 'provider', tenantColumn: 'tenant_id' },
  { table: 'portal_question_attachments', columns: ['storage_key'], source: 'provider', tenantVia: { parentTable: 'portal_questions', fkColumn: 'question_id' } },
  { table: 'payroll_import_sessions', columns: ['file_path', 'companion_file_path'], source: 'localPath', tenantColumn: 'tenant_id' },
  { table: 'report_instances', columns: ['pdf_url'], source: 'provider', tenantColumn: 'tenant_id' },
];

const FILE_ENTRY_PREFIX = 'f:';

/** Bundle entry id for a non-attachments file: `f:<table>:<column>:<rowId>`. */
export function encodeFileEntryId(table: string, rowId: string, column: string): string {
  return `${FILE_ENTRY_PREFIX}${table}:${column}:${rowId}`;
}

/**
 * Parse a bundle entry id. Returns null for legacy bare ids (attachments
 * rows), which callers map through the attachments table as before.
 */
export function decodeFileEntryId(id: string): { table: string; column: string; rowId: string } | null {
  if (!id.startsWith(FILE_ENTRY_PREFIX)) return null;
  const rest = id.slice(FILE_ENTRY_PREFIX.length);
  const first = rest.indexOf(':');
  const second = rest.indexOf(':', first + 1);
  if (first <= 0 || second <= first + 1 || second === rest.length - 1) return null;
  return {
    table: rest.slice(0, first),
    column: rest.slice(first + 1, second),
    rowId: rest.slice(second + 1),
  };
}
