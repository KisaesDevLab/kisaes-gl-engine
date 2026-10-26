// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * The `mybooks-tenant-archive` container format, formatVersion 1.
 *
 *   envelope.json                        plaintext: format, archiveId, KDF/cipher parameters, keyCheck
 *   manifest.json.enc                    encrypted manifest
 *   data/_tenant.ndjson.enc              identity: the tenants row
 *   data/_users.ndjson.enc               identity: users projection
 *   data/_user_tenant_access.ndjson.enc  identity: access rows
 *   data/<table>.ndjson.enc              one row_to_json(archive projection) per line
 *   files/<table>/<column>/<rowId>.enc   bundled file bytes
 *
 * Every entry but envelope.json is encrypted with archive-crypto.ts. The
 * zip stores entries uncompressed (ciphertext does not compress). A
 * ClientLedger `.clbackup` is this archive byte-for-byte: application
 * metadata goes in `manifest.host`, never in extra entries.
 */

export const ARCHIVE_FORMAT = 'mybooks-tenant-archive';
export const ARCHIVE_FORMAT_VERSION = 1;

export const ENVELOPE_ENTRY = 'envelope.json';
export const MANIFEST_ENTRY = 'manifest.json.enc';
export const IDENTITY_ENTRIES = {
  tenant: 'data/_tenant.ndjson',
  users: 'data/_users.ndjson',
  access: 'data/_user_tenant_access.ndjson',
} as const;

/** Entry name of a table part (without the `.enc` suffix the zip entry carries). */
export function tablePartName(table: string): string {
  return `data/${table}.ndjson`;
}

export function filePartName(table: string, column: string, rowId: string): string {
  return `files/${table}/${column}/${rowId}`;
}

/** Zip entry name for a logical part: every part but the envelope is `<name>.enc`. */
export function zipEntryName(partName: string): string {
  return `${partName}.enc`;
}

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parse a zip entry name into its part kind, refusing anything the format does not define (zip-slip included). */
export function parseEntryName(entry: string):
  | { kind: 'envelope' }
  | { kind: 'manifest' }
  | { kind: 'identity'; section: keyof typeof IDENTITY_ENTRIES; part: string }
  | { kind: 'table'; table: string; part: string }
  | { kind: 'file'; table: string; column: string; rowId: string; part: string }
  | null {
  if (entry === ENVELOPE_ENTRY) return { kind: 'envelope' };
  if (entry === MANIFEST_ENTRY) return { kind: 'manifest' };
  if (!entry.endsWith('.enc')) return null;
  const part = entry.slice(0, -'.enc'.length);
  for (const [section, name] of Object.entries(IDENTITY_ENTRIES) as Array<[keyof typeof IDENTITY_ENTRIES, string]>) {
    if (part === name) return { kind: 'identity', section, part };
  }
  let m = /^data\/([^/]+)\.ndjson$/.exec(part);
  if (m && TABLE_RE.test(m[1]!)) return { kind: 'table', table: m[1]!, part };
  m = /^files\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(part);
  if (m && TABLE_RE.test(m[1]!) && TABLE_RE.test(m[2]!) && UUID_RE.test(m[3]!)) {
    return { kind: 'file', table: m[1]!, column: m[2]!, rowId: m[3]!, part };
  }
  return null;
}

export type PkShapeName = 'uuid' | 'omit-pk' | 'no-pk';

export interface ManifestTable {
  name: string;
  bucket: 'tenant' | 'child';
  pk: PkShapeName;
  rows: number;
  /** SHA-256 (hex) of the plaintext part bytes. */
  sha256: string;
  /** Canonical projection digest (hex): ordered SHA-256 for uuid tables, multiset digest otherwise. */
  contentDigest: string;
  /** Archive projection in order, with declared types. */
  columns: Array<[string, string]>;
  /** Plaintext bytes of the part. */
  bytes: number;
}

export interface ManifestFile {
  table: string;
  column: string;
  rowId: string;
  resolver: string;
  bytes: number;
  sha256: string;
}

export interface TrialBalanceRow {
  companyId: string | null;
  accountId: string;
  status: string;
  basis: string;
  debit: string;
  credit: string;
  lines: number;
}

export interface TrialBalance {
  definition: string;
  rows: TrialBalanceRow[];
  totals: { debit: string; credit: string };
}

export interface TenantFingerprint {
  algorithm: 'fp1';
  tenantRow: string;
  tables: Record<string, { rows: number; digest: string }>;
  /** SHA-256 of the trial balance rows (by company). */
  trialBalance: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: number;
  archiveId: string;
  engine: { version: string; commit: string | null };
  schema: { version: number; tag: string | null };
  createdAt: string;
  source: { tenantId: string; name: string; ledgerVersion: string };
  /** omitIntakeSettings: absent in archives written before U-93. */
  options: { includeAttachments: boolean; includeAudit: boolean; omitIntakeSettings?: boolean };
  /** `table.column` values left out on request (U-93; OMITTABLE_COLUMNS): the rows carry the column default. Absent before U-93. */
  omitted?: string[];
  host: Record<string, unknown>;
  tables: ManifestTable[];
  identity: {
    tenant: string;
    users: string;
    access: string;
    /** Plaintext hashes and byte counts of the identity parts. */
    parts: Record<string, { sha256: string; bytes: number; rows: number }>;
  };
  files: ManifestFile[];
  trialBalance: TrialBalance;
  unbalancedTransactions: number;
  fingerprint: TenantFingerprint;
  excludedTables: Record<string, { category: string; reason: string }>;
  redactedColumns: Record<string, string>;
  nulledReferences: Record<string, string>;
  warnings: string[];
  /** Natural-key values of referenced global/system rows: table -> old id -> key columns. */
  globalRows?: Record<string, Record<string, Record<string, unknown>>>;
  /** Canonical projection column names per table, as the exporter computed them. */
  canonical?: Record<string, string[]>;
}

/** The users projection of the identity section, in order. */
export const USERS_PROJECTION = [
  'id', 'email', 'password_hash', 'display_name', 'role', 'user_type', 'is_active',
  'display_preferences', 'created_at', 'updated_at',
] as const;

/** Upper bound of the `host` object (serialized), S3. */
export const HOST_MAX_BYTES = 16 * 1024;
