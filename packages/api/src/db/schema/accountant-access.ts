import { pgTable, uuid, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const accountantCompanyExclusions = pgTable('accountant_company_exclusions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  companyId: uuid('company_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  uniqueExclusion: uniqueIndex('acct_excl_user_company_idx').on(table.userId, table.companyId),
}));
