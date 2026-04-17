// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

const billStatuses = ['unpaid', 'partial', 'paid', 'overdue'] as const;
const paymentMethods = ['check', 'check_handwritten', 'ach', 'credit_card', 'cash', 'other'] as const;

const billLineSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().optional(),
  amount: z.string().min(1),
  itemId: z.string().uuid().optional(),
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
  lines: z.array(billLineSchema).min(1, 'At least one line is required'),
});

const vendorCreditLineSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().optional(),
  amount: z.string().min(1),
});

export const createVendorCreditSchema = z.object({
  contactId: z.string().uuid(),
  txnDate: z.string().min(1),
  vendorInvoiceNumber: z.string().max(100).optional(),
  memo: z.string().optional(),
  lines: z.array(vendorCreditLineSchema).min(1, 'At least one line is required'),
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
  method: z.enum(paymentMethods),
  printLater: z.boolean().optional(),
  memo: z.string().optional(),
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
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const payableBillsQuerySchema = z.object({
  contactId: z.string().uuid().optional(),
  dueOnOrBefore: z.string().optional(),
});
