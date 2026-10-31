// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

// Price levels (U-40, price-levels-v1, Q-P20l). percent: signed, -100 to
// 1000, at most 4 places (-7.5 = 7.5 % down). itemPrices: fixed prices for
// chosen items (0 or more; stored rounded half away from zero to the cent);
// sent on an edit, it replaces the level's whole list.
const levelPercentSchema = z.string().trim()
  .regex(/^-?\d{1,4}(\.\d{1,4})?$/, 'A percent with at most 4 decimal places, such as -7.5 or 10')
  .refine((v) => Number(v) >= -100 && Number(v) <= 1000, 'The percent must be from -100 to 1000');

export const priceLevelItemPriceSchema = z.object({
  itemId: z.string().uuid(),
  unitPrice: z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/, 'A price of 0 or more with at most 4 decimal places'),
});

export const createPriceLevelSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  percent: levelPercentSchema.default('0'),
  itemPrices: z.array(priceLevelItemPriceSchema).max(5000).default([]),
});

export const updatePriceLevelSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  percent: levelPercentSchema.optional(),
  isActive: z.boolean().optional(),
  itemPrices: z.array(priceLevelItemPriceSchema).max(5000).optional(),
});

const boolParam = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());

export const priceLevelFiltersSchema = z.object({
  isActive: boolParam,
});

export type CreatePriceLevelInput = z.infer<typeof createPriceLevelSchema>;
export type UpdatePriceLevelInput = z.infer<typeof updatePriceLevelSchema>;
