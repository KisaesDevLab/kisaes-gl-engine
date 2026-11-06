// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, decimal, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Units of measure (U-161, migration 0260): a set with its base unit, and
 * the set's other units with fixed factors (base units per unit). See
 * services/units.service.ts.
 */
export const unitSets = pgTable('unit_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  baseUnitName: varchar('base_unit_name', { length: 30 }).notNull(),
  baseUnitAbbreviation: varchar('base_unit_abbreviation', { length: 10 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}); // unique (tenant_id, company_id, lower(name)) in 0260

export const unitSetUnits = pgTable('unit_set_units', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  unitSetId: uuid('unit_set_id').notNull(),
  name: varchar('name', { length: 30 }).notNull(),
  abbreviation: varchar('abbreviation', { length: 10 }),
  // Base units per unit: > 0, at most 6 places, at most 1,000,000.
  factor: decimal('factor', { precision: 19, scale: 6 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_unit_set_units_tenant').on(table.tenantId),
})); // unique (unit_set_id, lower(name)) in 0260
