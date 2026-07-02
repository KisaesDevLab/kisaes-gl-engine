// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import {
  createDailySalesTemplateSchema,
  updateDailySalesTemplateSchema,
  replaceDailySalesTemplateLinesSchema,
  createDailySalesEntrySchema,
  updateDailySalesEntrySchema,
  previewDailySalesEntrySchema,
  dailySalesEntriesFilterSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as service from '../services/daily-sales.service.js';

export const dailySalesRouter = Router();
dailySalesRouter.use(authenticate);
dailySalesRouter.use(companyContext);
dailySalesRouter.use(requireResource('daily_sales'));

// ── Templates ──
dailySalesRouter.get('/templates', async (req, res) => {
  res.json({ templates: await service.listTemplates(req.tenantId) });
});

dailySalesRouter.post('/templates', validate(createDailySalesTemplateSchema), async (req, res) => {
  const template = await service.createTemplate(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ template });
});

dailySalesRouter.get('/templates/:id', async (req, res) => {
  res.json({ template: await service.getTemplate(req.tenantId, req.params['id']!) });
});

dailySalesRouter.put('/templates/:id', validate(updateDailySalesTemplateSchema), async (req, res) => {
  res.json({ template: await service.updateTemplate(req.tenantId, req.params['id']!, req.body, req.userId) });
});

dailySalesRouter.delete('/templates/:id', async (req, res) => {
  await service.deleteTemplate(req.tenantId, req.params['id']!, req.userId);
  res.json({ deleted: true });
});

dailySalesRouter.put('/templates/:id/lines', validate(replaceDailySalesTemplateLinesSchema), async (req, res) => {
  const template = await service.replaceTemplateLines(req.tenantId, req.params['id']!, req.body.lines, req.userId);
  res.json({ template });
});

// ── Entries ──
dailySalesRouter.get('/entries', async (req, res) => {
  const filters = dailySalesEntriesFilterSchema.parse(req.query);
  res.json({ entries: await service.listEntries(req.tenantId, filters) });
});

dailySalesRouter.post('/entries', validate(createDailySalesEntrySchema), async (req, res) => {
  const entry = await service.createDraft(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ entry });
});

dailySalesRouter.post('/entries/preview', validate(previewDailySalesEntrySchema), async (req, res) => {
  res.json(await service.previewEntry(req.tenantId, req.body));
});

dailySalesRouter.get('/entries/:id', async (req, res) => {
  res.json({ entry: await service.getEntry(req.tenantId, req.params['id']!) });
});

dailySalesRouter.put('/entries/:id', validate(updateDailySalesEntrySchema), async (req, res) => {
  res.json({ entry: await service.updateDraft(req.tenantId, req.params['id']!, req.body, req.userId) });
});

dailySalesRouter.post('/entries/:id/post', async (req, res) => {
  res.json({ entry: await service.postEntry(req.tenantId, req.params['id']!, req.userId, req.companyId) });
});

dailySalesRouter.post('/entries/:id/void', async (req, res) => {
  res.json({ entry: await service.voidEntry(req.tenantId, req.params['id']!, req.userId) });
});

dailySalesRouter.delete('/entries/:id', async (req, res) => {
  await service.deleteEntry(req.tenantId, req.params['id']!, req.userId);
  res.json({ deleted: true });
});
