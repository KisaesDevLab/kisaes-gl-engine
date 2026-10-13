// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator tables — taxpayers, persons, links (features/tax-estimator/PHASES.md Phase 3).
// SQL lives in migrations/parts/taxpayers.sql and is assembled into
// 0201_tax_estimator.sql by the orchestrator.
//
// D1: a taxpayer belongs to a FIRM (firm_id), and a link points at a company in ANY
// tenant the firm manages, so links carry tenant_id explicitly.

import {
  pgTable, uuid, varchar, text, boolean, integer, smallint, date, jsonb, numeric, char, timestamp, index, unique,
} from 'drizzle-orm/pg-core';
import { portalContacts } from './portal-contacts.js';

export const taxEstTaxpayers = pgTable('tax_est_taxpayers', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  filingStatus: varchar('filing_status', { length: 10 }).notNull().default('single'),
  residentState: char('resident_state', { length: 2 }),
  safeHarborOverride: varchar('safe_harbor_override', { length: 20 }),
  portalShows: varchar('portal_shows', { length: 10 }),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tax_est_taxpayers_firm').on(t.firmId),
]);

export const taxEstPersons = pgTable('tax_est_persons', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 10 }).notNull(),
  firstName: varchar('first_name', { length: 120 }).notNull(),
  lastName: varchar('last_name', { length: 120 }).notNull(),
  dateOfBirth: date('date_of_birth'),
  isBlind: boolean('is_blind').notNull().default(false),
  /** 12 booleans Jan..Dec; true = SEHI-eligible month (not eligible for an employer plan). */
  sehiEligibleMonths: jsonb('sehi_eligible_months').$type<boolean[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_persons_role').on(t.taxpayerId, t.role),
]);

export const taxEstLinks = pgTable('tax_est_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  personId: uuid('person_id').notNull().references(() => taxEstPersons.id, { onDelete: 'cascade' }),
  taxYear: integer('tax_year').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  profitPct: numeric('profit_pct', { precision: 7, scale: 4 }),
  lossPct: numeric('loss_pct', { precision: 7, scale: 4 }),
  capitalPct: numeric('capital_pct', { precision: 7, scale: 4 }),
  partnerSeStatus: varchar('partner_se_status', { length: 20 }),
  partnerSeMemo: text('partner_se_memo'),
  isOfficer: boolean('is_officer').notNull().default(false),
  activityType: varchar('activity_type', { length: 12 }).notNull().default('active'),
  activeParticipation: boolean('active_participation').notNull().default(false),
  qbiEligible: boolean('qbi_eligible'),
  qbiOverrideReason: text('qbi_override_reason'),
  allowedLossOverride: numeric('allowed_loss_override', { precision: 19, scale: 4 }),
  allowedLossReason: text('allowed_loss_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_links_person_company_year').on(t.personId, t.tenantId, t.companyId, t.taxYear),
  index('idx_tax_est_links_taxpayer_year').on(t.taxpayerId, t.taxYear),
  index('idx_tax_est_links_company').on(t.tenantId, t.companyId),
]);

export const taxEstTaxpayerContacts = pgTable('tax_est_taxpayer_contacts', {
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  portalContactId: uuid('portal_contact_id').notNull().references(() => portalContacts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_taxpayer_contacts').on(t.taxpayerId, t.portalContactId),
  index('idx_tax_est_taxpayer_contacts_contact').on(t.portalContactId),
]);

// D17 (migration 0202, parts/taxpayer-visibility.sql): per-taxpayer staff allow-list.
// No rows = everyone the firm's linked-tenant rule allows; rows = only these users plus
// firm admins / super admins. Read ONLY through firm-scope.service visibleTaxpayerFilter
// and taxpayer-staff.service.
export const taxEstTaxpayerStaff = pgTable('tax_est_taxpayer_staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id').notNull(),
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uniq_tax_est_taxpayer_staff').on(t.firmId, t.taxpayerId, t.userId),
  index('idx_tax_est_taxpayer_staff_taxpayer').on(t.taxpayerId, t.userId),
]);

// Q44 (migration 0204, parts/dependents.sql): dependents of a taxpayer. Scoped through the
// taxpayer like tax_est_persons; read / written only after the taxpayer's firm + D17 / D18
// visibility check (taxpayers.service loadTaxpayer). No SSN is stored.
export const taxEstDependents = pgTable('tax_est_dependents', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxpayerId: uuid('taxpayer_id').notNull().references(() => taxEstTaxpayers.id, { onDelete: 'cascade' }),
  displayName: varchar('display_name', { length: 120 }).notNull(),
  dateOfBirth: date('date_of_birth').notNull(),
  relationship: varchar('relationship', { length: 20 }).notNull().default('other'),
  kind: varchar('kind', { length: 20 }).notNull(),
  monthsLivedWith: smallint('months_lived_with'),
  isStudent: boolean('is_student').notNull().default(false),
  isDisabled: boolean('is_disabled').notNull().default(false),
  firstTaxYear: integer('first_tax_year'),
  lastTaxYear: integer('last_tax_year'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tax_est_dependents_taxpayer').on(t.taxpayerId),
]);
