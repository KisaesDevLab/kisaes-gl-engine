import { describe, it, expect } from 'vitest';
import {
  parseCsvText,
  parseCurrency,
  parseDate,
  detectFileType,
} from './payroll-parse.service.js';

// Deterministic adversarial input sweep. The goal isn't Monte Carlo
// coverage (vitest isn't a fuzzer) — it's a battery of *specific*
// hostile shapes that exercised parsers have historically choked on:
// oversized inputs, unterminated quotes, binary bytes in text,
// Unicode edge cases, numeric overflow, date-format confusion.
//
// Every parser on the public import surface (payroll, bank-feed, contact)
// must survive the full battery without: throwing an unhandled error,
// hanging (timeout), or silently returning a nonsensical value that
// a downstream caller would treat as authoritative.

const LARGE_FIELD = 'A'.repeat(1_000_000); // 1MB single field

const CSV_CASES: { name: string; input: string; minRows?: number; maxRows?: number }[] = [
  { name: 'empty string', input: '', maxRows: 0 },
  { name: 'single newline', input: '\n', maxRows: 0 },
  { name: 'only commas', input: ',,,,\n,,,,', maxRows: 0 },
  { name: 'BOM + header', input: '\uFEFFa,b\n1,2', minRows: 2, maxRows: 2 },
  { name: 'unterminated quote', input: 'a,b\n"unterminated' },
  { name: 'nested quotes', input: 'a,b\n"he said ""hi""",2', minRows: 2 },
  { name: 'CRLF line endings', input: 'a,b\r\n1,2\r\n3,4', minRows: 3 },
  { name: 'mixed line endings', input: 'a,b\n1,2\r\n3,4', minRows: 3 },
  { name: 'trailing newline', input: 'a,b\n1,2\n', minRows: 2 },
  { name: 'huge single field', input: `a,b\n${LARGE_FIELD},2`, minRows: 2, maxRows: 2 },
  { name: 'null bytes', input: 'a,b\n\0\0,2', minRows: 2 },
  { name: 'only quoted newlines', input: '"a\nb","c\nd"', minRows: 1 },
  { name: 'billion-comma row', input: 'a'.repeat(0) + ','.repeat(10_000) + '\n', minRows: 0 },
  { name: 'unicode high surrogates', input: 'a,b\n\uD800\uDC00,\u{1F600}', minRows: 2 },
];

const CURRENCY_CASES: { input: any; expected: number | 'finite' | 'zero' }[] = [
  { input: null, expected: 0 },
  { input: undefined, expected: 0 },
  { input: '', expected: 0 },
  { input: '0', expected: 0 },
  { input: '1.23', expected: 1.23 },
  { input: '$1,234.56', expected: 1234.56 },
  { input: '(100.00)', expected: -100 },
  { input: '500.00-', expected: -500 },
  { input: 'NaN', expected: 0 },
  { input: 'Infinity', expected: 0 },
  { input: '-Infinity', expected: 0 },
  { input: '1e400', expected: 0 },
  { input: '-0', expected: 'finite' }, // parseFloat('-0') === -0 (distinct from +0 by Object.is)
  { input: '  42  ', expected: 42 },
  { input: 'abc', expected: 0 },
  { input: '1.2.3', expected: 'finite' },
  { input: '\x001.23', expected: 'finite' },
  { input: Number.POSITIVE_INFINITY, expected: 0 },
  { input: Number.NEGATIVE_INFINITY, expected: 0 },
  { input: Number.NaN, expected: 0 },
  { input: Number.MAX_SAFE_INTEGER, expected: Number.MAX_SAFE_INTEGER },
];

const DATE_CASES: { input: string; valid: boolean; expected?: string | null }[] = [
  { input: '', valid: false, expected: null },
  { input: '   ', valid: false, expected: null },
  { input: '2024-01-15', valid: true, expected: '2024-01-15' },
  { input: '2024-13-45', valid: false, expected: null }, // month/day out of range — now rejected
  { input: '0000-00-00', valid: false, expected: null }, // out-of-range year/month/day — now rejected
  { input: '2024-02-30', valid: false, expected: null }, // Feb 30 doesn't exist — now rejected
  { input: '01/15/2024', valid: true },
  { input: '15/01/2024', valid: false, expected: null }, // US format: month=15 invalid
  { input: 'not a date', valid: false, expected: null },
  { input: '\0\0\0\0', valid: false, expected: null },
  { input: 'A'.repeat(1_000_000), valid: false, expected: null },
];

const DETECT_CASES: { name: string; bytes: Buffer; filename: string; shouldThrow?: boolean }[] = [
  { name: 'PK zip with .xlsx', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), filename: 'ok.xlsx' },
  { name: 'random bytes with .xlsx', bytes: Buffer.from('NOTZIP'), filename: 'bad.xlsx', shouldThrow: true },
  { name: 'PE with .csv', bytes: Buffer.from([0x4d, 0x5a, 0x00]), filename: 'evil.csv', shouldThrow: false /* text parsers accept anything */ },
  { name: 'zip header + .csv', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), filename: 'disguised.csv', shouldThrow: true },
  { name: 'empty .csv', bytes: Buffer.from([]), filename: 'empty.csv' },
];

function withTimeout<T>(p: Promise<T> | T, ms = 2_000, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(to); resolve(v); },
      (e) => { clearTimeout(to); reject(e); },
    );
  });
}

describe('Parser fuzzing', () => {
  describe('parseCsvText', () => {
    for (const c of CSV_CASES) {
      it(`handles: ${c.name}`, async () => {
        const start = Date.now();
        const rows = await withTimeout(parseCsvText(c.input), 2_000, 'parseCsvText');
        expect(Date.now() - start).toBeLessThan(2_000);
        expect(Array.isArray(rows)).toBe(true);
        if (c.minRows !== undefined) expect(rows.length).toBeGreaterThanOrEqual(c.minRows);
        if (c.maxRows !== undefined) expect(rows.length).toBeLessThanOrEqual(c.maxRows);
      });
    }
  });

  describe('parseCurrency', () => {
    for (const c of CURRENCY_CASES) {
      it(`handles: ${JSON.stringify(c.input)} → ${c.expected}`, () => {
        const result = parseCurrency(c.input);
        expect(Number.isFinite(result)).toBe(true);
        if (typeof c.expected === 'number') {
          expect(result).toBe(c.expected);
        } else if (c.expected === 'finite') {
          expect(Number.isFinite(result)).toBe(true);
        }
      });
    }
  });

  describe('parseDate', () => {
    for (const c of DATE_CASES) {
      it(`handles: ${JSON.stringify(c.input).slice(0, 40)}`, () => {
        // Must not throw, must return either a string or null.
        const result = parseDate(c.input);
        expect(result === null || typeof result === 'string').toBe(true);
        if (typeof result === 'string') {
          expect(result.length).toBeLessThan(100);
          // If we returned a string, it must be a real calendar date.
          expect(/^\d{4}-\d{2}-\d{2}$/.test(result)).toBe(true);
          const roundtrip = new Date(result + 'T00:00:00Z');
          expect(Number.isFinite(roundtrip.getTime())).toBe(true);
        }
        if (c.expected !== undefined) expect(result).toBe(c.expected);
      });
    }
  });

  describe('detectFileType', () => {
    for (const c of DETECT_CASES) {
      it(`handles: ${c.name}`, () => {
        if (c.shouldThrow) {
          expect(() => detectFileType(c.filename, c.bytes)).toThrow();
        } else {
          const type = detectFileType(c.filename, c.bytes);
          expect(typeof type).toBe('string');
          expect(['csv', 'tsv', 'xlsx', 'xls'].includes(type)).toBe(true);
        }
      });
    }
  });

  describe('stress: nothing hangs on pathological input', () => {
    it('1MB of just commas', async () => {
      const input = ','.repeat(1_000_000);
      const rows = await withTimeout(parseCsvText(input), 3_000, 'giant-commas');
      expect(Array.isArray(rows)).toBe(true);
    });

    it('1MB of random quotes', async () => {
      const input = '"'.repeat(1_000_000);
      const rows = await withTimeout(parseCsvText(input), 3_000, 'giant-quotes');
      expect(Array.isArray(rows)).toBe(true);
    });

    it('100k lines', async () => {
      const input = Array.from({ length: 100_000 }, (_, i) => `${i},row`).join('\n');
      const rows = await withTimeout(parseCsvText(input), 5_000, '100k-lines');
      expect(rows.length).toBeGreaterThanOrEqual(100_000);
    });
  });
});
