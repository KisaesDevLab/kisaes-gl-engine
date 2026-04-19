// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Accounts Payable types: bills, vendor credits, bill payments

import type { BillStatus, JournalLine } from './transactions.js';

export type BillPaymentMethod = 'check' | 'check_handwritten' | 'ach' | 'credit_card' | 'cash' | 'other';

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

export interface BillFilters {
  contactId?: string;
  billStatus?: BillStatus;
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
