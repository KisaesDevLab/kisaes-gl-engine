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
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { companies } from './company.js';
import { portalContacts } from './portal-contacts.js';
import { portalQuestions } from './portal-questions.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 13 — automated reminders.
// Four tables: schedules, individual sends, suppressions, templates.

export const reminderSchedules = pgTable('reminder_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // null → applies to every company in the tenant.
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  // unanswered_question | w9_pending | doc_request | recurring_non_transaction | magic_link_expiring
  triggerType: varchar('trigger_type', { length: 40 }).notNull(),
  // JSON-array of day offsets (e.g. [3,7,14] = nudge after 3, 7, 14 days).
  cadenceDays: jsonb('cadence_days').notNull().default([3, 7, 14]),
  // email_only | sms_only | both | escalating
  channelStrategy: varchar('channel_strategy', { length: 20 }).notNull().default('email_only'),
  quietHoursStart: integer('quiet_hours_start').notNull().default(20),
  quietHoursEnd: integer('quiet_hours_end').notNull().default(8),
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  // Hard cap so a misconfigured cadence can't carpet-bomb a contact.
  maxPerWeek: integer('max_per_week').notNull().default(3),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantTriggerIdx: index('idx_reminder_schedules_tenant_trigger').on(table.tenantId, table.triggerType, table.active),
}));

export const reminderSends = pgTable('reminder_sends', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduleId: uuid('schedule_id').references(() => reminderSchedules.id, { onDelete: 'set null' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  // Optional — set when the reminder was about a specific question.
  questionId: uuid('question_id').references(() => portalQuestions.id, { onDelete: 'set null' }),
  channel: varchar('channel', { length: 10 }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  clickedAt: timestamp('clicked_at', { withTimezone: true }),
  bouncedAt: timestamp('bounced_at', { withTimezone: true }),
  error: text('error'),
  // DOC_REQUEST_SMS_V1 — provider correlation. Twilio/TextLinkSMS each
  // return a message id we store here so the inbound delivery-status
  // webhook can correlate back to the send row that generated it.
  providerMessageId: varchar('provider_message_id', { length: 120 }),
  providerStatus: varchar('provider_status', { length: 40 }),
}, (table) => ({
  contactSentIdx: index('idx_reminder_sends_contact_sent').on(table.contactId, table.sentAt),
  tenantSentIdx: index('idx_reminder_sends_tenant_sent').on(table.tenantId, table.sentAt),
  providerMsgIdx: index('idx_reminder_sends_provider_msg').on(table.providerMessageId),
}));

export const reminderSuppressions = pgTable('reminder_suppressions', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  // STOP_KEYWORD | ENGAGEMENT | MANUAL | BOUNCE
  reason: varchar('reason', { length: 30 }).notNull(),
  channel: varchar('channel', { length: 10 }), // null = all channels
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (table) => ({
  contactIdx: index('idx_reminder_suppressions_contact').on(table.contactId, table.expiresAt),
}));

export const reminderTemplates = pgTable('reminder_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  triggerType: varchar('trigger_type', { length: 40 }).notNull(),
  channel: varchar('channel', { length: 10 }).notNull(),
  subject: varchar('subject', { length: 255 }),
  body: text('body').notNull(),
  variablesJsonb: jsonb('variables_jsonb').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  triggerChannelIdx: index('idx_reminder_templates_trigger_channel').on(table.tenantId, table.triggerType, table.channel),
}));
