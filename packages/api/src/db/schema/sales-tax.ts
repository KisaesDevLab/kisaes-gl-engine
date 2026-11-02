// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, boolean, integer, date, timestamp, decimal, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Sales tax (U-147, migration 0252). An agency is a vendor the tax is paid
// to; a sales tax item is one rate (with its agency) or a group of items
// charged together; codes say why a line is or is not taxed. Each posted
// sales document writes transaction_tax_lines (one row per tax item: base
// and tax, signed by liability effect), so the liability report and Pay
// Sales Tax sum what the documents stored.

export const salesTaxAgencies = pgTable('sales_tax_agencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  vendorId: uuid('vendor_id').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vendorIdx: uniqueIndex('uq_sales_tax_agency_vendor').on(t.companyId, t.vendorId),
  tenantIdx: index('idx_sales_tax_agency_tenant').on(t.tenantId),
}));

export const salesTaxItems = pgTable('sales_tax_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** 'item' (one rate) or 'group' (its members' rates added). */
  kind: varchar('kind', { length: 10 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  /** Fraction, 6 places; NULL on a group. */
  rate: decimal('rate', { precision: 7, scale: 6 }),
  /** NULL only on a legacy item (made from a stored line rate). */
  agencyId: uuid('agency_id'),
  /** The stored line rate a legacy item stands for (unique per company). */
  legacyRate: decimal('legacy_rate', { precision: 7, scale: 6 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nameIdx: uniqueIndex('uq_sales_tax_item_name').on(t.companyId, sql`lower(${t.name})`).where(sql`legacy_rate IS NULL`),
  legacyIdx: uniqueIndex('uq_sales_tax_item_legacy').on(t.companyId, t.legacyRate),
  tenantIdx: index('idx_sales_tax_item_tenant').on(t.tenantId),
}));

export const salesTaxGroupMembers = pgTable('sales_tax_group_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  groupId: uuid('group_id').notNull(),
  itemId: uuid('item_id').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => ({
  memberIdx: uniqueIndex('uq_sales_tax_group_member').on(t.groupId, t.itemId),
  itemIdx: index('idx_sales_tax_group_member_item').on(t.companyId, t.itemId),
}));

export const salesTaxCodes = pgTable('sales_tax_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  code: varchar('code', { length: 8 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  taxable: boolean('taxable').notNull(),
  /** 'Tax' and 'Non', made for every company; never renamed or deactivated. */
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('uq_sales_tax_code').on(t.companyId, sql`lower(${t.code})`),
  tenantIdx: index('idx_sales_tax_code_tenant').on(t.tenantId),
}));

export const transactionTaxLines = pgTable('transaction_tax_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  transactionId: uuid('transaction_id').notNull(),
  /** sale | discount | bad_debt | recovery. */
  kind: varchar('kind', { length: 10 }).notNull(),
  eventDate: date('event_date').notNull(),
  /** The document's sales tax (item or group). */
  salesTaxId: uuid('sales_tax_id'),
  /** The item the tax is owed for; NULL = unassigned (STP tax with no item). */
  taxItemId: uuid('tax_item_id'),
  /** The item's agency when the row was written (Q-P23v). */
  agencyId: uuid('agency_id'),
  taxCodeId: uuid('tax_code_id'),
  invoiceId: uuid('invoice_id'),
  applicationId: uuid('application_id'),
  rate: decimal('rate', { precision: 7, scale: 6 }),
  base: decimal('base', { precision: 19, scale: 4 }).notNull().default('0'),
  tax: decimal('tax', { precision: 19, scale: 4 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dateIdx: index('idx_txn_tax_lines_date').on(t.companyId, t.eventDate),
  itemIdx: index('idx_txn_tax_lines_item').on(t.companyId, t.taxItemId),
  txnIdx: index('idx_txn_tax_lines_txn').on(t.transactionId),
  invoiceIdx: index('idx_txn_tax_lines_invoice').on(t.invoiceId),
  tenantIdx: index('idx_txn_tax_lines_tenant').on(t.tenantId),
}));

export const salesTaxPaymentLines = pgTable('sales_tax_payment_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** NULL on an opening line (paid before 0252, no GL). */
  transactionId: uuid('transaction_id'),
  taxItemId: uuid('tax_item_id'),
  agencyId: uuid('agency_id'),
  /** paid | adjustment | opening. */
  kind: varchar('kind', { length: 12 }).notNull(),
  lineDate: date('line_date').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  accountId: uuid('account_id'),
  reason: varchar('reason', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyIdx: index('idx_st_payment_lines_company').on(t.companyId, t.taxItemId),
  txnIdx: index('idx_st_payment_lines_txn').on(t.transactionId),
  tenantIdx: index('idx_st_payment_lines_tenant').on(t.tenantId),
}));

/**
 * Pay Sales Tax (U-150, migration 0254): one row per sales_tax_payment
 * transaction — its agency, the date it pays through and the method. Its
 * paid and adjustment lines are sales_tax_payment_lines.
 */
export const salesTaxPayments = pgTable('sales_tax_payments', {
  transactionId: uuid('transaction_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  agencyId: uuid('agency_id').notNull(),
  throughDate: date('through_date').notNull(),
  /** check | electronic. */
  method: varchar('method', { length: 12 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyIdx: index('idx_st_payments_company').on(t.companyId, t.agencyId, t.throughDate),
  tenantIdx: index('idx_st_payments_tenant').on(t.tenantId),
}));

/** Exemption certificates (U-151, migration 0255): a client's resale or exemption certificate. */
export const contactTaxExemptions = pgTable('contact_tax_exemptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  number: varchar('number', { length: 50 }).notNull(),
  state: varchar('state', { length: 20 }),
  /** NULL: does not expire. */
  expiresOn: date('expires_on'),
  /** A file of the same company filed on the same client. */
  attachmentId: uuid('attachment_id'),
  note: text('note'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  contactIdx: index('idx_tax_exemptions_contact').on(t.companyId, t.contactId),
  expiryIdx: index('idx_tax_exemptions_expiry').on(t.companyId, t.expiresOn),
  tenantIdx: index('idx_tax_exemptions_tenant').on(t.tenantId),
}));

/**
 * Bad-debt recoveries (U-154, migration 0256): the write-off application a
 * bad_debt_recovery transaction takes back, and how much. Counts while the
 * recovery is posted.
 */
export const writeOffRecoveries = pgTable('write_off_recoveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  recoveryTxnId: uuid('recovery_txn_id').notNull(),
  amount: decimal('amount', { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appIdx: index('idx_write_off_recoveries_app').on(t.applicationId),
  invoiceIdx: index('idx_write_off_recoveries_invoice').on(t.companyId, t.invoiceId),
  txnIdx: index('idx_write_off_recoveries_txn').on(t.recoveryTxnId),
  tenantIdx: index('idx_write_off_recoveries_tenant').on(t.tenantId),
}));