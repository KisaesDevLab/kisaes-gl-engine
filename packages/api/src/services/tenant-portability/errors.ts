// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { AppError } from '../../utils/errors.js';

/** Error codes of the tenant-archive routes, with their HTTP status. */
export const ARCHIVE_ERROR_STATUS = {
  ARCHIVE_PASSPHRASE_INVALID: 422,
  ARCHIVE_UNSUPPORTED: 422,
  ARCHIVE_CORRUPT: 422,
  ARCHIVE_TOO_NEW: 409,
  ARCHIVE_TABLE_UNKNOWN: 422,
  ARCHIVE_COLUMN_UNKNOWN: 422,
  ARCHIVE_COLUMN_TYPE_CHANGED: 422,
  ARCHIVE_COLUMN_MISSING: 422,
  ARCHIVE_VERIFY_FAILED: 422,
  ARCHIVE_UNSUPPORTED_REFERENCE: 422,
  ARCHIVE_NOT_ELIGIBLE: 409,
  ARCHIVE_STALE: 409,
  ARCHIVE_TOO_LARGE: 422,
  FILE_MISSING: 422,
  FILE_SIZE_MISMATCH: 422,
  PASSPHRASE_TOO_WEAK: 400,
  WORKSPACE_TENANT: 409,
  TENANT_BUSY: 409,
  JOB_UNKNOWN: 404,
  SCRATCH_NOT_AVAILABLE: 400,
  SCRATCH_TENANT: 403,
  STALE: 409,
  /** Rows of the archive belong to users this caller may not create (H1): a super admin must import it. */
  IMPORT_NEEDS_SUPER_ADMIN: 403,
  /** Too many wrong passphrases from this user in the window (M3). */
  PASSPHRASE_RATE_LIMITED: 429,
  /** The bundled files would not fit on the upload volume. */
  INSUFFICIENT_STORAGE: 507,
} as const;

export type ArchiveErrorCode = keyof typeof ARCHIVE_ERROR_STATUS;

/**
 * An error of the tenant-archive code. Messages never carry row values,
 * file contents or the passphrase: table names, counts and check names only.
 */
export class ArchiveError extends AppError {
  constructor(code: ArchiveErrorCode, message: string, details?: Record<string, unknown>) {
    super(ARCHIVE_ERROR_STATUS[code], message, code, details);
    this.name = 'ArchiveError';
  }
}

export function isArchiveError(err: unknown, code?: ArchiveErrorCode): err is ArchiveError {
  return err instanceof ArchiveError && (code === undefined || err.code === code);
}
