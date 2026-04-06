import { z } from 'zod';

export const plaidConfigUpdateSchema = z.object({
  environment: z.enum(['sandbox', 'production']).optional(),
  clientId: z.string().optional(),
  secretSandbox: z.string().optional(),
  secretProduction: z.string().optional(),
  webhookUrl: z.string().url().optional().or(z.literal('')),
  defaultProducts: z.array(z.string()).optional(),
  defaultCountryCodes: z.array(z.string()).optional(),
  defaultLanguage: z.string().max(5).optional(),
  maxHistoricalDays: z.number().int().min(30).max(730).optional(),
  isActive: z.boolean().optional(),
});

export const plaidExchangeSchema = z.object({
  publicToken: z.string().min(1),
  institutionId: z.string().optional(),
  institutionName: z.string().optional(),
  accounts: z.array(z.object({
    id: z.string(),
    name: z.string(),
    mask: z.string().nullable().optional(),
    type: z.string(),
    subtype: z.string().nullable().optional(),
  })).optional(),
  linkSessionId: z.string().optional(),
});

export const plaidMapAccountSchema = z.object({
  coaAccountId: z.string().uuid(),
});

export const plaidAccountUpdateSchema = z.object({
  isSyncEnabled: z.boolean().optional(),
  mappedAccountId: z.string().uuid().nullable().optional(),
});

export const plaidCreateAndMapSchema = z.object({
  accountName: z.string().min(1).max(255),
  accountNumber: z.string().max(20).optional(),
  accountType: z.enum(['asset', 'liability']),
  detailType: z.string(),
});
