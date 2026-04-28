// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 8 — Client Portal contact
// management. Portal contacts are the firm's *clients' people* who
// can answer questions, upload files, and view reports. They are
// distinct from `users` (staff/client app users) and from
// `contacts` (vendor/customer financial entities).

export const portalContacts = pgTable('portal_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 320 }).notNull(),
  phone: varchar('phone', { length: 30 }),
  firstName: varchar('first_name', { length: 120 }),
  lastName: varchar('last_name', { length: 120 }),
  // active | paused | deleted (soft-delete marker)
  status: varchar('status', { length: 20 }).notNull().default('active'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantEmailIdx: uniqueIndex('uq_portal_contacts_tenant_email').on(table.tenantId, table.email),
  tenantStatusIdx: index('idx_portal_contacts_tenant_status').on(table.tenantId, table.status),
}));

export const portalContactCompanies = pgTable('portal_contact_companies', {
  contactId: uuid('contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  // owner | controller | bookkeeper-liaison | staff | other
  role: varchar('role', { length: 40 }).notNull().default('staff'),
  // Whether this contact may be assigned questions for this company.
  assignable: boolean('assignable').notNull().default(true),
  financialsAccess: boolean('financials_access').notNull().default(false),
  filesAccess: boolean('files_access').notNull().default(true),
  questionsForUsAccess: boolean('questions_for_us_access').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.contactId, table.companyId] }),
  companyIdx: index('idx_portal_contact_companies_company').on(table.companyId),
}));

export const portalSettingsPerPractice = pgTable('portal_settings_per_practice', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  remindersEnabled: boolean('reminders_enabled').notNull().default(true),
  reminderCadenceDays: jsonb('reminder_cadence_days').notNull().default([3, 7, 14]),
  openTrackingEnabled: boolean('open_tracking_enabled').notNull().default(true),
  assignableQuestionsEnabled: boolean('assignable_questions_enabled').notNull().default(true),
  customDomain: varchar('custom_domain', { length: 253 }),
  brandingLogoUrl: text('branding_logo_url'),
  brandingPrimaryColor: varchar('branding_primary_color', { length: 9 }),
  announcementText: text('announcement_text'),
  announcementEnabled: boolean('announcement_enabled').notNull().default(false),
  // Phase 8.4 / 9.8 — preview ("View as Client") gating.
  previewEnabled: boolean('preview_enabled').notNull().default(true),
  // Comma-separated role allowlist for who may initiate preview.
  previewAllowedRoles: varchar('preview_allowed_roles', { length: 200 }).notNull().default('owner,bookkeeper,accountant'),
  // DOC_REQUEST_SMS_V1 — per-tenant SMS kill-switch. Off by default
  // even when system-wide SMS provider config is present, so a firm
  // without 10DLC registration in the destination country can keep
  // SMS dark while email keeps flowing.
  smsOutboundEnabled: boolean('sms_outbound_enabled').notNull().default(false),
  // DOC_REQUEST_SMS_V1 — opt-in to multi-segment SMS. Default off so
  // the renderer truncates at 160 chars (single-segment, lowest cost).
  smsAllowMultiSegment: boolean('sms_allow_multi_segment').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const portalSettingsPerCompany = pgTable('portal_settings_per_company', {
  companyId: uuid('company_id').primaryKey().references(() => companies.id, { onDelete: 'cascade' }),
  remindersEnabled: boolean('reminders_enabled'),
  reminderCadenceDays: jsonb('reminder_cadence_days'),
  assignableQuestionsEnabled: boolean('assignable_questions_enabled'),
  financialsAccessDefault: boolean('financials_access_default'),
  filesAccessDefault: boolean('files_access_default'),
  // Per-company override of preview re-auth requirement.
  previewRequireReauth: boolean('preview_require_reauth').notNull().default(false),
  paused: boolean('paused').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Phase 8.4 — preview/impersonation session log. Every "View as
// Client" session start + end gets a row here so we can audit and
// build the practice-level "Preview sessions last 30 days" report.
export const previewSessions = pgTable('preview_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  contactId: uuid('contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  // contact_detail | contact_list | close_page | question_view
  origin: varchar('origin', { length: 30 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),
}, (table) => ({
  tenantStartedIdx: index('idx_preview_sessions_tenant_started').on(table.tenantId, table.startedAt),
  contactIdx: index('idx_preview_sessions_contact').on(table.contactId, table.startedAt),
}));
