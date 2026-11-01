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
  // Default account for early-payment discounts taken in Pay Bills
  // (U-101, bill-discounts-v1). An account of this company; null clears it.
  billDiscountAccountId: z.string().uuid().nullable().optional(),
  // Income account billable-cost markups post to (U-128, billable-costs-v1).
  // An active income account of this company (else 400
  // MARKUP_ACCOUNT_INVALID); null clears it.
  billableMarkupAccountId: z.string().uuid().nullable().optional(),
  // Bounced payments (U-132, payment-bounce-v1): the expense account of the
  // bank's fee, the income account of the fee charged to the client, and
  // that fee (whole cents; null = none). Accounts of this company, active,
  // not A/R, A/P, Payments Clearing or Customer Deposits (else 400
  // NSF_ACCOUNT_INVALID); null clears.
  nsfBankFeeAccountId: z.string().uuid().nullable().optional(),
  nsfFeeIncomeAccountId: z.string().uuid().nullable().optional(),
  // Receive Payment (U-133, U-134): the write-off account, the shortfall
  // under which a write-off is suggested (null = never), and the sales
  // discount account. Accounts: of this company, active, not A/R, A/P,
  // Payments Clearing or Customer Deposits (400 WRITE_OFF_ACCOUNT_INVALID /
  // DISCOUNT_ACCOUNT_INVALID); null clears.
  writeOffAccountId: z.string().uuid().nullable().optional(),
  writeOffThreshold: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'an amount with at most 2 decimal places').nullable().optional(),
  salesDiscountAccountId: z.string().uuid().nullable().optional(),
  nsfCustomerFee: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'an amount with at most 2 decimal places').nullable().optional(),
  // Finance charges (U-141): annual percent 0 < r <= 100 with at most 4
  // places (null = off, Q-P22a), minimum (whole cents), grace days 0..365,
  // compounding, the income account (income or other income of this company;
  // 400 FINANCE_CHARGE_ACCOUNT_INVALID), print later (default true).
  financeChargeAnnualRate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'a percent with at most 4 decimal places')
    .refine((v) => Number(v) > 0 && Number(v) <= 100, 'a percent above 0 and at most 100').nullable().optional(),
  financeChargeMinimum: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'an amount with at most 2 decimal places').optional(),
  financeChargeGraceDays: z.number().int().min(0).max(365).optional(),
  financeChargeOnFinanceCharges: z.boolean().optional(),
  financeChargeIncomeAccountId: z.string().uuid().nullable().optional(),
  financeChargePrintLater: z.boolean().optional(),
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
  // Display name for the From header. Optional — blank sends the bare address.
  smtpFromName: z.string().max(255).optional().default(''),
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
  fromName: z.string().max(255).optional(),
  testEmail: z.string().email().max(255).optional(),
});
export type CompanySmtpTestInput = z.infer<typeof companySmtpTestSchema>;

// Invite teammate to the tenant. Roles allowed via this endpoint exclude
// 'owner' — owners are minted only via tenant creation.
//
// `userType` distinguishes an internal staff teammate ('staff', the
// default) from an external ('client') user — an outside collaborator
// who logs into the ledger UI. External users are permission-customizable
// regardless of role (see isCustomizablePrincipal), so the caller
// typically invites them as 'readonly' and then applies a permission
// template. 'readonly' is offered here for both user types as a
// view-only baseline.
export const inviteUserSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(255),
  role: z.enum(['accountant', 'bookkeeper', 'readonly']).optional(),
  userType: z.enum(['staff', 'client']).optional(),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

// Edit an existing team member's display name, login email, and/or tenant
// role. All fields are optional so the caller can change just one; the
// refine keeps an empty PATCH from silently no-op'ing. Email is the login
// identity, so the service rejects a collision with another account before
// saving. Role includes 'owner' (multi-owner is supported); the service
// guards self-changes and demoting a tenant's last owner.
export const updateUserSchema = z
  .object({
    email: z.string().email().max(320).optional(),
    displayName: z.string().min(1).max(255).optional(),
    role: z.enum(['owner', 'accountant', 'bookkeeper', 'readonly']).optional(),
  })
  .refine((v) => v.email !== undefined || v.displayName !== undefined || v.role !== undefined, {
    message: 'Provide an email, display name, or role to update',
  });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
