// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// String-decimal arithmetic for the Tax Estimator engine (MODULE.md "Money":
// the shared engine uses a string-decimal helper, never floats, and rounds to
// whole dollars half-up only at final per-line amounts). Values are decimal
// strings ('-123.4567'); internally each is a BigInt scaled by a power of ten,
// so addition, subtraction and multiplication are exact and division is
// rounded half-up at DIV_SCALE places. No dependency is added to shared.
//
// This file sits beside allocation.ts rather than under engine/ because the
// engine literal guard (engine/no-literals.guard.test.ts) forbids every
// numeric literal but 0/1/12, and base-ten arithmetic needs its radix.

const TEN = 10n;
const DIV_SCALE = 12;
const PERCENT_SCALE = 2;
const RATE_PLACES = 6;

export type Dec = string;
export const ZERO: Dec = '0';
export const ONE: Dec = '1';

interface Scaled { int: bigint; scale: number }

const DEC_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function pow10(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= TEN;
  return r;
}

function parse(v: Dec | number): Scaled {
  const s = typeof v === 'number' ? String(v) : String(v).trim();
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`decimal: non-finite number ${v}`);
  const m = DEC_RE.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`decimal: cannot parse '${s}'`);
  const whole = m[2] ?? '';
  const frac = m[3] ?? '';
  const exp = m[4] ? Number(m[4]) : 0;
  let int = BigInt((whole || '0') + frac);
  if (m[1] === '-') int = -int;
  let scale = frac.length - exp;
  if (scale < 0) { int *= pow10(-scale); scale = 0; }
  return { int, scale };
}

function toString(x: Scaled): Dec {
  const neg = x.int < 0n;
  let digits = (neg ? -x.int : x.int).toString();
  if (x.scale > 0) {
    digits = digits.padStart(x.scale + 1, '0');
    const cut = digits.length - x.scale;
    const frac = digits.slice(cut).replace(/0+$/, '');
    const whole = digits.slice(0, cut);
    digits = frac.length > 0 ? `${whole}.${frac}` : whole;
  }
  if (/^0(\.0*)?$/.test(digits)) return ZERO;
  return neg ? `-${digits}` : digits;
}

function align(a: Scaled, b: Scaled): [bigint, bigint, number] {
  if (a.scale === b.scale) return [a.int, b.int, a.scale];
  if (a.scale > b.scale) return [a.int, b.int * pow10(a.scale - b.scale), a.scale];
  return [a.int * pow10(b.scale - a.scale), b.int, b.scale];
}

/** Round a scaled value to `places` fractional digits, half-up away from zero. */
function roundScaled(x: Scaled, places: number): Scaled {
  if (x.scale <= places) return x;
  const drop = pow10(x.scale - places);
  const neg = x.int < 0n;
  const abs = neg ? -x.int : x.int;
  let q = abs / drop;
  const rem = abs % drop;
  if (rem * 2n >= drop) q += 1n;
  return { int: neg ? -q : q, scale: places };
}

/** Normalise any decimal string or finite number to canonical form. */
export function dec(v: Dec | number): Dec {
  return toString(parse(v));
}

export function dAdd(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(parse(a), parse(b));
  return toString({ int: x + y, scale: s });
}

export function dSub(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(parse(a), parse(b));
  return toString({ int: x - y, scale: s });
}

export function dMul(a: Dec, b: Dec): Dec {
  const x = parse(a); const y = parse(b);
  return toString({ int: x.int * y.int, scale: x.scale + y.scale });
}

/** a ÷ b rounded half-up at DIV_SCALE (12) places. Throws on division by zero. */
export function dDiv(a: Dec, b: Dec): Dec {
  const x = parse(a); const y = parse(b);
  if (y.int === 0n) throw new Error('decimal: division by zero');
  // (x.int / 10^x.scale) / (y.int / 10^y.scale) = x.int * 10^(y.scale) / (y.int * 10^(x.scale))
  // Scale the numerator so the quotient carries DIV_SCALE + 1 digits, then round the last one.
  const extra = DIV_SCALE + 1;
  const num = x.int * pow10(y.scale + extra);
  const den = y.int * pow10(x.scale);
  const neg = (num < 0n) !== (den < 0n);
  const q = (num < 0n ? -num : num) / (den < 0n ? -den : den);
  return toString(roundScaled({ int: neg ? -q : q, scale: extra }, DIV_SCALE));
}

export function dSum(values: ReadonlyArray<Dec>): Dec {
  let acc: Dec = ZERO;
  for (const v of values) acc = dAdd(acc, v);
  return acc;
}

export function dCmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(parse(a), parse(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export function dMin(first: Dec, ...rest: Dec[]): Dec {
  let m = dec(first);
  for (const r of rest) if (dCmp(r, m) < 0) m = dec(r);
  return m;
}

export function dMax(first: Dec, ...rest: Dec[]): Dec {
  let m = dec(first);
  for (const r of rest) if (dCmp(r, m) > 0) m = dec(r);
  return m;
}

export function dNeg(a: Dec): Dec {
  const x = parse(a);
  return toString({ int: -x.int, scale: x.scale });
}

export function dAbs(a: Dec): Dec {
  const x = parse(a);
  return toString({ int: x.int < 0n ? -x.int : x.int, scale: x.scale });
}

export function dIsNeg(a: Dec): boolean { return parse(a).int < 0n; }
export function dIsZero(a: Dec): boolean { return parse(a).int === 0n; }
export function dIsPos(a: Dec): boolean { return parse(a).int > 0n; }

/** max(0, a) */
export function dFloorZero(a: Dec): Dec {
  return dIsNeg(a) ? ZERO : dec(a);
}

export function dClamp(a: Dec, lo: Dec, hi: Dec): Dec {
  return dMin(dMax(a, lo), hi);
}

/** Round half-up (away from zero) to `places` fractional digits. */
export function dRound(a: Dec, places: number): Dec {
  return toString(roundScaled(parse(a), places));
}

/** Whole dollars, half-up away from zero — the only rounding the engine applies, at final per-line amounts. */
export function dRoundDollars(a: Dec): Dec {
  return dRound(a, 0);
}

/** A rate (fraction) rounded half-up to 6 places — for reporting effective rates. */
export function dRoundRate(a: Dec): Dec {
  return dRound(a, RATE_PLACES);
}

/** 0–100 percent (as stored in profit_pct / adjustment pct columns) → fraction. null/undefined → 0. */
export function percentToFraction(pct: Dec | number | null | undefined): Dec {
  if (pct == null || pct === '') return ZERO;
  const x = parse(pct);
  return toString({ int: x.int, scale: x.scale + PERCENT_SCALE });
}
