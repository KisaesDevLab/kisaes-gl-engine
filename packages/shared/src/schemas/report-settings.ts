// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import { REPORT_FOOTER_MAX_LENGTH } from '../types/report-settings.js';

const labelField = z.string().trim().max(80);

export const plSectionLabelsSchema = z.object({
  revenue: labelField,
  cogs: labelField,
  grossProfit: labelField,
  expenses: labelField,
  operatingIncome: labelField,
  otherRevenue: labelField,
  otherExpenses: labelField,
  netIncome: labelField,
}).partial();

export const bsSectionLabelsSchema = z.object({
  assets: labelField,
  liabilities: labelField,
  equity: labelField,
  totalLiabilitiesAndEquity: labelField,
}).partial();

export const cfSectionLabelsSchema = z.object({
  operatingActivities: labelField,
  investingActivities: labelField,
  financingActivities: labelField,
  netChange: labelField,
}).partial();

export const updateTenantReportSettingsSchema = z.object({
  plLabels: plSectionLabelsSchema.optional(),
  bsLabels: bsSectionLabelsSchema.optional(),
  cfLabels: cfSectionLabelsSchema.optional(),
  reportFooter: z.string().trim().max(REPORT_FOOTER_MAX_LENGTH).optional(),
});

export type UpdateTenantReportSettingsInput = z.infer<typeof updateTenantReportSettingsSchema>;
