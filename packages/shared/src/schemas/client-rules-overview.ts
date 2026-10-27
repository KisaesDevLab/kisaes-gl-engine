// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

export const clientRulesOverviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional(),
});
export type ClientRulesOverviewQuery = z.infer<typeof clientRulesOverviewQuerySchema>;

// Post rule-matched items for one or more clients. `ruleIds` narrows the
// post to items whose first matching rule is in the list (the per-rule
// "Post" in an expanded client row); omitted = every ready item.
export const clientRulesPostSchema = z.object({
  tenantIds: z.array(z.string().uuid()).min(1).max(100),
  ruleIds: z.array(z.string().uuid()).min(1).max(200).optional(),
});
export type ClientRulesPostInput = z.infer<typeof clientRulesPostSchema>;

export const clientAccountMappingSchema = z.object({
  sourceAccountId: z.string().uuid(),
  accountId: z.string().uuid(),
});
export type ClientAccountMappingInput = z.infer<typeof clientAccountMappingSchema>;
