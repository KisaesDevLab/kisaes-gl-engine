// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { portalContacts } from './portal-contacts.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 9 — magic-link auth +
// session storage for the portal. Distinct from staff JWT auth:
// portal contacts authenticate themselves via emailed one-time
// links (single-use, 15 min) and live in portal_contact_sessions.

export const portalMagicLinks = pgTable('portal_magic_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  // SHA-256 hex of the unhashed token; we never store the raw token.
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  emailSentTo: varchar('email_sent_to', { length: 320 }).notNull(),
  ipAddress: varchar('ip_address', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
}, (table) => ({
  hashIdx: uniqueIndex('uq_portal_magic_links_hash').on(table.tokenHash),
  contactIdx: index('idx_portal_magic_links_contact').on(table.contactId, table.createdAt),
}));

export const portalContactSessions = pgTable('portal_contact_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  // SHA-256 of the cookie value. The cookie sets a random 32-byte token;
  // we compare hashes server-side so a DB read of this table never reveals
  // a usable cookie.
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: varchar('ip_address', { length: 64 }),
  userAgent: text('user_agent'),
}, (table) => ({
  hashIdx: uniqueIndex('uq_portal_sessions_hash').on(table.tokenHash),
  contactIdx: index('idx_portal_sessions_contact').on(table.contactId, table.lastActivityAt),
}));

export const portalPasswords = pgTable('portal_passwords', {
  contactId: uuid('contact_id').primaryKey().references(() => portalContacts.id, { onDelete: 'cascade' }),
  bcryptHash: varchar('bcrypt_hash', { length: 80 }).notNull(),
  setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  // Active flag lets us soft-disable a password without wiping the hash —
  // useful when an admin pauses an account but might want to restore.
  active: boolean('active').notNull().default(true),
});
