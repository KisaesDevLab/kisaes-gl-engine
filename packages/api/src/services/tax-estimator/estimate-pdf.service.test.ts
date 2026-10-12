// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import type { EstimateResultDTO } from '@kis-books/shared';
import { renderEstimatePdf } from './estimate-pdf.service.js';

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
});
