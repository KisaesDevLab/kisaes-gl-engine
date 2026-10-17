// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import { pgTable, uuid, boolean, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

/**
 * Provenance of a tenant created by a tenant-archive import (migration
 * 0217, U-05). Install-local: excluded from archives (category
 * `provenance` in the portability plan) and removed with the tenant.
 */
export const tenantArchiveImports = pgTable('tenant_archive_imports', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  // A scratch (test-restore) copy: no access rows, cannot be opened, swept.
  scratch: boolean('scratch').notNull().default(false),
  sourceTenantId: uuid('source_tenant_id'),
  archiveId: uuid('archive_id').notNull(),
  // SHA-256 of the archive file (ciphertext) that was imported.
  archiveSha256: varchar('archive_sha256', { length: 64 }).notNull(),
  // Tenant fingerprint computed inside the import transaction (fp1).
  fingerprint: jsonb('fingerprint').notNull(),
  // Users the import created (never pre-existing users matched by email).
  createdUserIds: uuid('created_user_ids').array().notNull().default([]),
  importedBy: uuid('imported_by'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  scratchIdx: index('idx_tenant_archive_imports_scratch').on(table.importedAt).where(sql`${table.scratch}`),
}));
