// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { pgTable, uuid, varchar, text, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';

export const knowledgeArticles = pgTable('knowledge_articles', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 255 }).notNull(),
  category: varchar('category', { length: 100 }).notNull(),
  summary: text('summary').notNull().default(''),
  body: text('body').notNull().default(''),
  sortOrder: integer('sort_order').default(0),
  isPublished: boolean('is_published').default(true),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  categoryIdx: index('idx_kb_category').on(table.category),
  publishedIdx: index('idx_kb_published').on(table.isPublished),
}));
