import { z } from 'zod';

export const entityTypes = ['sole_prop', 'single_member_llc', 's_corp', 'c_corp', 'partnership'] as const;
export const accountingMethods = ['cash', 'accrual'] as const;
export const paymentTerms = ['due_on_receipt', 'net_15', 'net_30', 'net_60', 'net_90', 'custom'] as const;
export const categoryFilterModes = ['by_type', 'all'] as const;

export const updateCompanySchema = z.object({
  businessName: z.string().min(1).max(255).optional(),
  legalName: z.string().max(255).nullish(),
  ein: z.string().max(20).nullish(),
  addressLine1: z.string().max(255).nullish(),
  addressLine2: z.string().max(255).nullish(),
  city: z.string().max(100).nullish(),
  state: z.string().max(50).nullish(),
  zip: z.string().max(20).nullish(),
  country: z.string().length(2).or(z.string().length(3)).optional(),
  phone: z.string().max(30).nullish(),
  email: z.string().email().max(255).nullish(),
  website: z.string().max(255).nullish(),
  industry: z.string().max(100).nullish(),
  entityType: z.enum(entityTypes).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  accountingMethod: z.enum(accountingMethods).optional(),
  defaultPaymentTerms: z.enum(paymentTerms).optional(),
  invoicePrefix: z.string().max(20).optional(),
  invoiceNextNumber: z.number().int().min(1).optional(),
  defaultSalesTaxRate: z.string().optional(),
  currency: z.string().length(3).optional(),
  dateFormat: z.string().max(20).optional(),
  categoryFilterMode: z.enum(categoryFilterModes).optional(),
});

export const updateCompanySettingsSchema = z.object({
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  accountingMethod: z.enum(accountingMethods).optional(),
  defaultPaymentTerms: z.enum(paymentTerms).optional(),
  invoicePrefix: z.string().max(20).optional(),
  invoiceNextNumber: z.number().int().min(1).optional(),
  defaultSalesTaxRate: z.string().optional(),
  currency: z.string().length(3).optional(),
  dateFormat: z.string().max(20).optional(),
  categoryFilterMode: z.enum(categoryFilterModes).optional(),
  lockDate: z.string().nullable().optional(),
});
