// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 10b bridge additions: per-person year inputs (Q28) and the §469(i)(5) MFS
// flag (Q33) reach the engine input; the request schemas accept / reject the new fields.
import { describe, it, expect } from 'vitest';
import { enginePersonFromDto, engineYearFromDto, personYearInputsFromDto } from './engine/bridge.js';
import type { PersonDTO } from './taxpayers-api.js';
import type { YearSettingsDTO } from './years-api.js';
import { upsertYearSchema, stateRowSchema } from '../schemas/tax-estimator-years.js';
import { createPaymentSchema, computeEstimateSchema } from '../schemas/tax-estimator-estimate.js';

const year = (over: Partial<YearSettingsDTO> = {}): YearSettingsDTO => ({
  id: 'y', taxpayerId: 't', taxYear: 2026, priorYearTax: null, priorYearAgi: null, priorYearTaxPresent: false, priorYearAgiPresent: false,
  priorYearTwelveMonths: true, priorYearFiled: true, safeHarborRule: null, rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto',
  itemized: {}, sch1a: {}, creditsNonrefundable: '0', creditsRefundable: '0', hsaCoverage: {}, withholding: {}, createdAt: '', updatedAt: '', ...over,
});
const person = (role: PersonDTO['role']): PersonDTO => ({ id: role, taxpayerId: 't', role, firstName: 'A', lastName: 'B', dateOfBirth: null, isBlind: false, sehiEligibleMonths: Array(12).fill(true) as boolean[] });

describe('personYearInputsFromDto', () => {
  it('maps the role entry to the engine person (plan type, deferral, outside W-2 / SS wages)', () => {
    const y = year({ personInputs: { spouse: { retirementPlanType: 'solo_401k', employeeDeferral: 23500, w2Wages: 40000, w2SocialSecurityWages: 41000 } } });
    const p = enginePersonFromDto(person('spouse'), y, personYearInputsFromDto(y, 'spouse'));
    expect([p.retirementPlan, p.retirementEmployeeDeferral, p.w2Wages, p.w2SocialSecurityWages]).toEqual(['solo_401k', '23500', '40000', '41000']);
  });

  it('absent inputs keep the engine defaults (SEP assumed downstream, SS wages = box 1)', () => {
    const p = enginePersonFromDto(person('primary'), year(), personYearInputsFromDto(year(), 'primary'));
    expect([p.retirementPlan, p.retirementEmployeeDeferral, p.w2Wages, p.w2SocialSecurityWages]).toEqual([null, null, '0', null]);
  });
});

describe('engineYearFromDto (Phase 10b)', () => {
  it('carries mfsLivedApartAllYear from the year; an explicit extra wins', () => {
    expect(engineYearFromDto(year({ mfsLivedApartAllYear: true })).mfsLivedApartAllYear).toBe(true);
    expect(engineYearFromDto(year()).mfsLivedApartAllYear).toBe(false);
    expect(engineYearFromDto(year({ mfsLivedApartAllYear: true }), { mfsLivedApartAllYear: false }).mfsLivedApartAllYear).toBe(false);
  });
});

describe('Phase 10b request schemas', () => {
  it('year: person inputs, MFS, NII deductions, farmer figures', () => {
    expect(upsertYearSchema.safeParse({ personInputs: { primary: { retirementPlanType: 'simple', employeeDeferral: 16500 } }, mfsLivedApartAllYear: true, niiAllocableDeductions: '100.25', farmerGross: { prior: { primary: { farming: 1, totalGross: 2 } } }, isFisherman: true }).success).toBe(true);
    expect(upsertYearSchema.safeParse({ personInputs: { primary: { retirementPlanType: 'ira' } } }).success).toBe(false);
    // R3-13: jsonb money carried as JSON numbers must be whole cents (exact through jsonb + the string bridge).
    expect(upsertYearSchema.safeParse({ itemized: { saltPaid: 10000.25 }, withholding: { federal: 4500.1, states: { MO: 0.07 } } }).success).toBe(true);
    expect(upsertYearSchema.safeParse({ itemized: { saltPaid: 10000.123 } }).success).toBe(false);
    expect(upsertYearSchema.safeParse({ withholding: { states: { MO: 0.005 } } }).success).toBe(false);
    expect(upsertYearSchema.safeParse({ farmerGross: { current: { primary: { farming: 0.1 + 0.2 } } } }).success).toBe(true);
    expect(upsertYearSchema.safeParse({ niiAllocableDeductions: '-1' }).success).toBe(false);
    expect(upsertYearSchema.safeParse({ farmerGross: { current: { primary: { acres: 3 } } } }).success).toBe(false);
  });

  it('state row: gate inputs and write-only prior-year figures', () => {
    const ok = stateRowSchema.safeParse({ residency: 'resident', state: 'mo', effectiveRate: 0.04, withholding: '2000', priorYearTax: '7050', priorYearAgi: null });
    expect(ok.success).toBe(true);
    expect(stateRowSchema.safeParse({ residency: 'resident', state: 'MO', effectiveRate: 0.04, withholding: '-5' }).success).toBe(false);
  });

  it('payment: date required unless a prior-year overpayment; GL rows need tenant + transaction; jurisdiction normalised', () => {
    expect(createPaymentSchema.safeParse({ jurisdiction: 'federal', amount: 100 }).success).toBe(false);
    const op = createPaymentSchema.parse({ jurisdiction: 'Federal', amount: 100, source: 'prior_year_overpayment' });
    expect(op.jurisdiction).toBe('federal');
    expect(createPaymentSchema.parse({ jurisdiction: 'ar', date: '2026-04-15', amount: '5' }).jurisdiction).toBe('AR');
    expect(createPaymentSchema.safeParse({ jurisdiction: 'federal', date: '2026-04-15', amount: 5, source: 'gl' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ jurisdiction: 'federal', date: '2026-04-15', amount: 0 }).success).toBe(false);
    expect(computeEstimateSchema.safeParse({ throughMonth: '2026-13' }).success).toBe(false);
    expect(computeEstimateSchema.safeParse({ tenantIds: [] }).success).toBe(false);
  });
});
