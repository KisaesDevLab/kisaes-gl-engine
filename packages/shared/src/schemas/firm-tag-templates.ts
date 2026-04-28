// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

// 3-tier rules plan, Phase 7 — zod schemas for tag templates.
// `template_key` is URL-safe lowercase + underscores so it round-
// trips through CSV exports + JSON imports without escaping.

const templateKeySchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9](_?[a-z0-9])*$/, 'template_key must be lowercase alphanumeric with single underscores');

export const createFirmTagTemplateSchema = z.object({
  templateKey: templateKeySchema,
  displayName: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
});
export type CreateFirmTagTemplateInput = z.infer<typeof createFirmTagTemplateSchema>;

export const updateFirmTagTemplateSchema = z.object({
  // template_key intentionally NOT updatable — renaming would
  // silently invalidate every rule referencing it.
  displayName: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
});
export type UpdateFirmTagTemplateInput = z.infer<typeof updateFirmTagTemplateSchema>;

export const upsertTagBindingSchema = z.object({
  tenantId: z.string().uuid(),
  tagId: z.string().uuid(),
});
export type UpsertTagBindingInput = z.infer<typeof upsertTagBindingSchema>;
