// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

// Mirrors the BatchRow interface in packages/api/src/services/batch.service.ts.
// Both `amount`/`debit`/`credit` accept number OR string because users can
// upload CSV rows where these arrive as strings; the service normalizes.
export const batchRowSchema = z.object({
  rowNumber: z.number().int(),
  date: z.string().max(40).optional(),
  refNo: z.string().max(80).optional(),
  contactName: z.string().max(255).optional(),
  accountName: z.string().max(255).optional(),
  memo: z.string().max(2000).optional(),
  amount: z.union([z.number(), z.string()]).optional(),
  debit: z.union([z.number(), z.string()]).optional(),
  credit: z.union([z.number(), z.string()]).optional(),
  description: z.string().max(2000).optional(),
  dueDate: z.string().max(40).optional(),
  invoiceNo: z.string().max(80).optional(),
  tagId: z.string().uuid().nullable().optional(),
  // The grid's pickers hold ids; sending them avoids a lossy id → name →
  // id round-trip (duplicate names, lists capped at 500). Names remain
  // the path for CSV / pasted rows.
  accountId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
});

// Mirrors the cases handled in batch.service.ts's createOne switch.
// Unknown txn_type values previously fell through silently; the enum
// makes the contract explicit and returns a clean 400 at the boundary.
export const batchTxnTypeEnum = z.enum([
  'expense',
  'credit_card_charge',
  'deposit',
  'credit_card_credit',
  'invoice',
  'bill',
  'credit_memo',
  'journal_entry',
  'customer_payment',
]);

export const batchValidateSchema = z.object({
  txn_type: batchTxnTypeEnum,
  context_account_id: z.string().uuid().nullable().optional(),
  rows: z.array(batchRowSchema).min(1).max(10_000),
});

export const batchSaveSchema = batchValidateSchema.extend({
  auto_create_contacts: z.boolean().optional(),
  skip_invalid: z.boolean().optional(),
});

// `parse-csv` is multipart and the body has the file separately. Only
// the form fields land in req.body here.
export const batchParseCsvSchema = z.object({
  txn_type: batchTxnTypeEnum.optional(),
  // column_mapping arrives as a JSON string from multipart forms or a
  // record from JSON callers — service handles either.
  column_mapping: z.union([
    z.string().max(4000),
    z.record(z.number().int()),
  ]).optional(),
});

// ─── Grouped shape (U-67–U-72, ClientLedger Bulk Entry) ──────────
//
// `{ groups: [{ txn_type, context_account_id, rows }] }`. All groups are
// validated together and saved in ONE database transaction: any failing
// row rolls back the whole request. Amounts are decimal STRINGS only (a
// JSON number is a 400); their format (at most 4 places) and every other
// per-row rule are reported per row by the service, so the grid can show
// them. The single-type shape above stays as it was for the web UI.

/** Most rows one request may carry, across all groups. */
export const BATCH_MAX_ROWS = 10_000;
/** Most groups one request may carry. */
export const BATCH_MAX_GROUPS = 50;

// Row types the grouped shape posts. Invoice, bill, credit memo and
// customer payment rows need items, terms or payment application the
// batch row has no columns for: they stay on the single-type shape.
export const batchGroupTxnTypeEnum = z.enum([
  'check',
  'expense',
  'credit_card_charge',
  'credit_card_credit',
  'deposit',
  'journal_entry',
]);

const batchAmountString = z.string().max(32);

export const batchGroupRowSchema = z.object({
  // Unique across the whole request; every per-row error names it.
  rowNumber: z.number().int().min(1).max(1_000_000),
  // YYYY-MM-DD (checked per row).
  date: z.string().max(40).optional(),
  // check: the check number (a whole number; empty = next number, or none
  // with printLater). expense / card charge / deposit / card credit /
  // journal entry: the reference number (txnNumber).
  refNo: z.string().max(80).optional(),
  contactName: z.string().max(255).optional(),
  contactId: z.string().uuid().nullable().optional(),
  accountName: z.string().max(255).optional(),
  accountId: z.string().uuid().nullable().optional(),
  // Non-JE rows: the transaction memo and line description. JE rows: the
  // line description (description wins when both are sent); the first
  // row's memo is the entry memo.
  memo: z.string().max(2000).optional(),
  description: z.string().max(2000).optional(),
  // Non-JE rows: amount (> 0). JE rows: debit or credit (one of them).
  amount: batchAmountString.optional(),
  debit: batchAmountString.optional(),
  credit: batchAmountString.optional(),
  tagId: z.string().uuid().nullable().optional(),
  // check rows only: queue the check for printing (numbered at print time).
  printLater: z.boolean().optional(),
  // journal_entry rows only: rows with the same entry key form one entry
  // (else rows with the same date and refNo do; a row with neither is an
  // entry of its own).
  entry: z.string().min(1).max(80).optional(),
}).strict();

export const batchGroupSchema = z.object({
  txn_type: batchGroupTxnTypeEnum,
  // The bank / card account every row of the group posts against
  // (required except for journal_entry).
  context_account_id: z.string().uuid().nullable().optional(),
  rows: z.array(batchGroupRowSchema).min(1).max(BATCH_MAX_ROWS),
}).strict();

function refineGroups(
  body: { groups: Array<{ rows: Array<{ rowNumber: number }> }> },
  ctx: z.RefinementCtx,
) {
  let total = 0;
  const seen = new Set<number>();
  body.groups.forEach((g, gi) => {
    total += g.rows.length;
    g.rows.forEach((r, ri) => {
      if (seen.has(r.rowNumber)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', gi, 'rows', ri, 'rowNumber'],
          message: `rowNumber ${r.rowNumber} appears more than once`,
        });
      }
      seen.add(r.rowNumber);
    });
  });
  if (total > BATCH_MAX_ROWS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['groups'],
      message: `A batch can have at most ${BATCH_MAX_ROWS} rows (this one has ${total})`,
    });
  }
}

const batchGroupsBase = z.object({
  groups: z.array(batchGroupSchema).min(1).max(BATCH_MAX_GROUPS),
  // Read by the closing-date middleware (staff confirmation, as on the
  // single forms); closingPassword is taken out of the body before this.
  overrideConfirmed: z.boolean().optional(),
});

export const batchValidateGroupsSchema = batchGroupsBase.strict().superRefine(refineGroups);

export const batchSaveGroupsSchema = batchGroupsBase.extend({
  // Create a contact for a name that matches none (vendor for check /
  // expense / card rows, customer for deposit rows). Journal entry names
  // must exist.
  auto_create_contacts: z.boolean().optional(),
}).strict().superRefine(refineGroups);

export type BatchGroupRow = z.infer<typeof batchGroupRowSchema>;
export type BatchGroupTxnType = z.infer<typeof batchGroupTxnTypeEnum>;
export type BatchValidateGroupsInput = z.infer<typeof batchValidateGroupsSchema>;
export type BatchSaveGroupsInput = z.infer<typeof batchSaveGroupsSchema>;

export type BatchValidateInput = z.infer<typeof batchValidateSchema>;
export type BatchSaveInput = z.infer<typeof batchSaveSchema>;
export type BatchParseCsvInput = z.infer<typeof batchParseCsvSchema>;
