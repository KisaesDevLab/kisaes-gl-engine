// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Asset detail types that are bank registers: both vocabularies in use (the
 * default chart's umbrella 'bank' and the more specific 'checking' /
 * 'savings'), plus cash on hand and petty cash. Bank deposits, batch groups
 * and bank file import (U-175) share this set.
 */
export const BANK_DETAIL_TYPES: readonly string[] = ['bank', 'checking', 'savings', 'cash', 'petty_cash'];
