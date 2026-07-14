// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

const txnTypes = ['invoice', 'customer_payment', 'cash_sale', 'expense', 'deposit', 'transfer', 'journal_entry', 'credit_memo', 'customer_refund'] as const;

// Cap on any journal-line / line-item array. 500 is well beyond any realistic
// invoice or deposit and bounds the input size so a malicious client can't
// push a 100k-line transaction that pins CPU on the validate + balance path.
const MAX_LINES = 500;
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
  // ADR 0XX — optional per-line tag. Null means explicitly untagged;
  // undefined (omitted) means the caller is not sending a tag value.
  tagId: z.string().uuid().nullable().optional(),
});

export const createJournalEntrySchema = z.object({
  txnDate: z.string().min(1),
  memo: z.string().optional(),
  // Which report bases this entry affects. Default 'both' preserves prior
  // behavior (appears on cash- and accrual-basis reports alike).
  basis: z.enum(['cash', 'accrual', 'both']).default('both'),
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
});

export const createDepositSchema = z.object({
  txnDate: z.string().min(1),
  depositToAccountId: z.string().uuid(),
  lines: z.array(depositLineSchema).min(1).max(MAX_LINES),
  memo: z.string().optional(),
});

const lineItemSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().optional(),
  quantity: z.string().min(1),
  unitPrice: z.string().min(1),
  isTaxable: z.boolean().default(false),
  taxRate: z.string().default('0'),
  tagId: z.string().uuid().nullable().optional(),
});

export const createCashSaleSchema = z.object({
  txnDate: z.string().min(1),
  contactId: z.string().uuid().optional(),
  depositToAccountId: z.string().uuid(),
  lines: z.array(lineItemSchema).min(1).max(MAX_LINES),
  memo: z.string().optional(),
});

export const createInvoiceSchema = z.object({
  txnDate: z.string().min(1),
  dueDate: z.string().optional(),
  contactId: z.string().uuid(),
  paymentTerms: z.string().optional(),
  lines: z.array(lineItemSchema).min(1).max(MAX_LINES),
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
    tagId: z.string().uuid().nullable().optional(),
  })).min(1).max(MAX_LINES),
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
  /** Filter by transactions.source — the bulk-import success-link
   *  surface uses this to navigate to "transactions I just imported"
   *  via tags like 'accounting_power_import' / 'trial_balance_import'.
   *  Restricted to a sane character set so it can't be used to inject
   *  arbitrary strings — the source values are short enum-ish keys. */
  source: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).optional(),
  // Report-basis lens for the list: 'cash' → transactions.basis in (both,cash);
  // 'accrual' → (both,accrual). Omitted shows all bases.
  basis: z.enum(['cash', 'accrual']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
  // Column sort for the transactions list. Whitelisted keys map to real
  // columns server-side; default is date desc.
  sortBy: z.enum(['date', 'type', 'number', 'payee', 'memo', 'category', 'amount', 'status']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Bulk edit on the transactions list: change Payee, Category, and/or Tag
// across the selected transactions. At least one mutation must be supplied.
//   - setPayeeContactId: null clears the payee; a uuid assigns it.
//   - setCategoryAccountId: re-points the (single) category line's account.
//     Only applied to single-category transactions server-side; splits skip.
//   - setTagId: null clears, a uuid sets the tag on the transaction's lines.
//   - tagAccountId: scopes a setTagId change to lines on this account only
//     (e.g. the filtered account), so a JE/split only tags the viewed line.
export const bulkUpdateTransactionsSchema = z
  .object({
    txnIds: z.array(z.string().uuid()).min(1).max(500),
    setPayeeContactId: z.string().uuid().nullable().optional(),
    setCategoryAccountId: z.string().uuid().optional(),
    setTagId: z.string().uuid().nullable().optional(),
    tagAccountId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      v.setPayeeContactId !== undefined ||
      v.setCategoryAccountId !== undefined ||
      v.setTagId !== undefined,
    { message: 'Specify at least one of payee, category, or tag to change.' },
  );

// Tag schemas moved to schemas/tags.ts
