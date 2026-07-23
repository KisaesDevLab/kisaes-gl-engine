// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// CPA engagement letters / reports (SSARS 21) — SYSTEM-level HTML templates
// managed by the super-admin, shared across the appliance (no tenant scoping).
// See services/report-letter.service.ts and 0140_report_letters.sql.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const reportLetters = pgTable('report_letters', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // compilation | preparation | review (review reserved for AR-C 90).
  letterType: varchar('letter_type', { length: 30 }).notNull(),
  // Printed heading (<h1>) above the body. NULL/blank → the standard SSARS
  // title for the letter's type (REPORT_LETTER_TITLES).
  title: text('title'),
  // Font-stack KEY (see LETTER_FONT_OPTIONS) applied to the rendered letter.
  // NULL → the default stack.
  fontFamily: varchar('font_family', { length: 40 }),
  // WYSIWYG body with {{variables}}; variable values are escaped at render.
  bodyHtml: text('body_html').notNull().default(''),
  isActive: boolean('is_active').notNull().default(true),
  // Marks the seeded SSARS-21 system defaults.
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  activeSortIdx: index('idx_report_letters_active_sort').on(table.isActive, table.sortOrder),
}));
