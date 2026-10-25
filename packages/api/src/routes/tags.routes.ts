// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { createTagSchema, updateTagSchema, mergeTagsSchema, createTagGroupSchema, updateTagGroupSchema, transactionTagsSchema, bulkTagSchema, createSavedFilterSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import * as tagsService from '../services/tags.service.js';

export const tagsRouter = Router();
tagsRouter.use(authenticate);
tagsRouter.use(requireResource('tags'));

// OpenAPI documentation for the tag routes (U-04 describe()).
const tagResponse = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  companyId: z.string().uuid().nullable(),
  groupId: z.string().uuid().nullable(),
  name: z.string(),
  tagNumber: z.string().nullable().describe('optional, unique per tenant when set (tag-number-v1)'),
  color: z.string().nullable(),
  description: z.string().nullable(),
  isActive: z.boolean().nullable(),
  usageCount: z.number().int().nullable(),
  sortOrder: z.number().int().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
const tagEnvelope = z.object({ tag: tagResponse });
const tagNumberConflict = '409 TAG_NUMBER_EXISTS when another tag of the tenant has this tagNumber; 409 without code for a duplicate name.';

// ─── Tags ────────────────────────────────────────────────────────

tagsRouter.get('/', describe({
  summary: 'List tags',
  description: 'Sorted by sortOrder, then tagNumber (text order, tags without a number last), then name. `search` matches the name or the tag number.',
  query: z.object({
    group_id: z.string().uuid().optional(),
    is_active: z.enum(['true', 'false']).optional(),
    search: z.string().optional().describe('case-insensitive substring of name or tagNumber'),
    limit: z.string().optional().describe('1..500, default 200'),
    offset: z.string().optional(),
  }),
  response: z.object({ tags: z.array(tagResponse), total: z.number().int(), limit: z.number().int(), offset: z.number().int() }),
}), async (req, res) => {
  const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
  const offset = req.query['offset'] ? Number(req.query['offset']) : undefined;
  const result = await tagsService.list(req.tenantId, {
    groupId: req.query['group_id'] as string,
    isActive: req.query['is_active'] === 'true' ? true : req.query['is_active'] === 'false' ? false : undefined,
    search: req.query['search'] as string,
    limit,
    offset,
  });
  // Legacy `{ tags }` shape preserved alongside new pagination metadata
  // so existing frontend callers don't break.
  res.json({ tags: result.data, total: result.total, limit: result.limit, offset: result.offset });
});

tagsRouter.post('/', describe({
  summary: 'Create a tag',
  description: tagNumberConflict,
  response: tagEnvelope,
}), validate(createTagSchema), async (req, res) => {
  const tag = await tagsService.create(req.tenantId, req.body, req.userId);
  res.status(201).json({ tag });
});

tagsRouter.get('/usage-summary', async (req, res) => {
  const tags = await tagsService.getUsageSummary(req.tenantId);
  res.json({ tags });
});

// Saved filters must be before /:id to avoid route conflict
tagsRouter.get('/saved-filters', async (req, res) => {
  const filters = await tagsService.listSavedFilters(req.tenantId, req.query['report_type'] as string);
  res.json({ filters });
});

tagsRouter.post('/saved-filters', validate(createSavedFilterSchema), async (req, res) => {
  const filter = await tagsService.createSavedFilter(req.tenantId, req.body);
  res.status(201).json({ filter });
});

tagsRouter.delete('/saved-filters/:id', async (req, res) => {
  await tagsService.deleteSavedFilter(req.tenantId, req.params['id']!);
  res.json({ message: 'Filter deleted' });
});

tagsRouter.get('/:id', describe({ summary: 'Get a tag', response: tagEnvelope }), async (req, res) => {
  const tag = await tagsService.getById(req.tenantId, req.params['id']!);
  res.json({ tag });
});

// ADR 0XX §8 / ADR 0XY §5 — pre-delete usage check. UI calls this before
// showing the confirm dialog so the user sees "used by N transactions /
// M budgets" with actionable reassignment CTAs instead of hitting a 409
// on the DELETE.
tagsRouter.get('/:id/usage', async (req, res) => {
  const tag = await tagsService.getById(req.tenantId, req.params['id']!);
  const usage = await tagsService.getUsage(req.tenantId, req.params['id']!);
  res.json({ tag, usage });
});

tagsRouter.put('/:id', describe({
  summary: 'Update a tag',
  description: `tagNumber omitted keeps the stored number; "" or null clears it. ${tagNumberConflict}`,
  response: tagEnvelope,
}), validate(updateTagSchema), async (req, res) => {
  const tag = await tagsService.update(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ tag });
});

tagsRouter.delete('/:id', async (req, res) => {
  await tagsService.remove(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Tag deleted' });
});

tagsRouter.post('/merge', validate(mergeTagsSchema), async (req, res) => {
  const result = await tagsService.merge(req.tenantId, req.body.sourceTagId, req.body.targetTagId);
  res.json({ tag: result });
});

// ─── Tag Groups ──────────────────────────────────────────────────

tagsRouter.get('/groups/list', async (req, res) => {
  const groups = await tagsService.listGroups(req.tenantId);
  res.json({ groups });
});

tagsRouter.post('/groups', validate(createTagGroupSchema), async (req, res) => {
  const group = await tagsService.createGroup(req.tenantId, req.body);
  res.status(201).json({ group });
});

tagsRouter.put('/groups/:id', validate(updateTagGroupSchema), async (req, res) => {
  const group = await tagsService.updateGroup(req.tenantId, req.params['id']!, req.body);
  res.json({ group });
});

tagsRouter.delete('/groups/:id', async (req, res) => {
  await tagsService.deleteGroup(req.tenantId, req.params['id']!);
  res.json({ message: 'Group deleted' });
});

tagsRouter.put('/groups/reorder', async (req, res) => {
  await tagsService.reorderGroups(req.tenantId, req.body.orderedIds);
  res.json({ message: 'Reordered' });
});

// ─── Transaction Tagging ─────────────────────────────────────────

tagsRouter.post('/transactions/:id/add', validate(transactionTagsSchema), async (req, res) => {
  await tagsService.addTags(req.tenantId, req.params['id']!, req.body.tagIds);
  res.json({ message: 'Tags added' });
});

tagsRouter.post('/transactions/:id/remove', validate(transactionTagsSchema), async (req, res) => {
  await tagsService.removeTags(req.tenantId, req.params['id']!, req.body.tagIds);
  res.json({ message: 'Tags removed' });
});

tagsRouter.put('/transactions/:id', validate(transactionTagsSchema), async (req, res) => {
  await tagsService.replaceTags(req.tenantId, req.params['id']!, req.body.tagIds);
  res.json({ message: 'Tags replaced' });
});

tagsRouter.post('/bulk-tag', validate(bulkTagSchema), async (req, res) => {
  await tagsService.bulkAddTags(req.tenantId, req.body.transactionIds, req.body.tagIds);
  res.json({ message: 'Bulk tagged' });
});

tagsRouter.post('/bulk-untag', validate(bulkTagSchema), async (req, res) => {
  await tagsService.bulkRemoveTags(req.tenantId, req.body.transactionIds, req.body.tagIds);
  res.json({ message: 'Bulk untagged' });
});

// Saved filters GET/POST/DELETE routes are defined above /:id to avoid route conflict
