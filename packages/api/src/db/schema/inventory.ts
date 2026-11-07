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
  // A linked return's sale position: the sale row's movement_date and txn_created_at (PR-4 RB1, migration 0261);
  // orders a credit memo's rows of one part. Null on every other row. Kept current when the sale moves date.
  sourceMovementDate: date('source_movement_date'),
  sourceTxnCreatedAt: timestamp('source_txn_created_at', { withTimezone: true }),
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
  // A sale row's share of the negative-stock corrections of the units it sold short (PR-4 S5, migration 0261); 0 otherwise.
  correctionShare: decimal('correction_share', { precision: 19, scale: 4 }).notNull().default('0'),
  voided: boolean('voided').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  txnItemIdx: uniqueIndex('idx_inventory_movements_txn_item').on(table.transactionId, table.itemId, table.sourceTransactionId), // NULLS NOT DISTINCT in 0259
  // PR-4 B1 (0261): inside a document, the unlinked row first, then the linked rows by their sale's position, then id
  // (services/inventory-position.ts).
  positionIdx: index('idx_inventory_movements_position').on(table.companyId, table.itemId, table.movementDate, table.txnCreatedAt, table.transactionId,
    table.sourceMovementDate.asc().nullsFirst(), table.sourceTxnCreatedAt.asc().nullsFirst(), table.sourceTransactionId.asc().nullsFirst(), table.id),
  tenantIdx: index('idx_inventory_movements_tenant').on(table.tenantId),
  sourceIdx: index('idx_inventory_movements_source').on(table.sourceTransactionId).where(sql`source_transaction_id IS NOT NULL`),
}));
