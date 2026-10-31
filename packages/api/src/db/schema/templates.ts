// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const emailTemplates = pgTable('email_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  templateType: varchar('template_type', { length: 50 }).notNull(),
  subject: varchar('subject', { length: 500 }).notNull(),
  body: text('body').notNull(),
  isDefault: boolean('is_default').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export interface InvoiceLayoutColumns {
  item: boolean;
  description: boolean;
  serviceDate: boolean;
  quantity: boolean;
  rate: boolean;
}

/** Today's printed form: description, quantity and rate (U-130). */
export const DEFAULT_LAYOUT_COLUMNS: InvoiceLayoutColumns = {
  item: false, description: true, serviceDate: false, quantity: true, rate: true,
};

export const invoiceTemplates = pgTable('invoice_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id'),
  name: varchar('name', { length: 100 }).notNull(),
  logoUrl: varchar('logo_url', { length: 500 }),
  accentColor: varchar('accent_color', { length: 7 }).default('#2563EB'),
  showShipTo: boolean('show_ship_to').default(false),
  showPoNumber: boolean('show_po_number').default(false),
  showTerms: boolean('show_terms').default(true),
  footerText: text('footer_text'),
  // Per-type footer text (U-111, migration 0240); blank or absent -> footerText.
  footerOverrides: jsonb('footer_overrides').$type<Record<string, string | null>>().notNull().default({}),
  // Which line columns the printed invoice shows (U-130, migration 0246);
  // the amount always prints. Each row is an invoice layout of its company;
  // one per company is the default (uq_invoice_templates_company_default).
  lineColumns: jsonb('line_columns').$type<InvoiceLayoutColumns>().notNull().default(DEFAULT_LAYOUT_COLUMNS),
  // Archived layouts (U-130) are never deleted: they leave the picker, can't
  // be chosen for new invoices or clients, and still print the invoices
  // that use them. The default can't be archived.
  isArchived: boolean('is_archived').notNull().default(false),
  isDefault: boolean('is_default').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
