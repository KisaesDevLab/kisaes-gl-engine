// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

// 3-tier rules plan, Phase 1 — firms foundation.
// A firm is the long-lived owner of `tenant_firm` and
// `global_firm` rules. Modeled separately from `tenants` so rule
// ownership survives staff turnover and so firm-scoped resources
// don't have to pick a single bookkeeping-tenant context.
export const firms = pgTable('firms', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  // URL-safe handle. Mirrors `tenants.slug` style. Unique.
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  // When true, only super-admins can edit firm settings — lets
  // Kisaes operators provision firms before the customer
  // self-serves admin actions on the firm.
  superAdminManaged: boolean('super_admin_managed').notNull().default(false),
  // Audit only. Not an FK — `users` is tenant-scoped and a firm
  // creator may have left their original tenant. Same loose
  // pattern as user_tenant_access.user_id.
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Joins users to firms with a firm-internal role. Orthogonal to
// per-tenant `user_tenant_access.role` — a firm staffer still
// needs explicit per-tenant access via that table to operate on a
// managed tenant. v1 does NOT auto-grant tenant access from firm
// membership (avoids permission-amplification surprises during
// rollout).
//
// firm_role values:
//   firm_admin    — manages firm settings, creates global rules,
//                   invites staff, assigns tenants
//   firm_staff    — authors tenant_firm rules, reads globals
//   firm_readonly — observes firm rules, no authoring
export const firmUsers = pgTable('firm_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  // Loose reference (no FK) for the same reason as user_tenant_access.
  userId: uuid('user_id').notNull(),
  firmRole: varchar('firm_role', { length: 50 }).notNull().default('firm_staff'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueFirmUser: uniqueIndex('firm_users_firm_user_idx').on(table.firmId, table.userId),
  userIdx: index('idx_firm_users_user').on(table.userId),
}));

// Records which firm manages which tenant. 1:N — a tenant has at
// most one managing firm at a time. Functionally exclusive in
// CPA-firm reality (one firm closes the books); 1:N also avoids
// the "whose global rule wins?" ambiguity an M:N model would
// introduce.
//
// Soft-detach via `is_active=false` keeps historical attribution
// intact; rule eval reads `is_active=true` rows only.
export const tenantFirmAssignments = pgTable('tenant_firm_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  firmId: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'restrict' }),
  // Loose reference — audit only.
  assignedByUserId: uuid('assigned_by_user_id'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean('is_active').notNull().default(true),
}, (table) => ({
  // Plain index in Drizzle — the migration SQL adds a PARTIAL
  // unique constraint (`WHERE is_active = true`) that Drizzle
  // can't express via its builder API. The service layer enforces
  // the 1:N invariant before insert; the partial index is the
  // belt-and-suspenders safety net at the DB level.
  tenantIdx: index('idx_tfa_tenant').on(table.tenantId),
  firmIdx: index('idx_tfa_firm').on(table.firmId),
}));
