// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import { invoiceLineSchema } from './transactions.js';
import { wholeCentsAmount } from './payments.js';
import { PAYMENT_METHODS } from '../constants/payment-methods.js';

// Credit memos (U-138) and sales receipts (U-143) on the invoice line model:
// items, quantities and rates (4 places), discount percents, taxable flags
// and rates, tags, service dates. Billable-cost fields are refused.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date YYYY-MM-DD');
const storedAmount = z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'a decimal amount with at most 4 places');
const MAX_LINES = 500;

const salesDocHeader = {
  txnDate: isoDate,
  lines: z.array(invoiceLineSchema).min(1).max(MAX_LINES),
  memo: z.string().optional(),
  customerMessage: z.string().max(4000).optional(),
  tagIds: z.array(z.string().uuid()).max(50).optional(),
  hideZeroLines: z.boolean().optional(),
  layoutId: z.string().uuid().nullable().optional(),
  txnNumber: z.string().trim().max(50).optional(),
  warnOnly: z.boolean().optional(),
  printLater: z.boolean().optional(),
};

/** POST /credit-memos, PUT /credit-memos/:id (U-138). */
export const creditMemoSchema = z.object({
  ...salesDocHeader,
  contactId: z.string().uuid(),
  // Q-P22b: applied in the same database transaction (applied_date NULL).
  applications: z.array(z.object({
    invoiceId: z.string().uuid(),
    amount: wholeCentsAmount,
    expectedBalanceDue: storedAmount.optional(),
  })).max(1000).optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

/** POST /credit-memos/preview: the create body (applications ignored) + editingId. */
export const creditMemoPreviewSchema = creditMemoSchema.extend({ editingId: z.string().uuid().optional() });

/** POST /sales-receipts, PUT /sales-receipts/:id (U-143). */
export const salesReceiptSchema = z.object({
  ...salesDocHeader,
  contactId: z.string().uuid().nullable().optional(),
  // Default: Payments Clearing (Q-P20h). A total below 0.00 needs a bank account.
  depositToAccountId: z.string().uuid().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  refNo: z.string().trim().max(100).optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

export const salesReceiptPreviewSchema = salesReceiptSchema.extend({ editingId: z.string().uuid().optional() });

export type CreditMemoInput = z.infer<typeof creditMemoSchema>;
export type CreditMemoPreviewInput = z.infer<typeof creditMemoPreviewSchema>;
export type SalesReceiptInput = z.infer<typeof salesReceiptSchema>;
export type SalesReceiptPreviewInput = z.infer<typeof salesReceiptPreviewSchema>;
