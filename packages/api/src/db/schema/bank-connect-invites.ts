// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bank connection invites (migration 0151): tokenized public links that let
// a client connect their bank via Plaid Link without logging in. Mirrors the
// W-9 request pattern (portal-1099.ts w9Requests): the raw token is never
// stored, only its SHA-256; the resulting Plaid connection is attributed to
// the INVITING staff user (created_by), which is what makes it visible for
// mapping. One invite serves multiple institutions until expiry/revocation.

import { pgTable, uuid, varchar, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';

export const bankConnectInvites = pgTable('bank_connect_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  recipientName: varchar('recipient_name', { length: 255 }).notNull(),
  // Either or both must be set; enforced in the service.
  recipientEmail: varchar('recipient_email', { length: 320 }),
  recipientPhone: varchar('recipient_phone', { length: 30 }),
  message: text('message'),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  // sent | viewed | connected | expired | revoked. Unlike W-9 requests,
  // 'connected' invites remain loadable/connectable until expiry (a client
  // commonly has several banks to hook up from one link).
  status: varchar('status', { length: 20 }).notNull().default('sent'),
  // email | sms | both
  sentVia: varchar('sent_via', { length: 10 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  viewedAt: timestamp('viewed_at', { withTimezone: true }),
  connectedAt: timestamp('connected_at', { withTimezone: true }),
  // No FK — plaid_items is appliance-global and admin force-removal may
  // delete rows independently of this tenant.
  connectedPlaidItemId: uuid('connected_plaid_item_id'),
  connectionsCount: integer('connections_count').notNull().default(0),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
  createdBy: uuid('created_by').notNull(),
  // Snapshot at send time — the notification email target must survive the
  // inviter later changing their address or being deleted.
  createdByName: varchar('created_by_name', { length: 255 }),
  createdByEmail: varchar('created_by_email', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenIdx: index('idx_bci_token').on(table.tokenHash),
  tenantIdx: index('idx_bci_tenant').on(table.tenantId, table.status),
}));
