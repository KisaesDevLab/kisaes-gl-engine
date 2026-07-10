// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report CSV export must render negative amounts AS numbers (-1), not as text
// ('-1). The formula-injection guard still has to neutralize real attacks and
// leave decorative "--- SECTION ---" banners alone.

import { describe, it, expect } from 'vitest';
import { toCsv } from './report-export.service.js';

const cols = [{ key: 'label', label: 'Label' }, { key: 'amount', label: 'Amount' }];
// The data row (line 1; line 0 is the header). Asserting the whole line avoids
// a naive comma-split mangling values that legitimately contain commas.
const row = (r: Record<string, unknown>) => toCsv([r], cols).split('\n')[1]!;

describe('report-export toCsv — negative numbers vs formula injection', () => {
  it('keeps genuine negative amounts as numbers (no apostrophe)', () => {
    expect(row({ label: 'Net', amount: '-1' })).toBe('"Net","-1"');
    expect(row({ label: 'Net', amount: '-1.50' })).toBe('"Net","-1.50"');
    expect(row({ label: 'Net', amount: '-1,234.56' })).toBe('"Net","-1,234.56"');
  });

  it('still neutralizes real formula-injection payloads', () => {
    expect(row({ label: 'x', amount: '=SUM(A1)' })).toBe(`"x","'=SUM(A1)"`);
    expect(row({ label: 'x', amount: '-SUM(A1)' })).toBe(`"x","'-SUM(A1)"`);
    expect(row({ label: 'x', amount: '-1+1' })).toBe(`"x","'-1+1"`);
    expect(row({ label: 'x', amount: '@foo' })).toBe(`"x","'@foo"`);
  });

  it('leaves decorative section banners untouched', () => {
    expect(row({ label: '--- REVENUE ---', amount: '' })).toBe('"--- REVENUE ---",""');
  });
});
