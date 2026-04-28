// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, text, decimal, timestamp, index, uniqueIndex, jsonb } from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { bankFeedItems } from './banking.js';
import { bankRules } from './bank-rules.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 2 — the bucket workflow
// extends each pending bank-feed item with the computed bucket
// assignment and reasoning. Keyed by bank_feed_item_id (1:1) so a
// row exists during the review queue — transaction_id back-fills
// at approval time for the post-approval audit trail.
export const transactionClassificationState = pgTable('transaction_classification_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id'),
  bankFeedItemId: uuid('bank_feed_item_id').notNull().references(() => bankFeedItems.id, { onDelete: 'cascade' }),
  transactionId: uuid('transaction_id'),
  bucket: varchar('bucket', { length: 20 }).notNull(),
  confidenceScore: decimal('confidence_score', { precision: 4, scale: 3 }).notNull().default('0'),
  suggestedAccountId: uuid('suggested_account_id'),
  suggestedVendorId: uuid('suggested_vendor_id'),
  matchedRuleId: uuid('matched_rule_id').references(() => bankRules.id, { onDelete: 'set null' }),
  reasoningBlob: jsonb('reasoning_blob'),
  modelUsed: varchar('model_used', { length: 100 }),
  matchCandidates: jsonb('match_candidates'),
  vendorEnrichment: jsonb('vendor_enrichment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  bankFeedItemUnique: uniqueIndex('tcs_bank_feed_item_unique').on(table.bankFeedItemId),
  tenantBucketIdx: index('idx_tcs_tenant_bucket').on(table.tenantId, table.bucket),
  tenantPeriodIdx: index('idx_tcs_tenant_period').on(table.tenantId, table.companyId, table.createdAt),
  matchedRuleIdx: index('idx_tcs_matched_rule').on(table.tenantId, table.matchedRuleId),
}));

// 30-day cache for vendor enrichment AI calls. Keyed by normalized
// vendor description so the same payee pattern only costs one AI
// call per month across the tenant.
export const vendorEnrichmentCache = pgTable('vendor_enrichment_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  vendorKey: varchar('vendor_key', { length: 255 }).notNull(),
  likelyBusinessType: varchar('likely_business_type', { length: 100 }),
  suggestedAccountType: varchar('suggested_account_type', { length: 50 }),
  sourceUrl: text('source_url'),
  summary: text('summary'),
  provider: varchar('provider', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => ({
  tenantVendorUnique: uniqueIndex('vec_tenant_vendor_unique').on(table.tenantId, table.vendorKey),
  expiryIdx: index('idx_vec_expiry').on(table.tenantId, table.expiresAt),
}));
