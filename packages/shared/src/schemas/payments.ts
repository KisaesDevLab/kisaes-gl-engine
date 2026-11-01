// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

import { PAYMENT_METHODS } from '../constants/payment-methods.js';

// Whole cents (U-132, Q-P21g / Q-P21t): at most 2 decimal places. Trailing
// zeros up to 4 places ("100.0000", a stored amount echoed back) are the same
// whole-cent amount and are accepted; anything finer is 400 VALIDATION_ERROR.
export const WHOLE_CENTS_RE = /^\d{1,15}(\.\d{1,2}0{0,2})?$/;
export const wholeCentsAmount = z.string().regex(WHOLE_CENTS_RE, 'an amount with at most 2 decimal places');
// A stored balance echoed back (balanceDueExact): up to 4 places, may be negative.
const storedAmount = z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'a decimal amount with at most 4 places');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date YYYY-MM-DD');

export const receivePaymentSchema = z.object({
  customerId: z.string().uuid(),
  date: z.string().min(1),
  amount: wholeCentsAmount,
  depositTo: z.string().uuid(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  refNo: z.string().trim().max(100).optional(),
  memo: z.string().optional(),
  applications: z.array(z.object({
    invoiceId: z.string().uuid(),
    amount: wholeCentsAmount,
    // U-132: the invoice's balanceDueExact as read (optional for older
    // clients); a mismatch is 409 INVOICE_BALANCE_CHANGED.
    expectedBalanceDue: storedAmount.optional(),
    // U-134: an early-payment discount taken on top of amount.
    discountAmount: wholeCentsAmount.optional(),
    // U-133: the part of the balance written off.
    writeOffAmount: wholeCentsAmount.optional(),
  })),
  // U-133: the write-off account; default the company setting writeOffAccountId.
  writeOffAccountId: z.string().uuid().optional(),
  // U-134: the sales discount account; default the company setting salesDiscountAccountId.
  discountAccountId: z.string().uuid().optional(),
  // U-133: existing credits of the same client applied in this payment.
  creditApplications: z.array(z.object({
    sourcePaymentId: z.string().uuid(),
    invoiceId: z.string().uuid(),
    amount: wholeCentsAmount,
    expectedBalanceDue: storedAmount.optional(),
  })).optional(),
});

/** PUT /payments/:id (U-132): the receive body + the payment's updatedAt as read. */
export const updateCustomerPaymentSchema = receivePaymentSchema.extend({
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

/** POST /payments/preview (U-132): posts nothing. */
export const previewPaymentSchema = z.object({
  customerId: z.string().uuid(),
  date: isoDate,
  amount: wholeCentsAmount.nullable().optional(),
  depositTo: z.string().uuid().optional(),
  applications: z.array(z.object({
    invoiceId: z.string().uuid(),
    amount: wholeCentsAmount.nullable(),
    discountAmount: wholeCentsAmount.nullable().optional(),
    writeOffAmount: wholeCentsAmount.nullable().optional(),
  })).optional(),
  creditApplications: z.array(z.object({
    sourcePaymentId: z.string().uuid(),
    invoiceId: z.string().uuid(),
    amount: wholeCentsAmount.nullable(),
  })).optional(),
  editingPaymentId: z.string().uuid().optional(),
});

/** POST /payments/:id/apply (U-133): apply a payment's credit to invoices later; amount omitted fills. */
export const applyPaymentCreditSchema = z.object({
  date: isoDate,
  applications: z.array(z.object({
    invoiceId: z.string().uuid(),
    amount: wholeCentsAmount.optional(),
    expectedBalanceDue: storedAmount.optional(),
  })).min(1),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

/** POST /payments/unapply (U-132: validated, expectedUpdatedAt optional). */
export const unapplyPaymentSchema = z.object({
  paymentId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

/** POST /payments/:id/void (U-132). */
export const voidPaymentSchema = z.object({
  reason: z.string().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

/** POST /payments/:id/bounce (U-132, payment-bounce-v1). */
export const bouncePaymentSchema = z.object({
  date: isoDate,
  bankFeeAmount: wholeCentsAmount.optional(),
  bankFeeAccountId: z.string().uuid().optional(),
  bankFeeBankAccountId: z.string().uuid().optional(),
  memo: z.string().max(500).optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

export const listPaymentsQuerySchema = z.object({
  contactId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const createBankDepositSchema = z.object({
  depositToAccountId: z.string().uuid(),
  date: z.string().min(1),
  memo: z.string().optional(),
  lines: z.array(z.object({
    sourceTransactionId: z.string().uuid(),
    amount: z.string().min(1),
  })).min(1),
  otherFunds: z.array(z.object({
    accountId: z.string().uuid(),
    description: z.string().optional(),
    amount: z.string().min(1),
  })).optional(),
});
