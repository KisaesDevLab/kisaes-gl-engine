// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import { sortBySchema, sortDirSchema } from './list-view.js';
import { SALES_ITEM_TYPES } from '../types/items.js';

export const itemSortKeys = ['name', 'price', 'taxable', 'status'] as const;

const boolParam = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());

// GET /items query. Parsed with zod like every other list (the route used
// to hand-read `is_active` while the client sent `isActive`, so the
// Active/Inactive select silently did nothing).
export const itemFiltersSchema = z.object({
  isActive: boolParam,
  // Item kind (U-39a, item-kinds-sales-v1).
  itemType: z.enum(SALES_ITEM_TYPES).optional(),
  isTaxable: boolParam,
  search: z.string().optional(),
  sortBy: sortBySchema(itemSortKeys),
  sortDir: sortDirSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// Item kinds (U-39a, item-kinds-sales-v1): service (default), non_inventory,
// other_charge, discount, subtotal. A discount item takes discountPercent (a
// percent off, 0 < p <= 100, at most 4 places) or unitPrice (the amount off,
// 0 or more), not both; a subtotal item takes neither. Discount items are
// taxable unless isTaxable is false (a taxable discount reduces the taxable
// base, Q-P20t).
export const itemDiscountPercentSchema = z.string().trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'A percent with at most 4 decimal places')
  .refine((v) => Number(v) > 0 && Number(v) <= 100, 'The discount percent must be above 0 and at most 100');

export const createItemSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().nullish(),
  itemType: z.enum(SALES_ITEM_TYPES).default('service'),
  unitPrice: z.string().nullish(),
  discountPercent: itemDiscountPercentSchema.nullish(),
  incomeAccountId: z.string().uuid(),
  isTaxable: z.boolean().default(true),
});

export const updateItemSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullish(),
  itemType: z.enum(SALES_ITEM_TYPES).optional(),
  unitPrice: z.string().nullish(),
  discountPercent: itemDiscountPercentSchema.nullish(),
  incomeAccountId: z.string().uuid().optional(),
  isTaxable: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

// CSV-import body for POST /items/import. The frontend reads the CSV
// client-side, parses each row into a partial item, and sends the array.
// `unitPrice` arrives as a string (decimal) since CSV values are textual.
export const itemsImportRowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  unitPrice: z.string().max(40).optional(),
  incomeAccountName: z.string().max(255).optional(),
  isTaxable: z.boolean().optional(),
});

export const itemsImportSchema = z.object({
  items: z.array(itemsImportRowSchema).min(1).max(10_000),
});
export type ItemsImportInput = z.infer<typeof itemsImportSchema>;
