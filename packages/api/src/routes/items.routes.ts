// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { createItemSchema, updateItemSchema, itemsImportSchema, itemFiltersSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotent.js';
import { describe } from '../middleware/describe.js';
import * as itemsService from '../services/items.service.js';

export const itemsRouter = Router();
itemsRouter.use(authenticate);
itemsRouter.use(companyContext);
itemsRouter.use(requireResource('items'));

const idParams = z.object({ id: z.string().uuid() });

const kindRules = 'Item kinds (item-kinds-sales-v1, item-types-v1): itemType service (default) | non_inventory | other_charge | discount | subtotal | '
  + 'inventory_part. A discount item takes discountPercent (0 < p <= 100, at most 4 places) or unitPrice (the amount off, 0 or more), not both, and is '
  + 'taxable unless isTaxable is false (a taxable discount reduces the taxable base); a subtotal item takes neither; other kinds take no discountPercent. '
  + 'Otherwise 400 VALIDATION_ERROR. Invoices price them per invoice-pricing-v1 (POST /invoices/preview).';

const partRules = 'Purchase side on every kind (item-types-v1): purchaseDescription, purchaseCost (a string, 0 or more, at most 4 places), '
  + 'expenseAccountId, preferredVendorId (a vendor of the company). An inventory_part needs inventory on for the company (400 INVENTORY_OFF), '
  + 'assetAccountId (an active asset account, not bank or receivables) and cogsAccountId (an active cost of goods sold account), and may take '
  + 'reorderPoint (0 or more) and reorderQuantity (above 0), strings with at most 4 places; unitLabel (at most 10 characters) on any kind. '
  + 'Only parts take the asset / COGS accounts and reorder fields. A bad account or vendor is 400 VALIDATION_ERROR with details.field. '
  + 'Read-only on parts (null on other kinds): quantityOnHand (4 places), averageCost (6 places), assetValue (2 places), all strings.';

itemsRouter.get('/', describe({
  summary: 'List items',
  description: `{data, total}. itemType filters by kind. ${kindRules} ${partRules}`,
  query: itemFiltersSchema,
}), async (req, res) => {
  const result = await itemsService.list(req.tenantId, itemFiltersSchema.parse(req.query));
  res.json(result);
});

// Idempotency-Key (idempotency-v1, U-18).
itemsRouter.post('/', idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ item: await itemsService.getWithFigures(req.tenantId, entity!.id) }),
}), validate(createItemSchema), describe({
  summary: 'Create an item',
  description: `Response 201 {item}. A name already used is 409. ${kindRules} ${partRules}`,
  body: createItemSchema,
}), async (req, res) => {
  const item = await itemsService.create(req.tenantId, req.body, req.userId, req.companyId);
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

itemsRouter.get('/:id', describe({
  summary: 'Get an item',
  description: `Response {item} with the read-only stock figures of a part (item-types-v1). ${partRules}`,
  params: idParams,
}), async (req, res) => {
  const item = await itemsService.getWithFigures(req.tenantId, req.params['id']!);
  res.json({ item });
});

itemsRouter.put('/:id', validate(updateItemSchema), describe({
  summary: 'Edit an item',
  description: 'Response {item}; omitted fields keep their values and the kind rules apply to the result. The row is locked; '
    + 'expectedUpdatedAt (updatedAt as last read) that no longer matches is 409 STALE (details.updatedAt). Moving the kind to or from '
    + 'inventory_part while posted transactions name the item is 409 ITEM_IN_USE; changing a part\'s assetAccountId once it has stock '
    + 'movements is 409 ITEM_HAS_INVENTORY; moving away from inventory_part clears the part-only fields. A name already used is 409. '
    + `${kindRules} ${partRules}`,
  body: updateItemSchema,
  params: idParams,
}), async (req, res) => {
  const item = await itemsService.update(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ item });
});

itemsRouter.delete('/:id', describe({
  summary: 'Make an item inactive',
  description: 'Response {message}. Items are never deleted (an item with stock movements keeps its history); the item becomes inactive.',
  params: idParams,
}), async (req, res) => {
  await itemsService.deactivate(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Deactivated' });
});
