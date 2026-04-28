// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, boolean, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

// Per-tenant feature flag table introduced in VIBE_MYBOOKS_PRACTICE_
// BUILD_PLAN Phase 1. Composite (tenant_id, flag_key) PK keeps every
// tenant's state isolated and means every read is a single index
// probe. ON DELETE CASCADE from tenants so a removed tenant doesn't
// leave orphaned flag rows.
//
// `rollout_percent` is stored but not yet consumed — the Phase 1
// `isEnabled` check only looks at the `enabled` boolean. Gradual-
// rollout evaluation is a later-phase concern; storing the column
// now avoids an ALTER when that ships.
export const tenantFeatureFlags = pgTable('tenant_feature_flags', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  flagKey: varchar('flag_key', { length: 64 }).notNull(),
  enabled: boolean('enabled').notNull().default(false),
  rolloutPercent: integer('rollout_percent').notNull().default(0),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.tenantId, table.flagKey] }),
}));
