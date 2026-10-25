// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import { csvEnumSet, sortBySchema, sortDirSchema } from './list-view.js';
import { BILL_PAYMENT_METHODS } from '../constants/payment-methods.js';
import { PAYMENT_TERM_CODES } from '../constants/payment-terms.js';

const billStatuses = ['unpaid', 'partial', 'paid', 'overdue'] as const;

// A YYYY-MM-DD calendar day (U-86): a date-time or an impossible day
// (2026-02-30) is 400 VALIDATION_ERROR.
const apDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Not a valid date');

// Web forms send "" for an empty optional field; treat it as absent.
const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const optionalApDate = z.preprocess(blankToUndefined, apDate.optional());

// Optimistic concurrency (U-84, ap-edit-v1): the record's updatedAt as last
// read. A mismatch is 409 STALE with details.updatedAt; omitted = no check.
const expectedUpdatedAt = z.string().datetime({ offset: true }).optional();

// Item and quantity fields on a line (U-85, bill-lines-v1). Decimal strings;
// the service checks scale and bounds (quantity > 0, at most 4 places, below
// 100,000,000; unitPrice >= 0, at most 4 places) and that amount equals
// quantity x unitPrice rounded half away from zero to cents.
const lineItemFields = {
  itemId: z.string().uuid().nullable().optional(),
  quantity: z.string().min(1).nullable().optional(),
  unitPrice: z.string().min(1).nullable().optional(),
  // ADR 0XX: per-line tag.
  tagId: z.string().uuid().nullable().optional(),
  // Per-line customer (U-49 semantics), stored on journal_lines.contact_id.
  contactId: z.string().uuid().nullable().optional(),
};

const billLineSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().optional(),
  amount: z.string().min(1),
  ...lineItemFields,
  // Billable to the line's customer (U-50 semantics); requires contactId.
  isBillable: z.boolean().optional(),
});

export const createBillSchema = z.object({
  contactId: z.string().uuid(),
  txnDate: apDate,
  // An explicit due date is the owner's override (stored with
  // due_date_overridden); omitted, the engine computes it from the terms.
  dueDate: optionalApDate,
  paymentTerms: z.preprocess(blankToUndefined, z.enum(PAYMENT_TERM_CODES).optional()),
  termsDays: z.coerce.number().int().min(0).max(3650).optional(),
  // Custom terms only (U-86): early-payment discount percent (0 < p < 100,
  // at most 4 places) and the days it is offered (0..365, fewer than the
  // net days). Both or neither.
  discountPercent: z.preprocess(blankToUndefined, z.string().regex(/^\d{1,2}(\.\d{1,4})?$/, 'A percent with at most 4 decimal places').optional()),
  discountDays: z.coerce.number().int().min(0).max(365).optional(),
  // Owner override of the discount date (stored with discount_date_overridden).
  discountDate: optionalApDate,
  // Bill received (U-87, bill-received-v1). Default true; false keeps the
  // bill out of Pay Bills until it is ticked.
  billReceived: z.boolean().optional(),
  vendorInvoiceNumber: z.string().max(100).optional(),
  memo: z.string().optional(),
  internalNotes: z.string().optional(),
  // Draft attachments relinked to the new bill in the same database
  // transaction (POST only).
  draftAttachmentId: z.string().uuid().optional(),
  expectedUpdatedAt,
  lines: z.array(billLineSchema).min(1, 'At least one line is required').max(500, 'Too many lines'),
});

const vendorCreditLineSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().optional(),
  amount: z.string().min(1),
  ...lineItemFields,
  // A vendor credit line is never billable (U-85): the billable-cost flow
  // invoices costs, and a credit reduces one. false or absent only.
  isBillable: z.literal(false, { errorMap: () => ({ message: 'A vendor credit line cannot be billable' }) }).optional(),
});

export const createVendorCreditSchema = z.object({
  contactId: z.string().uuid(),
  txnDate: apDate,
  vendorInvoiceNumber: z.string().max(100).optional(),
  memo: z.string().optional(),
  draftAttachmentId: z.string().uuid().optional(),
  expectedUpdatedAt,
  lines: z.array(vendorCreditLineSchema).min(1, 'At least one line is required').max(500, 'Too many lines'),
});

// GET /bills/terms-dates (U-86): the dates create would compute, read-only.
export const billTermsDatesQuerySchema = z.object({
  txnDate: apDate,
  paymentTerms: z.preprocess(blankToUndefined, z.enum(PAYMENT_TERM_CODES).optional()),
  termsDays: z.coerce.number().int().min(0).max(3650).optional(),
  discountPercent: z.preprocess(blankToUndefined, z.string().regex(/^\d{1,2}(\.\d{1,4})?$/, 'A percent with at most 4 decimal places').optional()),
  discountDays: z.coerce.number().int().min(0).max(365).optional(),
  contactId: z.string().uuid().optional(),
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

export const billSortKeys = ['number', 'vendor', 'vendorInvoiceNumber', 'date', 'dueDate', 'status', 'total', 'balance'] as const;

export const billFiltersSchema = z.object({
  contactId: z.string().uuid().optional(),
  // One status, or a comma-joined set (the Bills list's Status filter).
  billStatus: csvEnumSet(billStatuses),
  sortBy: sortBySchema(billSortKeys),
  sortDir: sortDirSchema.optional(),
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
