// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

export interface AddressParts {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

/**
 * Turn the structured address columns into display rows, USPS-style: street,
 * optional second street line, then "City, ST ZIP" on its own row. Mirrors
 * the `pushAddr` shape check-pdf.service uses when it draws a mailing panel,
 * so what a form shows is what the envelope prints.
 */
export function addressRows(parts: AddressParts | null | undefined): string[] {
  if (!parts) return [];
  const rows: string[] = [];
  const line1 = parts.line1?.trim();
  const line2 = parts.line2?.trim();
  if (line1) rows.push(line1);
  if (line2) rows.push(line2);
  const cityState = [parts.city?.trim(), parts.state?.trim()].filter(Boolean).join(', ');
  const cityStateZip = [cityState, parts.zip?.trim()].filter(Boolean).join(' ').trim();
  if (cityStateZip) rows.push(cityStateZip);
  return rows;
}

/** The same rows joined with newlines — the freeform format that
 *  transactions.payee_address stores and check-pdf splits back apart. */
export function addressText(parts: AddressParts | null | undefined): string {
  return addressRows(parts).join('\n');
}
