// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import { csvEnumSet, csvUuidSet } from './list-view.js';
import { PAYMENT_METHODS } from '../constants/payment-methods.js';
import type { TxnType } from '../types/transactions.js';

// Every TxnType. The AP types and daily sales were missing, so the
// transaction list's Type filter could not ask for bills or bill payments —
// the query param failed validation before it reached the ledger.
const txnTypes = [
  'invoice', 'customer_payment', 'cash_sale', 'expense', 'deposit', 'transfer', 'journal_entry',
  'credit_memo', 'customer_refund', 'bill', 'vendor_credit', 'bill_payment', 'daily_sales', 'aje',
] as const satisfies readonly TxnType[];

// Cap on any journal-line / line-item array. 500 is well beyond any realistic
// invoice or deposit and bounds the input size so a malicious client can't
// push a 100k-line transaction that pins CPU on the validate + balance path.
const MAX_LINES = 500;
// 'deleted' (P12 R7, txn-delete-v1): a soft-deleted transaction. Its lines
// stay (with reversing lines), it is hidden from registers, reports, balances
// and lists unless asked for (`status=deleted` or `includeDeleted=true`).
const txnStatuses = ['draft', 'posted', 'void', 'deleted'] as const;

const journalLineInputSchema = z.object({
  accountId: z.string().uuid(),
  debit: z.string().default('0'),
  credit: z.string().default('0'),
  description: z.string().optional(),
  quantity: z.string().optional(),
  unitPrice: z.string().optional(),
  isTaxable: z.boolean().default(false),
  taxRate: z.string().default('0'),
  taxAmount: z.string().default('0'),
  // ADR 0XX — optional per-line tag. Null means explicitly untagged;
  // undefined (omitted) means the caller is not sending a tag value.
  tagId: z.string().uuid().nullable().optional(),
  // Per-line name (U-58, je-names-v1): customer, vendor or other contact,
  // persisted on journal_lines.contact_id. Must belong to the tenant and
  // the company scope. On a journal entry, an A/R or A/P line requires one.
  contactId: z.string().uuid().nullable().optional(),
});

// A calendar date, YYYY-MM-DD (no time part, no impossible dates such as
// 2026-02-30): compared as strings against other dates.
const isoDateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Not a valid date');

export const createJournalEntrySchema = z.object({
  // YYYY-MM-DD: reverseOn is compared with it (U-61).
  txnDate: isoDateOnly,
  // Entry number (U-59, je-number-v1), at most 20 characters. Free text;
  // GET /journal-entries/next-number suggests the next numeric one.
  // Duplicates are allowed. On an edit, omitted keeps the stored number and
  // "" clears it.
  txnNumber: z.string().trim().max(20).optional(),
  memo: z.string().optional(),
  // Which report bases this entry affects. Default 'both' preserves prior
  // behavior (appears on cash- and accrual-basis reports alike).
  basis: z.enum(['cash', 'accrual', 'both']).default('both'),
  // Adjusting entry (U-60, je-adjusting-v1). On an edit, omitted keeps the
  // stored flag.
  isAdjusting: z.boolean().optional(),
  // Automatic reversing entry (U-61, je-reversing-v1): a date after txnDate.
  // Posting the entry also posts its reversal on this date, in the same
  // database transaction. On an edit: omitted keeps the reversal on its
  // stored date (re-posted there when the edit changes it), null removes
  // it, a date moves (or creates) it.
  reverseOn: isoDateOnly.nullable().optional(),
  lines: z.array(journalLineInputSchema).min(2, 'At least 2 lines required').max(MAX_LINES),
});

export const createExpenseSchema = z.object({
  txnDate: z.string().min(1),
  // Free-text reference (receipt #, confirmation #, check # for a
  // handwritten check recorded as an expense). Lands on
  // transactions.txn_number — searchable and sortable in the list.
  txnNumber: z.string().max(50).optional(),
  contactId: z.string().uuid().optional(),
  payFromAccountId: z.string().uuid(),
  expenseAccountId: z.string().uuid().optional(),
  amount: z.string().optional(),
  lines: z.array(z.object({
    expenseAccountId: z.string().uuid(),
    amount: z.string().min(1),
    description: z.string().optional(),
    // ADR 0XX: per-line tag.
    tagId: z.string().uuid().nullable().optional(),
    // Per-line customer (U-49), persisted on journal_lines.contact_id.
    contactId: z.string().uuid().nullable().optional(),
    // Billable to the line's customer (U-50); requires contactId.
    isBillable: z.boolean().optional(),
  })).max(MAX_LINES).optional(),
  memo: z.string().optional(),
  tags: z.array(z.string().uuid()).optional(),
});

export const createTransferSchema = z.object({
  txnDate: z.string().min(1),
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amount: z.string().min(1),
  memo: z.string().optional(),
});

const depositLineSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.string().min(1),
  description: z.string().optional(),
  tagId: z.string().uuid().nullable().optional(),
  // Per-line payee ("Received From"). Null means explicitly none; undefined
  // means the caller isn't sending one. Persisted on journal_lines.contact_id.
  contactId: z.string().uuid().nullable().optional(),
  // Deposit grouping (U-52, deposit-grouping-v1): the item this line deposits.
  // A customer payment / sales receipt / other entry sitting in Payments
  // Clearing (line account must be Payments Clearing, amount must equal the
  // item's undeposited amount exactly), or a vendor credit being refunded
  // (U-54, vendor-refund-v1: line account must be A/P, amount at most the
  // credit's open balance). Absent: a plain deposit line, as before.
  sourceTransactionId: z.string().uuid().optional(),
});

// Cash back (U-53, deposit-cashback-v1): part of the deposit kept as cash.
// The bank gets the line total less this amount; the account is debited.
export const depositCashBackSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.string().min(1),
  memo: z.string().max(1000).optional(),
});

export const createDepositSchema = z.object({
  txnDate: z.string().min(1),
  depositToAccountId: z.string().uuid(),
  lines: z.array(depositLineSchema).min(1).max(MAX_LINES),
  memo: z.string().optional(),
  cashBack: depositCashBackSchema.nullable().optional(),
  // true: every line amount must be an exact decimal string (at most 4
  // places, no exponent), else 400 VALIDATION_ERROR. The desktop app always
  // sends it; without it plain lines keep the old leniency.
  strictAmounts: z.boolean().optional(),
});

// Sales receipt (cash sale) and estimate lines. taxRate (a fraction,
// "0.0825"): sent, it is the line's rate; omitted, a taxable line takes the
// request company's default rate (U-122, sales-cents-v1).
const lineItemSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().optional(),
  quantity: z.string().min(1),
  unitPrice: z.string().min(1),
  isTaxable: z.boolean().default(false),
  taxRate: z.string().optional(),
  tagId: z.string().uuid().nullable().optional(),
});

// Invoice lines (U-123, invoice-fields-v1). itemId: an item of the company;
// it supplies the income account when accountId is omitted and the taxable
// flag when isTaxable is omitted. Without an item, accountId is required and
// an omitted isTaxable is false, as before. serviceDate: YYYY-MM-DD or null.
// quantity and unitPrice: decimal strings with at most 4 places, either may be
// negative; the amount is round2(quantity x unitPrice) (U-122).
// Pricing (U-129, invoice-pricing-v1): quantity omitted is 1; unitPrice
// omitted takes the client's price level, else the item's price. A discount
// item's line takes discountPercent (else the item's) or unitPrice (the
// amount off), not both; a subtotal item's line ignores both. Rules:
// packages/shared/fixtures/invoice-golden.json pricingRules.
export const invoiceLineSchema = z.object({
  accountId: z.string().uuid().optional(),
  itemId: z.string().uuid().nullable().optional(),
  description: z.string().max(4000).optional(),
  quantity: z.string().min(1).optional(),
  unitPrice: z.string().min(1).optional(),
  discountPercent: z.string().min(1).max(12).optional(),
  isTaxable: z.boolean().optional(),
  taxRate: z.string().optional(),
  tagId: z.string().uuid().nullable().optional(),
  serviceDate: isoDateOnly.nullable().optional(),
  // Billable cost (U-128, billable-costs-v1): the cost line (GET
  // /billable-costs sourceLineId) this line bills. accountId (the income
  // account its cost credits) is required (400
  // BILLABLE_INCOME_ACCOUNT_REQUIRED); itemId, quantity and unitPrice come
  // from the source (sending one is 400 BILLABLE_FIELDS_READONLY);
  // isTaxable defaults to true; serviceDate to the source date.
  billableSourceLineId: z.string().uuid().optional(),
  // A percent ("10" = 10 %), 0 to 1000, at most 4 places; omitted is 0. A
  // negative cost takes no markup (Q-P20z).
  markupPercent: z.string().min(1).max(12).optional(),
}).refine((l) => !!l.accountId || !!l.itemId || !!l.billableSourceLineId, { message: 'Each line needs an accountId or an itemId', path: ['accountId'] });

export const createCashSaleSchema = z.object({
  txnDate: z.string().min(1),
  contactId: z.string().uuid().optional(),
  depositToAccountId: z.string().uuid(),
  lines: z.array(lineItemSchema).min(1).max(MAX_LINES),
  memo: z.string().optional(),
  // Document number (U-111): typed, or omitted for the next from the company's
  // counter (GET /document-numbers/next). A duplicate of the same type in the
  // company is 409 DOCUMENT_NUMBER_IN_USE, or a warning with warnOnly: true.
  txnNumber: z.string().trim().max(50).optional(),
  warnOnly: z.boolean().optional(),
  // Waiting to be printed (U-113, GET /forms/print-queue). Create: default false;
  // edit: absent keeps it.
  printLater: z.boolean().optional(),
});

export const createInvoiceSchema = z.object({
  txnDate: z.string().min(1),
  // An explicit due date wins (stored as overridden). Omitted: computed from
  // the terms (invoice-terms-v1); on an edit, recomputed when the date or the
  // terms change and the stored one was not typed.
  dueDate: z.string().optional(),
  contactId: z.string().uuid(),
  // A code from GET /payment-terms (U-125, invoice-terms-v1). Omitted: the
  // client's default terms, else the company's. custom takes termsDays.
  paymentTerms: z.string().optional(),
  termsDays: z.number().int().min(0).max(3650).optional(),
  lines: z.array(invoiceLineSchema).min(1).max(MAX_LINES),
  // Internal memo; customerMessage is the text printed on the invoice (U-123).
  memo: z.string().optional(),
  customerMessage: z.string().max(4000).optional(),
  // The customer's PO number (U-123). On an edit, omitted keeps it and "" clears it.
  poNumber: z.string().trim().max(50).optional(),
  // Header tags (U-123): sent replaces the invoice's own tags; omitted keeps them.
  tagIds: z.array(z.string().uuid()).max(50).optional(),
  // Leave $0 lines off the printed invoice (U-123). Create: default false; edit: absent keeps.
  hideZeroLines: z.boolean().optional(),
  // invoice-edit-v1 (U-124): the invoice's updatedAt as last read; a mismatch
  // on PUT is 409 STALE (details.updatedAt) and nothing changes.
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  internalNotes: z.string().optional(),
  // Optional caller-supplied invoice number. When omitted, the server
  // auto-assigns the next number from the company counter. When provided
  // (manual override), the counter is left untouched and the number is
  // checked for collisions with other invoices in the company (409
  // DOCUMENT_NUMBER_IN_USE, or a warning with warnOnly: true; U-111).
  txnNumber: z.string().trim().max(50).optional(),
  warnOnly: z.boolean().optional(),
  // Waiting to be printed (U-113). Create: default false; edit: absent keeps it.
  printLater: z.boolean().optional(),
  // The invoice layout it prints with (U-130, invoice-layouts-v1): a layout
  // of the company (GET /company/invoice-layouts); null = the company
  // default. Create: default null; edit: absent keeps it.
  layoutId: z.string().uuid().nullable().optional(),
  // PUT only (U-128): billed costs this edit takes off the invoice. A cost
  // the invoice bills must be re-sent (by billableSourceLineId) or named
  // here, else 409 BILLABLE_LINES_MISSING.
  releaseBillableSourceLineIds: z.array(z.string().uuid()).max(MAX_LINES).optional(),
});

// POST /invoices/preview (U-129, invoice-pricing-v1): the create body, plus
// invoiceId when previewing an edit (that invoice's posted total leaves the
// client's balance before the new total is added).
export const previewInvoiceSchema = createInvoiceSchema.extend({
  invoiceId: z.string().uuid().optional(),
});

// Estimates keep the original invoice line shape (an account on every line).
export const createEstimateSchema = z.object({
  txnDate: z.string().min(1),
  dueDate: z.string().optional(),
  contactId: z.string().uuid(),
  paymentTerms: z.string().optional(),
  lines: z.array(lineItemSchema).min(1).max(MAX_LINES),
  memo: z.string().optional(),
  internalNotes: z.string().optional(),
});

// POST /invoices/:id/sent (U-126, invoice-sent-history-v1). recipients:
// email addresses for method email (never logged or audited); sentAt
// defaults to now.
export const recordDocumentSentSchema = z.object({
  method: z.enum(['printed', 'email', 'pdf']),
  recipients: z.array(z.string().trim().email().max(254)).max(50).optional(),
  sentAt: z.string().datetime({ offset: true }).optional(),
});

// POST /invoices/:id/email-later (U-127, invoice-email-v1): the message of a
// form email. Addresses are owner data (never logged or audited); subject
// and body are plain text (CR/LF are removed from the subject).
const emailAddressList = z.array(z.string().trim().email().max(254)).max(50);
export const invoiceEmailMessageSchema = z.object({
  to: emailAddressList.min(1),
  cc: emailAddressList.default([]),
  bcc: emailAddressList.default([]),
  subject: z.string().max(500).default(''),
  body: z.string().max(100_000).default(''),
});

/** Largest PDF an invoice email may attach, decoded (U-127, Q-P20q). */
export const INVOICE_EMAIL_PDF_MAX_BYTES = 10 * 1024 * 1024;

// POST /invoices/:id/email (U-127): the message plus the PDF the client
// made (base64 of application/pdf, at most 10 MB decoded) and its file name;
// outboxId sends a message of the Outbox and removes it in the same commit.
export const emailInvoiceSchema = invoiceEmailMessageSchema.extend({
  pdfFileName: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()#-]{0,115}\.pdf$/i,
    'pdfFileName: letters, digits, space . _ - ( ) #, ending in .pdf'),
  pdfBase64: z.string().min(1).max(Math.ceil(INVOICE_EMAIL_PDF_MAX_BYTES / 3) * 4 + 4),
  outboxId: z.string().uuid().optional(),
});

export const recordPaymentSchema = z.object({
  amount: z.string().min(1),
  txnDate: z.string().min(1),
  depositToAccountId: z.string().uuid(),
  memo: z.string().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  refNo: z.string().trim().max(100).optional(),
});

export const createCreditMemoSchema = z.object({
  txnDate: z.string().min(1),
  contactId: z.string().uuid(),
  lines: z.array(z.object({
    accountId: z.string().uuid(),
    description: z.string().optional(),
    quantity: z.string().min(1),
    unitPrice: z.string().min(1),
    tagId: z.string().uuid().nullable().optional(),
  })).min(1).max(MAX_LINES),
  memo: z.string().optional(),
  appliedToInvoiceId: z.string().uuid().optional(),
  // Document number (U-111): typed, or omitted for the next from the company's
  // counter (GET /document-numbers/next). A duplicate of the same type in the
  // company is 409 DOCUMENT_NUMBER_IN_USE, or a warning with warnOnly: true.
  txnNumber: z.string().trim().max(50).optional(),
  warnOnly: z.boolean().optional(),
  // Waiting to be printed (U-113, GET /forms/print-queue). Create: default false;
  // edit: absent keeps it.
  printLater: z.boolean().optional(),
});

export const createCustomerRefundSchema = z.object({
  txnDate: z.string().min(1),
  contactId: z.string().uuid(),
  refundFromAccountId: z.string().uuid(),
  amount: z.string().min(1),
  memo: z.string().optional(),
});

export const voidTransactionSchema = z.object({
  reason: z.string().min(1, 'Void reason is required'),
  // ap-edit-v1 (U-84): the transaction's updatedAt as last read; a mismatch
  // is 409 STALE (details.updatedAt) and nothing changes. Omitted: no check.
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

// DELETE /transactions/:id (txn-delete-v1). All optional; the closing-date
// password is taken out of the body by lockContextMiddleware before this runs.
export const deleteTransactionSchema = z.object({
  reason: z.string().max(500).optional(),
  overrideConfirmed: z.boolean().optional(),
  // ap-edit-v1 (U-84), as on void.
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

export const transactionSortKeys = ['date', 'type', 'number', 'payee', 'memo', 'category', 'amount', 'status', 'dueDate', 'balanceDue', 'invoiceStatus'] as const;
const invoiceStatuses = ['draft', 'sent', 'viewed', 'partial', 'paid', 'void'] as const;

export const transactionFiltersSchema = z.object({
  txnType: z.enum(txnTypes).optional(),
  status: z.enum(txnStatuses).optional(),
  // One contact, or a comma-joined set (the Invoices list's Customer filter).
  contactId: csvUuidSet,
  // Invoices list: keep these invoice statuses.
  invoiceStatus: csvEnumSet(invoiceStatuses),
  accountId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  /** Filter by transactions.source — the bulk-import success-link
   *  surface uses this to navigate to "transactions I just imported"
   *  via tags like 'accounting_power_import' / 'trial_balance_import'.
   *  Restricted to a sane character set so it can't be used to inject
   *  arbitrary strings — the source values are short enum-ish keys. */
  source: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).optional(),
  // Report-basis lens for the list: 'cash' → transactions.basis in (both,cash);
  // 'accrual' → (both,accrual). Omitted shows all bases.
  basis: z.enum(['cash', 'accrual']).optional(),
  // Adjusting-entry lens (U-60, je-adjusting-v1): 'include' (default) all,
  // 'exclude' leaves adjusting entries out, 'only' keeps just them.
  adjusting: z.enum(['include', 'exclude', 'only']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
  // Exact total (U-95, document-drafts-attach-v1): a decimal string with at
  // most 4 places, compared as SQL numeric (10.1 = 10.10, 10.01 differs).
  // Transactions without a total (journal entries, transfers) never match.
  amount: z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'A decimal string with at most 4 places').optional(),
  // Column sort for the transactions list. Whitelisted keys map to real
  // columns server-side; default is date desc.
  sortBy: z.enum(transactionSortKeys).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  // Max 10000 (was 500) so the list's "ALL" page-size option can fetch the
  // whole filtered set in one request for typical small-business volumes.
  limit: z.coerce.number().int().min(1).max(10000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // Soft-deleted transactions (txn-delete-v1) are left out unless asked for.
  includeDeleted: z.enum(['true', 'false']).optional(),
});

// GET /invoices: the transaction list filters plus sent (U-126): 'false' keeps
// invoices never sent (no send event, no sent date, never marked sent), in
// any status; 'true' the others.
export const invoiceListFiltersSchema = transactionFiltersSchema.extend({
  sent: z.enum(['true', 'false']).optional(),
});

// Transaction Report for a date range (GET /transactions/report.pdf). The
// same lenses as the transactions list, minus paging: the service caps the
// count itself and says so on the report.
export const transactionRangeReportSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  txnType: z.enum(txnTypes).optional(),
  contactId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  basis: z.enum(['cash', 'accrual']).optional(),
  includeVoid: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
  /** Which planned part to build (1-based); see GET /transactions/report-plan. */
  part: z.coerce.number().int().min(1).max(10000).optional(),
}).refine((v) => v.startDate <= v.endDate, { message: 'startDate must not be after endDate.' });

// Bulk edit on the transactions list: change Payee, Category, and/or Tag
// across the selected transactions. At least one mutation must be supplied.
//   - setPayeeContactId: null clears the payee; a uuid assigns it.
//   - setCategoryAccountId: re-points the (single) category line's account.
//     Only applied to single-category transactions server-side; splits skip.
//   - setTagId: null clears, a uuid sets the tag on the transaction's lines.
//   - tagAccountId: scopes a setTagId change to lines on this account only
//     (e.g. the filtered account), so a JE/split only tags the viewed line.
//   - moveFromAccountId + moveToAccountId (paired): re-point the lines posted
//     to moveFrom onto moveTo — a SOURCE-account move (clearing → loan), which
//     works on splits because the category lines are untouched.
export const bulkUpdateTransactionsSchema = z
  .object({
    txnIds: z.array(z.string().uuid()).min(1).max(500),
    setPayeeContactId: z.string().uuid().nullable().optional(),
    setCategoryAccountId: z.string().uuid().optional(),
    setTagId: z.string().uuid().nullable().optional(),
    tagAccountId: z.string().uuid().optional(),
    moveFromAccountId: z.string().uuid().optional(),
    moveToAccountId: z.string().uuid().optional(),
  })
  .refine(
    (v) => (v.moveFromAccountId === undefined) === (v.moveToAccountId === undefined),
    { message: 'moveFromAccountId and moveToAccountId must be supplied together.' },
  )
  .refine(
    (v) => v.moveFromAccountId === undefined || v.moveFromAccountId !== v.moveToAccountId,
    { message: 'The move source and destination accounts must differ.' },
  )
  .refine(
    (v) =>
      v.setPayeeContactId !== undefined ||
      v.setCategoryAccountId !== undefined ||
      v.setTagId !== undefined ||
      v.moveToAccountId !== undefined,
    { message: 'Specify at least one of payee, category, tag, or account move to change.' },
  );

// Tag schemas moved to schemas/tags.ts

// GET /billable-costs (U-128, billable-costs-v1). projectId is accepted and
// ignored until projects-v1.
export const billableCostFiltersSchema = z.object({
  contactId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
