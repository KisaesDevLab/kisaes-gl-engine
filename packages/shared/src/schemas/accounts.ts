import { z } from 'zod';

const accountTypes = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export const createAccountSchema = z.object({
  accountNumber: z.string().max(20).nullish(),
  name: z.string().min(1, 'Name is required').max(255),
  accountType: z.enum(accountTypes),
  detailType: z.string().max(100).nullish(),
  description: z.string().nullish(),
  parentId: z.string().uuid().nullish(),
});

export const updateAccountSchema = z.object({
  accountNumber: z.string().max(20).nullish(),
  name: z.string().min(1).max(255).optional(),
  accountType: z.enum(accountTypes).optional(),
  detailType: z.string().max(100).nullish(),
  description: z.string().nullish(),
  parentId: z.string().uuid().nullish(),
  isActive: z.boolean().optional(),
});

export const accountFiltersSchema = z.object({
  accountType: z.enum(accountTypes).optional(),
  isActive: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean().optional()),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const mergeAccountsSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
});
