// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-284 E6 (P32 review M7): the import compares its verification totals
// strictly on every restore (U-283, Q-P32o). Counts are taken before the
// post-verification steps and money after them, so any step that writes
// company data after verification must be wrapped in `trackBackfill(name)`
// (its changed money fields are then a named warning, not a mismatch), or be
// on the allowlist below with a reason. This test reads import.service.ts:
// the ordered steps between `const trackBackfill =` and `const finalMoney =`
// must be exactly EXPECTED_STEPS. A new step (a query, a write through a
// drizzle handle, or any awaited helper) changes the list and fails here;
// add it to EXPECTED_STEPS only together with its trackBackfill (or a reason
// in UNTRACKED_ALLOWED). No database needed.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, 'import.service.ts'), 'utf8');

/** Steps that write after verification without moving money, each with its reason. */
const UNTRACKED_ALLOWED: Record<string, string> = {
  'write:UPDATE companies SET intake_settings = D': 'intake folders reset (U-93): no money, counts taken before',
  'write:DELETE FROM document_drafts WHERE tenant': 'unconverted drafts removed (U-92): no ledger rows, counts taken before',
  'write:DELETE FROM vendor_layout_templates WHER': 'learned vendor layouts removed (U-92): no money',
};

/** The post-verification steps in source order: writes, each money-moving one followed by its trackBackfill. */
const EXPECTED_STEPS = [
  'write:UPDATE companies SET intake_settings = D',
  'write:DELETE FROM document_drafts WHERE tenant',
  'write:DELETE FROM vendor_layout_templates WHER',
  'write:INSERT INTO audit_log (tenant_id, compan',
  'track:sales_tax_backfill',
  'write:INSERT INTO audit_log (tenant_id, action',
  'track:sales_tax_liability_upgrade',
  'write:rewalkCompany',
  'track:inventory_rewalk',
];

/** Awaited callees that neither write nor need tracking. */
const READ_ONLY_AWAITS = new Set(['computeVerificationTotals']);

/**
 * The ordered steps of the post-verification block: `write:<first 40 chars of
 * SQL>` for every non-SELECT `client.query`, `write:<handle>.<op>` for a
 * drizzle write, `write:rewalkCompany`, `track:<name>` for every
 * `await trackBackfill('<name>')`, and `call:<callee>` for any other awaited
 * call (a helper may write).
 */
function importSteps(source: string): string[] {
  const start = source.indexOf('const trackBackfill =');
  const end = source.indexOf('const finalMoney =');
  if (start < 0 || end < 0 || end < start) return ['<markers not found: const trackBackfill = ... const finalMoney =>'];
  const defEnd = source.indexOf('};', start); // the trackBackfill definition itself
  const body = source.slice(defEnd + 2, end).replace(/^\s*\/\/.*$/gm, '');
  const found: Array<{ at: number; step: string }> = [];
  for (const m of body.matchAll(/client\.query\(\s*([`'"])([\s\S]*?)\1/g)) {
    const text = m[2]!.trim().replace(/\s+/g, ' ');
    if (/^SELECT\b/i.test(text)) continue;
    found.push({ at: m.index!, step: `write:${text.slice(0, 40)}` });
  }
  for (const m of body.matchAll(/\b(\w+)\.(execute|insert|update|delete)\(/g)) {
    if (m[1] === 'client') continue;
    found.push({ at: m.index!, step: `write:${m[1]}.${m[2]}` });
  }
  for (const m of body.matchAll(/await trackBackfill\('([^']+)'\)/g)) found.push({ at: m.index!, step: `track:${m[1]}` });
  for (const m of body.matchAll(/\bawait\s+\(?\s*([A-Za-z_$][\w$.]*)\(/g)) {
    const callee = m[1]!;
    if (callee === 'client.query' || callee === 'trackBackfill' || READ_ONLY_AWAITS.has(callee)) continue;
    found.push({ at: m.index!, step: callee === 'rewalkCompany' ? 'write:rewalkCompany' : `call:${callee}` });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.step);
}

describe('every import data step after verification is tracked (U-284 E6, M7)', () => {
  it('import.service.ts: the post-verification steps are exactly the known ones, each money-moving one tracked', () => {
    expect(importSteps(SOURCE)).toEqual(EXPECTED_STEPS);
  });

  it('every untracked write in the expected list is allowlisted with a reason, and every other write is tracked next', () => {
    for (let i = 0; i < EXPECTED_STEPS.length; i++) {
      const s = EXPECTED_STEPS[i]!;
      if (!s.startsWith('write:') || UNTRACKED_ALLOWED[s]) continue;
      // The next step that is not another write of the same group is its trackBackfill.
      const next = EXPECTED_STEPS.slice(i + 1).find((x) => !x.startsWith('write:'));
      expect(next, s).toMatch(/^track:/);
    }
  });

  it('goes red for a new step anywhere in the block: a query, a drizzle write, or a helper', () => {
    const inject = (marker: string, code: string) => {
      expect(SOURCE).toContain(marker);
      return importSteps(SOURCE.replace(marker, `${code}\n${marker}`));
    };
    const cases = [
      ['      // Money after every step above, under the counts taken before them.', "      await client.query('UPDATE journal_lines SET debit = debit WHERE tenant_id = $1', [newTenantId]);"],
      ['      // An archive made before 0252 (U-147)', "      await client.query('UPDATE accounts SET balance = 0 WHERE tenant_id = $1', [newTenantId]);"],
      ['      // The stock ledger (U-157, PR-4 RB1)', "      await client.query('UPDATE items SET qty = 0 WHERE tenant_id = $1', [newTenantId]);"],
      ['      // The stock ledger (U-157, PR-4 RB1)', '      await costing.update(items).set({ qty: 0 });'],
      ['      // The stock ledger (U-157, PR-4 RB1)', '      await backfillSomething(client, newTenantId);'],
    ] as const;
    for (const [marker, code] of cases) expect(inject(marker, code), code).not.toEqual(EXPECTED_STEPS);
  });
});
