// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, integer, timestamp, index } from 'drizzle-orm/pg-core';

/** Why a number was spoiled: the route that sent its check back to the print queue. */
export type SpoiledCheckReason = 'requeue' | 'reprint' | 'edit_reprint';

// Spoiled check numbers (U-106, migration 0239): a number a check carried
// before it went back to the print queue, listed for the register. The
// number may be used again; see check.service.ts.
export const spoiledCheckNumbers = pgTable('spoiled_check_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  bankAccountId: uuid('bank_account_id').notNull(),
  checkNumber: integer('check_number').notNull(),
  transactionId: uuid('transaction_id').notNull(),
  reason: varchar('reason', { length: 20 }).$type<SpoiledCheckReason>().notNull(),
  spoiledBy: uuid('spoiled_by'),
  spoiledAt: timestamp('spoiled_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  bankIdx: index('idx_spoiled_check_numbers_bank').on(table.tenantId, table.bankAccountId, table.checkNumber),
  txnIdx: index('idx_spoiled_check_numbers_txn').on(table.transactionId),
}));
