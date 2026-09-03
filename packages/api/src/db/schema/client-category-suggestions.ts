// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Categories portal contacts SUGGESTED for uncategorized activity.
//
// A suggestion is data, never an instruction: nothing in the portal write
// path can produce any status but 'pending', and approval runs through the
// existing posting primitives. See migration 0164 for the full rationale,
// including why this is not columns on transaction_classification_state.

import { pgTable, uuid, varchar, text, boolean, timestamp, date, numeric, index } from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';
import { accounts } from './accounts.js';
import { bankFeedItems } from './banking.js';
import { portalContacts } from './portal-contacts.js';

/** Only a portal write may create one, and only ever as 'pending'. */
export const CLIENT_SUGGESTION_STATUSES = [
  'pending',
  // Transient claim taken while the ledger primitive runs. The posting
  // services open their own DB transactions, so the row cannot simply be held
  // under FOR UPDATE across the post.
  'approving',
  'approved',
  'rejected',
  // The client answered again, or a colleague at the same company did.
  'superseded',
  // The target went away or was handled elsewhere. Distinct from 'rejected'
  // because it is not the client's fault and earns no "declined" message.
  'stale',
] as const;
export type ClientSuggestionStatus = typeof CLIENT_SUGGESTION_STATUSES[number];

export const clientCategorySuggestions = pgTable('client_category_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),

  targetKind: varchar('target_kind', { length: 20 }).notNull(),
  bankFeedItemId: uuid('bank_feed_item_id').references(() => bankFeedItems.id, { onDelete: 'cascade' }),
  // Soft reference by design — see the migration header.
  transactionId: uuid('transaction_id'),

  suggestedAccountId: uuid('suggested_account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  suggestedLabel: varchar('suggested_label', { length: 120 }),
  clientNote: text('client_note'),
  isPersonal: boolean('is_personal').notNull().default(false),

  status: varchar('status', { length: 20 }).notNull().default('pending'),
  submittedByContactId: uuid('submitted_by_contact_id').notNull()
    .references(() => portalContacts.id, { onDelete: 'cascade' }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),

  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by'),
  resolution: varchar('resolution', { length: 30 }),
  resolvedAccountId: uuid('resolved_account_id'),
  rejectionReason: text('rejection_reason'),
  postedTransactionId: uuid('posted_transaction_id'),

  // Staleness detector, not a cache: Plaid rewrites amounts pending->posted.
  snapshotAmount: numeric('snapshot_amount', { precision: 19, scale: 4 }).notNull(),
  snapshotDate: date('snapshot_date').notNull(),
  snapshotDescription: varchar('snapshot_description', { length: 500 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // The partial unique + unread indexes live in the migration; Drizzle has no
  // partial-index syntax here. These are the plain lookups.
  tenantCompanyIdx: index('idx_ccs_tenant_company_status')
    .on(table.tenantId, table.companyId, table.status, table.submittedAt),
  contactIdx: index('idx_ccs_contact').on(table.submittedByContactId, table.submittedAt),
}));
