import { z } from 'zod';

const txnTypes = ['invoice', 'customer_payment', 'cash_sale', 'expense', 'deposit', 'transfer', 'journal_entry', 'credit_memo', 'customer_refund'] as const;
const txnStatuses = ['draft', 'posted', 'void'] as const;

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
});

export const createJournalEntrySchema = z.object({
  txnDate: z.string().min(1),
  memo: z.string().optional(),
  lines: z.array(journalLineInputSchema).min(2, 'At least 2 lines required'),
});

export const createExpenseSchema = z.object({
  txnDate: z.string().min(1),
  contactId: z.string().uuid().optional(),
  payFromAccountId: z.string().uuid(),
  expenseAccountId: z.string().uuid().optional(),
  amount: z.string().optional(),
  lines: z.array(z.object({
    expenseAccountId: z.string().uuid(),
    amount: z.string().min(1),
    description: z.string().optional(),
  })).optional(),
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
});

export const createDepositSchema = z.object({
  txnDate: z.string().min(1),
  depositToAccountId: z.string().uuid(),
  lines: z.array(depositLineSchema).min(1),
  memo: z.string().optional(),
});

const lineItemSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().optional(),
  quantity: z.string().min(1),
  unitPrice: z.string().min(1),
  isTaxable: z.boolean().default(false),
  taxRate: z.string().default('0'),
});

export const createCashSaleSchema = z.object({
  txnDate: z.string().min(1),
  contactId: z.string().uuid().optional(),
  depositToAccountId: z.string().uuid(),
  lines: z.array(lineItemSchema).min(1),
  memo: z.string().optional(),
});

export const createInvoiceSchema = z.object({
  txnDate: z.string().min(1),
  dueDate: z.string().optional(),
  contactId: z.string().uuid(),
  paymentTerms: z.string().optional(),
  lines: z.array(lineItemSchema).min(1),
  memo: z.string().optional(),
  internalNotes: z.string().optional(),
});

export const recordPaymentSchema = z.object({
  amount: z.string().min(1),
  txnDate: z.string().min(1),
  depositToAccountId: z.string().uuid(),
  memo: z.string().optional(),
});

export const createCreditMemoSchema = z.object({
  txnDate: z.string().min(1),
  contactId: z.string().uuid(),
  lines: z.array(z.object({
    accountId: z.string().uuid(),
    description: z.string().optional(),
    quantity: z.string().min(1),
    unitPrice: z.string().min(1),
  })).min(1),
  memo: z.string().optional(),
  appliedToInvoiceId: z.string().uuid().optional(),
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
});

export const transactionFiltersSchema = z.object({
  txnType: z.enum(txnTypes).optional(),
  status: z.enum(txnStatuses).optional(),
  contactId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Tag schemas moved to schemas/tags.ts
