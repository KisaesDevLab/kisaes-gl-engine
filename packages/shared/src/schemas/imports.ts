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
  // U-264 (qbd-open-items-v1): A/R and A/P open items as of a date.
  'open_invoices',
  'unpaid_bills',
  // U-265 (qbd-mapping-v1): the item list; inventory on hand and value as of a date.
  'items',
  'inventory_valuation',
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

/** U-265: a contacts upload's list; 'other' (QuickBooks Desktop Other Names) imports as vendors (Q-78). */
export const contactUploadKindSchema = z.enum(['customer', 'vendor', 'other']);

export const tbColumnChoiceSchema = z.enum(['beginning', 'adjusted']);

export const importUploadOptionsSchema = z.object({
  updateExistingCoa: z.boolean().optional(),
  contactKind: contactUploadKindSchema.optional(),
  tbColumn: tbColumnChoiceSchema.optional(),
  /**
   * Required when uploading an Accounting Power trial balance — the
   * file doesn't carry an "as of" date. Validated as ISO YYYY-MM-DD;
   * service layer additionally requires it for AP TB and rejects with
   * IMPORT_BAD_DATE when missing.
   */
  tbReportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
  /** Open items (U-264): the report's as-of date when the file carries none. */
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
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
  /**
   * Source account key (the number, else the name: preview.accountMatches[].sourceKey) -> an account id of the
   * company, or "create" (U-265): a chart row of the batch is created as a new account even when the company has
   * one with its name. A key a batch commit can't resolve fails it (422 IMPORT_UNMAPPED_ACCOUNT), never suspense.
   */
  accountMap: z.record(z.string().min(1).max(200), z.union([z.string().uuid(), z.literal('create')])).optional(),
  /** Source class name -> {group?, tag}: journal lines of that class get the tag (in the group), created when missing (U-265). */
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

/**
 * U-267 (imports-tieout-v1): body of POST /imports/batches/:id/tieout and /verify. The accounts side compares
 * against the batch's reference trial balance, required by default for every source (review S9: never a file
 * against itself); requireReference false skips the accounts side when the batch has none.
 */
export const importTieoutRequestSchema = z.object({
  requireReference: z.boolean().default(true),
}).strict().default({});

/** U-267: PUT /imports/batches/:id/spot-check, the owner's spot-check list, stored on the batch as sent. */
export const importSpotCheckSchema = z.object({
  items: z.array(z.object({
    key: z.string().min(1).max(100),
    label: z.string().max(300),
    done: z.boolean(),
    note: z.string().max(2000).nullable().optional(),
  }).strict()).max(200),
}).strict();

/** U-271: GET /imports/batches/:id/transactions, the batch's created transactions, paged. */
export const importBatchTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  txnType: z.string().min(1).max(40).optional(),
});

export const importListQuerySchema = z.object({
  kind: importKindSchema.optional(),
  sourceSystem: sourceSystemSchema.optional(),
  status: importStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
