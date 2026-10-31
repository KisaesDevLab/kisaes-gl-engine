// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { PaymentMethod } from '../constants/payment-methods.js';

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
  | 'daily_sales'
  // Adjusting journal entry (TB module, rule TB3): a real GL journal
  // entry, firm-only CRUD, numbered AJE-001 per company per fiscal year.
  | 'aje';

export type TxnStatus = 'draft' | 'posted' | 'void' | 'deleted';

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
  // Item on the line (bill-lines-v1 on bills and vendor credits; invoices).
  itemId?: string | null;
  // Billable to the line's customer (U-50) and its billed state.
  isBillable?: boolean;
  billedStatus?: string | null;
  // The document this line settles (U-52 deposit grouping, U-54 vendor
  // refund); a deposit edit sends it back to keep the link (U-80).
  sourceTransactionId?: string | null;
  createdAt: string;
  // Denormalised display helpers populated by list endpoints.
  accountName?: string | null;
  accountNumber?: string | null;
  // Transaction-detail enrichment (GET /transactions/:id). Absent elsewhere.
  accountType?: string | null;
  accountDetailType?: string | null;
  tagName?: string | null;
  contactName?: string | null;
}

// The bank / credit-card account a transaction moved money through, derived
// from its journal lines. Transfers carry both ends.
export interface TransactionBankAccount {
  accountId: string;
  name: string;
  accountNumber: string | null;
  side: 'from' | 'to';
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
  // Bills (bill-terms-v1, bill-received-v1): early-payment discount terms,
  // the owner-override flags of the dates, and the received mark.
  discountPercent?: string | null;
  discountDays?: number | null;
  discountDate?: string | null;
  dueDateOverridden?: boolean;
  discountDateOverridden?: boolean;
  billReceived?: boolean;
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
  // Check fields — set on checks (txn_type 'expense') and bill payments.
  checkNumber?: number | null;
  printStatus?: string | null;
  payeeNameOnCheck?: string | null;
  payeeAddress?: string | null;
  printedMemo?: string | null;
  printedAt?: string | null;
  // How the payment was made + the payer/payee's reference for it. NULL on
  // anything entered before migration 0178 — see effectivePaymentMethod().
  paymentMethod?: PaymentMethod | null;
  referenceNumber?: string | null;
  // Provenance ('bank_feed', 'payroll_import', 'recurring', …).
  source?: string | null;
  sourceId?: string | null;
  ajeNumber?: number | null;
  /** Adjusting entry (U-60, migration 0224). */
  isAdjusting?: boolean;
  /** On an automatic reversing entry: the journal entry it reverses (U-61). */
  reversesTransactionId?: string | null;
  /** GET /transactions/:id of a journal entry with a live reversal (U-61): its id and date. */
  reversalTransactionId?: string | null;
  reverseOn?: string | null;
  companyId?: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: JournalLine[];
  // Transaction-detail enrichment (GET /transactions/:id). Absent elsewhere.
  tags?: Array<{ id: string; name: string }>;
  bankAccounts?: TransactionBankAccount[];
  appliedToInvoiceNumber?: string | null;
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
  // Billable to the line's contact (U-50). Persisted on
  // journal_lines.is_billable; billed_status becomes 'unbilled' when true
  // and stays NULL otherwise. Callers check that contactId is set.
  isBillable?: boolean;
  // The document this line settles (U-52 deposit grouping, U-54 vendor
  // refund). Persisted on journal_lines.source_transaction_id.
  sourceTransactionId?: string | null;
  // What the line is for inside its document, when the document needs to
  // tell lines apart: 'cash_back' on a deposit (U-53). Persisted on
  // journal_lines.line_role.
  lineRole?: string | null;
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
  // The day the line's work was done, YYYY-MM-DD (U-123). Persisted on
  // journal_lines.service_date.
  serviceDate?: string | null;
  // Invoice pricing (U-129): the percent a discount line used, and where
  // the line's price came from (input | item | price_level |
  // price_level_percent | none).
  discountPercent?: string | null;
  unitPriceSource?: string | null;
  // On an invoice's billable cost line (lineRole 'billable_cost') and its
  // markup line ('billable_markup'): the cost line it bills (U-128).
  // Persisted on journal_lines.billable_source_line_id.
  billableSourceLineId?: string | null;
}

export interface CreateJournalEntryInput {
  txnDate: string;
  /** Entry number, at most 20 characters (U-59). */
  txnNumber?: string;
  memo?: string;
  // Which report bases this entry affects: 'both' (default), 'cash', or
  // 'accrual'. Excludes the entry from the other basis's reports.
  basis?: 'cash' | 'accrual' | 'both';
  /** Adjusting entry (U-60). */
  isAdjusting?: boolean;
  /** Post an automatic reversing entry on this date, after txnDate (U-61). */
  reverseOn?: string | null;
  lines: JournalLineInput[];
}

export interface ExpenseLineItem {
  expenseAccountId: string;
  amount: string;
  description?: string;
  tagId?: string | null;
  /** Per-line customer (U-49) → journal_lines.contact_id. */
  contactId?: string | null;
  /** Billable to the line's customer (U-50); requires contactId. */
  isBillable?: boolean;
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
    // The item this line deposits (U-52) or the vendor credit it refunds (U-54).
    sourceTransactionId?: string;
  }>;
  memo?: string;
  // Cash kept back from the deposit (U-53).
  cashBack?: { accountId: string; amount: string; memo?: string } | null;
  // Every line amount an exact decimal string (the desktop app sends it).
  strictAmounts?: boolean;
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
  /**
   * Source-account move: re-points every journal line posted to
   * moveFromAccountId (the account the list is filtered by) onto
   * moveToAccountId — e.g. relocating transactions parked in a clearing
   * account to a loan account. Unlike setCategoryAccountId this moves the
   * MONEY/source side, so split transactions work (the splits are untouched).
   * Both must be supplied together. Lines cleared in a completed
   * reconciliation are skipped.
   */
  moveFromAccountId?: string;
  moveToAccountId?: string;
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
  /** Document number (U-111): typed, or the company's next when omitted. */
  txnNumber?: string;
  /** A duplicate number posts with a warning instead of 409 (U-111). */
  warnOnly?: boolean;
  /** Waiting to be printed (U-113). */
  printLater?: boolean;
}

export interface CreateInvoiceInput {
  txnDate: string;
  dueDate?: string;
  contactId: string;
  /** A PAYMENT_TERMS code (U-125); omitted: the client's, else the company's. */
  paymentTerms?: string;
  /** Net days for custom terms (U-125). */
  termsDays?: number;
  lines: Array<{
    /** Required unless itemId supplies the income account (U-123). */
    accountId?: string;
    itemId?: string | null;
    description?: string;
    /** Omitted: 1 (U-129). */
    quantity?: string;
    /** Omitted: the client's price level, else the item's price (U-129). */
    unitPrice?: string;
    /** A discount line's percent off (U-129). */
    discountPercent?: string;
    isTaxable?: boolean;
    taxRate?: string;
    tagId?: string | null;
    /** YYYY-MM-DD (U-123). */
    serviceDate?: string | null;
    /** A billable cost this line bills (U-128); accountId required, no itemId / quantity / unitPrice. */
    billableSourceLineId?: string;
    /** Markup percent on the cost ("10" = 10 %), 0 to 1000 (U-128). */
    markupPercent?: string;
  }>;
  memo?: string;
  internalNotes?: string;
  /** Printed on the invoice; memo stays internal (U-123). */
  customerMessage?: string;
  /** The customer's PO number (U-123). */
  poNumber?: string;
  /** Header tags (U-123): sent replaces, omitted keeps. */
  tagIds?: string[];
  /** Leave $0 lines off the printed invoice (U-123). */
  hideZeroLines?: boolean;
  /** updatedAt as last read; mismatch 409 STALE (U-124). */
  expectedUpdatedAt?: string;
  /** Optional manual invoice-number override; auto-assigned when omitted. */
  txnNumber?: string;
  /** A duplicate number posts with a warning instead of 409 (U-111). */
  warnOnly?: boolean;
  /** Waiting to be printed (U-113). */
  printLater?: boolean;
  /** The invoice layout it prints with (U-130); null = the company default; edit: absent keeps. */
  layoutId?: string | null;
  /** PUT only (U-128): billed costs this edit releases. */
  releaseBillableSourceLineIds?: string[];
  /** PUT only (invoice-pricing-lines-v1): the lines sent are every line the invoice keeps. */
  pricingLinesComplete?: boolean;
}

export interface RecordPaymentInput {
  amount: string;
  txnDate: string;
  depositToAccountId: string;
  memo?: string;
  paymentMethod?: PaymentMethod;
  refNo?: string;
}

// How a related transaction is tied to the one being viewed.
export type TransactionRelation =
  | 'payment'          // a payment applied to this bill / invoice
  | 'paid_bill'        // a bill this payment paid
  | 'paid_invoice'     // an invoice this payment / credit was applied to
  | 'credit'           // a vendor credit / credit memo / refund applied here
  | 'credited_bill';   // a bill this vendor credit was applied to

export interface RelatedTransaction {
  id: string;
  txnType: TxnType;
  txnNumber: string | null;
  txnDate: string;
  status: TxnStatus;
  contactName: string | null;
  total: string | null;
  relation: TransactionRelation;
  // Amount of this link (cash or credit applied). Null when the link carries
  // no amount of its own (legacy applied_to_invoice_id).
  appliedAmount: string | null;
  checkNumber: number | null;
  paymentMethod: PaymentMethod | null;
  referenceNumber: string | null;
  vendorInvoiceNumber: string | null;
  attachmentCount: number;
}

export interface RelatedTransactionsResult {
  related: RelatedTransaction[];
  // True when the chain was longer than the cap and the tail was dropped.
  truncated: boolean;
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
  /** Document number (U-111): typed, or the company's next when omitted. */
  txnNumber?: string;
  /** A duplicate number posts with a warning instead of 409 (U-111). */
  warnOnly?: boolean;
  /** Waiting to be printed (U-113). */
  printLater?: boolean;
}

export interface CreateCustomerRefundInput {
  txnDate: string;
  contactId: string;
  refundFromAccountId: string;
  amount: string;
  memo?: string;
}

export type TransactionSortKey = 'date' | 'type' | 'number' | 'payee' | 'memo' | 'category' | 'amount' | 'status' | 'dueDate' | 'balanceDue' | 'invoiceStatus';

export interface TransactionFilters {
  txnType?: TxnType;
  status?: TxnStatus;
  /** One contact, or several (the Invoices list's Customer filter). */
  contactId?: string | string[];
  /** Invoices list: keep these invoice statuses. */
  invoiceStatus?: InvoiceStatus[];
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
  /** Adjusting-entry lens (U-60): 'include' (default), 'exclude', 'only'. */
  adjusting?: 'include' | 'exclude' | 'only';
  startDate?: string;
  endDate?: string;
  search?: string;
  sortBy?: TransactionSortKey;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// Tag type moved to types/tags.ts

// ── Transaction activity (GET /transactions/:id/activity) ─────────
// One line of the transaction page's Activity card, assembled from the
// audit log, the bank-feed item the transaction came from, attachments,
// Close Review findings and client questions. Oldest first.
export type TransactionActivityKind =
  | 'imported' | 'suggested' | 'staged' | 'excluded'
  | 'created' | 'edited' | 'voided'
  | 'printed' | 'sent' | 'viewed' | 'paid'
  | 'attachment_added' | 'attachment_removed'
  | 'reviewed' | 'unreviewed'
  | 'finding' | 'finding_update'
  | 'question' | 'question_update';

export interface TransactionActivityEvent {
  at: string;
  kind: TransactionActivityKind;
  title: string;
  detail: string | null;
  /** Who did it: a user's name, "Client (…)" for portal actions, or null
   *  for the system (imports, bank sync, automatic steps). */
  actor: string | null;
}

export interface TransactionActivityResponse {
  events: TransactionActivityEvent[];
}
