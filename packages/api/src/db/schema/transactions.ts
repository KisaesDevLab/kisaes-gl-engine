import { pgTable, uuid, varchar, text, decimal, boolean, date, timestamp, integer, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  txnType: varchar('txn_type', { length: 30 }).notNull(),
  txnNumber: varchar('txn_number', { length: 50 }),
  txnDate: date('txn_date').notNull(),
  dueDate: date('due_date'),
  status: varchar('status', { length: 20 }).default('posted').notNull(),
  contactId: uuid('contact_id'),
  memo: text('memo'),
  internalNotes: text('internal_notes'),
  paymentTerms: varchar('payment_terms', { length: 50 }),
  subtotal: decimal('subtotal', { precision: 19, scale: 4 }),
  taxAmount: decimal('tax_amount', { precision: 19, scale: 4 }).default('0'),
  total: decimal('total', { precision: 19, scale: 4 }),
  amountPaid: decimal('amount_paid', { precision: 19, scale: 4 }).default('0'),
  balanceDue: decimal('balance_due', { precision: 19, scale: 4 }),
  invoiceStatus: varchar('invoice_status', { length: 20 }),
  // Accounts payable (bills, vendor credits)
  billStatus: varchar('bill_status', { length: 20 }),
  termsDays: integer('terms_days'),
  creditsApplied: decimal('credits_applied', { precision: 19, scale: 4 }).default('0'),
  vendorInvoiceNumber: varchar('vendor_invoice_number', { length: 100 }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  viewedAt: timestamp('viewed_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  isRecurring: boolean('is_recurring').default(false),
  recurringScheduleId: uuid('recurring_schedule_id'),
  sourceEstimateId: uuid('source_estimate_id'),
  appliedToInvoiceId: uuid('applied_to_invoice_id'),
  voidReason: text('void_reason'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  // Check fields
  checkNumber: integer('check_number'),
  printStatus: varchar('print_status', { length: 20 }),
  payeeNameOnCheck: varchar('payee_name_on_check', { length: 255 }),
  payeeAddress: text('payee_address'),
  printedMemo: varchar('printed_memo', { length: 255 }),
  printedAt: timestamp('printed_at', { withTimezone: true }),
  printBatchId: uuid('print_batch_id'),
  // Source tracking — identifies where this transaction originated
  source: varchar('source', { length: 30 }),  // 'payroll_import', 'bank_feed', 'manual', 'recurring', etc.
  sourceId: varchar('source_id', { length: 100 }), // payroll session ID, bank feed item ID, etc.
  // Public invoice link + Stripe payment
  publicToken: varchar('public_token', { length: 64 }).unique(),
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_txn_tenant').on(table.tenantId),
  typeIdx: index('idx_txn_type').on(table.tenantId, table.txnType),
  dateIdx: index('idx_txn_date').on(table.tenantId, table.txnDate),
  contactIdx: index('idx_txn_contact').on(table.tenantId, table.contactId),
  statusIdx: index('idx_txn_status').on(table.tenantId, table.status),
  billStatusIdx: index('idx_txn_bill_status').on(table.tenantId, table.billStatus),
  vendorInvIdx: index('idx_txn_vendor_inv').on(table.tenantId, table.vendorInvoiceNumber),
  sourceIdx: index('idx_txn_source').on(table.tenantId, table.source, table.sourceId),
}));

export const billPaymentApplications = pgTable('bill_payment_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  paymentId: uuid('payment_id').notNull(),
  billId: uuid('bill_id').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  paymentIdx: index('idx_bpa_payment').on(table.paymentId),
  billIdx: index('idx_bpa_bill').on(table.billId),
  tenantIdx: index('idx_bpa_tenant').on(table.tenantId),
}));

export const vendorCreditApplications = pgTable('vendor_credit_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  paymentId: uuid('payment_id').notNull(),
  creditId: uuid('credit_id').notNull(),
  billId: uuid('bill_id').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  paymentIdx: index('idx_vca_payment').on(table.paymentId),
  creditIdx: index('idx_vca_credit').on(table.creditId),
  billIdx: index('idx_vca_bill').on(table.billId),
  tenantIdx: index('idx_vca_tenant').on(table.tenantId),
}));

export const journalLines = pgTable('journal_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  transactionId: uuid('transaction_id').notNull(),
  accountId: uuid('account_id').notNull(),
  debit: decimal('debit', { precision: 19, scale: 4 }).default('0').notNull(),
  credit: decimal('credit', { precision: 19, scale: 4 }).default('0').notNull(),
  description: text('description'),
  itemId: uuid('item_id'),
  quantity: decimal('quantity', { precision: 12, scale: 4 }),
  unitPrice: decimal('unit_price', { precision: 19, scale: 4 }),
  isTaxable: boolean('is_taxable').default(false),
  taxRate: decimal('tax_rate', { precision: 5, scale: 4 }).default('0'),
  taxAmount: decimal('tax_amount', { precision: 19, scale: 4 }).default('0'),
  lineOrder: integer('line_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  transactionIdx: index('idx_jl_transaction').on(table.transactionId),
  accountIdx: index('idx_jl_account').on(table.tenantId, table.accountId),
  tenantIdx: index('idx_jl_tenant').on(table.tenantId),
}));

export const tagGroups = pgTable('tag_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  isSingleSelect: boolean('is_single_select').default(false),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  groupId: uuid('group_id'),
  name: varchar('name', { length: 100 }).notNull(),
  color: varchar('color', { length: 7 }),
  description: text('description'),
  isActive: boolean('is_active').default(true),
  usageCount: integer('usage_count').default(0),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_tags_tenant').on(table.tenantId),
  groupIdx: index('idx_tags_group').on(table.tenantId, table.groupId),
  activeIdx: index('idx_tags_active').on(table.tenantId, table.isActive),
}));

export const transactionTags = pgTable('transaction_tags', {
  transactionId: uuid('transaction_id').notNull(),
  tagId: uuid('tag_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tagIdx: index('idx_tt_tag').on(table.tenantId, table.tagId),
  txnIdx: index('idx_tt_transaction').on(table.transactionId),
}));

export const savedReportFilters = pgTable('saved_report_filters', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 255 }).notNull(),
  reportType: varchar('report_type', { length: 100 }).notNull(),
  filters: text('filters').notNull(), // JSON string
  isDefault: boolean('is_default').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
