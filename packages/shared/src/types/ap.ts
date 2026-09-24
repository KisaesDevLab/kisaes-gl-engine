// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Accounts Payable types: bills, vendor credits, bill payments

import type { BillStatus, JournalLine } from './transactions.js';
import type { BILL_PAYMENT_METHODS } from '../constants/payment-methods.js';

export type BillPaymentMethod = (typeof BILL_PAYMENT_METHODS)[number];

export interface BillLineInput {
  accountId: string;
  description?: string;
  amount: string;
  itemId?: string;
  tagId?: string | null;
}

export interface CreateBillInput {
  contactId: string;
  txnDate: string;
  dueDate?: string;
  paymentTerms?: string;
  termsDays?: number;
  vendorInvoiceNumber?: string;
  memo?: string;
  internalNotes?: string;
  lines: BillLineInput[];
}

export interface VendorCreditLineInput {
  accountId: string;
  description?: string;
  amount: string;
  tagId?: string | null;
}

export interface CreateVendorCreditInput {
  contactId: string;
  txnDate: string;
  vendorInvoiceNumber?: string;
  memo?: string;
  lines: VendorCreditLineInput[];
}

export interface BillPaymentBillSelection {
  billId: string;
  amount: string;
}

export interface BillPaymentCreditApplication {
  creditId: string;
  billId: string;
  amount: string;
}

export interface PayBillsInput {
  bankAccountId: string;
  txnDate: string;
  method: BillPaymentMethod;
  printLater?: boolean;
  memo?: string;
  /** ACH trace / card auth / confirmation number; stored on each payment. */
  referenceNumber?: string;
  /** Memo line printed on the check face; blank defaults to the bill refs. */
  printedMemo?: string;
  bills: BillPaymentBillSelection[];
  credits?: BillPaymentCreditApplication[];
}

export interface BillSummary {
  id: string;
  txnNumber: string | null;
  contactId: string | null;
  contactName: string | null;
  txnDate: string;
  dueDate: string | null;
  vendorInvoiceNumber: string | null;
  total: string | null;
  amountPaid: string | null;
  creditsApplied: string | null;
  balanceDue: string | null;
  billStatus: BillStatus | null;
  paymentTerms: string | null;
  daysOverdue: number;
  memo: string | null;
}

export interface PayableBillsResponse {
  bills: BillSummary[];
  credits: VendorCreditSummary[];
}

export interface VendorCreditSummary {
  id: string;
  txnNumber: string | null;
  contactId: string | null;
  contactName: string | null;
  txnDate: string;
  total: string | null;
  balanceDue: string | null;
  memo: string | null;
}

export interface BillPaymentApplicationRow {
  id: string;
  paymentId: string;
  billId: string;
  amount: string;
  createdAt: string;
}

export interface VendorCreditApplicationRow {
  id: string;
  paymentId: string;
  creditId: string;
  billId: string;
  amount: string;
  createdAt: string;
}

export interface ApAgingSummaryRow {
  contactId: string;
  contactName: string;
  current: string;
  bucket1to30: string;
  bucket31to60: string;
  bucket61to90: string;
  bucketOver90: string;
  total: string;
}

export interface ApAgingDetailRow {
  contactId: string;
  contactName: string;
  billId: string;
  txnNumber: string | null;
  vendorInvoiceNumber: string | null;
  txnDate: string;
  dueDate: string | null;
  daysOverdue: number;
  total: string;
  paid: string;
  balance: string;
  bucket: 'current' | '1_30' | '31_60' | '61_90' | 'over_90';
}

export type BillSortKey = 'number' | 'vendor' | 'vendorInvoiceNumber' | 'date' | 'dueDate' | 'status' | 'total' | 'balance';

export interface BillFilters {
  contactId?: string;
  /** One status or a set. A set containing 'overdue' also matches unpaid/partial bills past due. */
  billStatus?: BillStatus | BillStatus[];
  sortBy?: BillSortKey;
  sortDir?: 'asc' | 'desc';
  startDate?: string;
  endDate?: string;
  dueOnOrBefore?: string;
  overdueOnly?: boolean;
  tagId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// Re-export the journal line type so consumers of AP types can read returned bills
export type { JournalLine };

// ─── AP Bill Capture (migration 0175) ───────────────────────────────

export type BillCaptureStatus = 'received' | 'processing' | 'ready' | 'failed' | 'entered' | 'discarded';
export type BillCaptureSource = 'staff' | 'portal';
export type BillLinesMode = 'detailed' | 'single';
export type ExtractionSkippedReason = 'ai_disabled' | 'ai_function_disabled' | 'ai_consent_blocked' | 'unsupported_type';

export interface NewVendorInput {
  displayName: string;
  billingLine1?: string | null;
  billingLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZip?: string | null;
  billingCountry?: string;
  email?: string | null;
  phone?: string | null;
  defaultExpenseAccountId?: string | null;
}

export interface EnterBillCaptureInput extends Omit<CreateBillInput, 'contactId'> {
  contactId?: string;
  newVendor?: NewVendorInput;
  linesMode: BillLinesMode;
  overrideDuplicate?: boolean;
}

/** What the OCR pipeline read from the document (subset of the API's BillOcrResult). */
export interface BillCaptureExtraction {
  vendor: string | null;
  vendorInvoiceNumber: string | null;
  billDate: string | null;
  dueDate: string | null;
  paymentTerms: string | null;
  total: string | null;
  subtotal: string | null;
  tax: string | null;
  lineItems: Array<{ description: string | null; amount: string | null; quantity: string | null }>;
  notes: string | null;
  confidence: number;
  contactId: string | null;
  defaultExpenseAccountId: string | null;
  qualityWarnings: string[];
  status?: 'ok' | 'ocr_only';
  vendorAddress?: {
    line1: string | null; line2: string | null; city: string | null;
    state: string | null; zip: string | null;
  } | null;
}

export interface BillCaptureDuplicate {
  transactionId: string;
  txnNumber: string | null;
  matchedOn: 'invoice_number' | 'total_date';
}

export interface BillCaptureSummary {
  id: string;
  fileName: string;
  mimeType: string | null;
  source: BillCaptureSource;
  status: BillCaptureStatus;
  createdAt: string;
  enteredAt: string | null;
  vendorName: string | null;
  contactId: string | null;
  contactName: string | null;
  suggestedContactId: string | null;
  suggestedContactName: string | null;
  total: string | null;
  billDate: string | null;
  vendorInvoiceNumber: string | null;
  confidence: number | null;
  isDuplicate: boolean;
  duplicateOfTransactionId: string | null;
  billId: string | null;
  billTxnNumber: string | null;
  billVoided: boolean;
  extractionSkippedReason: ExtractionSkippedReason | null;
  extractionError: string | null;
  uploadedByName: string | null;
}

export interface BillCaptureVendorDefaults {
  contactId: string;
  displayName: string;
  defaultExpenseAccountId: string | null;
  defaultTagId: string | null;
  defaultPaymentTerms: string | null;
  defaultTermsDays: number | null;
  billLinesMode: BillLinesMode | null;
}

export interface BillCaptureDetail extends BillCaptureSummary {
  attachmentId: string;
  extraction: BillCaptureExtraction | null;
  duplicate: BillCaptureDuplicate | null;
  vendorCandidates: Array<{ id: string; displayName: string }>;
  vendorDefaults: BillCaptureVendorDefaults | null;
}

export interface BillCaptureListResponse {
  captures: BillCaptureSummary[];
  total: number;
  counts: Record<BillCaptureStatus, number>;
}

export type PortalBillCaptureStatus = 'received' | 'processing' | 'entered' | 'closed';

export interface PortalBillCaptureRow {
  id: string;
  fileName: string;
  status: PortalBillCaptureStatus;
  createdAt: string;
  enteredAt: string | null;
}
