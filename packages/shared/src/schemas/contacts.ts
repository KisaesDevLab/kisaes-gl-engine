import { z } from 'zod';

const contactTypes = ['customer', 'vendor', 'both'] as const;

export const createContactSchema = z.object({
  contactType: z.enum(contactTypes),
  displayName: z.string().min(1, 'Display name is required').max(255),
  companyName: z.string().max(255).nullish(),
  firstName: z.string().max(100).nullish(),
  lastName: z.string().max(100).nullish(),
  email: z.string().email().max(255).nullish().or(z.literal('')),
  phone: z.string().max(30).nullish(),
  billingLine1: z.string().max(255).nullish(),
  billingLine2: z.string().max(255).nullish(),
  billingCity: z.string().max(100).nullish(),
  billingState: z.string().max(50).nullish(),
  billingZip: z.string().max(20).nullish(),
  billingCountry: z.string().max(3).default('US'),
  shippingLine1: z.string().max(255).nullish(),
  shippingLine2: z.string().max(255).nullish(),
  shippingCity: z.string().max(100).nullish(),
  shippingState: z.string().max(50).nullish(),
  shippingZip: z.string().max(20).nullish(),
  shippingCountry: z.string().max(3).default('US'),
  defaultPaymentTerms: z.string().max(50).nullish(),
  openingBalance: z.string().default('0'),
  openingBalanceDate: z.string().nullish(),
  defaultExpenseAccountId: z.string().uuid().nullish(),
  taxId: z.string().max(30).nullish(),
  is1099Eligible: z.boolean().default(false),
  notes: z.string().nullish(),
});

export const updateContactSchema = z.object({
  contactType: z.enum(contactTypes).optional(),
  displayName: z.string().min(1).max(255).optional(),
  companyName: z.string().max(255).nullish(),
  firstName: z.string().max(100).nullish(),
  lastName: z.string().max(100).nullish(),
  email: z.string().email().max(255).nullish().or(z.literal('')),
  phone: z.string().max(30).nullish(),
  billingLine1: z.string().max(255).nullish(),
  billingLine2: z.string().max(255).nullish(),
  billingCity: z.string().max(100).nullish(),
  billingState: z.string().max(50).nullish(),
  billingZip: z.string().max(20).nullish(),
  billingCountry: z.string().max(3).optional(),
  shippingLine1: z.string().max(255).nullish(),
  shippingLine2: z.string().max(255).nullish(),
  shippingCity: z.string().max(100).nullish(),
  shippingState: z.string().max(50).nullish(),
  shippingZip: z.string().max(20).nullish(),
  shippingCountry: z.string().max(3).optional(),
  defaultPaymentTerms: z.string().max(50).nullish(),
  defaultExpenseAccountId: z.string().uuid().nullish(),
  taxId: z.string().max(30).nullish(),
  is1099Eligible: z.boolean().optional(),
  notes: z.string().nullish(),
  isActive: z.boolean().optional(),
});

export const contactFiltersSchema = z.object({
  contactType: z.enum(contactTypes).optional(),
  isActive: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean().optional()),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const mergeContactsSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
});
