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
