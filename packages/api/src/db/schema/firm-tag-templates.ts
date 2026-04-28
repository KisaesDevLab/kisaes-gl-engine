// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { firms, tenants } from './index.js';

// 3-tier rules plan, Phase 7 — firm-scoped tag templates.
//
// A tag template is a firm-level semantic key (e.g., "billable",
// "client_reimbursable") that lets a global_firm rule reference
// tags portably across every tenant the firm manages. The
// per-tenant binding (tenant_firm_tag_bindings) maps a template
// key to the actual tenant-local `tags.id` so the rule resolver
// can rebind at fire time the same way `accounts.system_tag`
// rebinds account targets.
export const firmTagTemplates = pgTable('firm_tag_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  // Stable URL-safe key the rule body stores. Once authored
  // it should not change (renaming would silently invalidate
  // every rule referencing it). Display label below is the
  // human-edit surface.
  templateKey: varchar('template_key', { length: 80 }).notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // (firm_id, template_key) is the firm-internal stable handle.
  uniqueKey: uniqueIndex('idx_ftt_firm_key').on(table.firmId, table.templateKey),
}));

// Maps a (firm, tenant, template_key) triple to a tenant-local
// tag uuid. The resolver looks up THIS row at fire time when a
// global_firm rule's set_tag action references a templateKey;
// drops the action silently if no binding exists for the
// current tenant.
//
// Note: `tagId` is a loose reference (no FK) because the tags
// schema lives in transactions.ts and has no `id` index of its
// own beyond the PK. The service layer enforces tag-belongs-to-
// tenant before insert.
export const tenantFirmTagBindings = pgTable('tenant_firm_tag_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  templateKey: varchar('template_key', { length: 80 }).notNull(),
  tagId: uuid('tag_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // (firm, tenant, key) is the resolver's lookup path.
  uniqueBinding: uniqueIndex('idx_tftb_firm_tenant_key').on(table.firmId, table.tenantId, table.templateKey),
  tenantIdx: index('idx_tftb_tenant').on(table.tenantId),
}));
