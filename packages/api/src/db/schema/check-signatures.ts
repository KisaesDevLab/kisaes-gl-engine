// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, integer, decimal, boolean, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { tenants, users } from './auth.js';

// Tenant-scoped library of check signature images. Image bytes live on
// LOCAL disk as AES-256-GCM ciphertext (file_path relative to UPLOAD_DIR,
// e.g. signatures/<tenantId>/<id>.enc) and are never routed through the
// tenant's pluggable storage provider. Deletes are soft (is_active=false,
// file unlinked, mappings cleared) so transactions.print_signature_id —
// deliberately FK-less — keeps resolving to a label for history.
export const checkSignatures = pgTable('check_signatures', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  label: varchar('label', { length: 100 }).notNull(),
  filePath: varchar('file_path', { length: 512 }).notNull(),
  mimeType: varchar('mime_type', { length: 32 }).notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  // NULL = no cap; checks above the cap print with a bare signature line.
  maxAmount: decimal('max_amount', { precision: 19, scale: 4 }),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Partial-unique in the SQL migration (WHERE is_active); Drizzle models
  // the plain columns — enforcement lives in 0153_check_signatures.sql.
  tenantIdx: index('idx_check_signatures_tenant').on(table.tenantId, table.isActive),
  uniqueLabel: uniqueIndex('uq_check_signatures_tenant_label').on(table.tenantId, table.label),
}));

// Which users may print with which signature (many-to-many).
export const checkSignatureUsers = pgTable('check_signature_users', {
  signatureId: uuid('signature_id').notNull().references(() => checkSignatures.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  grantedBy: uuid('granted_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.signatureId, table.userId] }),
  tenantUserIdx: index('idx_csu_tenant_user').on(table.tenantId, table.userId),
}));
