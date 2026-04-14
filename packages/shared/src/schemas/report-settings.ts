import { z } from 'zod';

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

export const updateTenantReportSettingsSchema = z.object({
  plLabels: plSectionLabelsSchema.optional(),
});

export type UpdateTenantReportSettingsInput = z.infer<typeof updateTenantReportSettingsSchema>;
