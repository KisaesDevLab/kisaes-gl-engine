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
  autoConfirm: z.boolean().default(false),
  priority: z.number().int().default(0),
});

export const updateBankRuleSchema = createBankRuleSchema.partial().extend({
  isActive: z.boolean().optional(),
});
