// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { PaymentMethod } from '../constants/payment-methods.js';

export interface ReceivePaymentInput {
  /** U-136: the pending bank-feed line this payment is (feed-customer-payments-v1). */
  bankFeedItemId?: string;
  customerId: string;
  date: string;
  amount: string;
  depositTo: string;
  paymentMethod?: PaymentMethod;
  refNo?: string;
  memo?: string;
  applications: Array<{
    invoiceId: string;
    amount: string;
    /** U-132: the invoice's balanceDueExact as read; a mismatch is 409 INVOICE_BALANCE_CHANGED. */
    expectedBalanceDue?: string;
    /** U-134: early-payment discount, on top of amount. */
    discountAmount?: string;
    /** U-133: the part of the balance written off. */
    writeOffAmount?: string;
  }>;
  /** U-133: default the company setting writeOffAccountId. */
  writeOffAccountId?: string;
  /** U-134: default the company setting salesDiscountAccountId. */
  discountAccountId?: string;
  /** U-133: existing credits of the same client applied in this payment. */
  creditApplications?: Array<{ sourcePaymentId: string; invoiceId: string; amount: string; expectedBalanceDue?: string }>;
  /** U-135: hold the amount as a customer deposit. */
  holdAsDeposit?: boolean;
}

/** POST /payments/:id/apply (U-133). */
export interface ApplyPaymentCreditInput {
  date: string;
  applications: Array<{ invoiceId: string; amount?: string; expectedBalanceDue?: string }>;
  expectedUpdatedAt?: string;
}

/** POST /payments/preview (U-132, receive-payment-v1). */
export interface PreviewPaymentInput {
  customerId: string;
  date: string;
  amount?: string | null;
  depositTo?: string;
  /** Omitted: auto (oldest first). amount null: fill. */
  applications?: Array<{ invoiceId: string; amount: string | null; discountAmount?: string | null; writeOffAmount?: string | null }>;
  creditApplications?: Array<{ sourcePaymentId: string; invoiceId: string; amount: string | null }>;
  editingPaymentId?: string;
  holdAsDeposit?: boolean;
}

/** POST /payments/:id/bounce (U-132, payment-bounce-v1). */
export interface BouncePaymentInput {
  date: string;
  bankFeeAmount?: string;
  bankFeeAccountId?: string;
  bankFeeBankAccountId?: string;
  memo?: string;
  expectedUpdatedAt?: string;
}

export interface ListPaymentsQuery {
  contactId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface PaymentApplication {
  id: string;
  tenantId: string;
  paymentId: string;
  invoiceId: string;
  amount: string;
  createdAt: string;
}

export interface PendingDepositItem {
  transactionId: string;
  txnType: string;
  date: string;
  customerName: string | null;
  refNo: string | null;
  paymentMethod: string | null;
  amount: number;
}

// CreateDepositInput is in types/transactions.ts — this extends with deposit-line tracking

export interface DepositLine {
  id: string;
  depositId: string;
  sourceTransactionId: string;
  amount: string;
  sortOrder: number;
  createdAt: string;
}
