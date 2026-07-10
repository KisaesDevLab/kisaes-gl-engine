// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
} from 'drizzle-orm/pg-core';

// PORTAL_IDENTITY_LINKING_V1 — master identity for portal contacts.
// One row per real human (keyed on lowercased email); per-firm
// portal_contacts rows link to it via portal_contacts.identity_id.
//
// The legacy portal_passwords table is kept for unlinked contacts; a
// contact with identity_id set authenticates against this row's
// password_hash instead, and lockout state is tracked here so a brute
// force at firm A also throttles firm B.
//
// Unique-by-lowercased-email is enforced both at the DB layer
// (functional UNIQUE INDEX on LOWER(email) — see migration 0097) and
// by the service which normalizes at insert. Drizzle doesn't model
// functional indexes, so the unique constraint is migration-only.
export const portalIdentities = pgTable('portal_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).notNull(),
  bcryptHash: varchar('password_hash', { length: 80 }).notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
