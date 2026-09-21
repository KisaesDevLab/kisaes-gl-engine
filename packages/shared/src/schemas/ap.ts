// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import { BILL_PAYMENT_METHODS } from '../constants/payment-methods.js';

const billStatuses = ['unpaid', 'partial', 'paid', 'overdue'] as const;

const billLineSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().optional(),
  amount: z.string().min(1),
  itemId: z.string().uuid().optional(),
  // ADR 0XX: per-line tag.
  tagId: z.string().uuid().nullable().optional(),
});

export const createBillSchema = z.object({
  contactId: z.string().uuid(),
  txnDate: z.string().min(1),
  dueDate: z.string().optional(),
  paymentTerms: z.string().optional(),
  termsDays: z.coerce.number().int().min(0).optional(),
  vendorInvoiceNumber: z.string().max(100).optional(),
  memo: z.string().optional(),
  internalNotes: z.string().optional(),
  lines: z.array(billLineSchema).min(1, 'At least one line is required').max(500, 'Too many lines'),
});

const vendorCreditLineSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().optional(),
  amount: z.string().min(1),
  tagId: z.string().uuid().nullable().optional(),
});

export const createVendorCreditSchema = z.object({
  contactId: z.string().uuid(),
  txnDate: z.string().min(1),
  vendorInvoiceNumber: z.string().max(100).optional(),
  memo: z.string().optional(),
  lines: z.array(vendorCreditLineSchema).min(1, 'At least one line is required').max(500, 'Too many lines'),
});

const billPaymentBillSchema = z.object({
  billId: z.string().uuid(),
  amount: z.string().min(1),
});

const billPaymentCreditSchema = z.object({
  creditId: z.string().uuid(),
  billId: z.string().uuid(),
  amount: z.string().min(1),
});

export const payBillsSchema = z.object({
  bankAccountId: z.string().uuid(),
  txnDate: z.string().min(1),
  method: z.enum(BILL_PAYMENT_METHODS),
  printLater: z.boolean().optional(),
  memo: z.string().optional(),
  // ACH trace / card auth / confirmation number. Stored on every payment the
  // run creates (transactions.reference_number). Checks don't need one — the
  // check number is the reference.
  referenceNumber: z.string().trim().max(100).optional(),
  // Memo line printed on the check face (transactions.printed_memo). Left
  // blank, the service fills in the bill/vendor-invoice numbers being paid
  // so the vendor can apply the payment. Editable afterwards from the
  // print queue until the check prints.
  printedMemo: z.string().max(255).optional(),
  bills: z.array(billPaymentBillSchema).min(1, 'Select at least one bill to pay'),
  credits: z.array(billPaymentCreditSchema).optional(),
});

export const billFiltersSchema = z.object({
  contactId: z.string().uuid().optional(),
  billStatus: z.enum(billStatuses).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  dueOnOrBefore: z.string().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  // ADR 0XX §5.2 — header-level tag filter.
  tagId: z.string().uuid().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const payableBillsQuerySchema = z.object({
  contactId: z.string().uuid().optional(),
  dueOnOrBefore: z.string().optional(),
});

// PORTAL_BILL_PAY_V1 — portal contact marks bills for payment. Bill ids
// only: the portal always pays the full balance due, and the bank
// account comes from portal_settings_per_company, never the client.
export const portalMarkBillsSchema = z.object({
  companyId: z.string().uuid(),
  billIds: z.array(z.string().uuid()).min(1).max(100),
});

// ─── AP Bill Capture (migration 0175) ───────────────────────────────
// Multi-upload intake reviewed on a two-pane screen and posted through the
// same createBill path as Enter Bill.

export const billLinesModes = ['detailed', 'single'] as const;
export const billCaptureStatuses = ['received', 'processing', 'ready', 'failed', 'entered', 'discarded'] as const;

export const billCaptureListQuerySchema = z.object({
  status: z.enum(billCaptureStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Vendor created on save when the OCR'd name matched no contact and the
// user kept it. Address fields come pre-filled from the bill when read.
export const newVendorSchema = z.object({
  displayName: z.string().trim().min(1).max(255),
  billingLine1: z.string().max(255).nullish(),
  billingLine2: z.string().max(255).nullish(),
  billingCity: z.string().max(100).nullish(),
  billingState: z.string().max(50).nullish(),
  billingZip: z.string().max(20).nullish(),
  billingCountry: z.string().max(3).optional(),
  email: z.string().email().max(255).nullish(),
  phone: z.string().max(30).nullish(),
  defaultExpenseAccountId: z.string().uuid().nullish(),
});

export const enterBillCaptureSchema = createBillSchema
  .omit({ contactId: true })
  .extend({
    contactId: z.string().uuid().optional(),
    newVendor: newVendorSchema.optional(),
    linesMode: z.enum(billLinesModes),
    // Server re-checks for a duplicate bill on enter; true posts anyway.
    overrideDuplicate: z.boolean().default(false),
  })
  .refine((v) => !!v.contactId !== !!v.newVendor, {
    message: 'Provide contactId or newVendor, not both',
    path: ['contactId'],
  });
