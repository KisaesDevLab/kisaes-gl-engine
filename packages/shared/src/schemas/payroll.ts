// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

const importModes = ['employee_level', 'prebuilt_je', 'check_register'] as const;
const sessionStatuses = ['uploaded', 'mapped', 'validated', 'posted', 'failed', 'cancelled'] as const;

export const payrollUploadSchema = z.object({
  companyId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
  importMode: z.enum(importModes).optional(),
  payPeriodStart: z.string().optional(),
  payPeriodEnd: z.string().optional(),
  checkDate: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(), // Provider-specific metadata (e.g. OnPay Run ID)
});

const columnMappingEntrySchema = z.object({
  source: z.string(),
  format: z.string().optional(),
});

const skipRuleSchema = z.object({
  type: z.enum(['blank_field', 'value_match']),
  field: z.string(),
  values: z.array(z.string()).optional(),
});

export const applyMappingSchema = z.object({
  header_row: z.coerce.number().int().min(0).default(0),
  data_start_row: z.coerce.number().int().min(0).default(1),
  skip_footer_rows: z.coerce.number().int().min(0).optional(),
  date_format: z.string().optional(),
  mappings: z.record(z.string(), columnMappingEntrySchema),
  skip_rules: z.array(skipRuleSchema).optional(),
  defaults: z.record(z.string(), z.any()).optional(),
});

export const saveTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  providerKey: z.string().min(1).max(50).default('custom'),
  description: z.string().optional(),
  columnMap: z.any(),
  fileFormatHints: z.any().optional(),
});

export const updateTemplateSchema = saveTemplateSchema.partial();

export const descriptionMapEntrySchema = z.object({
  sourceDescription: z.string(),
  accountId: z.string().uuid(),
  lineCategory: z.string().optional(),
});

export const saveDescriptionMapSchema = z.object({
  providerKey: z.string().default('payroll_relief_gl'),
  mappings: z.array(descriptionMapEntrySchema).min(1),
});

export const postChecksSchema = z.object({
  bankAccountId: z.string().uuid(),
  clearingAccountId: z.string().uuid(),
  checkIds: z.array(z.string().uuid()).min(1),
});

// Standalone check-register import. Each side of every check comes either
// from the file's own account-number column ('file') or from one account
// chosen for the whole import ('account').
export const postCheckRegisterSchema = z.object({
  cashSource: z.enum(['file', 'account']),
  cashAccountId: z.string().uuid().optional(),
  offsetSource: z.enum(['file', 'account']),
  offsetAccountId: z.string().uuid().optional(),
  tagId: z.string().uuid().nullable().optional(),
}).refine((v) => v.cashSource === 'file' || !!v.cashAccountId, {
  message: 'Choose the bank account the checks are paid from', path: ['cashAccountId'],
}).refine((v) => v.offsetSource === 'file' || !!v.offsetAccountId, {
  message: 'Choose the account the checks post to', path: ['offsetAccountId'],
});

export const generateJeSchema = z.object({
  aggregationMode: z.enum(['summary', 'per_employee']).default('summary'),
  accountMappings: z.record(z.string(), z.string().uuid()).optional(),
});

export const PAYROLL_SESSION_SORT_KEYS = ['payPeriod', 'originalFilename', 'importMode', 'status', 'rowCount', 'errorCount', 'jeCount', 'createdAt'] as const;

export const payrollSessionFiltersSchema = z.object({
  companyId: z.string().uuid().optional(),
  status: z.enum(sessionStatuses).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  // Server-side column sort (the history paginates). Default: newest import first.
  sortBy: z.enum(PAYROLL_SESSION_SORT_KEYS).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Tags applied when the generated JEs post. `tagId` stamps every line;
// `lineTags` overrides individual lines of the preview (null = untagged).
// Lines are addressed by position in the generated preview, and `date`
// pins the JE so a preview that changed since the user tagged it is
// rejected rather than tagging the wrong lines.
export const payrollLineTagSchema = z.object({
  jeIndex: z.number().int().min(0),
  lineIndex: z.number().int().min(0),
  date: z.string().min(1).max(20),
  tagId: z.string().uuid().nullable(),
});

export const postPayrollSchema = z.object({
  forcePost: z.boolean().optional().default(false),
  aggregationMode: z.enum(['summary', 'per_employee']).optional().default('summary'),
  tagId: z.string().uuid().nullable().optional(),
  lineTags: z.array(payrollLineTagSchema).max(10000).optional(),
});

export const accountMappingSaveSchema = z.object({
  mappings: z.record(z.string(), z.string().uuid()),
});

export const reversePayrollSchema = z.object({
  reason: z.string().min(1).max(500).default('Payroll import reversal'),
});

export type ApplyMappingInput = z.infer<typeof applyMappingSchema>;
export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;
export type SaveDescriptionMapInput = z.infer<typeof saveDescriptionMapSchema>;
export type PostChecksInput = z.infer<typeof postChecksSchema>;
export type PostCheckRegisterInput = z.infer<typeof postCheckRegisterSchema>;
export type PayrollLineTagInput = z.infer<typeof payrollLineTagSchema>;
export type GenerateJeInput = z.infer<typeof generateJeSchema>;
export type PostPayrollInput = z.infer<typeof postPayrollSchema>;
export type AccountMappingSaveInput = z.infer<typeof accountMappingSaveSchema>;
