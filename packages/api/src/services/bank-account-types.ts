// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Asset detail types that are bank registers: both vocabularies in use (the
 * default chart's umbrella 'bank' and the more specific 'checking' /
 * 'savings'), plus cash on hand and petty cash. Bank deposits, batch groups
 * and bank file import (U-175) share this set.
 */
export const BANK_DETAIL_TYPES: readonly string[] = ['bank', 'checking', 'savings', 'cash', 'petty_cash'];

/**
 * Whether an asset detail type is a bank register (BANK_DETAIL_TYPES). Checks,
 * deposits and transfers post on any of them, so registers and pickers that
 * offer those entries use this rather than comparing with 'bank' (U-194).
 */
export function isBankDetailType(detailType: string | null | undefined): boolean {
  return detailType != null && BANK_DETAIL_TYPES.includes(detailType);
}
