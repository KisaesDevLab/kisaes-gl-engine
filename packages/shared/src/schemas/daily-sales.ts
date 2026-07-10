// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

export const dailySalesSectionEnum = z.enum([
  'sales', 'tax', 'tips', 'discount', 'payment', 'payout', 'other',
]);
export const dailySalesSideEnum = z.enum(['debit', 'credit']);

const money = z.union([z.string(), z.number()]);

// ── Templates ──────────────────────────────────────────────────
export const createDailySalesTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  // Seed line definitions from a preset on create (optional).
  presetType: z.enum(['custom', 'restaurant', 'retail']).optional(),
  defaultTagId: z.string().uuid().nullable().optional(),
});
export type CreateDailySalesTemplateInput = z.infer<typeof createDailySalesTemplateSchema>;

export const updateDailySalesTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  defaultTagId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateDailySalesTemplateInput = z.infer<typeof updateDailySalesTemplateSchema>;

export const dailySalesTemplateLineSchema = z.object({
  id: z.string().uuid().optional(),
  section: dailySalesSectionEnum,
  label: z.string().min(1).max(120),
  accountId: z.string().uuid().nullable().optional(),
  normalSide: dailySalesSideEnum,
  sortOrder: z.number().int().min(0).default(0),
  isRequired: z.boolean().optional().default(false),
  allowTag: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
});
export type DailySalesTemplateLineInput = z.infer<typeof dailySalesTemplateLineSchema>;

// Bulk-replace the template's line definitions.
export const replaceDailySalesTemplateLinesSchema = z.object({
  lines: z.array(dailySalesTemplateLineSchema).max(200),
});

// ── Entries ────────────────────────────────────────────────────
const entryValueSchema = z.object({
  templateLineId: z.string().uuid(),
  amount: money,
  tagId: z.string().uuid().nullable().optional(),
});

export const createDailySalesEntrySchema = z.object({
  templateId: z.string().uuid(),
  businessDate: z.string().min(1).max(20),
  tagId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  values: z.array(entryValueSchema).max(200).default([]),
});
export type CreateDailySalesEntryInput = z.infer<typeof createDailySalesEntrySchema>;

export const updateDailySalesEntrySchema = z.object({
  businessDate: z.string().min(1).max(20).optional(),
  tagId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  values: z.array(entryValueSchema).max(200).optional(),
});
export type UpdateDailySalesEntryInput = z.infer<typeof updateDailySalesEntrySchema>;

// Live balance/over-short preview for unsaved values.
export const previewDailySalesEntrySchema = z.object({
  templateId: z.string().uuid(),
  values: z.array(entryValueSchema).max(200).default([]),
});
export type PreviewDailySalesEntryInput = z.infer<typeof previewDailySalesEntrySchema>;

export const dailySalesEntriesFilterSchema = z.object({
  status: z.enum(['draft', 'posted', 'void']).optional(),
  templateId: z.string().uuid().optional(),
  from: z.string().max(20).optional(),
  to: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
