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

/**
 * Font choices for a rendered letter. `value` is the stored key; `stack` is
 * the CSS font-family applied by the renderer. Every stack ends in a generic
 * family (serif / sans-serif) so it degrades gracefully to whatever fonts the
 * PDF (Chromium) environment actually has installed — the reliable, visible
 * distinction is serif vs. sans-serif. 'default' preserves the pre-existing
 * hardcoded stack so untouched letters render exactly as before.
 */
export const LETTER_FONT_OPTIONS = [
  { value: 'default', label: 'Default', stack: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Times New Roman',serif" },
  { value: 'times', label: 'Times New Roman (serif)', stack: "'Times New Roman',Times,serif" },
  { value: 'georgia', label: 'Georgia (serif)', stack: "Georgia,'Times New Roman',serif" },
  { value: 'garamond', label: 'Garamond (serif)', stack: "Garamond,'Times New Roman',serif" },
  { value: 'arial', label: 'Arial (sans-serif)', stack: "Arial,Helvetica,sans-serif" },
  { value: 'helvetica', label: 'Helvetica (sans-serif)', stack: "Helvetica,Arial,sans-serif" },
  { value: 'calibri', label: 'Calibri (sans-serif)', stack: "Calibri,'Segoe UI',Arial,sans-serif" },
] as const;

export type LetterFontKey = (typeof LETTER_FONT_OPTIONS)[number]['value'];

const DEFAULT_LETTER_FONT_STACK = LETTER_FONT_OPTIONS[0].stack;

/** Resolve a stored font key to its CSS font-family stack (default when unset/unknown). */
export function letterFontStack(fontFamily: string | null | undefined): string {
  if (!fontFamily) return DEFAULT_LETTER_FONT_STACK;
  return LETTER_FONT_OPTIONS.find((f) => f.value === fontFamily)?.stack ?? DEFAULT_LETTER_FONT_STACK;
}

export const createReportLetterSchema = z.object({
  name: z.string().trim().min(1).max(200),
  letterType: z.enum(REPORT_LETTER_TYPES),
  // Printed heading. Blank/omitted → the standard SSARS title for the type.
  title: z.string().trim().max(200).optional().nullable(),
  // Font-stack key; must be one of the known options.
  fontFamily: z.enum(LETTER_FONT_OPTIONS.map((f) => f.value) as [LetterFontKey, ...LetterFontKey[]]).optional().nullable(),
  // Generous cap: the body may inline logo/signature images as data URIs
  // (~1.35x the source bytes). Fits a couple of ≤1 MB images plus text.
  bodyHtml: z.string().max(4_000_000),
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
  /** Printed heading override; null → standard SSARS title for the type. */
  title: string | null;
  /** Font-stack key (see LETTER_FONT_OPTIONS); null → default stack. */
  fontFamily: string | null;
  bodyHtml: string;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
