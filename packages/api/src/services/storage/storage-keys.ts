// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Tenant-rooted storage key builder.
//
// Every NEW write to a StorageProvider uses keys of the form
//   {tenantId}/{domain}/{...parts}
// so a tenant's entire storage footprint lives under one folder.
// System-level artifacts with no tenant (system backups) use the
// reserved '_system' root: _system/backups/{fileName}.
//
// Compatibility: keys are ALWAYS read back via the value stored in the
// DB (attachments.storage_key / file_path, report pdf_url, the remote
// backup manifest, ...), so files written under the legacy layout
// ({domain}/{tenantId}/...) keep working without any migration. Only
// new writes use this builder.

import { AppError } from '../../utils/errors.js';

/** Reserved pseudo-tenant root for artifacts that belong to the appliance, not a tenant. */
export const SYSTEM_STORAGE_ROOT = '_system';

export type StorageDomain =
  | 'attachments'
  | 'reports'
  | 'w9'
  | 'receipts'
  | 'documents'
  | 'backups';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Defense-in-depth: key inputs are server-generated today, but a storage
// key ends up joined onto UPLOAD_DIR by LocalProvider, so reject anything
// that could escape the tenant folder if a future caller ever forwards
// user-influenced input.
function assertSafeParts(parts: string[]): void {
  if (parts.length === 0) {
    throw AppError.badRequest('Storage key requires at least one path part');
  }
  for (const part of parts) {
    if (!part || part.startsWith('/') || part.includes('\\')) {
      throw AppError.badRequest('Invalid storage key part');
    }
    for (const segment of part.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw AppError.badRequest('Invalid storage key part');
      }
    }
  }
}

/**
 * Build a tenant-rooted storage key: `{tenantId}/{domain}/{parts...}`.
 *
 * `tenantId` must be a UUID or the reserved `_system` root.
 */
export function tenantStorageKey(
  tenantId: string,
  domain: StorageDomain,
  ...parts: string[]
): string {
  if (tenantId !== SYSTEM_STORAGE_ROOT && !UUID_RE.test(tenantId)) {
    throw AppError.badRequest('Invalid tenant id for storage key');
  }
  assertSafeParts(parts);
  return `${tenantId}/${domain}/${parts.join('/')}`;
}
