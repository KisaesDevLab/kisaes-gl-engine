// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { eq, asc, and } from 'drizzle-orm';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { knowledgeArticles } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

export const knowledgeRouter = Router();

// ── Public: list published articles (any authenticated user) ──

knowledgeRouter.get('/', authenticate, async (_req, res) => {
  const rows = await db.select().from(knowledgeArticles)
    .where(eq(knowledgeArticles.isPublished, true))
    .orderBy(asc(knowledgeArticles.category), asc(knowledgeArticles.sortOrder));
  res.json({ articles: rows });
});

// ── Public: get single article by slug ──

knowledgeRouter.get('/:slug', authenticate, async (req, res) => {
  const row = await db.query.knowledgeArticles.findFirst({
    where: eq(knowledgeArticles.slug, req.params['slug']!),
  });
  if (!row) throw AppError.notFound('Article not found');
  res.json({ article: row });
});

// ── Admin: list ALL articles (including unpublished) ──

knowledgeRouter.get('/admin/all', authenticate, requireSuperAdmin, async (_req, res) => {
  const rows = await db.select().from(knowledgeArticles)
    .orderBy(asc(knowledgeArticles.category), asc(knowledgeArticles.sortOrder));
  res.json({ articles: rows });
});

// ── Admin: create article ──

knowledgeRouter.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  const { title, slug, category, summary, body, isPublished, sortOrder } = req.body;
  if (!title || !slug || !category) {
    throw AppError.badRequest('title, slug, and category are required');
  }

  const [article] = await db.insert(knowledgeArticles).values({
    title,
    slug,
    category,
    summary: summary || '',
    body: body || '',
    isPublished: isPublished ?? true,
    sortOrder: sortOrder ?? 0,
    createdBy: req.userId,
  }).returning();

  res.status(201).json({ article });
});

// ── Admin: update article ──

knowledgeRouter.put('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  const { title, slug, category, summary, body, isPublished, sortOrder } = req.body;

  const [updated] = await db.update(knowledgeArticles)
    .set({
      ...(title !== undefined && { title }),
      ...(slug !== undefined && { slug }),
      ...(category !== undefined && { category }),
      ...(summary !== undefined && { summary }),
      ...(body !== undefined && { body }),
      ...(isPublished !== undefined && { isPublished }),
      ...(sortOrder !== undefined && { sortOrder }),
      updatedAt: new Date(),
    })
    .where(eq(knowledgeArticles.id, req.params['id']!))
    .returning();

  if (!updated) throw AppError.notFound('Article not found');
  res.json({ article: updated });
});

// ── Admin: delete article ──

knowledgeRouter.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  const [deleted] = await db.delete(knowledgeArticles)
    .where(eq(knowledgeArticles.id, req.params['id']!))
    .returning();
  if (!deleted) throw AppError.notFound('Article not found');
  res.json({ message: 'Article deleted' });
});

// ── Get categories (distinct) ──

knowledgeRouter.get('/admin/categories', authenticate, requireSuperAdmin, async (_req, res) => {
  const rows = await db.selectDistinct({ category: knowledgeArticles.category })
    .from(knowledgeArticles)
    .orderBy(asc(knowledgeArticles.category));
  res.json({ categories: rows.map(r => r.category) });
});
