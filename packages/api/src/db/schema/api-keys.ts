// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, text, boolean, integer, bigint, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
  keyHash: varchar('key_hash', { length: 255 }).notNull(),
  // Permissions
  scopes: text('scopes').default('all'), // comma-separated: all,read,write,reports,banking,invoicing
  allowedCompanies: text('allowed_companies'), // comma-separated UUIDs, NULL = all user's companies
  // Rate limiting
  rateLimitPerMinute: integer('rate_limit_per_minute').default(60),
  rateLimitPerHour: integer('rate_limit_per_hour').default(1000),
  // Status
  role: varchar('role', { length: 50 }).notNull().default('owner'),
  isActive: boolean('is_active').default(true),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  lastUsedIp: varchar('last_used_ip', { length: 45 }),
  totalRequests: bigint('total_requests', { mode: 'number' }).default(0),
  // Lifecycle
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
}, (table) => ({
  // Unique: two rows must never share a hash. Lookup-by-hash is how we
  // authenticate API calls, and findFirst() returning the wrong row on
  // collision would be authentication identity confusion.
  keyHashIdx: uniqueIndex('idx_api_keys_hash').on(table.keyHash),
  tenantIdx: index('idx_api_keys_tenant').on(table.tenantId),
  userIdx: index('idx_api_keys_user').on(table.userId),
}));
