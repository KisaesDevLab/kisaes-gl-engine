import { pgTable, uuid, varchar, text, decimal, boolean, date, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  contactType: varchar('contact_type', { length: 20 }).notNull(), // customer | vendor | both
  displayName: varchar('display_name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 30 }),
  // Billing address
  billingLine1: varchar('billing_line1', { length: 255 }),
  billingLine2: varchar('billing_line2', { length: 255 }),
  billingCity: varchar('billing_city', { length: 100 }),
  billingState: varchar('billing_state', { length: 50 }),
  billingZip: varchar('billing_zip', { length: 20 }),
  billingCountry: varchar('billing_country', { length: 3 }).default('US'),
  // Shipping address
  shippingLine1: varchar('shipping_line1', { length: 255 }),
  shippingLine2: varchar('shipping_line2', { length: 255 }),
  shippingCity: varchar('shipping_city', { length: 100 }),
  shippingState: varchar('shipping_state', { length: 50 }),
  shippingZip: varchar('shipping_zip', { length: 20 }),
  shippingCountry: varchar('shipping_country', { length: 3 }).default('US'),
  // Customer-specific
  defaultPaymentTerms: varchar('default_payment_terms', { length: 50 }),
  defaultTermsDays: integer('default_terms_days'),
  openingBalance: decimal('opening_balance', { precision: 19, scale: 4 }).default('0'),
  openingBalanceDate: date('opening_balance_date'),
  // Vendor-specific
  defaultExpenseAccountId: uuid('default_expense_account_id'),
  taxId: varchar('tax_id', { length: 30 }),
  is1099Eligible: boolean('is_1099_eligible').default(false),
  // Shared
  notes: text('notes'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_contacts_tenant').on(table.tenantId),
  typeIdx: index('idx_contacts_type').on(table.tenantId, table.contactType),
  nameIdx: index('idx_contacts_name').on(table.tenantId, table.displayName),
}));
