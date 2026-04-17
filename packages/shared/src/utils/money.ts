// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Convert a dollar amount string or number to minor units (cents).
 * e.g., 10.50 → 1050
 */
export function toMinorUnits(amount: string | number): number {
  const value = typeof amount === 'string' ? parseFloat(amount) : amount;
  return Math.round(value * 10000);
}

/**
 * Convert minor units back to a decimal number.
 * e.g., 1050 → 10.50
 */
export function fromMinorUnits(minorUnits: number): number {
  return minorUnits / 10000;
}

/**
 * Format a decimal amount as a currency string.
 * Uses the locale and currency code provided.
 */
export function formatCurrency(
  amount: string | number,
  currency: string = 'USD',
  locale: string = 'en-US',
): string {
  const value = typeof amount === 'string' ? parseFloat(amount) : amount;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Safely add two decimal amount strings, avoiding floating point errors.
 * Returns a string with 4 decimal places.
 */
export function addDecimal(a: string, b: string): string {
  const result = toMinorUnits(a) + toMinorUnits(b);
  return fromMinorUnits(result).toFixed(4);
}

/**
 * Safely subtract two decimal amount strings.
 * Returns a string with 4 decimal places.
 */
export function subtractDecimal(a: string, b: string): string {
  const result = toMinorUnits(a) - toMinorUnits(b);
  return fromMinorUnits(result).toFixed(4);
}
