// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';
import { PRACTICE_FEATURE_FLAGS } from '../constants/feature-flags.js';

// Zod enum from the authoritative constant list — if a new flag is
// added to PRACTICE_FEATURE_FLAGS, the schema picks it up without a
// parallel edit here.
export const featureFlagKeySchema = z.enum(PRACTICE_FEATURE_FLAGS);
export type FeatureFlagKey = z.infer<typeof featureFlagKeySchema>;

export const featureFlagToggleSchema = z.object({
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
});
export type FeatureFlagToggleInput = z.infer<typeof featureFlagToggleSchema>;

export const featureFlagStatusSchema = z.object({
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
  activatedAt: z.string().nullable(),
});
export type FeatureFlagStatus = z.infer<typeof featureFlagStatusSchema>;

// GET /api/v1/feature-flags response shape.
export const featureFlagsResponseSchema = z.object({
  flags: z.record(featureFlagKeySchema, featureFlagStatusSchema),
});
export type FeatureFlagsResponse = z.infer<typeof featureFlagsResponseSchema>;
