import { pgTable, uuid, varchar, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const userTenantAccess = pgTable('user_tenant_access', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  role: varchar('role', { length: 50 }).notNull().default('owner'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  uniqueAccess: uniqueIndex('uta_user_tenant_idx').on(table.userId, table.tenantId),
}));
