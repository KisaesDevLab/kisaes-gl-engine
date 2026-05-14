// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

export const createItemSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().nullish(),
  unitPrice: z.string().nullish(),
  incomeAccountId: z.string().uuid(),
  isTaxable: z.boolean().default(true),
});

export const updateItemSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullish(),
  unitPrice: z.string().nullish(),
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
