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
  | 'bill_payment';

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
  createdAt: string;
}

export interface Transaction {
  id: string;
  tenantId: string;
  txnType: TxnType;
  txnNumber: string | null;
  txnDate: string;
  dueDate: string | null;
  status: TxnStatus;
  contactId: string | null;
  memo: string | null;
  internalNotes: string | null;
  paymentTerms: string | null;
  subtotal: string | null;
  taxAmount: string;
  total: string | null;
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
}

export interface CreateJournalEntryInput {
  txnDate: string;
  memo?: string;
  lines: JournalLineInput[];
}

export interface ExpenseLineItem {
  expenseAccountId: string;
  amount: string;
  description?: string;
}

export interface CreateExpenseInput {
  txnDate: string;
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
  }>;
  memo?: string;
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
  }>;
  memo?: string;
  internalNotes?: string;
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
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// Tag type moved to types/tags.ts
