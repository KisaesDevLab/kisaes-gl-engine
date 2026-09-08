// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// "Invite my accountant" (migration 0168): a tenant owner invites a firm
// staff member by email; the staffer accepts via link or 8-char code and
// the tenant is assigned to THEIR firm. Clones the bank_connect_invites
// shape: raw secrets are never stored, only SHA-256 hashes; resend rotates
// both; expiry flips lazily. The invite carries no firm id — the acceptor's
// firm membership decides where the tenant goes.

import { pgTable, uuid, varchar, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { firms } from './firms.js';

export const firmInvites = pgTable('firm_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // Normalised (trim + lower). Acceptance is bound to this address.
  recipientEmail: varchar('recipient_email', { length: 320 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  codeHash: varchar('code_hash', { length: 64 }).notNull(),
  // sent | viewed | accepted | expired | revoked
  status: varchar('status', { length: 20 }).notNull().default('sent'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  resendCount: integer('resend_count').notNull().default(0),
  viewedAt: timestamp('viewed_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  // Loose ref — users is tenant-scoped and the acceptor lives elsewhere.
  acceptedByUserId: uuid('accepted_by_user_id'),
  acceptedFirmId: uuid('accepted_firm_id').references(() => firms.id, { onDelete: 'set null' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
  createdBy: uuid('created_by').notNull(),
  // Snapshot at send time — the acceptance notification target must survive
  // the inviter changing their address or being deleted.
  createdByName: varchar('created_by_name', { length: 255 }),
  createdByEmail: varchar('created_by_email', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenIdx: index('idx_fi_token').on(table.tokenHash),
  codeIdx: index('idx_fi_code').on(table.codeHash),
  tenantIdx: index('idx_fi_tenant').on(table.tenantId, table.status),
}));
