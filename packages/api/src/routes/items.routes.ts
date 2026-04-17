// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { createItemSchema, updateItemSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as itemsService from '../services/items.service.js';
import { parseLimit, parseOffset } from '../utils/pagination.js';

export const itemsRouter = Router();
itemsRouter.use(authenticate);

itemsRouter.get('/', async (req, res) => {
  const result = await itemsService.list(req.tenantId, {
    isActive: req.query['is_active'] === 'true' ? true : req.query['is_active'] === 'false' ? false : undefined,
    search: req.query['search'] as string,
    limit: parseLimit(req.query['limit'], 100),
    offset: parseOffset(req.query['offset']),
  });
  res.json(result);
});

itemsRouter.post('/', validate(createItemSchema), async (req, res) => {
  const item = await itemsService.create(req.tenantId, req.body, req.userId);
  res.status(201).json({ item });
});

itemsRouter.get('/export', async (req, res) => {
  const csv = await itemsService.exportToCsv(req.tenantId);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="items.csv"');
  res.send(csv);
});

itemsRouter.post('/import', async (req, res) => {
  const result = await itemsService.importFromCsv(req.tenantId, req.body.items);
  res.status(201).json({ imported: result.length });
});

itemsRouter.get('/:id', async (req, res) => {
  const item = await itemsService.getById(req.tenantId, req.params['id']!);
  res.json({ item });
});

itemsRouter.put('/:id', validate(updateItemSchema), async (req, res) => {
  const item = await itemsService.update(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ item });
});

itemsRouter.delete('/:id', async (req, res) => {
  await itemsService.deactivate(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Deactivated' });
});
