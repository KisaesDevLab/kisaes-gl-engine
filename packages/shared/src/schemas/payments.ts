import { z } from 'zod';

const paymentMethods = ['check', 'cash', 'credit_card', 'ach', 'other'] as const;

export const receivePaymentSchema = z.object({
  customerId: z.string().uuid(),
  date: z.string().min(1),
  amount: z.string().min(1),
  depositTo: z.string().uuid(),
  paymentMethod: z.enum(paymentMethods).optional(),
  refNo: z.string().optional(),
  memo: z.string().optional(),
  applications: z.array(z.object({
    invoiceId: z.string().uuid(),
    amount: z.string().min(1),
  })).min(1),
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
