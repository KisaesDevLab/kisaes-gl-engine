import { pgTable, uuid, varchar, text, decimal, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  accountNumber: varchar('account_number', { length: 20 }),
  name: varchar('name', { length: 255 }).notNull(),
  accountType: varchar('account_type', { length: 20 }).notNull(),
  detailType: varchar('detail_type', { length: 100 }),
  description: text('description'),
  isActive: boolean('is_active').default(true),
  isSystem: boolean('is_system').default(false),
  systemTag: varchar('system_tag', { length: 50 }),
  parentId: uuid('parent_id'),
  balance: decimal('balance', { precision: 19, scale: 4 }).default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_accounts_tenant').on(table.tenantId),
  typeIdx: index('idx_accounts_type').on(table.tenantId, table.accountType),
  systemTagIdx: index('idx_accounts_system_tag').on(table.tenantId, table.systemTag),
  tenantAccountNumberIdx: uniqueIndex('idx_accounts_tenant_number').on(table.tenantId, table.accountNumber),
}));
