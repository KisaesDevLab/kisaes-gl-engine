// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Calculator-style arithmetic for numeric input fields ("145.15-50").
//
// A small recursive-descent parser — never eval()/Function — over exact
// rational arithmetic (BigInt numerator / denominator), so 0.1+0.2 is
// exactly 0.3 and rounding happens once, at the end, half away from zero.
//
// Grammar (whitespace ignored, optional leading "="):
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | 'x' | 'X' | '×' | '/' | '÷') unary)*
//   unary   := ('-' | '+' | '−') unary | postfix
//   postfix := primary '%'*                      (n% = n / 100)
//   primary := number | '(' expr ')'
//   number  := '$'? digits-with-optional-1,000-grouping ('.' digits)?

export const EXPRESSION_MAX_LENGTH = 200;
const MAX_DEPTH = 32;
// Larger magnitudes can't round-trip through a JS number to the cent and
// are far outside anything the ledger's decimal(19,4) columns hold.
const MAX_ABS_RESULT = 1e15;

interface Rational { n: bigint; d: bigint }

function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

function norm(n: bigint, d: bigint): Rational {
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

class ExprError extends Error {}

type Tok =
  | { t: 'num'; v: Rational }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '%' | '(' | ')' };

const OP_MAP: Record<string, '+' | '-' | '*' | '/' | '%' | '(' | ')'> = {
  '+': '+', '-': '-', '−': '-', '–': '-',
  '*': '*', 'x': '*', 'X': '*', '×': '*',
  '/': '/', '÷': '/',
  '%': '%', '(': '(', ')': ')',
};

function parseNumberToken(raw: string): Rational {
  // raw: digits/commas with optional single '.' fraction.
  const m = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m || (m[1] === '' && !m[2])) throw new ExprError(`"${raw}" isn't a valid number`);
  const intPart = (m[1] ?? '').replace(/,/g, '') || '0';
  const frac = m[2] ?? '';
  const d = 10n ** BigInt(frac.length);
  return norm(BigInt(intPart + frac), d);
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === ' ') { i++; continue; }
    if (c === '$') {
      // Currency sign is decoration; it must be followed by a number.
      if (!/[\d.]/.test(src[i + 1] ?? '')) throw new ExprError('"$" must be followed by a number');
      i++;
      continue;
    }
    if (/[\d.,]/.test(c)) {
      let j = i;
      while (j < src.length && /[\d.,]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      if (raw.startsWith(',')) throw new ExprError(`"${raw}" isn't a valid number`);
      out.push({ t: 'num', v: parseNumberToken(raw) });
      i = j;
      continue;
    }
    const op = OP_MAP[c];
    if (!op) throw new ExprError(`Unexpected "${c}"`);
    out.push({ t: 'op', v: op });
    i++;
  }
  return out;
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly toks: Tok[]) {}

  parse(): Rational {
    if (this.toks.length === 0) throw new ExprError('Enter a number');
    const v = this.expr();
    if (this.pos < this.toks.length) throw new ExprError('Incomplete or invalid expression');
    return v;
  }

  private peekOp(): string | null {
    const t = this.toks[this.pos];
    return t && t.t === 'op' ? t.v : null;
  }

  private expr(): Rational {
    let left = this.term();
    for (;;) {
      const op = this.peekOp();
      if (op !== '+' && op !== '-') return left;
      this.pos++;
      const right = this.term();
      left = op === '+'
        ? norm(left.n * right.d + right.n * left.d, left.d * right.d)
        : norm(left.n * right.d - right.n * left.d, left.d * right.d);
    }
  }

  private term(): Rational {
    let left = this.unary();
    for (;;) {
      const op = this.peekOp();
      if (op !== '*' && op !== '/') return left;
      this.pos++;
      const right = this.unary();
      if (op === '*') {
        left = norm(left.n * right.n, left.d * right.d);
      } else {
        if (right.n === 0n) throw new ExprError("Can't divide by zero");
        left = norm(left.n * right.d, left.d * right.n);
      }
    }
  }

  private unary(): Rational {
    const op = this.peekOp();
    if (op === '-' || op === '+') {
      this.pos++;
      this.enter();
      const v = this.unary();
      this.depth--;
      return op === '-' ? { n: -v.n, d: v.d } : v;
    }
    return this.postfix();
  }

  private postfix(): Rational {
    let v = this.primary();
    while (this.peekOp() === '%') {
      this.pos++;
      v = norm(v.n, v.d * 100n);
    }
    return v;
  }

  private primary(): Rational {
    const t = this.toks[this.pos];
    if (!t) throw new ExprError('Incomplete expression');
    if (t.t === 'num') { this.pos++; return t.v; }
    if (t.v === '(') {
      this.pos++;
      this.enter();
      const v = this.expr();
      this.depth--;
      if (this.peekOp() !== ')') throw new ExprError('Missing ")"');
      this.pos++;
      return v;
    }
    throw new ExprError('Incomplete or invalid expression');
  }

  private enter() {
    if (++this.depth > MAX_DEPTH) throw new ExprError('Expression is nested too deeply');
  }
}

/** Format an exact rational with `decimals` places, rounding half away from zero. */
function formatFixed(r: Rational, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const neg = r.n < 0n;
  const absN = neg ? -r.n : r.n;
  const scaled = absN * scale;
  let q = scaled / r.d;
  const rem = scaled % r.d;
  if (rem * 2n >= r.d) q += 1n;
  if (q === 0n) return decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
  let s = q.toString();
  if (decimals > 0) {
    s = s.padStart(decimals + 1, '0');
    s = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  }
  return neg ? `-${s}` : s;
}

export type ExpressionResult =
  | {
      ok: true;
      /** The exact result as a JS number (may carry float noise for repeating decimals). */
      value: number;
      /**
       * Plain-number string. With `decimals`, rounded half away from zero and
       * zero-padded to that many places; without it, the shortest exact
       * decimal (repeating fractions are cut at 10 places).
       */
      format: (decimals?: number) => string;
      /** True when the exact result is an integer. */
      isInteger: boolean;
    }
  | { ok: false; error: string };

/**
 * Evaluate a calculator expression such as `145.15-50`, `=$1,200 / 4`,
 * `200*15%` or `(10+5)*2`. Never throws; returns `{ ok: false, error }`
 * for anything it can't evaluate (garbage, division by zero, too long).
 */
export function evaluateExpression(input: string): ExpressionResult {
  let src = (input ?? '').trim();
  if (src.length > EXPRESSION_MAX_LENGTH) return { ok: false, error: 'Expression is too long' };
  if (src.startsWith('=')) src = src.slice(1).trim();
  try {
    const r = new Parser(tokenize(src)).parse();
    const value = Number(r.n) / Number(r.d);
    if (!Number.isFinite(value) || Math.abs(value) >= MAX_ABS_RESULT) {
      return { ok: false, error: 'Number is too large' };
    }
    const isInteger = r.d === 1n;
    const format = (decimals?: number): string => {
      if (decimals !== undefined) return formatFixed(r, Math.max(0, Math.min(10, Math.floor(decimals))));
      // Shortest exact representation when the denominator is 2^a·5^b.
      let d = r.d;
      let places = 0;
      while (d % 10n === 0n) { d /= 10n; places++; }
      while (d % 2n === 0n) { d /= 2n; places++; }
      while (d % 5n === 0n) { d /= 5n; places++; }
      const exact = d === 1n;
      const s = formatFixed(r, exact ? places : 10);
      return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
    };
    return { ok: true, value, format, isInteger };
  } catch (err) {
    if (err instanceof ExprError) return { ok: false, error: err.message };
    if (err instanceof RangeError) return { ok: false, error: 'Number is too large' };
    return { ok: false, error: 'Invalid expression' };
  }
}

/** A plain (possibly signed, possibly partial) decimal number as a number input would hold it: "", "-", "12", "-12.5", ".5". */
export function isPlainNumberText(text: string): boolean {
  return /^-?\d*\.?\d*$/.test(text.trim());
}
