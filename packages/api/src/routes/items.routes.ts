// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { createItemSchema, updateItemSchema, itemsImportSchema, itemFiltersSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotent.js';
import { describe } from '../middleware/describe.js';
import * as itemsService from '../services/items.service.js';

export const itemsRouter = Router();
itemsRouter.use(authenticate);
itemsRouter.use(requireResource('items'));

const kindRules = 'Item kinds (item-kinds-sales-v1): itemType service (default) | non_inventory | other_charge | discount | subtotal. A discount item takes '
  + 'discountPercent (0 < p <= 100, at most 4 places) or unitPrice (the amount off, 0 or more), not both, and is taxable unless isTaxable is false (a taxable '
  + 'discount reduces the taxable base); a subtotal item takes neither; other kinds take no discountPercent. Otherwise 400 VALIDATION_ERROR. '
  + 'Invoices price them per invoice-pricing-v1 (POST /invoices/preview).';

itemsRouter.get('/', describe({
  summary: 'List items',
  description: `{data, total}. itemType filters by kind. ${kindRules}`,
  query: itemFiltersSchema,
}), async (req, res) => {
  const result = await itemsService.list(req.tenantId, itemFiltersSchema.parse(req.query));
  res.json(result);
});

// Idempotency-Key (idempotency-v1, U-18).
itemsRouter.post('/', idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ item: await itemsService.getById(req.tenantId, entity!.id) }),
}), validate(createItemSchema), describe({
  summary: 'Create an item',
  description: `Response 201 {item}. A name already used is 409. ${kindRules}`,
  body: createItemSchema,
}), async (req, res) => {
  const item = await itemsService.create(req.tenantId, req.body, req.userId);
  res.status(201).json({ item });
});

itemsRouter.get('/export', async (req, res) => {
  const csv = await itemsService.exportToCsv(req.tenantId);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="items.csv"');
  res.send(csv);
});

itemsRouter.post('/import', validate(itemsImportSchema), async (req, res) => {
  const result = await itemsService.importFromCsv(req.tenantId, req.body.items);
  res.status(201).json({ imported: result.length });
});

itemsRouter.get('/:id', async (req, res) => {
  const item = await itemsService.getById(req.tenantId, req.params['id']!);
  res.json({ item });
});

itemsRouter.put('/:id', validate(updateItemSchema), describe({
  summary: 'Edit an item',
  description: `Response {item}; omitted fields keep their values and the kind rules apply to the result. ${kindRules}`,
  body: updateItemSchema,
}), async (req, res) => {
  const item = await itemsService.update(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ item });
});

itemsRouter.delete('/:id', async (req, res) => {
  await itemsService.deactivate(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Deactivated' });
});
