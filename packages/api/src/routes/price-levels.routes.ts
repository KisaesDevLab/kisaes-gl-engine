// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { createPriceLevelSchema, updatePriceLevelSchema, priceLevelFiltersSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import * as priceLevelsService from '../services/price-levels.service.js';

// Price levels (U-40, price-levels-v1). They price items, so they share the
// items permission.
export const priceLevelsRouter = Router();
priceLevelsRouter.use(authenticate);
priceLevelsRouter.use(companyContext);
priceLevelsRouter.use(requireResource('items'));

const idParams = z.object({ id: z.string().uuid() });
const levelShape = '{id, name, percent (signed, 4 places: "-7.5000" = 7.5 % down), isActive, companyId, createdAt, updatedAt, itemPrices: [{itemId, unitPrice}]}';
const rules = 'A level price is round2(item price x (1 + percent / 100)), half away from zero; a fixed item price wins (stored rounded to the cent). '
  + 'One level per client (contacts.priceLevelId); an inactive level prices nothing and can\'t be given to a client. Discount and subtotal items take no level price. '
  + 'Golden cases: packages/shared/fixtures/invoice-golden.json pricingCases.';

priceLevelsRouter.get('/', describe({
  summary: 'List price levels',
  description: `price-levels-v1: {data: [level without itemPrices, plus itemPriceCount]} by name, the company's and those of no company. ${rules}`,
  query: priceLevelFiltersSchema,
}), async (req, res) => {
  const parsed = priceLevelFiltersSchema.safeParse(req.query);
  if (!parsed.success) throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', 'VALIDATION_ERROR');
  res.json(await priceLevelsService.list(req.tenantId, parsed.data, req.companyId));
});

priceLevelsRouter.post('/', validate(createPriceLevelSchema), describe({
  summary: 'Create a price level',
  description: `price-levels-v1: response 201 {priceLevel: ${levelShape}}. A name already used (case-insensitive) is 409 PRICE_LEVEL_NAME_IN_USE; an item `
    + `listed twice, of another company, or a discount / subtotal item is 400 VALIDATION_ERROR. ${rules}`,
  body: createPriceLevelSchema,
}), async (req, res) => {
  const priceLevel = await priceLevelsService.create(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ priceLevel });
});

priceLevelsRouter.get('/:id', describe({
  summary: 'Get a price level',
  description: `price-levels-v1: {priceLevel: ${levelShape}}; another company's is 404.`,
  params: idParams,
}), async (req, res) => {
  res.json({ priceLevel: await priceLevelsService.getById(req.tenantId, req.params['id']!, req.companyId) });
});

priceLevelsRouter.put('/:id', validate(updatePriceLevelSchema), describe({
  summary: 'Edit a price level',
  description: `price-levels-v1: omitted fields keep their values; itemPrices sent replaces the whole list. Response {priceLevel}. Errors as create; 404 for another company's. ${rules}`,
  body: updatePriceLevelSchema,
  params: idParams,
}), async (req, res) => {
  res.json({ priceLevel: await priceLevelsService.update(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId) });
});

priceLevelsRouter.delete('/:id', describe({
  summary: 'Delete a price level',
  description: 'price-levels-v1: deletes the level and its item prices; 409 PRICE_LEVEL_IN_USE (details.clients) while a client has it (make it inactive instead). Response {message}.',
  params: idParams,
}), async (req, res) => {
  await priceLevelsService.remove(req.tenantId, req.params['id']!, req.userId, req.companyId);
  res.json({ message: 'Deleted' });
});
