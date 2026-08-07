// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

const validFontScales = [0.8125, 0.875, 1, 1.125, 1.25, 1.375, 1.5] as const;
const validThemes = ['light', 'dark', 'system'] as const;

export const updatePreferencesSchema = z.object({
  fontScale: z.number().refine((v) => (validFontScales as readonly number[]).includes(v), 'Invalid font scale').optional(),
  theme: z.enum(validThemes).optional(),
  // TB workpaper display prefs (TB module 6.7/12.8) — merge-patched
  // like the rest of displayPreferences.
  tb: z.object({
    drCrMode: z.boolean().optional(),
    showPy: z.boolean().optional(),
    showTax: z.boolean().optional(),
    nonZeroOnly: z.boolean().optional(),
    activityView: z.string().max(64).optional(),
    basis: z.enum(['accrual', 'cash']).optional(),
  }).optional(),
});
