// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Report Builder section rights (U-119, Q-A07i). A section needs its
 * source's base areas (fields.ts) plus the areas of the transaction types it
 * admits: a cash Sales section admits customer payments (receive_payment), a
 * Bank section that admits checks needs checks, bill payments pay_bills,
 * and so on. `gl` needs only reports (A/R and A/P are readable through it
 * until P29 decides). Read access is enough.
 */

import { RB_SOURCE_INFO, RB_TXN_TYPES, type RbSectionNode, type RbRight } from '@kis-books/shared';

const TYPE_RIGHT: Partial<Record<string, RbRight>> = {
  customer_payment: 'receive_payment',
  returned_payment: 'receive_payment',
  customer_refund: 'receive_payment',
  check: 'checks',
  bill_payment: 'pay_bills',
};

/** The transaction types a section's txn_type filters admit (every type when unfiltered). */
export function admittedTypes(s: RbSectionNode): Set<string> {
  let types = new Set<string>(RB_TXN_TYPES);
  for (const f of s.filters) {
    if (f.field !== 'txn_type' || !f.values) continue;
    if (f.op === 'in') types = new Set([...types].filter((t) => f.values!.includes(t)));
    if (f.op === 'not_in') types = new Set([...types].filter((t) => !f.values!.includes(t)));
  }
  return types;
}

/** The read rights a section needs on a basis. */
export function sectionRights(s: RbSectionNode, basis: 'accrual' | 'cash'): RbRight[] {
  const need = new Set<RbRight>(RB_SOURCE_INFO[s.source].rights);
  if (s.source !== 'gl') {
    const types = admittedTypes(s);
    // Sales and purchases admit payments only on cash basis.
    const paymentsCount = basis === 'cash' || s.source === 'bank';
    for (const t of types) {
      const r = TYPE_RIGHT[t];
      if (!r) continue;
      if ((r === 'receive_payment' || r === 'pay_bills') && !paymentsCount) continue;
      if (s.source === 'sales' || s.source === 'item_sales') { if (r === 'receive_payment') need.add(r); continue; }
      if (s.source === 'purchases' || s.source === 'item_purchases') { if (r === 'pay_bills' || r === 'checks') need.add(r); continue; }
      if (s.source === 'bank') need.add(r);
    }
  }
  return [...need];
}
