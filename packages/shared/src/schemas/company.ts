// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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
  // Default line-entry mode for entry forms — edited on Preferences; was absent
  // here so Zod stripped it before it could be saved.
  defaultLineEntryMode: z.enum(['category', 'item']).optional(),
  lockDate: z.string().nullable().optional(),
  // Per-company AI chat assistant opt-in (tier 2 of two-tier consent —
  // see AI_CHAT_SUPPORT_PLAN.md §8.1).
  chatSupportEnabled: z.boolean().optional(),
});

// Additional company under the same tenant. Used by `/company/create`.
export const createCompanySchema = z.object({
  businessName: z.string().min(1).max(255),
  entityType: z.enum(entityTypes).optional(),
  industry: z.string().max(100).optional(),
  // Free-form text identifying which COA template to seed from.
  businessType: z.string().max(100).optional(),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

// Per-company SMTP. Credential field uses the 3-state sentinel: null =
// clear, '' or omitted = no change, non-empty = set. Matches the system
// SMTP schema's behavior.
export const companySmtpUpdateSchema = z.object({
  smtpHost: z.string().min(1).max(255),
  smtpPort: z.number().int().min(1).max(65535),
  smtpUser: z.string().max(255).optional().default(''),
  smtpPass: z.string().max(512).nullish(),
  smtpFrom: z.string().email().max(255),
});
export type CompanySmtpUpdateInput = z.infer<typeof companySmtpUpdateSchema>;

// SMTP test request — same fields as the update plus an optional test
// recipient.
export const companySmtpTestSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).optional(),
  password: z.string().max(512).optional(),
  from: z.string().email().max(255),
  testEmail: z.string().email().max(255).optional(),
});
export type CompanySmtpTestInput = z.infer<typeof companySmtpTestSchema>;

// Invite teammate to the tenant. Roles allowed via this endpoint exclude
// 'owner' — owners are minted only via tenant creation.
export const inviteUserSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(255),
  role: z.enum(['accountant', 'bookkeeper']).optional(),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
