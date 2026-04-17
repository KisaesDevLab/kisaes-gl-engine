// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

const validFontScales = [0.8125, 0.875, 1, 1.125, 1.25, 1.375, 1.5] as const;
const validThemes = ['light', 'dark', 'system'] as const;

export const updatePreferencesSchema = z.object({
  fontScale: z.number().refine((v) => (validFontScales as readonly number[]).includes(v), 'Invalid font scale').optional(),
  theme: z.enum(validThemes).optional(),
});
