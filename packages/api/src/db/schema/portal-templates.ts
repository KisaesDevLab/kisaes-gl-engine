// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  date,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 11.2 — question template
// library, and 11.4 — recurring non-transaction question schedules.

export const portalQuestionTemplates = pgTable('portal_question_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // Null = practice-level (cascades to every company); set = company override.
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  // Variables consumed at render time: { vendor, amount, date, customer }.
  // Empty array means no variable substitution required.
  variablesJsonb: jsonb('variables_jsonb').notNull().default([]),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_portal_question_templates_tenant').on(table.tenantId),
  companyIdx: index('idx_portal_question_templates_company').on(table.companyId),
}));

export const portalRecurringQuestionSchedules = pgTable('portal_recurring_question_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  templateBody: text('template_body').notNull(),
  // 'monthly' | 'quarterly' | 'custom'
  cadence: varchar('cadence', { length: 20 }).notNull().default('monthly'),
  // For monthly: 1-31. For quarterly: 1-31 (in first month of each quarter).
  // For custom: ignored (use customDays).
  dayOfPeriod: varchar('day_of_period', { length: 4 }).notNull().default('5'),
  // ISO date of the next firing. The cron tick fires when nextFire <= today.
  nextFire: date('next_fire').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  fireIdx: index('idx_portal_recurring_q_next_fire').on(table.tenantId, table.nextFire, table.active),
}));
