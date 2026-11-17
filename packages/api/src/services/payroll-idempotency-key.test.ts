// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Pins the provider duplicate-key bytes for every payroll fixture. The key is
// stored on posted sessions (migration 0046), so a change in its material
// would let an already-posted payroll file post a second time (U-250).

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseFile, detectHeaderRow, detectProvider } from './payroll-parse.service.js';
import { computeIdempotencyKey } from './payroll-import.service.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'payroll');

async function keyFor(file: string, checkDate?: string) {
  const buffer = fs.readFileSync(path.join(FIXTURES, file));
  const { rows } = await parseFile(buffer, file);
  const headerRowIdx = detectHeaderRow(rows);
  const headers = rows[headerRowIdx] || [];
  const provider = detectProvider(headers)?.provider ?? null;
  return { provider, digest: computeIdempotencyKey(provider, rows.slice(headerRowIdx + 1), headers, checkDate) };
}

describe('payroll provider duplicate key is byte-stable', () => {
  // Captured from the float-era implementation (engine 5cce402d) before U-250.
  const PINNED: Record<string, { provider: string | null; digest: string | null }> = {
    'adp-run-gli.csv': { provider: 'adp_run_gli', digest: '859ae31a621e322414fc599b86e7a5d6' },
    'gusto-payroll.csv': { provider: 'gusto', digest: 'e74ee1515a304545e7ac5e9eb1027b3d' },
    'onpay-gl-summary.csv': { provider: 'onpay_gl_summary', digest: 'd673a02107a3a120d81ee514eb07e0e2' },
    'onpay-listing.csv': { provider: 'onpay_listing', digest: null },
    'paychex-flex-gls.csv': { provider: 'paychex_flex_gls', digest: '52a5d65660477893fba480781d360fe1' },
    'payroll-relief-gl.csv': { provider: 'payroll_relief_gl', digest: null },
    'toast-custom-report.csv': { provider: 'toast_payroll_detail', digest: null },
    'toast-je-report.csv': { provider: 'toast_je_report', digest: '7685002ede88fc6f1065e0b3df723903' },
  };

  it.each(Object.keys(PINNED))('%s', async (file) => {
    expect(await keyFor(file)).toEqual(PINNED[file]);
  });

  it('every csv fixture except the Square one is pinned', () => {
    const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.csv') && !f.startsWith('square')).sort();
    expect(files).toEqual(Object.keys(PINNED).sort());
  });

  it('sums the key amounts exactly, the same cents the float sum gave', () => {
    const headers = ['Check Date', 'Debit Amount'];
    // 0.1 + 0.2 + ... drifts in binary floating point; the key keeps 2 places.
    const rows = Array.from({ length: 300 }, () => ['2026-07-10', '0.10']).concat([['2026-07-10', '(12.30)'], ['2026-07-10', '5.00-']]);
    const legacy = rows.reduce((s, r) => s + (parseFloat(r[1]!.replace(/[$,]/g, '')) || 0), 0).toFixed(2);
    expect(legacy).toBe('35.00');
    const expected = computeIdempotencyKey('adp_run_gli', [['2026-07-10', '35.00']], headers);
    expect(computeIdempotencyKey('adp_run_gli', rows, headers)).toBe(expected);
  });

  it('Square keys on period, pay date, net total and row count', () => {
    const headers = ['Name', 'Pay Period Start', 'Pay Period End', 'Net Pay'];
    const rows = [['A', '2026-07-01', '2026-07-15', '100.00'], ['B', '2026-07-01', '2026-07-15', '200.00']];
    const regular = computeIdempotencyKey('square_payroll', rows, headers, '2026-07-17');
    const offCycle = computeIdempotencyKey('square_payroll', rows, headers, '2026-07-20');
    expect(regular).not.toBeNull();
    expect(offCycle).not.toBe(regular);
    expect(computeIdempotencyKey('square_payroll', rows.slice(0, 1), headers, '2026-07-17')).not.toBe(regular);
  });
});
