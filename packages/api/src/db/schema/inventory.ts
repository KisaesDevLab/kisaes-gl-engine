// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, decimal, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The stock ledger (U-157, migration 0259): one row per (transaction, item).
 * Values are signed by their effect on the inventory asset account. See
 * services/inventory-costing.service.ts and utils/inventory-walk.ts.
 */
export const inventoryMovements = pgTable('inventory_movements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  itemId: uuid('item_id').notNull(),
  transactionId: uuid('transaction_id').notNull(),
  // A linked return's sale (Q-P24e, returnOf.transactionId); null otherwise.
  sourceTransactionId: uuid('source_transaction_id'),
  movementDate: date('movement_date').notNull(),
  // The transaction's created_at (position tiebreak; kept on edits).
  txnCreatedAt: timestamp('txn_created_at', { withTimezone: true }).notNull(),
  kind: varchar('kind', { length: 20 }).$type<'receipt' | 'sale' | 'customer_return' | 'vendor_return' | 'adjust_qty' | 'adjust_value'>().notNull(),
  quantity: decimal('quantity', { precision: 12, scale: 4 }).notNull().default('0'),
  valueMode: varchar('value_mode', { length: 10 }).$type<'given' | 'derived' | 'linked'>().notNull(),
  value: decimal('value', { precision: 19, scale: 4 }).notNull().default('0'),
  correction: decimal('correction', { precision: 19, scale: 4 }).notNull().default('0'),
  residual: decimal('residual', { precision: 19, scale: 4 }).notNull().default('0'),
  fallbackCost: decimal('fallback_cost', { precision: 19, scale: 6 }),
  runningQty: decimal('running_qty', { precision: 12, scale: 4 }).notNull().default('0'),
  runningValue: decimal('running_value', { precision: 19, scale: 4 }).notNull().default('0'),
  lastCost: decimal('last_cost', { precision: 19, scale: 6 }).notNull().default('0'),
  voided: boolean('voided').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  txnItemIdx: uniqueIndex('idx_inventory_movements_txn_item').on(table.transactionId, table.itemId, table.sourceTransactionId), // NULLS NOT DISTINCT in 0259
  positionIdx: index('idx_inventory_movements_position').on(table.companyId, table.itemId, table.movementDate, table.txnCreatedAt, table.transactionId),
  tenantIdx: index('idx_inventory_movements_tenant').on(table.tenantId),
  sourceIdx: index('idx_inventory_movements_source').on(table.sourceTransactionId).where(sql`source_transaction_id IS NOT NULL`),
}));
