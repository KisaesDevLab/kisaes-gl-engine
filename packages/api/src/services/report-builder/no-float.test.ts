// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-119 (ClientLedger A07, §9 "No float money"): the Report Builder's run
// path never turns money into a JavaScript number. Every line of the run
// path's files is checked against the float patterns; each allowed use is a
// non-money use listed as `file:pattern:reason`. SQL strings may not cast to
// real / float / double precision. A self-test plants a violation. Every
// amount cell of a run is an exact string (^-?\d+\.\d{2,4}$), which the run
// tests check.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'report-builder/run.ts', 'report-builder/limits.ts', 'report-builder/request.ts', 'report-builder/rights.ts',
  'equity-earnings.ts', 'report-columns/planner.ts',
];
const PATTERNS: Array<[string, RegExp]> = [
  ['parseFloat', /parseFloat\(/],
  ['Number(', /\bNumber\(/],
  ['toFixed', /\.toFixed\(/],
  ['Math', /\bMath\.(round|floor|ceil|trunc)\(/],
  ['unary +', /[=(,]\s*\+[a-zA-Z_(]/],
  ['sql float', /::\s*(float|real|double precision)|\bdouble precision\b|::float/i],
];
/** file:pattern:reason — non-money uses only, matched by the line's text. */
const ALLOW: Array<{ file: string; pattern: string; line: RegExp; reason: string }> = [
  { file: 'report-builder/limits.ts', pattern: 'Number(', line: /pid = Number\(/, reason: 'a backend pid' },
  { file: 'report-builder/limits.ts', pattern: 'Math', line: /Math\.floor\(deadline - Date\.now\(\)\)/, reason: 'milliseconds left' },
  { file: 'report-builder/run.ts', pattern: 'Number(', line: /MONTHS\[Number\(/, reason: 'a month number for a caption' },
  { file: 'report-builder/run.ts', pattern: 'Number(', line: /Number\(cols\[i\]!\.key\.split/, reason: 'a compare index' },
  { file: 'report-builder/run.ts', pattern: 'Number(', line: /slot: Number\(r\['w'\]\)/, reason: 'a column window index' },
  { file: 'report-builder/run.ts', pattern: 'Number(', line: /return Number\(\(r\.rows\[0\] as \{ n: string \}\)\.n\)/, reason: 'the ledger stamp counter' },
  { file: 'report-columns/planner.ts', pattern: 'Math', line: /Math\.round\(\(Date\.parse/, reason: 'whole days between dates' },
];

export function violations(file: string, text: string): string[] {
  const out: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    for (const [name, re] of PATTERNS) {
      if (!re.test(code)) continue;
      if (ALLOW.some((a) => a.file === file && a.pattern === name && a.line.test(code))) continue;
      out.push(`${file}:${i + 1}: ${name}: ${line.trim()}`);
    }
  });
  return out;
}

describe('no float money on the Report Builder run path (U-119)', () => {
  it('finds no float use outside the allowlist', () => {
    const found = FILES.flatMap((f) => violations(f, fs.readFileSync(path.join(SRC, f), 'utf8')));
    expect(found).toEqual([]);
  });

  it('self-test: a planted violation is found', () => {
    expect(violations('report-builder/run.ts', 'const x = parseFloat(cell);')).toHaveLength(1);
    expect(violations('report-builder/run.ts', 'sql`SELECT amount::float FROM t`')).toHaveLength(1);
    expect(violations('report-builder/run.ts', 'const v = Number(row.amount);')).toHaveLength(1);
    expect(violations('report-builder/run.ts', 'const s = d.toFixed(2);')).toHaveLength(1);
  });

  it('every allowlist entry is still used (no stale exemptions)', () => {
    for (const a of ALLOW) {
      const text = fs.readFileSync(path.join(SRC, a.file), 'utf8');
      expect(text.split(/\r?\n/).some((l) => a.line.test(l)), `${a.file} ${a.reason}`).toBe(true);
    }
  });
});
