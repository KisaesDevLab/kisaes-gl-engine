// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

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
  'quickbooks_desktop',
  'generic',
]);

export const importStatusSchema = z.enum([
  'uploaded',
  'validated',
  'committing',
  'committed',
  'failed',
  'cancelled',
  // U-261: the batch holding the session was undone.
  'undone',
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

// ── Batches (U-261, U-263) ──────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const importSessionRoleSchema = z.enum(['post', 'reference']);

export const importBatchKindSchema = z.enum(['conversion', 'single', 'transactions']);

export const importBatchStatusSchema = z.enum(['draft', 'committing', 'committed', 'failed', 'undoing', 'undone']);

export const importBatchOptionsSchema = z.object({
  /** 1-12; only in a company with no transactions (409 IMPORT_FISCAL_YEAR_LOCKED). */
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  historyFrom: isoDate.optional(),
  conversionDate: isoDate.optional(),
  /** Refuse the commit unless the company has no transactions (409 IMPORT_COMPANY_NOT_EMPTY). */
  requireEmptyCompany: z.boolean().optional(),
  /** Source account key -> account id. */
  accountMap: z.record(z.string().max(200), z.string().uuid()).optional(),
  /** Source class name -> {group?, tag}. */
  classMap: z.record(z.string().max(200), z.object({ group: z.string().max(100).optional(), tag: z.string().min(1).max(100) })).optional(),
}).strict();

export const importBatchCreateSchema = z.object({
  sourceSystem: sourceSystemSchema,
  kind: importBatchKindSchema.default('single'),
  sessionIds: z.array(z.string().uuid()).min(1).max(100),
  options: importBatchOptionsSchema.optional(),
});

export const importBatchCommitSchema = z.object({
  /** The verified backup the client took before the commit (its file name); kept on the batch record. */
  backupRef: z.string().min(1).max(500).nullable().optional(),
  /** Staff confirmation for a closed period when the company has no closing-date password. */
  confirmClosedPeriod: z.boolean().optional(),
});

/** U-261: undo takes the same body (backupRef of the backup taken before the undo). */
export const importBatchUndoSchema = importBatchCommitSchema;

export const importBatchListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export const importListQuerySchema = z.object({
  kind: importKindSchema.optional(),
  sourceSystem: sourceSystemSchema.optional(),
  status: importStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
