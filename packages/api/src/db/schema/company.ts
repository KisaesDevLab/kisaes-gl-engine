// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, text, integer, decimal, boolean, timestamp, jsonb, date, bigint } from 'drizzle-orm/pg-core';

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  businessName: varchar('business_name', { length: 255 }).notNull(),
  legalName: varchar('legal_name', { length: 255 }),
  ein: varchar('ein', { length: 20 }),
  addressLine1: varchar('address_line1', { length: 255 }),
  addressLine2: varchar('address_line2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 50 }),
  zip: varchar('zip', { length: 20 }),
  country: varchar('country', { length: 3 }).default('US'),
  phone: varchar('phone', { length: 30 }),
  email: varchar('email', { length: 255 }),
  website: varchar('website', { length: 255 }),
  logoUrl: varchar('logo_url', { length: 500 }),
  industry: varchar('industry', { length: 100 }),
  entityType: varchar('entity_type', { length: 50 }).notNull().default('sole_prop'),
  fiscalYearStartMonth: integer('fiscal_year_start_month').default(1),
  accountingMethod: varchar('accounting_method', { length: 10 }).default('accrual'),
  defaultPaymentTerms: varchar('default_payment_terms', { length: 50 }).default('net_30'),
  invoicePrefix: varchar('invoice_prefix', { length: 20 }).default('INV-'),
  invoiceNextNumber: integer('invoice_next_number').default(1001),
  defaultSalesTaxRate: decimal('default_sales_tax_rate', { precision: 5, scale: 4 }).default('0'),
  currency: varchar('currency', { length: 3 }).default('USD'),
  dateFormat: varchar('date_format', { length: 20 }).default('MM/DD/YYYY'),
  categoryFilterMode: varchar('category_filter_mode', { length: 10 }).default('by_type'),
  defaultLineEntryMode: varchar('default_line_entry_mode', { length: 20 }).default('category'),
  checkSettings: jsonb('check_settings').default('{"format":"voucher","bankName":"","bankAddress":"","routingNumber":"","accountNumber":"","fractionalRouting":"","printOnBlankStock":false,"printCompanyInfo":true,"printSignatureLine":true,"alignmentOffsetX":0,"alignmentOffsetY":0,"nextCheckNumber":1001,"defaultBankAccountId":null}'),
  smtpHost: varchar('smtp_host', { length: 255 }),
  smtpPort: integer('smtp_port').default(587),
  smtpUser: varchar('smtp_user', { length: 255 }),
  smtpPass: varchar('smtp_pass', { length: 500 }),
  smtpFrom: varchar('smtp_from', { length: 255 }),
  lockDate: date('lock_date'),
  setupComplete: boolean('setup_complete').default(false),
  mcpEnabled: boolean('mcp_enabled').default(false),
  // Per-company chat opt-in (tier 2 of two-tier consent — see
  // AI_CHAT_SUPPORT_PLAN.md §8.1). System enables on ai_config,
  // company opts in here. Both must be true for the chat panel
  // to appear.
  chatSupportEnabled: boolean('chat_support_enabled').default(false),
  // Per-company AI consent (tier 2 of the AI PII addendum). Same
  // pattern as chatSupportEnabled but covers the core AI tasks
  // (categorization, receipt OCR, statement parsing, document
  // classification). aiDisclosureVersion points at the
  // ai_config.disclosure_version that was in effect when the owner
  // accepted — if the admin later changes a setting that loosens
  // data handling, ai_config.disclosure_version increments and the
  // company is paused until re-acceptance.
  aiEnabled: boolean('ai_enabled').notNull().default(false),
  aiEnabledTasks: jsonb('ai_enabled_tasks').notNull().default(
    '{"categorization":false,"receipt_ocr":false,"statement_parsing":false,"document_classification":false}'
  ),
  aiDisclosureAcceptedAt: timestamp('ai_disclosure_accepted_at', { withTimezone: true }),
  aiDisclosureAcceptedBy: uuid('ai_disclosure_accepted_by'),
  aiDisclosureVersion: integer('ai_disclosure_version'),
  // Remote backup configuration
  remoteBackupEnabled: boolean('remote_backup_enabled').default(false),
  remoteBackupDestination: varchar('remote_backup_destination', { length: 30 }),
  remoteBackupConfig: jsonb('remote_backup_config'),
  remoteBackupSchedule: varchar('remote_backup_schedule', { length: 20 }),
  remoteBackupPassphraseHash: varchar('remote_backup_passphrase_hash', { length: 255 }),
  remoteBackupLastAt: timestamp('remote_backup_last_at', { withTimezone: true }),
  remoteBackupLastStatus: varchar('remote_backup_last_status', { length: 20 }),
  remoteBackupLastSize: bigint('remote_backup_last_size', { mode: 'number' }),
  // Stripe online payments (per-company keys)
  stripeSecretKeyEncrypted: text('stripe_secret_key_encrypted'),
  stripePublishableKey: varchar('stripe_publishable_key', { length: 255 }),
  stripeWebhookSecretEncrypted: text('stripe_webhook_secret_encrypted'),
  onlinePaymentsEnabled: boolean('online_payments_enabled').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
