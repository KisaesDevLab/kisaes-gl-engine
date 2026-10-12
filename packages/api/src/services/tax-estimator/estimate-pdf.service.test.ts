// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildCalcSections, type EstimateResultDTO } from '@kis-books/shared';
import { PDFDocument } from 'pdf-lib';
import { renderEstimatePdf } from './estimate-pdf.service.js';
import { pdfDrawnText, pdfText, type DrawnText } from './pdf-text.test-fixtures.js';

const inst = (i: number) => ({
  index: i, label: `Q${i + 1}`, dueDate: `2026-0${4 + i}-15`, regularInstallment: '7000', annualizedInstallment: i === 0 ? '5000' : null,
  estimatesApplied: '4800', unpaid: '2200', catchUpAmount: String(2200 * (i + 1)), status: 'unpaid',
});
const estimate = (jurisdiction: string, required: boolean) => ({
  jurisdiction, estimatesRequired: required, estimatesRequiredReason: 'Below the threshold', verify: jurisdiction === 'AR',
  safeHarbor: {
    appliedRule: 'current_year', currentYear: { tax: '30000', pct: '0.9', amount: '27000' },
    priorYear: { available: false, pct: '1.1', amount: null }, requiredAnnualPayment: '27000',
  },
  installments: required ? [0, 1, 2, 3].map(inst) : [],
  penalty: required ? { total: '120', installments: [{ penalty: '30' }, { penalty: '30' }, { penalty: '30' }, { penalty: '30' }] } : null,
});

const dto = {
  taxYear: 2026, scenarioName: 'Base', filingStatus: 'mfj', computedAt: '2026-10-12T00:00:00Z', engineVersion: 'x', safeHarborRule: 'lesser_of', safeHarborRuleSource: 'firm_default',
  summary: { federalTotal: '35829', stateTotal: '7902', total: '43731', marginalRate: '0.22', federalRequiredAnnualPayment: '32246', federalUnpaid: '7046', federalPenalty: '120', statePenalty: '0' },
  federal: {
    income: { totalIncome: '232400' }, adjustmentsToIncome: { total: '20000' }, agi: '212400', deductions: { chosen: 'standard', deduction: '30000' },
    qbi: { deduction: '10000' }, taxableIncome: '172400', regularTax: { method: 'brackets', tax: '30000' }, credits: { nonrefundableAllowed: '0', refundable: '0' },
    seTax: '18086', additionalMedicareTax: '0', niit: '0', federalTotal: '35829',
  },
  state: { stateTotal: '7902', rows: [
    { state: 'MO', residency: 'resident', method: 'resident', netTax: '7590', creditForOtherStates: '312', verify: false },
    { state: 'AR', residency: 'nonresident', method: 'nonresident_flat', netTax: '312', creditForOtherStates: '0', verify: true },
  ] },
  federalEstimates: estimate('federal', true), stateEstimates: [estimate('MO', true), estimate('AR', false)],
  warnings: [{ code: 'TE_X', severity: 'warning', message: 'Section §179 “quoted” — unverified' }],
  parametersUsed: [{ key: 'a', status: 'provisional', value: 1 }], rulesUsed: [{ state: 'AR', key: 'b', status: 'unverified', value: 1 }],
  entities: [], ccorps: [], farmer: null, payments: [], adjustments: [], scheduleAi: [],
  assumptions: {
    version: 1, disclaimerText: 'Firm disclaimer from the assumptions block.',
    sections: [
      { id: 'rate_mode', title: 'Rate mode', items: [{ label: 'Federal', detail: 'Brackets', badge: null }] },
      { id: 'parameters', title: 'Unverified and provisional parameters', items: [{ label: 'Federal a', detail: '1 (provisional).', badge: 'provisional' }] },
      { id: 'readiness', title: 'Readiness warnings', items: [] },
      { id: 'disclaimer', title: 'Disclaimer', items: [{ label: 'Disclaimer', detail: 'Firm disclaimer from the assumptions block.' }] },
    ],
  },
} as unknown as EstimateResultDTO;

describe('renderEstimatePdf', () => {
  it('renders a multi-section PDF from the DTO, tolerating non-WinAnsi characters', async () => {
    const bytes = await renderEstimatePdf(dto, { taxpayerName: 'Rivera, Daniel & Maria', disclaimer: 'Custom disclaimer — not a return.' });
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(2000);
  });

  it('renders with defaults and no state', async () => {
    const bytes = await renderEstimatePdf({ ...dto, state: null, stateEstimates: [], warnings: [] } as unknown as EstimateResultDTO);
    expect(bytes.length).toBeGreaterThan(1500);
  });

  it('prints the firm header, the snapshot provenance and an assumptions page (one page per section block)', async () => {
    const bytes = await renderEstimatePdf(dto, {
      taxpayerName: 'Rivera', firmName: 'Sample CPA Firm', snapshot: { id: '11111111-2222-4333-8444-555555555555', createdAt: '2026-10-12T04:00:00.000Z', reason: 'report_pack' },
    });
    const doc = await PDFDocument.load(bytes);
    // Summary pages + the assumptions page always starts on a new page.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getTitle()).toContain('2026 Tax Estimate');
  });

  it('R4-05: disclaimer newlines are paragraphs, never "?"', async () => {
    const withParas = { ...dto, assumptions: { ...dto.assumptions!, disclaimerText: 'Paragraph one ends here.\nParagraph two starts here.\n\nThird.' } } as EstimateResultDTO;
    const text = pdfText(await renderEstimatePdf(withParas, { taxpayerName: 'Rivera' }));
    expect(text).not.toMatch(/here\.\?|\?\?Third/);
    expect(text.split('\n')).toEqual(expect.arrayContaining(['Paragraph one ends here.', 'Paragraph two starts here.', 'Third.']));
  });

  it('QA D8 / D19: the recommended rule is named in words and warnings print formatted, never as raw JSON or enum names', async () => {
    const value = [{ from: '2026-01-01', to: '2026-03-31', rate: '0.07' }];
    const withWarn = { ...dto, warnings: [...dto.warnings, { code: 'TE_PARAM_UNVERIFIED', severity: 'warning' as const, message: `Tax parameter 'penalty.underpayment_rate' is unverified (not CPA-verified); the estimate uses its current value ${JSON.stringify(value)}.`, details: { key: 'penalty.underpayment_rate', status: 'unverified', value } }] };
    const text = pdfText(await renderEstimatePdf(withWarn, { taxpayerName: 'Rivera' }));
    expect(text).not.toContain('recommended: lesser_of');
    expect(text).toMatch(/recommended: (current|prior)-year rule/);
    expect(text).toContain('a table of 1 row');
    expect(text).not.toContain('"rate"');
  });

  it('R4-04: the client audience drops warnings, readiness, unverified parameters, engine version and verify markers', async () => {
    const preparer = pdfText(await renderEstimatePdf(dto, { taxpayerName: 'Rivera' }));
    expect(preparer).toContain('engine x');
    expect(preparer).toContain('Unverified and provisional parameters');
    expect(preparer).toContain('Warnings');
    const client = pdfText(await renderEstimatePdf(dto, { taxpayerName: 'Rivera', audience: 'client' }));
    for (const banned of ['engine x', 'Warnings', 'Readiness warnings', 'Unverified and provisional parameters', 'PROVISIONAL', 'unverified', '(verify)', 'TE_X']) {
      expect(client, banned).not.toContain(banned);
    }
    expect(client).toContain('Payment vouchers');
    expect(client).toContain('Firm disclaimer from the assumptions block.');
  });

  it('QA D18 / D19: every text goes through the presenter, also for a snapshot frozen with raw engine text', async () => {
    const frozen = { ...dto, assumptions: { ...dto.assumptions, sections: [
      { id: 'projection', title: 'Projection', items: [{ label: 'Rivera', detail: 'Books through 2026-09; withholding 2000 projected.', badge: null }] },
      { id: 'state_methods', title: 'State methods', items: [
        { label: 'MO resident', detail: 'Base "federal_agi" $197,557 × 4%; credit for tax paid to other states $312.', badge: null },
        { label: 'MO requirement test', detail: 'threshold: estimates required - Tax 7590.29 less withholding 2000 and credits 0 = 5590.29; threshold 100 (at_least). The penalty estimate may differ..', badge: null },
      ] },
      { id: 'parameters', title: 'Unverified and provisional parameters', items: [{ label: 'Federal penalty.underpayment_rate', detail: '[{"to":"2025-03-31","from":"2025-01-01","rate":0.07},{"to":"2025-06-30","from… (unverified).', badge: 'unverified' }] },
      ...dto.assumptions!.sections.filter((x) => x.id === 'disclaimer'),
    ] } } as unknown as EstimateResultDTO;
    const preparer = pdfText(await renderEstimatePdf(frozen, { taxpayerName: 'Rivera' })).replace(/\n/g, ' ');
    for (const banned of ['federal_agi', 'may differ..', '{"', 'withholding 2000', '7590.29', '(nonresident) - unverified']) expect(preparer, banned).not.toContain(banned);
    expect(preparer).toContain('Tax $7,590.29 less withholding $2,000 and credits $0 = $5,590.29; threshold: at least $100');
    expect(preparer).toContain('Base federal AGI $197,557');
    expect(preparer).toContain('a table of values (see Admin > Tax parameters)');
    // The preparer marker matches the screen ("Verify" = needs review), never "unverified" for a reviewed-rule state.
    expect(preparer).toContain('AR (nonresident) - verify');
    const client = pdfText(await renderEstimatePdf(frozen, { taxpayerName: 'Rivera', audience: 'client' })).replace(/\n/g, ' ');
    for (const banned of ['unverified', 'verify', 'VERIFY', 'federal_agi', '{"']) expect(client, banned).not.toContain(banned);
    expect(client).toContain('withholding $2,000 projected.');
  });
});


// The Rivera household's real engine result (base scenario, full year through 2026-12),
// captured from estimate.service against the rivera.test-fixtures.ts seed on 2026-10-12.
const rivera = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'rivera-estimate.test-fixture.json'), 'utf8')) as EstimateResultDTO;
/** Same whole-dollar format the PDF uses everywhere ("$35,829", "-$2,200"). */
const money = (v: string) => { const n = Math.round(Number(v)); return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`; };
const FOOTER = /Page \d+ of \d+$/;
const body = (t: DrawnText[]) => t.filter((x) => !FOOTER.test(x.text));
/** Pages whose drawn text includes `needle`. */
const pagesWith = (t: DrawnText[], needle: string) => [...new Set(t.filter((x) => x.text === needle).map((x) => x.page))];

describe('Detailed calculation page (owner request 2026-10-12)', () => {
  for (const audience of ['preparer', 'client'] as const) {
    it(`${audience}: the vouchers end a page and "Detailed calculation" starts the next one`, async () => {
      const bytes = await renderEstimatePdf(rivera, { taxpayerName: 'Carlos & Maria Rivera', firmName: 'Rivera CPA LLC', audience });
      const t = pdfDrawnText(bytes);
      expect(new Set(t.map((x) => x.page)).size).toBe((await PDFDocument.load(bytes)).getPageCount());
      const [calcPage] = pagesWith(t, 'Detailed calculation');
      expect(calcPage).toBeDefined();
      // The calculation title is the first thing drawn on its page...
      expect(body(t).find((x) => x.page === calcPage)!.text).toBe('Detailed calculation');
      // ...and the page before it ends with the vouchers (its last body text is a voucher row).
      const prev = body(t).filter((x) => x.page === calcPage! - 1);
      const vouchersAt = t.findIndex((x) => x.text === 'Payment vouchers');
      expect(t[vouchersAt]!.page).toBeLessThan(calcPage!);
      const lastVoucherRow = body(t).filter((x) => x.text.startsWith('  Q4') || x.text === '  Estimated penalty' || x.text.startsWith('No estimated payments required')).at(-1)!;
      expect(lastVoucherRow.page).toBe(calcPage! - 1);
      expect(prev.at(-1)!.y).toBeGreaterThanOrEqual(lastVoucherRow.y - 2 * 13);
      expect(prev.some((x) => x.y < lastVoucherRow.y - 26)).toBe(false);
    });
  }

  it('prints every Calculation line exactly as the screen builds it, with the YTD and projected columns on the same row', async () => {
    const t = pdfDrawnText(await renderEstimatePdf(rivera, { taxpayerName: 'Rivera' }));
    const calcStart = pagesWith(t, 'Detailed calculation')[0]!;
    const calc = body(t).filter((x) => x.page >= calcStart);
    // Column headers like the screen.
    expect(calc.some((x) => x.text === 'YTD tax basis')).toBe(true);
    expect(calc.some((x) => x.text === '2026 Projected')).toBe(true);
    const sections = buildCalcSections(rivera);
    for (const s of sections) expect(calc.some((x) => x.text === s.title), s.title).toBe(true);
    const lines = sections.flatMap((s) => s.lines);
    expect(lines.length).toBeGreaterThanOrEqual(20);
    for (const l of lines) {
      const label = calc.find((x) => x.text.replace(/ \[.*\]$/, '') === l.label.replace(/—/g, '-'));
      expect(label, l.label).toBeDefined();
      const row = calc.filter((x) => x.page === label!.page && Math.abs(x.y - label!.y) < 0.5).map((x) => x.text);
      expect(row, l.label).toContain(l.projected == null ? '-' : money(l.projected));
      if (l.ytd != null) expect(row, l.label).toContain(money(l.ytd));
      if (l.sub) expect(calc.some((x) => x.text.includes(l.sub!.replace(/—/g, '-').slice(0, 40))), `${l.label} sub`).toBe(true);
    }
    const text = calc.map((x) => x.text);
    // The screen's figures for Rivera.
    for (const v of ['Rivera Plumbing LLC', 'Maria Designs Inc', 'Oak Street Rentals LP', 'W-2 wages', 'Total income', 'Half of self-employment tax',
      'Adjusted gross income', 'Standard deduction', 'Qualified business income deduction', 'Taxable income', 'Regular income tax',
      'Self-employment tax - Carlos Rivera', 'Federal total', 'MO - resident', 'AR - nonresident', 'State total', 'Total estimated tax']) {
      expect(text.some((x) => x.replace(/ \[.*\]$/, '') === v), v).toBe(true);
    }
    for (const v of ['$54,000', '$232,400', '$35,829', '$7,590', '$312', '$7,902', '$43,732']) expect(text, v).toContain(v);
    expect(text).toContain('Itemized would be 0 (auto)');
    expect(text).toContain('Marginal rate 22%');
    expect(text).toContain('Sch C · active');
    // Subtotals are bold (Helvetica-Bold is the second embedded font; drawn with /F2... checked via layout: bold rows exist).
  });

  it('repeats the column header on a continuation page', async () => {
    // Many businesses push the table past one page.
    const many = structuredClone(rivera) as EstimateResultDTO;
    const e0 = many.federal.entities[0]!;
    many.federal.entities = Array.from({ length: 60 }, (_, i) => ({ ...e0, companyId: `c${i}`, companyName: `Business ${i + 1}` }));
    const t = pdfDrawnText(await renderEstimatePdf(many, { taxpayerName: 'Rivera' }));
    const calcStart = pagesWith(t, 'Detailed calculation')[0]!;
    const headerPages = pagesWith(t, 'YTD tax basis').filter((p) => p >= calcStart);
    expect(headerPages.length).toBeGreaterThanOrEqual(2);
    expect(headerPages).toEqual([...new Set(body(t).filter((x) => x.page >= calcStart && x.text.startsWith('Business ')).map((x) => x.page))]);
    expect(t.filter((x) => x.text === 'Detailed calculation (continued)').map((x) => x.page)).toEqual(headerPages.slice(1));
  });

  it('client audience: no trace / formula text and no review markers; preparer: no trace text either', async () => {
    const formulas = [...rivera.federal.trace, ...(rivera.state?.trace ?? [])].map((x) => x.formula).filter((x): x is string => !!x && x.length > 12);
    expect(formulas.length).toBeGreaterThan(5);
    for (const audience of ['client', 'preparer'] as const) {
      const text = pdfText(await renderEstimatePdf(rivera, { taxpayerName: 'Rivera', audience }));
      expect(text).toContain('Detailed calculation');
      for (const f of formulas) expect(text, `${audience}: ${f}`).not.toContain(f.replace(/[×]/g, 'x').slice(0, 30));
      expect(text).not.toMatch(/\bTrace\b/);
    }
    const client = pdfText(await renderEstimatePdf(rivera, { taxpayerName: 'Rivera', audience: 'client' }));
    expect(client).not.toContain('[Rules unverified]');
    expect(client).not.toContain('[Verify]');
  });
});

describe('Businesses included: ownership per person (owner request 2026-10-12)', () => {
  it('shows each person\'s profit % for every linked business (Carlos 100% / Maria 50%)', async () => {
    const text = pdfText(await renderEstimatePdf(rivera, { taxpayerName: 'Rivera' }));
    const lines = text.split('\n');
    const at = (company: string) => lines[lines.indexOf(company) + 4];
    expect(lines).toContain('Rivera Plumbing LLC');
    expect(at('Rivera Plumbing LLC')).toBe('Owners: Carlos Rivera 100%');
    expect(at('Maria Designs Inc')).toBe('Owners: Maria Rivera 50%');
    expect(at('Oak Street Rentals LP')).toBe('Owners: Carlos Rivera 100%');
    // Type column uses the screen's short labels.
    expect(lines[lines.indexOf('Maria Designs Inc') + 1]).toBe('S corp');
  });

  it('prints the loss % only when it differs, and joins several owners', async () => {
    const r = structuredClone(rivera) as EstimateResultDTO;
    r.entities[1]!.owners = [
      { personId: 'a', personRole: 'primary', displayName: 'Carlos Rivera', profitPct: 60, lossPct: 40 },
      { personId: 'b', personRole: 'spouse', displayName: 'Maria Rivera', profitPct: 40, lossPct: 40 },
    ];
    const text = pdfText(await renderEstimatePdf(r, { taxpayerName: 'Rivera' }));
    expect(text).toContain('Owners: Carlos Rivera 60% (loss 40%), Maria Rivera 40%');
  });

  it('an old snapshot without owners still renders (no ownership line, everything else intact)', async () => {
    const old = structuredClone(rivera) as EstimateResultDTO;
    for (const e of old.entities) delete (e as { owners?: unknown }).owners;
    const text = pdfText(await renderEstimatePdf(old, { taxpayerName: 'Rivera', snapshot: { id: '11111111-2222-4333-8444-555555555555', createdAt: '2026-01-02T03:04:05Z', reason: 'pdf' } }));
    expect(text).toContain('Rivera Plumbing LLC');
    expect(text).not.toContain('Owners:');
    expect(text).toContain('Detailed calculation');
    expect(text).toContain('$35,829');
  });
});

describe('keep-with-next: no heading is orphaned at the bottom of a page (coordinator follow-up 2026-10-12)', () => {
  const HEADINGS = new Set(['Businesses included', 'Summary', 'Federal calculation (full-year projection)', 'State calculation', 'Safe harbor', 'Payment vouchers',
    'Warnings', 'Assumptions', 'Disclaimer', 'Income', 'Adjustments', 'Deductions', 'Federal tax', 'State tax', 'Total']);
  /**
   * Every heading has at least min(3, its block's line count) body LINES (distinct baselines)
   * below it on its own page; a block runs to the next heading or the end of the document.
   */
  const orphans = (t: DrawnText[], min = 3) => {
    const b = body(t);
    return b.flatMap((x, i) => {
      if (!HEADINGS.has(x.text)) return [];
      const rest = b.slice(i + 1);
      const end = rest.findIndex((y) => HEADINGS.has(y.text));
      const block = end < 0 ? rest : rest.slice(0, end);
      const lines = (xs: DrawnText[]) => new Set(xs.map((y) => `${y.page}:${y.y.toFixed(1)}`)).size;
      return lines(block.filter((y) => y.page === x.page)) < Math.min(min, lines(block)) ? [`${x.text} (page ${x.page})`] : [];
    });
  };

  it('Rivera, both audiences: every heading keeps its first lines on its page ("Safe harbor" was alone at the bottom of page 1)', async () => {
    for (const audience of ['preparer', 'client'] as const) {
      // The sample-estimate.pdf options (the snapshot line moves "Safe harbor" to the foot of page 1).
      const t = pdfDrawnText(await renderEstimatePdf(rivera, {
        taxpayerName: 'Carlos & Maria Rivera', firmName: 'Rivera CPA LLC', audience,
        snapshot: { id: '5f0c2a8e-1111-4333-8444-555555555555', createdAt: '2026-10-12T19:40:00.000Z', reason: 'pdf' },
      }));
      expect(orphans(t), audience).toEqual([]);
    }
  });

  it('calculation group headings move to the next page with their lines, whatever the table length', async () => {
    for (let n = 30; n <= 52; n++) {
      const many = structuredClone(rivera) as EstimateResultDTO;
      const e0 = many.federal.entities[0]!;
      many.federal.entities = Array.from({ length: n }, (_, i) => ({ ...e0, companyId: `c${i}`, companyName: `Business ${i + 1}` }));
      const t = pdfDrawnText(await renderEstimatePdf(many, { taxpayerName: 'Rivera' }));
      expect(orphans(t), `n=${n}`).toEqual([]);
    }
  });
});
