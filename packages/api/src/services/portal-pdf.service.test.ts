// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  w9HtmlTemplate,
  renderBlockPdf,
  reportHtmlTemplate,
  type PdfBlockPayload,
} from './portal-pdf.service.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("a & b's")).toBe('a &amp; b&#39;s');
  });

  it('coerces nullish to empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('w9HtmlTemplate', () => {
  const baseInput = {
    legalName: 'Jane Smith',
    businessName: 'Smith LLC',
    taxClassification: 'Individual / sole proprietor',
    exemptPayeeCode: undefined,
    address: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
    tinMasked: '***-**-1234',
    tinType: 'SSN' as const,
    signedAt: new Date('2026-04-26T15:00:00Z'),
    signatureName: 'Jane Smith',
    ipAddress: '203.0.113.7',
  };

  it('never embeds the unmasked TIN', () => {
    const html = w9HtmlTemplate(baseInput);
    // TIN must only appear masked, even though the form collects it.
    expect(html).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(html).toContain('***-**-1234');
  });

  it('embeds the captured signature, signer name, and IP', () => {
    const html = w9HtmlTemplate(baseInput);
    expect(html).toContain('Jane Smith');
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('Electronic signature');
  });

  it('escapes HTML in user-supplied fields', () => {
    const html = w9HtmlTemplate({
      ...baseInput,
      legalName: '<script>alert(1)</script>',
      businessName: '"O\'Brien" & Co',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;O&#39;Brien&quot; &amp; Co');
  });

  it('omits the IP block when no ip is provided', () => {
    const html = w9HtmlTemplate({ ...baseInput, ipAddress: null });
    expect(html).not.toContain('From IP');
  });
});

// ── Render parity (wave 2) ───────────────────────────────────────
// Every payload type resolveBlock can emit must render real PDF HTML:
// non-empty, no "not yet supported" fallback, no raw error text.

const aging = { current: 100, days1to30: 50, days31to60: 25, days61to90: 10, over90: 5, total: 190 };
const pl = { revenue: 1000, cogs: 200, grossProfit: 800, operatingExpense: 300, netIncome: 500 };
const trend = [
  { month: '2026-05', label: 'May 26', amount: 100 },
  { month: '2026-06', label: 'Jun 26', amount: -40 },
];

// One fixture per payload type the resolver can emit (old + new).
const PAYLOAD_FIXTURES: Array<{ block: Record<string, unknown>; payload: PdfBlockPayload }> = [
  { block: { type: 'block', name: 'top_customers' }, payload: { type: 'top_customers', data: [{ name: 'Acme', amount: 100 }] } },
  { block: { type: 'block', name: 'top_vendors' }, payload: { type: 'top_vendors', data: [{ name: 'Vendor', amount: 60 }] } },
  { block: { type: 'block', name: 'ar_aging' }, payload: { type: 'ar_aging', data: aging } },
  { block: { type: 'block', name: 'ap_aging' }, payload: { type: 'ap_aging', data: aging } },
  { block: { type: 'block', name: 'pl_bar' }, payload: { type: 'pl_bar', data: pl } },
  {
    block: { type: 'block', name: 'bank_balances' },
    payload: {
      type: 'bank_balances',
      data: { asOfDate: '2026-06-30', accounts: [{ name: 'Checking', balance: 500, isInactive: false }], totalBalance: 500 },
    },
  },
  { block: { type: 'block', name: 'expense_by_category' }, payload: { type: 'expense_by_category', data: [{ name: 'Rent', amount: 900 }] } },
  {
    block: { type: 'block', name: 'budget_vs_actual' },
    payload: {
      type: 'budget_vs_actual',
      data: {
        budgetName: 'FY26 Plan',
        fiscalYear: 2026,
        rows: [{ account: 'Sales', budgeted: 3000, actual: 2500, variance: -500, variancePct: -16.7 }],
        totals: { budgeted: 3000, actual: 2500, variance: -500 },
        truncated: false,
      },
    },
  },
  {
    block: { type: 'tag-segment', tags: ['t1'] },
    payload: {
      type: 'tag_segments',
      data: [{ tagId: 't1', tagName: 'Location A', revenue: 1000, expenses: 400, netIncome: 600 }],
    },
  },
  { block: { type: 'chart', name: 'pl_vs_prior_year' }, payload: { type: 'pl_vs_prior_year', data: { current: pl, prior: pl } } },
  { block: { type: 'chart', name: 'revenue_trend_12m' }, payload: { type: 'revenue_trend_12m', data: trend } },
  { block: { type: 'chart', name: 'expense_trend_12m' }, payload: { type: 'expense_trend_12m', data: trend } },
  { block: { type: 'chart', name: 'cash_balance_trend' }, payload: { type: 'cash_balance_trend', data: trend } },
  { block: { type: 'chart', name: 'net_income_trend_12m' }, payload: { type: 'net_income_trend_12m', data: trend } },
  {
    block: { type: 'chart', name: 'gross_margin_trend_12m' },
    payload: { type: 'gross_margin_trend_12m', data: [{ month: '2026-05', label: 'May 26', amount: 42.5 }] },
  },
  { block: { type: 'report', key: 'profit_loss' }, payload: { type: 'profit_loss', data: pl } },
  {
    block: { type: 'report', key: 'balance_sheet' },
    payload: {
      type: 'balance_sheet',
      data: {
        assets: 1000,
        liabilities: 200,
        equity: 800,
        sections: { currentAssets: 400, fixedAssets: 500, otherAssets: 100, currentLiabilities: 150, longTermLiabilities: 50 },
      },
    },
  },
  {
    block: { type: 'report', key: 'cash_flow' },
    payload: { type: 'cash_flow', data: { netIncome: 500, operating: 400, investing: -100, financing: 0, netChange: 300 } },
  },
  {
    block: { type: 'report', key: 'trial_balance' },
    payload: {
      type: 'trial_balance',
      data: { rows: [{ account: 'Checking', debit: 100, credit: 0 }], totalDebits: 100, totalCredits: 100, truncated: true },
    },
  },
  { block: { type: 'report', key: 'sales_tax' }, payload: { type: 'sales_tax', data: { totalSales: 150, totalTax: 12.25 } } },
];

describe('renderBlockPdf — parity across every payload type', () => {
  it('renders real HTML for every payload type (no unsupported fallback)', () => {
    for (const { block, payload } of PAYLOAD_FIXTURES) {
      const html = renderBlockPdf(block, payload);
      expect(html.length, `payload ${payload.type} renders`).toBeGreaterThan(40);
      expect(html, `payload ${payload.type} is supported`).not.toContain('not yet supported');
      expect(html, `payload ${payload.type} carries no error copy`).not.toContain('Section unavailable');
    }
  });

  it('renders error payloads as "Section unavailable." without leaking the raw message', () => {
    for (const { block, payload } of PAYLOAD_FIXTURES) {
      const html = renderBlockPdf(block, { type: payload.type, error: 'SELECT boom FROM secrets' });
      expect(html).toContain('Section unavailable.');
      expect(html).not.toContain('SELECT boom FROM secrets');
    }
  });

  it('balance_sheet renders indented section subtotals; cash_flow includes the accrual NI row', () => {
    const bs = renderBlockPdf(
      { type: 'report', key: 'balance_sheet' },
      PAYLOAD_FIXTURES.find((f) => f.payload.type === 'balance_sheet')!.payload,
    );
    expect(bs).toContain('Current Assets');
    expect(bs).toContain('Long-Term Liabilities');
    const cf = renderBlockPdf(
      { type: 'report', key: 'cash_flow' },
      PAYLOAD_FIXTURES.find((f) => f.payload.type === 'cash_flow')!.payload,
    );
    expect(cf).toContain('Net Income (accrual)');
  });
});

describe('reportHtmlTemplate — kpi-row parity + status dots', () => {
  const base = {
    companyName: 'Acme LLC',
    templateName: 'Monthly Packet',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    publishedAt: new Date('2026-07-01T00:00:00Z'),
  };

  it('renders "No KPIs selected." for an empty kpi-row', () => {
    const html = reportHtmlTemplate({
      ...base,
      layout: [{ type: 'kpi-row', kpis: [] }],
      data: {},
    });
    expect(html).toContain('No KPIs selected.');
  });

  it('renders a colored dot when kpi_status carries a status', () => {
    const html = reportHtmlTemplate({
      ...base,
      layout: [{ id: 'k1', type: 'kpi-row', kpis: ['gross_margin_pct'] }],
      data: {
        kpis: { gross_margin_pct: '41.0%' },
        kpi_names: { gross_margin_pct: 'Gross Margin %' },
        kpi_status: { gross_margin_pct: 'green' },
      },
    });
    expect(html).toContain('dot-green');
    expect(html).toContain('41.0%');
  });

  it('routes tag-segment blocks through the block renderer', () => {
    const html = reportHtmlTemplate({
      ...base,
      layout: [{ id: 'ts1', type: 'tag-segment', tags: ['t1'] }],
      data: {
        blocks: {
          ts1: {
            type: 'tag_segments',
            data: [{ tagId: 't1', tagName: 'Location A', revenue: 1000, expenses: 400, netIncome: 600 }],
          },
        },
      },
    });
    expect(html).toContain('Location A');
    expect(html).toContain('Tag Segments');
  });
});
