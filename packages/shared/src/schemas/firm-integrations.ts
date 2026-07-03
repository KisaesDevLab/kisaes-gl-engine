// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

// Firm-level Tax1099.com integration settings. Credential fields are
// 3-state: null clears, ''/omitted keeps the stored value, a non-empty
// string replaces it (encrypted server-side).
export const tax1099SettingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  environment: z.enum(['sandbox', 'production']).optional(),
  baseUrlOverride: z.string().url().max(255).nullable().optional().or(z.literal('').transform(() => null)),
  apiKey: z.string().max(500).nullable().optional(),
  username: z.string().max(255).nullable().optional(),
  password: z.string().max(255).nullable().optional(),
});
export type Tax1099SettingsInput = z.infer<typeof tax1099SettingsSchema>;

export const submit1099FilingSchema = z.object({
  taxYear: z.number().int().min(2015).max(2100),
  formType: z.enum(['1099-NEC', '1099-MISC']),
});
export type Submit1099FilingInput = z.infer<typeof submit1099FilingSchema>;
