// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Integer money helpers for the financial-statement engine. The shared
// package has no decimal library, so every amount is carried as an
// integer count of 1/10,000ths (the GL's decimal(19,4) precision) and
// rounded to presentation units (whole dollars or cents) explicitly.

export const SCALE = 10_000;

export const toUnits = (x: number | null | undefined): number => Math.round((x ?? 0) * SCALE);

// Presentation unit size in 1e-4 units: whole dollars = 10,000; cents = 100.
export const presUnit = (decimals: 0 | 2): number => (decimals === 0 ? SCALE : 100);

// Round half away from zero to a multiple of `unit`, returning a multiple
// of `unit` (still in 1e-4 units).
export function roundTo(v: number, unit: number): number {
  const q = Math.abs(v) / unit;
  const r = Math.floor(q + 0.5 + 1e-9) * unit;
  return v < 0 ? -r : r;
}

// Display value (dollars) from 1e-4 units.
export const toDisplay = (v: number): number => v / SCALE;

export function pct(num: number, den: number): number | null {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 10;
}

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function shiftYear(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const ny = y + years;
  // Feb 29 → Feb 28 in a non-leap target year.
  const last = new Date(Date.UTC(ny, m, 0)).getUTCDate();
  return `${ny}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function dayBefore(iso: string): string {
  const dt = new Date(iso + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

// Last day of the month before `iso`'s month.
export function priorMonthEnd(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const dt = new Date(Date.UTC(y, m - 1, 0));
  return dt.toISOString().slice(0, 10);
}

export const BS_TYPES: ReadonlySet<string> = new Set(['asset', 'liability', 'equity']);
export const isBsType = (t: string): boolean => BS_TYPES.has(t);
const CREDIT_TYPES: ReadonlySet<string> = new Set(['liability', 'equity', 'revenue', 'other_revenue']);
export const isCreditNatural = (t: string): boolean => CREDIT_TYPES.has(t);

export function compareAccountNumbers(a: { number: string | null; name: string }, b: { number: string | null; name: string }): number {
  const an = a.number ?? '';
  const bn = b.number ?? '';
  if (an && bn && an !== bn) return an.localeCompare(bn, undefined, { numeric: true });
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  return a.name.localeCompare(b.name);
}

export function scheduleLabel(n: number, numbering: 'numeric' | 'alpha'): string {
  if (numbering === 'alpha') {
    let s = '';
    let x = n;
    while (x > 0) {
      const r = (x - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      x = Math.floor((x - 1) / 26);
    }
    return `Schedule ${s}`;
  }
  return `Schedule ${n}`;
}
