// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function convertGroup(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ones[n]!;
  if (n < 100) return tens[Math.floor(n / 10)]! + (n % 10 ? '-' + ones[n % 10]! : '');
  return ones[Math.floor(n / 100)]! + ' Hundred' + (n % 100 ? ' ' + convertGroup(n % 100) : '');
}

/**
 * Convert a dollar amount to check words format.
 * e.g., 1500.00 → "One Thousand Five Hundred and 00/100"
 *       42.50  → "Forty-Two and 50/100"
 *       0.99   → "Zero and 99/100"
 */
export function numberToWords(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num) || num < 0) return '';
  if (num > 999999999.99) return 'Amount too large';

  const dollars = Math.floor(num);
  const cents = Math.round((num - dollars) * 100);
  const centsStr = String(cents).padStart(2, '0');

  if (dollars === 0) return `Zero and ${centsStr}/100`;

  const parts: string[] = [];

  const millions = Math.floor(dollars / 1000000);
  const thousands = Math.floor((dollars % 1000000) / 1000);
  const remainder = dollars % 1000;

  if (millions > 0) parts.push(convertGroup(millions) + ' Million');
  if (thousands > 0) parts.push(convertGroup(thousands) + ' Thousand');
  if (remainder > 0) parts.push(convertGroup(remainder));

  return parts.join(' ') + ` and ${centsStr}/100`;
}

/**
 * Validate ABA routing number (9 digits with checksum).
 */
export function validateRoutingNumber(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const digits = routing.split('').map(Number);
  const checksum = (
    3 * (digits[0]! + digits[3]! + digits[6]!) +
    7 * (digits[1]! + digits[4]! + digits[7]!) +
    1 * (digits[2]! + digits[5]! + digits[8]!)
  );
  return checksum % 10 === 0;
}
