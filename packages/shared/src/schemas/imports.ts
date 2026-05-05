// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Zod schemas for the bulk-import endpoints. Used by both the API
// route validators and the web hooks (so the wire format is enforced
// in one place and TypeScript types stay aligned).

import { z } from 'zod';

export const importKindSchema = z.enum([
  'coa',
  'contacts',
  'trial_balance',
  'gl_transactions',
]);

export const sourceSystemSchema = z.enum([
  'accounting_power',
  'quickbooks_online',
]);

export const importStatusSchema = z.enum([
  'uploaded',
  'validated',
  'committing',
  'committed',
  'failed',
  'cancelled',
]);

export const contactKindSchema = z.enum(['customer', 'vendor']);

export const tbColumnChoiceSchema = z.enum(['beginning', 'adjusted']);

export const importUploadOptionsSchema = z.object({
  updateExistingCoa: z.boolean().optional(),
  contactKind: contactKindSchema.optional(),
  tbColumn: tbColumnChoiceSchema.optional(),
  /**
   * Required when uploading an Accounting Power trial balance — the
   * file doesn't carry an "as of" date. Validated as ISO YYYY-MM-DD;
   * service layer additionally requires it for AP TB and rejects with
   * IMPORT_BAD_DATE when missing.
   */
  tbReportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
});

/**
 * The upload endpoint takes multipart form-data: one `file` part plus
 * these scalar fields. Multer surfaces them on req.body as strings;
 * the route parses `options` from a JSON string.
 */
export const importUploadFieldsSchema = z.object({
  kind: importKindSchema,
  sourceSystem: sourceSystemSchema,
  options: importUploadOptionsSchema.optional(),
});

export const importCommitSchema = z.object({
  /** Validate-only run — returns the same shape but doesn't mutate. */
  dryRun: z.boolean().optional(),
});

export const importListQuerySchema = z.object({
  kind: importKindSchema.optional(),
  sourceSystem: sourceSystemSchema.optional(),
  status: importStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
