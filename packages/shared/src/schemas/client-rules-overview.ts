// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

// Columns the overview can be ordered by. Name and the portal counters
// are cheap (one SQL pass over every client); the rule counters mean
// evaluating every client's pending items before paging.
export const CLIENT_RULES_OVERVIEW_SORT_KEYS = [
  'tenantName',
  'rulesMatched',
  'matched',
  'ready',
  'needsMapping',
  'unreadDocuments',
  'openDocumentRequests',
  'openQuestions',
] as const;
export type ClientRulesOverviewSortKey = typeof CLIENT_RULES_OVERVIEW_SORT_KEYS[number];

const boolFromQuery = z.preprocess(
  (v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v),
  z.boolean(),
);

export const clientRulesOverviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional(),
  sortBy: z.enum(CLIENT_RULES_OVERVIEW_SORT_KEYS).default('tenantName'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  // Clients excluded from bulk posting are hidden unless asked for.
  includeExcluded: boolFromQuery.default(false),
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

// Per-client switch that keeps the client off the overview and refuses
// bulk rule posting into it — for clients who do not want bulk changes.
export const clientRulesExclusionSchema = z.object({
  excluded: z.boolean(),
});
export type ClientRulesExclusionInput = z.infer<typeof clientRulesExclusionSchema>;
