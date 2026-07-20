// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// CPA report-letter (SSARS 21) admin CRUD schemas + type metadata.
// Templates are SYSTEM-level (managed by super-admin, shared across the
// appliance). See services/report-letter.service.ts + the 0140 migration.

import { z } from 'zod';

/**
 * Letter type. Kept as a plain string with a bounded set so a later review
 * engagement (AR-C 90) can be added without a schema migration. Two seeded
 * defaults exist today: compilation (AR-C 80) and preparation (AR-C 70).
 */
export const REPORT_LETTER_TYPES = ['compilation', 'preparation'] as const;
export type ReportLetterType = (typeof REPORT_LETTER_TYPES)[number];

/** Default report title per type (also exposed as the {{report_title}} value). */
export const REPORT_LETTER_TITLES: Record<ReportLetterType, string> = {
  compilation: "Accountant's Compilation Report",
  preparation: 'Preparation of Financial Statements',
};

export const createReportLetterSchema = z.object({
  name: z.string().trim().min(1).max(200),
  letterType: z.enum(REPORT_LETTER_TYPES),
  bodyHtml: z.string().max(100_000),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const updateReportLetterSchema = createReportLetterSchema.partial();

export type CreateReportLetterInput = z.infer<typeof createReportLetterSchema>;
export type UpdateReportLetterInput = z.infer<typeof updateReportLetterSchema>;

/** A report-letter row as returned by the API. */
export interface ReportLetter {
  id: string;
  name: string;
  letterType: ReportLetterType;
  bodyHtml: string;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
