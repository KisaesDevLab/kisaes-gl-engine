// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q51 (migration 0211, parts/portal-options.sql): what one portal contact may
// see of the tax estimates shared with them. One row per contact; no row = the defaults
// (DEFAULT_PORTAL_CONTACT_TAX_OPTIONS = the view before Q51). Read / written only through
// services/tax-estimator/portal-options.service.ts.
import { pgTable, uuid, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { portalContacts } from './portal-contacts.js';
import { tenants } from './auth.js';

export const taxEstPortalContactOptions = pgTable('tax_est_portal_contact_options', {
  portalContactId: uuid('portal_contact_id').primaryKey().references(() => portalContacts.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  calculationSummary: boolean('calculation_summary').notNull().default(false),
  quarterlyEstimates: boolean('quarterly_estimates').notNull().default(true),
  paymentsOnRecord: boolean('payments_on_record').notNull().default(true),
  pdfDownload: boolean('pdf_download').notNull().default(false),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_tax_est_portal_contact_options_tenant').on(t.tenantId),
]);
