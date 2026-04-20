// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { createTagSchema, updateTagSchema, mergeTagsSchema, createTagGroupSchema, updateTagGroupSchema, transactionTagsSchema, bulkTagSchema, createSavedFilterSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as tagsService from '../services/tags.service.js';

export const tagsRouter = Router();
tagsRouter.use(authenticate);

// ─── Tags ────────────────────────────────────────────────────────

tagsRouter.get('/', async (req, res) => {
  const tags = await tagsService.list(req.tenantId, {
    groupId: req.query['group_id'] as string,
    isActive: req.query['is_active'] === 'true' ? true : req.query['is_active'] === 'false' ? false : undefined,
    search: req.query['search'] as string,
  });
  res.json({ tags });
});

tagsRouter.post('/', validate(createTagSchema), async (req, res) => {
  const tag = await tagsService.create(req.tenantId, req.body);
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

tagsRouter.get('/:id', async (req, res) => {
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

tagsRouter.put('/:id', validate(updateTagSchema), async (req, res) => {
  const tag = await tagsService.update(req.tenantId, req.params['id']!, req.body);
  res.json({ tag });
});

tagsRouter.delete('/:id', async (req, res) => {
  await tagsService.remove(req.tenantId, req.params['id']!);
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
