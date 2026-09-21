// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The values stored in transactions.payment_method. One list for both sides
// of the ledger — Receive Payment and Pay Bills used to carry their own
// slightly different copies.
export const PAYMENT_METHODS = ['check', 'ach', 'credit_card', 'cash', 'other'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  check: 'Check',
  ach: 'ACH',
  credit_card: 'Credit Card',
  cash: 'Cash',
  other: 'Other',
};

// Pay Bills offers "hand-written check" as its own choice because it decides
// whether a check number is allocated now or the check is queued to print.
// That is an input concern: what gets stored is 'check', and
// transactions.print_status = 'hand_written' keeps the distinction.
export const BILL_PAYMENT_METHODS = [...PAYMENT_METHODS, 'check_handwritten'] as const;

export function toStoredPaymentMethod(method: (typeof BILL_PAYMENT_METHODS)[number]): PaymentMethod {
  return method === 'check_handwritten' ? 'check' : method;
}

export function paymentMethodLabel(method: string | null | undefined): string | null {
  if (!method) return null;
  return PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method;
}
