// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { firms } from './firms.js';
import { tenants } from './auth.js';
import { companies } from './company.js';
import { portalContacts } from './portal-contacts.js';

// Vibe Practice Management peer trust (migration 0172). One row per
// firm per provider: the PM instance's `iss` plus either a public key
// PEM or a JWKS URL. Public material only — nothing here is secret.
// `issuer` is globally unique so a bearer token resolves to exactly one
// firm without any firm hint in the request.
export const firmPeers = pgTable('firm_peers', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 50 }).notNull().default('vibe_pm'),
  issuer: varchar('issuer', { length: 255 }).notNull(),
  publicKeyPem: text('public_key_pem'),
  jwksUrl: varchar('jwks_url', { length: 512 }),
  isEnabled: boolean('is_enabled').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  // Enum (services/peer-token.service.ts PeerErrorCode) — never token text.
  lastError: varchar('last_error', { length: 40 }),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  updatedByUserId: uuid('updated_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  firmProviderIdx: uniqueIndex('firm_peers_firm_provider_idx').on(table.firmId, table.provider),
  issuerIdx: uniqueIndex('firm_peers_issuer_idx').on(table.issuer),
}));

// PM client entity → the exact MyBooks (tenant, company, portal contact)
// the peer acts as. The contact's portal_contact_companies flags for
// that company are what PM inherits; staff maintain these rows.
export const pmClientLinks = pgTable('pm_client_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  pmClientId: varchar('pm_client_id', { length: 120 }).notNull(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  firmClientIdx: uniqueIndex('pm_client_links_firm_client_idx').on(table.firmId, table.pmClientId),
  tenantIdx: index('idx_pm_client_links_tenant').on(table.tenantId),
}));
