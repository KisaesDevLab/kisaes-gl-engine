// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { pgTable, uuid, varchar, text, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { firms } from './firms.js';

// Firm-level external integration credentials (migration 0113).
// First provider: tax1099.com e-filing. Credential columns hold
// AES-GCM ciphertext (utils/encryption.ts) — NEVER return them to a
// client; expose has* booleans only (plaid_config idiom).
export const firmIntegrations = pgTable('firm_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 50 }).notNull(),
  apiKeyEncrypted: text('api_key_encrypted'),
  usernameEncrypted: text('username_encrypted'),
  passwordEncrypted: text('password_encrypted'),
  environment: varchar('environment', { length: 20 }).notNull().default('sandbox'),
  baseUrlOverride: varchar('base_url_override', { length: 255 }),
  isEnabled: boolean('is_enabled').notNull().default(false),
  updatedByUserId: uuid('updated_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  firmProviderIdx: uniqueIndex('firm_integrations_firm_provider_idx').on(table.firmId, table.provider),
}));
