// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  buildTransactionHeaderFields, effectivePaymentMethod, transactionTitle, txnTypeLabel, contactRoleLabel,
  type TransactionDisplayInput,
} from './transaction-display.js';

const fieldsOf = (txn: TransactionDisplayInput) =>
  Object.fromEntries(buildTransactionHeaderFields(txn).map((f) => [f.label, f.value]));

describe('transaction display', () => {
  it('a bill names its vendor, the vendor invoice number, terms and what is still owed', () => {
    const bill: TransactionDisplayInput = {
      txnType: 'bill', txnNumber: 'BILL-00012', txnDate: '2026-09-10', dueDate: '2026-09-28',
      contactName: 'Spire', vendorInvoiceNumber: '4394722222', paymentTerms: 'net_30',
      total: '68.9500', amountPaid: '0', balanceDue: '68.9500',
    };
    expect(transactionTitle(bill)).toBe('Bill #BILL-00012');
    expect(fieldsOf(bill)).toMatchObject({
      Vendor: 'Spire', 'Bill #': 'BILL-00012', 'Vendor invoice #': '4394722222',
      Terms: 'Net 30', Due: '2026-09-28', Total: '68.9500', 'Balance due': '68.9500',
    });
    expect(fieldsOf(bill)).not.toHaveProperty('Amount paid');
  });

  it('a bill payment shows how it was paid, the reference and the bank account', () => {
    const payment: TransactionDisplayInput = {
      txnType: 'bill_payment', txnDate: '2026-09-28', contactName: 'Spire', total: '68.95',
      paymentMethod: 'ach', referenceNumber: 'ACH-7781',
      bankAccounts: [{ accountId: 'a', name: 'Cash in Bank - Operating', accountNumber: '1060', side: 'from' }],
    };
    // Bill payments are posted without a txn_number — the reference stands in.
    expect(transactionTitle(payment)).toBe('Bill Payment Ref ACH-7781');
    expect(fieldsOf(payment)).toMatchObject({
      Vendor: 'Spire', 'Payment method': 'ACH', 'Ref #': 'ACH-7781', 'Paid from': 'Cash in Bank - Operating (1060)',
    });
  });

  it('a check is an expense with a check number: payee, check #, status, memo on the check', () => {
    const check: TransactionDisplayInput = {
      txnType: 'expense', txnDate: '2026-09-01', contactName: 'City Water', total: '40.00',
      checkNumber: 1042, printStatus: 'printed', payeeNameOnCheck: 'City of Monett Water Dept', printedMemo: 'Acct 00-4471-A',
    };
    expect(txnTypeLabel(check)).toBe('Check');
    expect(transactionTitle(check)).toBe('Check #1042');
    expect(fieldsOf(check)).toMatchObject({
      Payee: 'City Water', 'Payment method': 'Check', 'Check #': '1042', 'Check status': 'Printed',
      'Payee on check': 'City of Monett Water Dept', 'Memo on check': 'Acct 00-4471-A',
    });
  });

  it('does not repeat the payee when the check was made out to the contact', () => {
    const check: TransactionDisplayInput = { txnType: 'expense', contactName: 'City Water', payeeNameOnCheck: 'City Water', checkNumber: 7 };
    expect(fieldsOf(check)).not.toHaveProperty('Payee on check');
  });

  describe('effectivePaymentMethod', () => {
    it('prefers the stored method', () => {
      expect(effectivePaymentMethod({ txnType: 'bill_payment', paymentMethod: 'ach', checkNumber: 5 })).toBe('ach');
    });
    it('reads a pre-0178 row with a check number as a check', () => {
      expect(effectivePaymentMethod({ txnType: 'bill_payment', paymentMethod: null, checkNumber: 1042 })).toBe('check');
    });
    it('reads a queued check — no number yet — as a check', () => {
      expect(effectivePaymentMethod({ txnType: 'bill_payment', paymentMethod: null, checkNumber: null, printStatus: 'queue' })).toBe('check');
    });
    it('does not guess otherwise', () => {
      expect(effectivePaymentMethod({ txnType: 'bill_payment' })).toBeNull();
    });
  });

  it('a transfer shows both ends', () => {
    const transfer: TransactionDisplayInput = {
      txnType: 'transfer', txnDate: '2026-09-01', total: '500',
      bankAccounts: [
        { accountId: 'a', name: 'Checking', accountNumber: null, side: 'from' },
        { accountId: 'b', name: 'Savings', accountNumber: '1070', side: 'to' },
      ],
    };
    expect(fieldsOf(transfer)).toMatchObject({ 'From account': 'Checking', 'To account': 'Savings (1070)' });
  });

  it('an AJE is titled by its AJE number; a cash-only entry says so', () => {
    const aje: TransactionDisplayInput = { txnType: 'aje', ajeNumber: 3, txnDate: '2026-12-31', basis: 'cash' };
    expect(transactionTitle(aje)).toBe('Adjusting Journal Entry (AJE) AJE-003');
    expect(fieldsOf(aje)).toMatchObject({ 'AJE #': 'AJE-003', Basis: 'Cash only' });
  });

  it('shows void details only on a void transaction, and hides a manual source', () => {
    const posted: TransactionDisplayInput = { txnType: 'deposit', status: 'posted', voidReason: 'stale', source: 'manual' };
    expect(fieldsOf(posted)).not.toHaveProperty('Void reason');
    expect(fieldsOf(posted)).not.toHaveProperty('Source');
    const voided: TransactionDisplayInput = { txnType: 'deposit', status: 'void', voidReason: 'entered twice', source: 'bank_feed', tags: [{ id: 't', name: 'Farm' }] };
    expect(fieldsOf(voided)).toMatchObject({ 'Void reason': 'entered twice', Source: 'Bank feed', Tags: 'Farm' });
  });

  it('labels every contact role', () => {
    expect(contactRoleLabel('vendor_credit')).toBe('Vendor');
    expect(contactRoleLabel('invoice')).toBe('Customer');
    expect(contactRoleLabel('deposit')).toBe('Received from');
    expect(contactRoleLabel('journal_entry')).toBe('Name');
  });
});
