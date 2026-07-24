// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

export type TxnType =
  | 'invoice'
  | 'customer_payment'
  | 'cash_sale'
  | 'expense'
  | 'deposit'
  | 'transfer'
  | 'journal_entry'
  | 'credit_memo'
  | 'customer_refund'
  | 'bill'
  | 'vendor_credit'
  | 'bill_payment'
  | 'daily_sales';

export type TxnStatus = 'draft' | 'posted' | 'void';

export type InvoiceStatus = 'draft' | 'sent' | 'viewed' | 'partial' | 'paid' | 'void';

export type BillStatus = 'unpaid' | 'partial' | 'paid' | 'overdue';

export interface JournalLine {
  id: string;
  tenantId: string;
  transactionId: string;
  accountId: string;
  debit: string;
  credit: string;
  description: string | null;
  quantity: string | null;
  unitPrice: string | null;
  isTaxable: boolean;
  taxRate: string;
  taxAmount: string;
  lineOrder: number;
  // ADR 0XX split-level tag. Null when untagged.
  tagId: string | null;
  // Per-line payee ("Received From"). Null when none.
  contactId: string | null;
  createdAt: string;
  // Denormalised display helpers populated by list endpoints.
  accountName?: string | null;
  accountNumber?: string | null;
}

export interface Transaction {
  id: string;
  tenantId: string;
  txnType: TxnType;
  txnNumber: string | null;
  txnDate: string;
  dueDate: string | null;
  status: TxnStatus;
  // Reporting basis: 'both' (default), 'cash', or 'accrual'.
  basis?: 'cash' | 'accrual' | 'both';
  contactId: string | null;
  memo: string | null;
  internalNotes: string | null;
  paymentTerms: string | null;
  subtotal: string | null;
  taxAmount: string;
  total: string | null;
  /**
   * List-endpoint display amount: `total` with a server-side fallback to
   * the transaction's journal-line magnitude (sum of debits) when total
   * is NULL — journal entries, transfers, and GL-imported entries carry
   * no document total. Present on list responses only.
   */
  displayTotal?: string | null;
  amountPaid: string;
  balanceDue: string | null;
  invoiceStatus: InvoiceStatus | null;
  billStatus: BillStatus | null;
  termsDays: number | null;
  creditsApplied: string | null;
  vendorInvoiceNumber: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  paidAt: string | null;
  isRecurring: boolean;
  recurringScheduleId: string | null;
  sourceEstimateId: string | null;
  appliedToInvoiceId: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: JournalLine[];
  // List endpoints enrich transactions with denormalised display helpers.
  // Both are absent on raw detail / insert payloads.
  contactName?: string | null;
  contactPhone?: string | null;
  aiCategorized?: 'ai' | 'manual' | 'rule' | string | null;
  daysOverdue?: number;
  // Detail endpoints for invoices may include a currency override.
  currency?: string | null;
}

export interface JournalLineInput {
  accountId: string;
  debit?: string;
  credit?: string;
  description?: string;
  quantity?: string;
  unitPrice?: string;
  isTaxable?: boolean;
  taxRate?: string;
  taxAmount?: string;
  // ADR 0XX: optional per-line tag. Undefined means "caller did not specify";
  // null means "explicitly untagged." The ledger service persists whichever
  // the caller passes; if neither is set the column is stored as NULL.
  tagId?: string | null;
  // Per-line payee ("Received From"). Persisted on journal_lines.contact_id.
  contactId?: string | null;
  // ADR 0XY §3.2 — when the line references an item, the ledger service
  // batch-loads items.default_tag_id and feeds it into the resolver so
  // item-default resolution runs server-side. Persisted on the journal
  // line too for reporting continuity.
  itemId?: string | null;
  // ADR 0XY §2 — bank-rule or AI sources populated by the caller. Never
  // persisted as-is; consumed by the resolver chain before the line is
  // stored. `explicitUserTagId` (the column above) still wins.
  bankRuleTagId?: string | null;
  aiSuggestedTagId?: string | null;
}

export interface CreateJournalEntryInput {
  txnDate: string;
  memo?: string;
  // Which report bases this entry affects: 'both' (default), 'cash', or
  // 'accrual'. Excludes the entry from the other basis's reports.
  basis?: 'cash' | 'accrual' | 'both';
  lines: JournalLineInput[];
}

export interface ExpenseLineItem {
  expenseAccountId: string;
  amount: string;
  description?: string;
  tagId?: string | null;
}

export interface CreateExpenseInput {
  txnDate: string;
  /** Free-text reference (receipt #, check #, confirmation #) → transactions.txn_number. */
  txnNumber?: string;
  contactId?: string;
  payFromAccountId: string;
  /** Single-line expense (backward compat) */
  expenseAccountId?: string;
  amount?: string;
  /** Multi-line expense */
  lines?: ExpenseLineItem[];
  memo?: string;
  tags?: string[];
}

export interface CreateTransferInput {
  txnDate: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  memo?: string;
}

export interface CreateDepositInput {
  txnDate: string;
  depositToAccountId: string;
  lines: Array<{
    accountId: string;
    amount: string;
    description?: string;
    tagId?: string | null;
    // Per-line payee ("Received From").
    contactId?: string | null;
  }>;
  memo?: string;
}

export interface BulkUpdateTransactionsInput {
  txnIds: string[];
  /** Null clears the payee; a contact id assigns it. */
  setPayeeContactId?: string | null;
  /** Re-points the single category line's account (split txns are skipped). */
  setCategoryAccountId?: string;
  /** Null clears the tag; a tag id sets it on the transaction's lines. */
  setTagId?: string | null;
  /**
   * Scopes a setTagId change (set OR clear) to journal lines on this account
   * only — e.g. the account the list is filtered by. Without it the tag
   * applies to every line, which is wrong for a split / journal entry where
   * only the viewed account's line should carry the tag.
   */
  tagAccountId?: string;
}

export interface BulkUpdateTransactionsResult {
  updated: number;
  /** Transactions left untouched, with the reason (split, void, locked…). */
  skipped: Array<{ id: string; reason: string }>;
}

export interface CreateCashSaleInput {
  txnDate: string;
  contactId?: string;
  depositToAccountId: string;
  lines: Array<{
    accountId: string;
    description?: string;
    quantity: string;
    unitPrice: string;
    isTaxable?: boolean;
    taxRate?: string;
    tagId?: string | null;
  }>;
  memo?: string;
}

export interface CreateInvoiceInput {
  txnDate: string;
  dueDate?: string;
  contactId: string;
  paymentTerms?: string;
  lines: Array<{
    accountId: string;
    description?: string;
    quantity: string;
    unitPrice: string;
    isTaxable?: boolean;
    taxRate?: string;
    tagId?: string | null;
  }>;
  memo?: string;
  internalNotes?: string;
  /** Optional manual invoice-number override; auto-assigned when omitted. */
  txnNumber?: string;
}

export interface RecordPaymentInput {
  amount: string;
  txnDate: string;
  depositToAccountId: string;
  memo?: string;
}

export interface CreateCreditMemoInput {
  txnDate: string;
  contactId: string;
  lines: Array<{
    accountId: string;
    description?: string;
    quantity: string;
    unitPrice: string;
    tagId?: string | null;
  }>;
  memo?: string;
  appliedToInvoiceId?: string;
}

export interface CreateCustomerRefundInput {
  txnDate: string;
  contactId: string;
  refundFromAccountId: string;
  amount: string;
  memo?: string;
}

export interface TransactionFilters {
  txnType?: TxnType;
  status?: TxnStatus;
  contactId?: string;
  accountId?: string;
  tagId?: string;
  /** Filter by transactions.source ('accounting_power_import' /
   *  'quickbooks_online_import' / 'trial_balance_import' / etc.). The
   *  bulk-import success links navigate here so the operator lands on
   *  the rows just posted instead of the unfiltered list. */
  source?: string;
  /** Report-basis lens: 'cash' keeps transactions that affect cash-basis
   *  reports (basis in both/cash); 'accrual' keeps both/accrual. Omitted =
   *  all. Mirrors the reports' basis at the transaction level. */
  basis?: 'cash' | 'accrual';
  startDate?: string;
  endDate?: string;
  search?: string;
  sortBy?: 'date' | 'type' | 'number' | 'payee' | 'memo' | 'category' | 'amount' | 'status';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// Tag type moved to types/tags.ts
