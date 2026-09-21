// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * What a vendor's account number looks like on a check's memo line, or ''
 * when the vendor has none. One definition so Write Check (prefilled in the
 * browser) and Pay Bills (defaulted on the server) print the same thing.
 *
 * The number is free text — "00-4471-A" is as valid as "12345" — so it is
 * only trimmed, never parsed or reformatted.
 */
export function vendorAccountMemo(vendorAccountNumber: string | null | undefined): string {
  const n = (vendorAccountNumber ?? '').trim();
  return n ? `Acct ${n}` : '';
}
