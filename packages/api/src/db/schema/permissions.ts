// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PermissionMap } from '@kis-books/shared';
import { tenants } from './auth.js';

// Per-member permissions. Only the `bookkeeper` role consults these;
// every other role resolves purely from its role (see
// resolveEffectivePermissions in @kis-books/shared). The permission
// maps are stored as jsonb — a compact `{ resourceKey: level }` object
// keyed by the shared resource catalog — mirroring the "one row per
// (tenant, thing)" spirit of tenant_feature_flags. Additive only
// (CLAUDE.md rule 13).

// A named, reusable access set (e.g. "AR Clerk") scoped to a tenant.
export const permissionTemplates = pgTable('permission_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  description: varchar('description', { length: 500 }),
  permissions: jsonb('permissions').$type<PermissionMap>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueName: uniqueIndex('perm_tpl_tenant_name_idx').on(table.tenantId, table.name),
}));

// The (tenant, user) permission assignment. Presence of this row is
// what flips a bookkeeper out of legacy full-access into the
// restricted, template-driven mode. `template_id` is a nullable soft
// reference (ON DELETE SET NULL so deleting a template downgrades
// assignees to overrides-only rather than cascading them away).
// `user_id` is a loose reference (no FK) to match user_tenant_access.
export const userPermissions = pgTable('user_permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  templateId: uuid('template_id').references(() => permissionTemplates.id, { onDelete: 'set null' }),
  overrides: jsonb('overrides').$type<PermissionMap>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueUser: uniqueIndex('user_perms_tenant_user_idx').on(table.tenantId, table.userId),
}));
