export type PaymentMethod = 'check' | 'cash' | 'credit_card' | 'ach' | 'other';

export interface ReceivePaymentInput {
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
  }>;
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
