// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

export const staffIpAllowlist = pgTable('staff_ip_allowlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  cidr: text('cidr').notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
});
