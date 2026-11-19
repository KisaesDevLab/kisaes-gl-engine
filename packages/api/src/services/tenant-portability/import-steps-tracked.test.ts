// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-284 E6 (P32 review M7): the import compares its verification totals
// strictly on every restore (U-283, Q-P32o). Counts are taken before the
// post-verification steps and money after them, so any step that writes
// company data after verification must be wrapped in `trackBackfill(name)`
// (its changed money fields are then a named warning, not a mismatch), or be
// on the allowlist below with a reason. This test reads import.service.ts
// and fails when a writing step between `const trackBackfill =` and
// `const finalMoney =` is neither. No database needed.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, 'import.service.ts'), 'utf8');

/** Steps that write after verification without moving money, each with its reason. */
const UNTRACKED_ALLOWED: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^UPDATE companies SET intake_settings = DEFAULT/, reason: 'intake folders reset (U-93): no money, counts taken before' },
  { pattern: /^DELETE FROM document_drafts /, reason: 'unconverted drafts removed (U-92): no ledger rows, counts taken before' },
  { pattern: /^DELETE FROM vendor_layout_templates /, reason: 'learned vendor layouts removed (U-92): no money' },
];

interface Step { kind: 'write' | 'track'; text: string; depth: number; index: number }

/**
 * The writing steps of the post-verification block that no `trackBackfill`
 * covers. A step is covered by the first `await trackBackfill(...)` after it
 * when that call sits at the step's brace depth or shallower, and the depth
 * never drops below the call's depth in between (same block, or the block
 * that encloses it). `rewalkCompany(` counts as a writing step.
 */
function untrackedImportSteps(source: string): string[] {
  const start = source.indexOf('const trackBackfill =');
  const end = source.indexOf('const finalMoney =');
  if (start < 0 || end < 0 || end < start) return ['<markers not found: const trackBackfill = ... const finalMoney =>'];
  // Skip the trackBackfill definition itself (up to its closing `};`).
  const defEnd = source.indexOf('};', start);
  const body = source.slice(defEnd + 2, end);
  // Walk once: brace depth outside strings, the text of each string literal, and the depth at every offset.
  const depthAt: number[] = new Array(body.length).fill(0);
  const strings: Array<{ at: number; text: string }> = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '`' || c === "'" || c === '"') {
      let j = i + 1;
      while (j < body.length && body[j] !== c) j += body[j] === '\\' ? 2 : 1;
      strings.push({ at: i, text: body.slice(i + 1, j) });
      for (let k = i; k <= j && k < body.length; k++) depthAt[k] = depth;
      i = j;
      continue;
    }
    if (c === '/' && body[i + 1] === '/') {
      const j = body.indexOf('\n', i);
      for (let k = i; k < (j < 0 ? body.length : j); k++) depthAt[k] = depth;
      i = j < 0 ? body.length : j;
      depthAt[i] = depth;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    depthAt[i] = depth;
  }
  const steps: Step[] = [];
  for (const m of body.matchAll(/client\.query\(\s*/g)) {
    const s = strings.find((x) => x.at === m.index! + m[0].length);
    const text = (s?.text ?? '').trim().replace(/\s+/g, ' ');
    if (/^SELECT\b/i.test(text)) continue;
    if (UNTRACKED_ALLOWED.some((a) => a.pattern.test(text))) continue;
    steps.push({ kind: 'write', text: text || '<dynamic query>', depth: depthAt[m.index!]!, index: m.index! });
  }
  for (const m of body.matchAll(/rewalkCompany\(/g)) steps.push({ kind: 'write', text: 'rewalkCompany(...)', depth: depthAt[m.index!]!, index: m.index! });
  for (const m of body.matchAll(/await trackBackfill\('([^']+)'\)/g)) steps.push({ kind: 'track', text: m[1]!, depth: depthAt[m.index!]!, index: m.index! });
  steps.sort((a, b) => a.index - b.index);
  const untracked: string[] = [];
  for (const w of steps.filter((x) => x.kind === 'write')) {
    const t = steps.find((x) => x.kind === 'track' && x.index > w.index);
    let covered = !!t && t.depth <= w.depth;
    if (covered) {
      for (let k = w.index; k < t!.index; k++) if (depthAt[k]! < t!.depth) { covered = false; break; }
    }
    if (!covered) untracked.push(w.text);
  }
  return untracked;
}

describe('every import data step after verification is tracked (U-284 E6, M7)', () => {
  it('import.service.ts: every writing step is in trackBackfill or allowlisted', () => {
    expect(untrackedImportSteps(SOURCE)).toEqual([]);
  });

  it('the known upgrade steps are tracked by name', () => {
    for (const name of ['sales_tax_backfill', 'sales_tax_liability_upgrade', 'inventory_rewalk']) {
      expect(SOURCE).toContain(`await trackBackfill('${name}')`);
    }
  });

  it('goes red for an untracked step: after the last tracked one, or before a tracked block', () => {
    const marker = '      // Money after every step above, under the counts taken before them.';
    expect(SOURCE).toContain(marker);
    const after = SOURCE.replace(marker, `      await client.query('UPDATE journal_lines SET debit = debit WHERE tenant_id = $1', [newTenantId]);\n${marker}`);
    expect(untrackedImportSteps(after)).toEqual(['UPDATE journal_lines SET debit = debit WHERE tenant_id = $1']);
    const beforeMarker = '      // An archive made before 0252 (U-147)';
    expect(SOURCE).toContain(beforeMarker);
    const before = SOURCE.replace(beforeMarker, `      await client.query('UPDATE accounts SET balance = 0 WHERE tenant_id = $1', [newTenantId]);\n${beforeMarker}`);
    expect(untrackedImportSteps(before)).toEqual(['UPDATE accounts SET balance = 0 WHERE tenant_id = $1']);
  });
});
