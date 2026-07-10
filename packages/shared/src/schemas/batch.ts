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

export type BatchValidateInput = z.infer<typeof batchValidateSchema>;
export type BatchSaveInput = z.infer<typeof batchSaveSchema>;
export type BatchParseCsvInput = z.infer<typeof batchParseCsvSchema>;
