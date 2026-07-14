// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Journal-entry templates — reusable line skeletons (label, account,
// debit/credit side, required flag) mirroring the Daily Sales (POS)
// template builder, minus the POS-specific sections/presets. "Using"
// a template pre-fills the Journal Entry form; the posted JE remains
// the only ledger artifact.

import { z } from 'zod';

export const jeTemplateSideEnum = z.enum(['debit', 'credit']);

export const createJeTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  memo: z.string().max(500).nullable().optional(),
  defaultTagId: z.string().uuid().nullable().optional(),
});
export type CreateJeTemplateInput = z.infer<typeof createJeTemplateSchema>;

export const updateJeTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  memo: z.string().max(500).nullable().optional(),
  defaultTagId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateJeTemplateInput = z.infer<typeof updateJeTemplateSchema>;

export const jeTemplateLineSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().min(1).max(120),
  accountId: z.string().uuid().nullable().optional(),
  normalSide: jeTemplateSideEnum,
  sortOrder: z.number().int().min(0).default(0),
  isRequired: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
});
export type JeTemplateLineInput = z.infer<typeof jeTemplateLineSchema>;

export const replaceJeTemplateLinesSchema = z.object({
  lines: z.array(jeTemplateLineSchema).max(100),
});

export interface JeTemplateLine {
  id: string;
  templateId: string;
  label: string;
  accountId: string | null;
  normalSide: 'debit' | 'credit';
  sortOrder: number;
  isRequired: boolean;
  isActive: boolean;
}

export interface JeTemplate {
  id: string;
  name: string;
  memo: string | null;
  defaultTagId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JeTemplateWithLines extends JeTemplate {
  lines: JeTemplateLine[];
}
