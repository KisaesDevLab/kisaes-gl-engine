// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, decimal, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Price levels (U-40, price-levels-v1, migration 0243): a name and a signed
// percent (-7.5 = 7.5 % down, 10 = 10 % up) applied to an item's price, plus
// optional fixed prices for chosen items (price_level_items). A client has
// at most one level (contacts.price_level_id). Soft references, no FK.
export const priceLevels = pgTable('price_levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 100 }).notNull(),
  percent: decimal('percent', { precision: 8, scale: 4 }).notNull().default('0'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_price_levels_tenant').on(table.tenantId, table.companyId),
}));

export const priceLevelItems = pgTable('price_level_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  priceLevelId: uuid('price_level_id').notNull(),
  itemId: uuid('item_id').notNull(),
  unitPrice: decimal('unit_price', { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  levelItemIdx: uniqueIndex('idx_price_level_items_level_item').on(table.priceLevelId, table.itemId),
  tenantIdx: index('idx_price_level_items_tenant').on(table.tenantId),
}));
