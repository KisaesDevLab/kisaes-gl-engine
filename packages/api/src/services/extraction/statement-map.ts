// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Pure mapping helpers for the statement pipeline (no DB / IO deps), so the
// sign convention — the highest-risk part of the import — is unit-testable in
// isolation.

export const centsToAmountString = (cents: number): string => (Math.abs(cents) / 100).toFixed(2);

// Whether the statement is a credit-card / line-of-credit account, which
// inverts the spend sign. Extraction convention: bank → out negative, in
// positive; credit card → charge positive, payment negative.
export const isCreditCardType = (typeHint: string | null | undefined): boolean =>
  typeHint === 'CREDITCARD' || typeHint === 'LINEOFCREDIT';

// Map a signed extraction amount (integer cents) to the bank-feed contract: a
// positive magnitude string + a debit/credit type. "Spend" (money out) is a
// debit. Bank statements encode out as negative; credit cards encode a charge
// (spend) as positive — hence the inversion.
export function mapSignedCentsToFeed(
  amountCents: number,
  isCreditCard: boolean,
): { amount: string; type: 'debit' | 'credit' } {
  const isSpend = isCreditCard ? amountCents > 0 : amountCents < 0;
  return { amount: centsToAmountString(amountCents), type: isSpend ? 'debit' : 'credit' };
}
