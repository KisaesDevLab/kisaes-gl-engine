// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { pgTable, uuid, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

/**
 * People of a company who came in through a transfer file as names only
 * (U-284, migration 0283). `userId` is the id the company's rows use for
 * that person; it never names a users row of this install.
 */
export const transferUserNames = pgTable('transfer_user_names', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdx: uniqueIndex('uq_transfer_user_names_user').on(table.tenantId, table.userId),
}));
