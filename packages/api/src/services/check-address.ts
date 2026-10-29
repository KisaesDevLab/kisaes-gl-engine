// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Payee mailing-address rows for checks, shared by the check PDF and the
 * print queue (U-107). Structured rows keep "City, ST ZIP" on its own line:
 * street / street 2 / "City, ST ZIP".
 */
export function addressLinesFromParts(
  line1: string | null | undefined, line2: string | null | undefined,
  city: string | null | undefined, state: string | null | undefined, zip: string | null | undefined,
): string[] {
  const out: string[] = [];
  if (line1) out.push(line1);
  if (line2) out.push(line2);
  const cityState = [city, state].filter(Boolean).join(', ');
  const cityStateZip = [cityState, zip].filter(Boolean).join(' ');
  if (cityStateZip) out.push(cityStateZip);
  return out;
}

/** A freeform, newline-separated address (transactions.payee_address) as trimmed, non-empty rows. */
export function addressLinesFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  return String(text).split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * The address a check mails to, as rows. A bill payment prints the vendor's
 * billing address first and the check's freeform address as a fallback (as
 * the check PDF does); any other check prints its freeform address (what the
 * Write Check form holds) and falls back to the payee contact's billing
 * address when none was typed.
 */
export function checkPayeeAddressLines(
  txnType: string | null | undefined,
  freeform: string | null | undefined,
  contact: { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null,
): string[] {
  const fromContact = contact
    ? addressLinesFromParts(contact.line1, contact.line2, contact.city, contact.state, contact.zip) : [];
  const fromText = addressLinesFromText(freeform);
  if (txnType === 'bill_payment') return fromContact.length > 0 ? fromContact : fromText;
  return fromText.length > 0 ? fromText : fromContact;
}
