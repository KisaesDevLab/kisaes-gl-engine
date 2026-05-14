// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

export const createBankRuleSchema = z.object({
  name: z.string().min(1).max(255),
  applyTo: z.enum(['deposits', 'expenses', 'both']).default('both'),
  bankAccountId: z.string().uuid().nullish(),
  descriptionContains: z.string().max(255).nullish(),
  descriptionExact: z.string().max(255).nullish(),
  amountEquals: z.string().nullish(),
  amountMin: z.string().nullish(),
  amountMax: z.string().nullish(),
  assignAccountId: z.string().uuid().nullish(),
  assignContactId: z.string().uuid().nullish(),
  assignMemo: z.string().max(500).nullish(),
  // ADR 0XY §6: tag stamped onto every journal line produced when the rule
  // matches a bank feed transaction during categorization.
  assignTagId: z.string().uuid().nullable().optional(),
  autoConfirm: z.boolean().default(false),
  priority: z.number().int().default(0),
});

export const updateBankRuleSchema = createBankRuleSchema.partial().extend({
  isActive: z.boolean().optional(),
});

// Body for POST /bank-rules/reorder — the UI reorders the rule priority
// list and sends the new top-down order.
export const bankRulesReorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(2000),
});
export type BankRulesReorderInput = z.infer<typeof bankRulesReorderSchema>;

// Body for POST /bank-rules/test — operator paste-tests a single feed
// description + amount against the tenant's active rule set.
export const bankRulesTestSchema = z.object({
  description: z.string().min(1).max(2000),
  amount: z.union([z.number(), z.string()]),
});
export type BankRulesTestInput = z.infer<typeof bankRulesTestSchema>;

// Body for POST /bank-rules/:id/submit-global — optional note explaining
// why this rule should be promoted to the global library.
export const bankRulesSubmitGlobalSchema = z.object({
  note: z.string().max(2000).optional(),
});
export type BankRulesSubmitGlobalInput = z.infer<typeof bankRulesSubmitGlobalSchema>;
