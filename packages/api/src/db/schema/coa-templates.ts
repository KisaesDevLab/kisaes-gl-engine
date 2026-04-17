// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, jsonb, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Runtime-editable Chart of Accounts templates.
 *
 * The static `BUSINESS_TEMPLATES` constant in `@kis-books/shared` is the
 * factory default. On first startup we copy each entry into this table
 * (marked `is_builtin = true`). After that, the table is the source of
 * truth — super admins can edit, add, delete, import, or clone templates,
 * and `seedFromTemplate` reads from this table when seeding a new tenant.
 *
 * The `accounts` column is a JSONB array of `CoaTemplateAccount` objects.
 * We store it denormalized because (a) templates are read/written as a
 * unit, (b) the line count is small (~100 per template), and (c) it keeps
 * migrations simple — no join table to keep in sync.
 */
export const coaTemplatesTable = pgTable('coa_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 100 }).notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  // CoaTemplateAccount[] — see packages/shared/src/types/coa-templates.ts
  accounts: jsonb('accounts').notNull(),
  isBuiltin: boolean('is_builtin').default(false).notNull(),
  // Hidden templates don't appear in the public business-type
  // dropdowns at registration / setup time, but they remain
  // visible to super admins so they can un-hide later.
  isHidden: boolean('is_hidden').default(false).notNull(),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  slugIdx: uniqueIndex('idx_coa_templates_slug').on(table.slug),
}));
