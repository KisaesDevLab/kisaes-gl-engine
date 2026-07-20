// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  basisOfAccountingPhrase,
  financialStatementTitles,
  formatLongDate,
  periodDescription,
  renderLetterBody,
  normalizeLetterBasis,
  LETTER_VARIABLES,
} from './letter-variables.js';

describe('basisOfAccountingPhrase', () => {
  it('maps accrual/gaap to US GAAP wording', () => {
    const gaap = 'accounting principles generally accepted in the United States of America';
    expect(basisOfAccountingPhrase('accrual')).toBe(gaap);
    expect(basisOfAccountingPhrase('gaap')).toBe(gaap);
  });
  it('maps cash / tax / modified_cash', () => {
    expect(basisOfAccountingPhrase('cash')).toBe('the cash basis of accounting');
    expect(basisOfAccountingPhrase('tax')).toBe('the tax basis of accounting');
    expect(basisOfAccountingPhrase('modified_cash')).toBe('the modified cash basis of accounting');
  });
  it('defaults unknown basis to GAAP', () => {
    expect(basisOfAccountingPhrase('nonsense')).toContain('generally accepted');
  });
});

describe('financialStatementTitles', () => {
  it('GAAP lists the conventional statements', () => {
    const t = financialStatementTitles('accrual');
    expect(t).toContain('balance sheet');
    expect(t).toContain('statement of cash flows');
  });
  it('tax basis uses special-purpose-framework titles', () => {
    const t = financialStatementTitles('tax');
    expect(t).toContain('assets, liabilities, and equity—tax basis');
    expect(t).toContain('revenues and expenses—tax basis');
  });
  it('cash basis uses cash-transaction titles', () => {
    const t = financialStatementTitles('cash');
    expect(t).toContain('assets and liabilities arising from cash transactions');
    expect(t).toContain('revenues collected and expenses paid');
  });
});

describe('formatLongDate', () => {
  it('formats an ISO date as a long date', () => {
    expect(formatLongDate('2025-12-31')).toBe('December 31, 2025');
    expect(formatLongDate('2025-01-01')).toBe('January 1, 2025');
  });
  it('returns empty string for missing/invalid input', () => {
    expect(formatLongDate('')).toBe('');
    expect(formatLongDate(null)).toBe('');
    expect(formatLongDate('not-a-date')).toBe('');
  });
});

describe('periodDescription', () => {
  it('reads a full calendar year as "year ended"', () => {
    expect(periodDescription('2025-01-01', '2025-12-31')).toBe('year ended December 31, 2025');
  });
  it('reads a short/stub period as "period ended"', () => {
    expect(periodDescription('2025-10-01', '2025-12-31')).toBe('period ended December 31, 2025');
  });
  it('handles a fiscal (non-calendar) year', () => {
    expect(periodDescription('2024-07-01', '2025-06-30')).toBe('year ended June 30, 2025');
  });
  it('falls back to "period ended" when start is missing', () => {
    expect(periodDescription(null, '2025-12-31')).toBe('period ended December 31, 2025');
  });
});

describe('normalizeLetterBasis', () => {
  it('normalizes aliases and defaults', () => {
    expect(normalizeLetterBasis('CASH')).toBe('cash');
    expect(normalizeLetterBasis('modified-cash')).toBe('modified_cash');
    expect(normalizeLetterBasis(undefined)).toBe('accrual');
  });
});

describe('renderLetterBody', () => {
  it('substitutes known tokens and HTML-escapes values', () => {
    const html = renderLetterBody('<p>Hello {{client_name}}</p>', { client_name: 'Smith & Co <LLC>' });
    expect(html).toBe('<p>Hello Smith &amp; Co &lt;LLC&gt;</p>');
  });
  it('tolerates whitespace inside braces', () => {
    expect(renderLetterBody('{{ firm_name }}', { firm_name: 'Acme' })).toBe('Acme');
  });
  it('leaves unknown tokens untouched', () => {
    expect(renderLetterBody('{{unknown}}', { client_name: 'x' })).toBe('{{unknown}}');
  });
});

describe('LETTER_VARIABLES catalog', () => {
  it('marks framework-driven variables basis-dependent', () => {
    const byKey = Object.fromEntries(LETTER_VARIABLES.map((v) => [v.key, v]));
    expect(byKey['basis_of_accounting']?.basisDependent).toBe(true);
    expect(byKey['financial_statement_titles']?.basisDependent).toBe(true);
    expect(byKey['client_name']?.basisDependent).toBe(false);
  });
});
