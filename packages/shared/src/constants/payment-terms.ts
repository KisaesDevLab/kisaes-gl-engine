// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * The fixed payment-terms table (U-86, bill-terms-v1). Bills, vendor
 * defaults and GET /payment-terms all read this one list. `netDays` is the
 * number of calendar days from the bill date to the due date; a discount
 * term also gives the early-payment discount (percent of the amount, as a
 * decimal string with up to 4 places) and the days it is offered.
 *
 * `custom` has no fixed days: the bill (or the vendor default) carries
 * `termsDays` and, optionally, `discountPercent` + `discountDays`.
 */
export const PAYMENT_TERM_CODES = [
  'due_on_receipt',
  'net_10',
  'net_15',
  'net_30',
  'net_45',
  'net_60',
  'net_90',
  '1_10_net_30',
  '2_10_net_30',
  'custom',
] as const;

export type PaymentTermCode = (typeof PAYMENT_TERM_CODES)[number];

export interface PaymentTermDefinition {
  code: PaymentTermCode;
  label: string;
  /** Days from the bill date to the due date; null for `custom`. */
  netDays: number | null;
  /** Early-payment discount percent ("2.0000" = 2 %), or null. */
  discountPercent: string | null;
  /** Days from the bill date the discount is offered, or null. */
  discountDays: number | null;
}

export const PAYMENT_TERMS: readonly PaymentTermDefinition[] = [
  { code: 'due_on_receipt', label: 'Due on receipt', netDays: 0, discountPercent: null, discountDays: null },
  { code: 'net_10', label: 'Net 10', netDays: 10, discountPercent: null, discountDays: null },
  { code: 'net_15', label: 'Net 15', netDays: 15, discountPercent: null, discountDays: null },
  { code: 'net_30', label: 'Net 30', netDays: 30, discountPercent: null, discountDays: null },
  { code: 'net_45', label: 'Net 45', netDays: 45, discountPercent: null, discountDays: null },
  { code: 'net_60', label: 'Net 60', netDays: 60, discountPercent: null, discountDays: null },
  { code: 'net_90', label: 'Net 90', netDays: 90, discountPercent: null, discountDays: null },
  { code: '1_10_net_30', label: '1% 10 Net 30', netDays: 30, discountPercent: '1.0000', discountDays: 10 },
  { code: '2_10_net_30', label: '2% 10 Net 30', netDays: 30, discountPercent: '2.0000', discountDays: 10 },
  { code: 'custom', label: 'Custom', netDays: null, discountPercent: null, discountDays: null },
];

export function findPaymentTerm(code: string | null | undefined): PaymentTermDefinition | undefined {
  if (!code) return undefined;
  return PAYMENT_TERMS.find((t) => t.code === code);
}
