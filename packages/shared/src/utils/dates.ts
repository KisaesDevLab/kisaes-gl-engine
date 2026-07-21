// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Format a date string or Date object for display.
 */
export function formatDate(
  date: string | Date,
  format: string = 'MM/DD/YYYY',
): string {
  const d = typeof date === 'string' ? new Date(date) : date;

  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = String(d.getFullYear());

  switch (format) {
    case 'MM/DD/YYYY':
      return `${month}/${day}/${year}`;
    case 'YYYY-MM-DD':
      return `${year}-${month}-${day}`;
    case 'DD/MM/YYYY':
      return `${day}/${month}/${year}`;
    default:
      return `${month}/${day}/${year}`;
  }
}

/**
 * Format an ISO date (yyyy-mm-dd) as MM/DD/YYYY WITHOUT constructing a Date —
 * so it never shifts across a timezone (new Date('2025-01-01') is UTC
 * midnight, which local getters can read back as the previous day). Used for
 * report date labels. Non-ISO input is returned unchanged.
 */
export function formatIsoUS(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : (iso ?? '');
}

/**
 * Get the start date of a fiscal year given the starting month and a reference date.
 */
export function getFiscalYearStart(
  fiscalYearStartMonth: number,
  referenceDate: Date = new Date(),
): Date {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth() + 1;

  if (month >= fiscalYearStartMonth) {
    return new Date(year, fiscalYearStartMonth - 1, 1);
  }
  return new Date(year - 1, fiscalYearStartMonth - 1, 1);
}

/**
 * Get the end date of a fiscal year given the starting month and a reference date.
 */
export function getFiscalYearEnd(
  fiscalYearStartMonth: number,
  referenceDate: Date = new Date(),
): Date {
  const start = getFiscalYearStart(fiscalYearStartMonth, referenceDate);
  const endYear = start.getFullYear() + 1;
  const endMonth = start.getMonth();
  return new Date(endYear, endMonth, 0); // Last day of preceding month = last day of fiscal year
}

/**
 * Convert a date to UTC ISO string for database storage.
 */
export function toUTC(date: Date): string {
  return date.toISOString();
}
