// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';
import { CLASSIFICATION_BUCKETS } from '../types/practice-classification.js';

export const classificationBucketSchema = z.enum(CLASSIFICATION_BUCKETS);

// All thresholds in [0, 1]. The schema enforces the ordering
// invariant from build plan §2.2: the Bucket-4 floor must be ≤
// the Bucket-3 medium cutoff must be ≤ the Bucket-3 high cutoff.
// Otherwise a tenant could set contradictory thresholds (floor =
// 0.9, high = 0.1) that silently misclassify every row.
export const classificationThresholdsSchema = z
  .object({
    bucket3HighConfidence: z.number().min(0).max(1).optional(),
    bucket3HighVendorConsistency: z.number().min(0).max(1).optional(),
    bucket3MediumConfidence: z.number().min(0).max(1).optional(),
    bucket4Floor: z.number().min(0).max(1).optional(),
  })
  .refine(
    (v) => {
      // Every PAIR of present values must satisfy the ordering
      // invariant `bucket4Floor ≤ bucket3MediumConfidence ≤
      // bucket3HighConfidence`. Checking each pair independently
      // (rather than chaining with ?? fallbacks) catches the case
      // where the middle value is omitted but the two endpoints
      // contradict — e.g. floor=0.9, high=0.5.
      const { bucket4Floor: f, bucket3MediumConfidence: m, bucket3HighConfidence: h } = v;
      if (f !== undefined && m !== undefined && f > m) return false;
      if (m !== undefined && h !== undefined && m > h) return false;
      if (f !== undefined && h !== undefined && f > h) return false;
      return true;
    },
    { message: 'Thresholds must satisfy bucket4Floor ≤ bucket3MediumConfidence ≤ bucket3HighConfidence' },
  );

export type ClassificationThresholdsInput = z.infer<typeof classificationThresholdsSchema>;

export const approveSelectedSchema = z.object({
  stateIds: z.array(z.string().uuid()).min(1).max(200),
});
export type ApproveSelectedInput = z.infer<typeof approveSelectedSchema>;

export const approveAllSchema = z.object({
  bucket: classificationBucketSchema,
  companyId: z.string().uuid().nullable().optional(),
  periodStart: z.string(),
  periodEnd: z.string(),
  confirm: z.boolean().optional(),
});
export type ApproveAllInput = z.infer<typeof approveAllSchema>;

export const reclassifySchema = z.object({
  bucket: classificationBucketSchema,
});
export type ReclassifyInput = z.infer<typeof reclassifySchema>;

export const bucketQuerySchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type BucketQueryInput = z.infer<typeof bucketQuerySchema>;

export const summaryQuerySchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  periodStart: z.string(),
  periodEnd: z.string(),
});
export type SummaryQueryInput = z.infer<typeof summaryQuerySchema>;
