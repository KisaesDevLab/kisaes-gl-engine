// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Transaction, TxnType } from '../types/transactions.js';
import { paymentMethodLabel, type PaymentMethod } from '../constants/payment-methods.js';

/**
 * What a transaction's header shows, per transaction type. One definition so
 * the transaction view (React) and the Transaction Report (server-rendered
 * PDF) always print the same facts — a bill names its vendor and the vendor's
 * invoice number, a check names its payee and check number, and so on.
 *
 * Everything here is pure: callers format money / dates for their medium.
 */

export const TXN_TYPE_LABELS: Record<TxnType, string> = {
  invoice: 'Invoice',
  customer_payment: 'Payment',
  cash_sale: 'Cash Sale',
  expense: 'Expense',
  deposit: 'Deposit',
  transfer: 'Transfer',
  journal_entry: 'Journal Entry',
  aje: 'Adjusting Journal Entry (AJE)',
  credit_memo: 'Credit Memo',
  customer_refund: 'Refund',
  bill: 'Bill',
  vendor_credit: 'Vendor Credit',
  bill_payment: 'Bill Payment',
  daily_sales: 'Daily Sales',
};

/** Any transaction-shaped object: only the type is required. */
export type TransactionDisplayInput = Pick<Transaction, 'txnType'> & Partial<Transaction>;
type DisplayTxn = TransactionDisplayInput;

function isCheck(txn: DisplayTxn): boolean {
  return txn.checkNumber != null || !!txn.printStatus;
}

export function txnTypeLabel(txn: DisplayTxn): string {
  // A check is an 'expense' row with check fields stamped on it.
  if (txn.txnType === 'expense' && isCheck(txn)) return 'Check';
  return TXN_TYPE_LABELS[txn.txnType] ?? txn.txnType;
}

/** What the transaction's contact is to us: Vendor, Customer, Payee… */
export function contactRoleLabel(txnType: TxnType): string {
  switch (txnType) {
    case 'bill':
    case 'vendor_credit':
    case 'bill_payment':
      return 'Vendor';
    case 'expense':
      return 'Payee';
    case 'invoice':
    case 'customer_payment':
    case 'cash_sale':
    case 'credit_memo':
    case 'customer_refund':
      return 'Customer';
    case 'deposit':
      return 'Received from';
    default:
      return 'Name';
  }
}

/**
 * Rows entered before payment_method existed carry NULL. A check number or a
 * print status (a queued check has no number yet) still tells us it was a
 * check; anything else is honestly unknown.
 */
export function effectivePaymentMethod(txn: DisplayTxn): PaymentMethod | null {
  if (txn.paymentMethod) return txn.paymentMethod;
  return isCheck(txn) ? 'check' : null;
}

const PRINT_STATUS_LABELS: Record<string, string> = {
  queue: 'Queued to print',
  printed: 'Printed',
  hand_written: 'Hand-written',
};

const SOURCE_LABELS: Record<string, string> = {
  bank_feed: 'Bank feed',
  payroll_import: 'Payroll import',
  recurring: 'Recurring schedule',
  manual: 'Manual entry',
  client_portal: 'Client portal',
  stripe_webhook: 'Stripe',
  ofx_import: 'OFX import',
};

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function termsLabel(txn: DisplayTxn): string | null {
  if (txn.paymentTerms) {
    const known = /^net_(\d+)$/.exec(txn.paymentTerms);
    if (known) return `Net ${known[1]}`;
    if (txn.paymentTerms === 'custom' && txn.termsDays != null) return `Net ${txn.termsDays}`;
    return titleCase(txn.paymentTerms);
  }
  return txn.termsDays != null ? `Net ${txn.termsDays}` : null;
}

/**
 * The document's own identifier: "#BILL-00012", "Check #1042", "Ref 88123".
 * Bill payments are posted without a txn_number, so the check number or
 * reference stands in. Returns '' when there is nothing to show.
 */
export function transactionNumberLabel(txn: DisplayTxn): string {
  if (txn.txnType === 'aje' && txn.ajeNumber != null) {
    return `AJE-${String(txn.ajeNumber).padStart(3, '0')}`;
  }
  if (txn.txnNumber) return `#${txn.txnNumber}`;
  if (txn.checkNumber != null) return `Check #${txn.checkNumber}`;
  if (txn.referenceNumber) return `Ref ${txn.referenceNumber}`;
  return '';
}

/** "Bill #BILL-00012", "Bill Payment Check #1042", "Transfer". */
export function transactionTitle(txn: DisplayTxn): string {
  const label = txnTypeLabel(txn);
  const num = transactionNumberLabel(txn);
  // "Check Check #1042" reads badly — the number label already says it.
  if (label === 'Check' && num.startsWith('Check #')) return num;
  return num ? `${label} ${num}` : label;
}

export type TransactionFieldKind = 'text' | 'money' | 'date' | 'datetime' | 'multiline';

export interface TransactionHeaderField {
  key: string;
  label: string;
  /** Raw value — money as a decimal string, dates as ISO strings. */
  value: string;
  kind: TransactionFieldKind;
}

const DOC_NUMBER_LABELS: Partial<Record<TxnType, string>> = {
  bill: 'Bill #',
  vendor_credit: 'Credit #',
  invoice: 'Invoice #',
  expense: 'Ref #',
  journal_entry: 'Entry #',
  aje: 'Entry #',
};

const BANK_LABELS: Partial<Record<TxnType, string>> = {
  bill_payment: 'Paid from',
  expense: 'Paid from',
  customer_refund: 'Refunded from',
  customer_payment: 'Deposited to',
  cash_sale: 'Deposited to',
  deposit: 'Deposited to',
};

function positive(value: string | null | undefined): boolean {
  return !!value && Number(value) > 0;
}

/**
 * The header facts worth printing for this transaction, in display order.
 * A field appears only when it has a value, so callers can map blindly.
 */
export function buildTransactionHeaderFields(txn: DisplayTxn): TransactionHeaderField[] {
  const fields: TransactionHeaderField[] = [];
  const add = (key: string, label: string, value: string | number | null | undefined, kind: TransactionFieldKind = 'text') => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text) fields.push({ key, label, value: text, kind });
  };
  const type = txn.txnType;
  const isAp = type === 'bill' || type === 'vendor_credit';
  const isPayment = type === 'bill_payment' || type === 'customer_payment' || type === 'expense' || type === 'customer_refund';

  add('contact', contactRoleLabel(type), txn.contactName);
  add('txnNumber', DOC_NUMBER_LABELS[type] ?? 'Number', txn.txnNumber);
  if (type === 'aje' && txn.ajeNumber != null) add('ajeNumber', 'AJE #', `AJE-${String(txn.ajeNumber).padStart(3, '0')}`);
  if (isAp) add('vendorInvoiceNumber', 'Vendor invoice #', txn.vendorInvoiceNumber);

  add('txnDate', 'Date', txn.txnDate, 'date');
  if (type === 'bill' || type === 'invoice') {
    add('terms', 'Terms', termsLabel(txn));
    add('dueDate', 'Due', txn.dueDate, 'date');
  }

  if (isPayment) {
    add('paymentMethod', 'Payment method', paymentMethodLabel(effectivePaymentMethod(txn)));
    add('referenceNumber', 'Ref #', txn.referenceNumber);
  }
  if (isCheck(txn)) {
    add('checkNumber', 'Check #', txn.checkNumber);
    add('printStatus', 'Check status', txn.printStatus ? (PRINT_STATUS_LABELS[txn.printStatus] ?? titleCase(txn.printStatus)) : null);
    // Only worth a line when it differs from the contact already shown.
    if (txn.payeeNameOnCheck && txn.payeeNameOnCheck !== txn.contactName) {
      add('payeeNameOnCheck', 'Payee on check', txn.payeeNameOnCheck);
    }
    add('payeeAddress', 'Mailing address', txn.payeeAddress, 'multiline');
    add('printedMemo', 'Memo on check', txn.printedMemo);
    add('printedAt', 'Printed', txn.printedAt, 'datetime');
  }

  const banks = txn.bankAccounts ?? [];
  if (type === 'transfer') {
    for (const b of banks) add(`bank-${b.side}`, b.side === 'from' ? 'From account' : 'To account', bankLabel(b));
  } else if (BANK_LABELS[type] && banks[0]) {
    add('bankAccount', BANK_LABELS[type]!, bankLabel(banks[0]));
  }

  if (txn.appliedToInvoiceNumber) add('appliedToInvoice', 'Applied to invoice', `#${txn.appliedToInvoiceNumber}`);

  if (txn.subtotal && positive(txn.taxAmount)) {
    add('subtotal', 'Subtotal', txn.subtotal, 'money');
    add('taxAmount', 'Tax', txn.taxAmount, 'money');
  }
  add('total', 'Total', txn.total, 'money');
  if (type === 'bill' || type === 'invoice') {
    if (positive(txn.amountPaid)) add('amountPaid', 'Amount paid', txn.amountPaid, 'money');
    if (positive(txn.creditsApplied)) add('creditsApplied', 'Credits applied', txn.creditsApplied, 'money');
    add('balanceDue', 'Balance due', txn.balanceDue, 'money');
  } else if (type === 'vendor_credit') {
    add('balanceDue', 'Credit remaining', txn.balanceDue, 'money');
  }

  if ((type === 'journal_entry' || type === 'aje') && txn.basis && txn.basis !== 'both') {
    add('basis', 'Basis', txn.basis === 'cash' ? 'Cash only' : 'Accrual only');
  }
  if (txn.tags?.length) add('tags', 'Tags', txn.tags.map((t) => t.name).join(', '));
  add('memo', 'Memo', txn.memo, 'multiline');
  add('internalNotes', 'Internal notes', txn.internalNotes, 'multiline');
  if (txn.source && txn.source !== 'manual') add('source', 'Source', SOURCE_LABELS[txn.source] ?? titleCase(txn.source));
  if (txn.status === 'void') {
    add('voidReason', 'Void reason', txn.voidReason, 'multiline');
    add('voidedAt', 'Voided', txn.voidedAt, 'datetime');
  }
  return fields;
}

function bankLabel(b: { name: string; accountNumber: string | null }): string {
  return b.accountNumber ? `${b.name} (${b.accountNumber})` : b.name;
}
