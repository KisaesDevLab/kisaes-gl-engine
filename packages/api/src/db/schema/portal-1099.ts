// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  date,
  timestamp,
  decimal,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { contacts } from './contacts.js';
import { accounts } from './accounts.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 14 + 15 — 1099 / W-9.
// Three tables: vendor_1099_profile, w9_requests, annual filings.
// New columns on contacts (1099_type, exempt_payee_code) live in
// the migration alongside; we don't redeclare them in the contacts
// schema file to keep that file owned by the contact CRUD pipeline.

export const vendor1099Profile = pgTable('vendor_1099_profile', {
  contactId: uuid('contact_id').primaryKey().references(() => contacts.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  w9OnFile: boolean('w9_on_file').notNull().default(false),
  w9DocumentId: uuid('w9_document_id'),
  w9CapturedAt: timestamp('w9_captured_at', { withTimezone: true }),
  w9ExpiresAt: timestamp('w9_expires_at', { withTimezone: true }),
  // TIN ciphertext lives here — uses the existing PLAID_ENCRYPTION_KEY-
  // derived AES helper. We never store the plaintext.
  tinEncrypted: text('tin_encrypted'),
  tinType: varchar('tin_type', { length: 4 }), // SSN | EIN
  tinMatchStatus: varchar('tin_match_status', { length: 20 }), // pending | matched | mismatched | not_run
  tinMatchDate: timestamp('tin_match_date', { withTimezone: true }),
  // 15.5 — IRS Pub 2108A match code returned by Bulk TIN Match.
  // 0=match, 1=missing/invalid, 2=TIN not currently issued,
  // 3=TIN/Name mismatch, 4=invalid request, 5=duplicate request,
  // 6/7/8=matched on SSN/EIN/both (when type was 'Unknown').
  tinMatchCode: varchar('tin_match_code', { length: 2 }),
  // 15.5 — captured at W-9 completion. The Bulk TIN Match service
  // requires the legal name on file with IRS, which differs from
  // the AR/AP display_name (e.g. "Acme" vs "Acme Manufacturing,
  // Inc."). For manually-entered profiles these stay null and the
  // export falls back to contacts.display_name.
  legalName: varchar('legal_name', { length: 255 }),
  businessName: varchar('business_name', { length: 255 }),
  // 15.0 — captured from W-9 form. Audit-trail copy of the
  // mailing address the vendor swore to. Bookkeeper UI offers
  // an explicit "Apply to contact billing address" action so
  // contacts.billing_* is never silently overwritten.
  addressLine1: varchar('address_line1', { length: 255 }),
  addressCity: varchar('address_city', { length: 100 }),
  addressState: varchar('address_state', { length: 50 }),
  addressZip: varchar('address_zip', { length: 20 }),
  // 14.x — explicit "not subject to 1099 reporting" mark with a
  // canonical reason. Validated in setExclusion(); UI surfaces the
  // reason as a tooltip on the Excluded pill. See migration 0082
  // for the rationale on keeping this distinct from is_1099_eligible.
  exclusionReason: varchar('exclusion_reason', { length: 40 }),
  exclusionNote: text('exclusion_note'),
  excludedAt: timestamp('excluded_at', { withTimezone: true }),
  excludedBy: uuid('excluded_by'),
  backupWithholding: boolean('backup_withholding').notNull().default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_vendor_1099_profile_tenant').on(table.tenantId),
}));

export const w9Requests = pgTable('w9_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  // Either or both must be set; constraint enforced in service.
  // Migration 0080 relaxed the NOT NULL on email to allow SMS-only.
  requestedContactEmail: varchar('requested_contact_email', { length: 320 }),
  requestedContactPhone: varchar('requested_contact_phone', { length: 30 }),
  // pending | sent | viewed | completed | expired
  status: varchar('status', { length: 20 }).notNull().default('sent'),
  magicLinkTokenHash: varchar('magic_link_token_hash', { length: 64 }).notNull(),
  message: text('message'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  viewedAt: timestamp('viewed_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  w9DocumentId: uuid('w9_document_id'),
  createdBy: uuid('created_by').notNull(),
}, (table) => ({
  tokenIdx: index('idx_w9_requests_token').on(table.magicLinkTokenHash),
  tenantIdx: index('idx_w9_requests_tenant').on(table.tenantId, table.status),
  contactIdx: index('idx_w9_requests_contact').on(table.contactId),
}));

export const annual1099Filings = pgTable('annual_1099_filings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  taxYear: integer('tax_year').notNull(),
  // 1099-NEC | 1099-MISC | 1099-K
  formType: varchar('form_type', { length: 20 }).notNull(),
  // generic | track1099 | tax1099 | irs_fire
  exportFormat: varchar('export_format', { length: 20 }).notNull(),
  vendorCount: integer('vendor_count').notNull(),
  totalAmount: decimal('total_amount', { precision: 19, scale: 4 }).notNull(),
  exportedAt: timestamp('exported_at', { withTimezone: true }).notNull().defaultNow(),
  exportedBy: uuid('exported_by').notNull(),
  // For corrections (15.8): null for original filings, set on the
  // correction row pointing back to the filing it amends/voids.
  correctionOf: uuid('correction_of'),
  // Per-vendor snapshot of what was filed: [{ contactId, displayName,
  // amount, tinMasked, tinType, backupWithholding }]. Populated on the
  // original filing so later corrections can reference exact filed
  // amounts rather than re-deriving from a ledger that may have moved.
  // Pre-0077 filings have NULL here; the correction UI prompts the
  // operator to enter vendors manually in that case.
  detailsJson: jsonb('details_json'),
  notes: text('notes'),
}, (table) => ({
  yearIdx: index('idx_annual_1099_filings_year').on(table.tenantId, table.taxYear),
}));

// 1099 account mapping — see migration 0089. One row per (tenant,
// account); the unique index enforces the "one account → one box"
// rule so the bookkeeper UI can safely assume each expense account
// belongs to at most one form_box.
export const vendor1099AccountMappings = pgTable('vendor_1099_account_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  // Closed enum validated at the service layer:
  //   NEC-1, MISC-1, MISC-2, MISC-3, MISC-6, MISC-10
  formBox: varchar('form_box', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
}, (table) => ({
  accountIdx: index('idx_vendor_1099_account_mappings_account').on(table.tenantId, table.accountId),
  formBoxIdx: index('idx_vendor_1099_account_mappings_form_box').on(table.tenantId, table.formBox),
}));
