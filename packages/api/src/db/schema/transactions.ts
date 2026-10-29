// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, decimal, boolean, date, timestamp, integer, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
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
  // Reporting basis: which report bases this transaction affects. 'both'
  // (default) shows on cash AND accrual reports; 'cash' only on cash-basis
  // reports; 'accrual' only on accrual. Lets a manual journal entry (e.g. a
  // depreciation / accrual adjusting entry) be excluded from the other basis.
  // Non-JE transactions stay 'both', preserving existing report behavior.
  basis: varchar('basis', { length: 10 }).default('both').notNull(),
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
  // Bill terms (U-86, migration 0230): the early-payment discount of the
  // terms, the discount date, and whether the owner typed the due / discount
  // date instead of the engine computing it.
  discountPercent: decimal('discount_percent', { precision: 7, scale: 4 }),
  discountDays: integer('discount_days'),
  discountDate: date('discount_date'),
  dueDateOverridden: boolean('due_date_overridden').notNull().default(false),
  discountDateOverridden: boolean('discount_date_overridden').notNull().default(false),
  // Bill received (U-87, migration 0230): false = in A/P, not payable yet.
  billReceived: boolean('bill_received').notNull().default(true),
  // Invoice, cash sale or credit memo waiting to be printed (U-113, migration 0240).
  printLater: boolean('print_later').notNull().default(false),
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
  // Signature image applied when this check printed (NULL = printed
  // unsigned). FK-less on purpose: historical record, survives signature
  // soft-delete. See check-signatures.ts.
  printSignatureId: uuid('print_signature_id'),
  // Created as a check (Write Checks, or a Pay Bills payment by check that
  // pays cash); stays true after a void (U-117, migration 0241).
  isCheck: boolean('is_check').notNull().default(false),
  // How the payment was made (shared PAYMENT_METHODS) and the payer/payee's
  // reference for it — ACH trace, card auth, the customer's check number.
  // NULL on rows that predate migration 0178.
  paymentMethod: varchar('payment_method', { length: 20 }),
  referenceNumber: varchar('reference_number', { length: 100 }),
  // Source tracking — identifies where this transaction originated
  source: varchar('source', { length: 30 }),  // 'payroll_import', 'bank_feed', 'manual', 'recurring', etc.
  // AJE display number (TB module, D17): sequential per company per
  // fiscal year, only set when txn_type = 'aje'. Shown as AJE-001
  // alongside txn_number. Claimed from tb_aje_sequences.
  ajeNumber: integer('aje_number'),
  sourceId: varchar('source_id', { length: 100 }), // payroll session ID, bank feed item ID, etc.
  // Adjusting entry (U-60, migration 0224). Reports take
  // adjusting=include|exclude|only. AJEs (txn_type 'aje') are always true.
  isAdjusting: boolean('is_adjusting').notNull().default(false),
  // On an automatic reversing entry (U-61, migration 0224): the journal
  // entry it reverses. No FK (like applied_to_invoice_id).
  reversesTransactionId: uuid('reverses_transaction_id'),
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
  reversesIdx: index('idx_txn_reverses').on(table.tenantId, table.reversesTransactionId)
    .where(sql`${table.reversesTransactionId} IS NOT NULL`),
}));

export const billPaymentApplications = pgTable('bill_payment_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  paymentId: uuid('payment_id').notNull(),
  billId: uuid('bill_id').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  // Early-payment discount this payment took on the bill (migration 0230,
  // P18). Counts toward the bill with the cash amount; 0 until P18 writes it.
  discountAmount: decimal('discount_amount', { precision: 19, scale: 4 }).notNull().default('0'),
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
  // ADR 0XX: split-level tag. FK declared in migration 0059 (ON DELETE RESTRICT).
  tagId: uuid('tag_id'),
  // Per-line payee ("Received From"). Added in migration 0099. No FK (mirrors
  // transactions.contact_id), tenant-scoped via the composite index below.
  contactId: uuid('contact_id'),
  // True on the reversing lines persisted by voidTransaction (rule 23,
  // migration 0112). Document views filter these out; the GL keeps them.
  isVoidReversal: boolean('is_void_reversal').notNull().default(false),
  // Billable to the line's contact (U-50, migration 0221). billedStatus is
  // NULL when not billable, 'unbilled' when billable and not yet invoiced,
  // 'billed' once invoiced (CHECK journal_lines_billed_status_chk).
  isBillable: boolean('is_billable').notNull().default(false),
  billedStatus: text('billed_status'),
  // The document this line settles (migration 0223): on a deposit, the
  // Payments Clearing item it deposits (U-52) or the vendor credit it
  // refunds (U-54). deposit_lines is the settlement registry; this column
  // ties the registry row to its line for display and editing. No FK
  // (mirrors deposit_lines).
  sourceTransactionId: uuid('source_transaction_id'),
  // The line's job inside its document when lines must be told apart
  // (migration 0223): 'cash_back' on a deposit (U-53). NULL otherwise.
  lineRole: varchar('line_role', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  transactionIdx: index('idx_jl_transaction').on(table.transactionId),
  accountIdx: index('idx_jl_account').on(table.tenantId, table.accountId),
  tenantIdx: index('idx_jl_tenant').on(table.tenantId),
  tagIdx: index('idx_journal_lines_tag_id').on(table.tagId),
  tenantTagIdx: index('idx_journal_lines_tenant_tag').on(table.tenantId, table.tagId),
  contactIdx: index('idx_jl_contact').on(table.tenantId, table.contactId),
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
  // Optional number (tag-number-v1, migration 0228), unique per tenant when set.
  tagNumber: varchar('tag_number', { length: 20 }),
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
  tenantTagNumberIdx: uniqueIndex('idx_tags_tenant_tag_number').on(table.tenantId, table.tagNumber).where(sql`tag_number IS NOT NULL`),
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
