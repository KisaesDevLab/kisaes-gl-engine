// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Guard (MODULE.md "Engineering rules"): the pure engine reads every tax
// number and date from the parameter registry. A numeric literal other than
// 0, 1 or 12 (months per year), or a 'YYYY-MM-DD' / 'MM-DD' string literal,
// anywhere under engine/ is a hard-coded tax constant and fails this test.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_NUMBERS = new Set(['0', '1', '12']);
const DATE_LITERAL = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAY_LITERAL = /^\d{2}-\d{2}$/;

interface Scan { code: string; strings: string[] }

/** Strip comments; replace string/template literals with "" and collect their contents. */
export function scan(source: string): Scan {
  let code = '';
  const strings: string[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let body = '';
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { body += source[i + 1] ?? ''; i += 2; continue; }
        body += source[i]; i++;
      }
      i++;
      strings.push(body);
      code += '""';
      continue;
    }
    code += c; i++;
  }
  return { code, strings };
}

/** Violations found in one source text. */
export function findViolations(source: string): string[] {
  const { code, strings } = scan(source);
  const out: string[] = [];
  const num = /(?<![\w.$])(0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)(?![\w])/g;
  for (let m = num.exec(code); m; m = num.exec(code)) {
    const lit = m[1]!;
    const before = code.slice(0, m.index).trimEnd().slice(-1);
    const after = code.slice(m.index + lit.length).trimStart()[0];
    const isIndex = before === '[' && after === ']';
    if (!ALLOWED_NUMBERS.has(lit) && !isIndex) out.push(`numeric literal ${lit}`);
  }
  for (const s of strings) {
    if (DATE_LITERAL.test(s) || MONTH_DAY_LITERAL.test(s)) out.push(`date literal '${s}'`);
  }
  return out;
}

function listTs(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...listTs(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(p);
  }
  return files;
}

describe('engine has no tax literals', () => {
  it('every engine source file is free of numeric and date literals', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const problems: string[] = [];
    for (const f of listTs(dir)) {
      for (const v of findViolations(readFileSync(f, 'utf8'))) problems.push(`${f}: ${v}`);
    }
    expect(problems).toEqual([]);
  });

  it('scanner flags bad snippets and accepts clean ones', () => {
    expect(findViolations('const r = income * 0.9235;')).toEqual(['numeric literal 0.9235']);
    expect(findViolations('const w = 168600; const x = 2;')).toHaveLength(2);
    expect(findViolations("const d = '2026-04-15'; const e = \"04-15\";")).toHaveLength(2);
    expect(findViolations('const t = `2026-04-15`;')).toHaveLength(1);
    expect(findViolations('const a = 1e3;')).toHaveLength(1);
  });

  it('scanner ignores comments, allowed numbers, index positions and non-date strings', () => {
    const clean = [
      '// rate is 0.9235 and 2026-04-15',
      '/* 168600 */',
      'const m = months / 12 + 0 - 1;',
      'const first = rows[0]; const third = rows[2];',
      "const label = 'Rate 0.9235'; const k = 'se.ss_rate';",
      'const id = tax2;',
    ].join('\n');
    expect(findViolations(clean)).toEqual([]);
  });
});
