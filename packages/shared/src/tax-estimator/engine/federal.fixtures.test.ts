// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Independent engine fixtures (R2 oracle note O-2): the Rivera oracle never
// reaches the QD/LTCG worksheet, itemized deductions / SALT phase-down / §68,
// Schedule 1-A, §469 netting or the §469(i) allowance, §461(l), the W-2/UBIA
// limit, the SSTB phase-in, a positive NIIT or Additional Medicare tax. The three
// fixtures below were computed BY HAND from the shipped 2026 seed values (the
// arithmetic is written out beside every expectation) and are not derived from
// the engine. Parameters are the shipped 2026 federal seed file read as text.
//
//   Hale   — MFJ, taxable income inside the §199A phase-in range: W-2/UBIA limit
//            phased in, SSTB applicable percentage, rental loss netted against
//            passive income with the §469(i) allowance fully phased out, QD + LTCG
//            at 15%, SALT cap phased down, charitable 0.5% floor, senior deduction
//            phased out, Additional Medicare on NESE, NIIT.
//   Okafor — MFJ, top bracket: §68 benefit cap, LTCG partly at 20%, SSTB fully
//            excluded, SALT at the floor, §461(l) excess business loss, QBI net
//            loss carryforward, Additional Medicare on wages.
//   Quinn  — single: §469(i) allowance allocated to the rental first (Form 8582
//            Worksheets 4–5, R2-03) and its effect on §199A.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { characters } from './income.js';
import type { EngineAdjustment, EngineEntity, EngineLink, EnginePerson, FederalEngineInput, ParameterMap } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');

/** Every single-line row of the shipped 2026 federal seed, as the engine's parameter map. */
function loadSeed2026(): ParameterMap {
  const seed = readFileSync(join(repoRoot, 'packages', 'api', 'src', 'db', 'seeds', 'tax-estimator', 'federal', '2026.ts'), 'utf8');
  const rowRe = /key: '([^']+)',\s*value: ([^\n]+?),\s*citation:[\s\S]*?status: '(\w+)'/g;
  const out: Record<string, ParameterMap[string]> = {};
  for (let m = rowRe.exec(seed); m; m = rowRe.exec(seed)) {
    out[m[1]!] = { key: m[1]!, value: JSON.parse(m[2]!.replace(/'/g, '"')) as unknown, status: m[3] as 'verified' | 'unverified' | 'provisional' };
  }
  return out;
}
const params = loadSeed2026();

// Seed values the hand computations below rely on; if the seed moves, the expectations must be recomputed.
const SEED_USED: Record<string, unknown> = {
  'brackets.mfj': [[24800, 0.1], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [null, 0.37]],
  'brackets.single': [[12400, 0.1], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [null, 0.37]],
  'ltcg.breakpoints.mfj': [98900, 613700], 'ltcg.rates': [0, 0.15, 0.2],
  'std_deduction.mfj': 32200, 'std_deduction.single': 16100, 'std_deduction.additional_65_blind.married': 1650, 'charity.nonitemizer.mfj': 2000,
  'salt.cap.standard': 40400, 'salt.phase_down.threshold.standard': 505000, 'salt.phase_down.rate': 0.3, 'salt.floor.standard': 10000, 'charity.agi_floor_pct': 0.005, 'itemized.benefit_cap_rate': 0.35,
  'sch1a.senior.amount': 6000, 'sch1a.senior.phaseout_threshold.mfj': 150000, 'sch1a.senior.phaseout_rate': 0.06,
  'qbi.rate': 0.2, 'qbi.threshold.mfj': 403500, 'qbi.phase_in_range.mfj': 150000, 'qbi.threshold.single': 201750, 'qbi.w2_wage_pct': 0.5, 'qbi.alt_w2_wage_pct': 0.25, 'qbi.ubia_pct': 0.025, 'qbi.taxable_income_limit_pct': 0.2,
  'se.nese_factor': 0.9235, 'se.ss_rate': 0.124, 'se.medicare_rate': 0.029, 'se.ss_wage_base': 184500, 'se.deduction_factor': 0.5,
  'addl_medicare.rate': 0.009, 'addl_medicare.threshold.mfj': 250000, 'niit.rate': 0.038, 'niit.threshold.mfj': 250000, 'ebl.threshold.mfj': 512000,
  'passive.rental_allowance.standard': 25000, 'passive.rental_allowance_phaseout_start.standard': 100000, 'passive.rental_allowance_phaseout_end.standard': 150000,
};

const allMonths = (): boolean[] => Array(12).fill(true) as boolean[];
const person = (personId: string, role: 'primary' | 'spouse', dateOfBirth: string, over: Partial<EnginePerson> = {}): EnginePerson => ({
  personId, role, displayName: personId, dateOfBirth, isBlind: false, sehiEligibleMonths: allMonths(), w2Wages: '0', w2SocialSecurityWages: null, withholding: '0',
  retirementPlan: 'none', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' }, ...over,
});
const link = (linkId: string, personId: string, over: Partial<EngineLink> = {}): EngineLink => ({
  linkId, personId, profitPct: 100, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active', activeParticipation: false, qbiEligible: null, allowedLossOverride: null, ...over,
});
const entity = (companyId: string, over: Partial<EngineEntity>): EngineEntity => ({
  tenantId: 't', companyId, companyName: companyId, entityType: 'partnership', monthsElapsed: 12, monthsRemaining: 0,
  ytd: characters({}), recurringYtd: characters({}), ownerItems: [], guaranteedPayments: [], officerWages: [], taxDepreciationBookYtd: '0',
  links: [], isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null, warnings: [], ...over,
});
const adjBase: EngineAdjustment = { id: '', label: '', typeCode: null, kind: 'income', amount: '0', pct: null, personId: null, linkId: null, affectsSe: false, affectsQbi: false, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false, isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false };
const yearBase: FederalEngineInput['year'] = { rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto', itemized: { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' }, creditsNonrefundable: '0', creditsRefundable: '0', unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false };
const inputBase = (fs: FederalEngineInput['filingStatus'], persons: EnginePerson[], entities: EngineEntity[], year: Partial<FederalEngineInput['year']> = {}, adjustments: EngineAdjustment[] = []): FederalEngineInput =>
  ({ taxYear: 2026, filingStatus: fs, parameters: params, persons, entities, adjustments, year: { ...yearBase, ...year }, qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null } });
const codes = (r: ReturnType<typeof computeFederal>) => new Set(r.warnings.map((w) => w.code));

// ── Hale (MFJ, §199A phase-in range) ─────────────────────────────────
const DANA = 'dana'; const EVAN = 'evan';
function hale(qdViaAdjustment = false): FederalEngineInput {
  const books = qdViaAdjustment ? { interest: '5000', capital_gain_lt: '60000' } : { interest: '5000', dividends_qualified: '20000', capital_gain_lt: '60000' };
  return inputBase('mfj',
    [person(DANA, 'primary', '1960-03-15', { w2Wages: '170000' }), person(EVAN, 'spouse', '1962-07-04')],
    [
      entity('scorp', { entityType: 's_corp', ytd: characters({ ordinary: '150000' }), recurringYtd: characters({ ordinary: '150000' }), officerWages: [{ personId: EVAN, amount: '50000' }], w2WagesEffective: '50000', ubia: '100000', links: [link('l-scorp', EVAN, { isOfficer: true })] }),
      entity('sstb', { ytd: characters({ ordinary: '200000' }), recurringYtd: characters({ ordinary: '200000' }), isSstb: true, w2WagesEffective: '300000', ubia: '0', links: [link('l-sstb', DANA, { profitPct: 50, partnerSeStatus: 'general' })] }),
      entity('rental', { ytd: characters({ rental: '-40000' }), recurringYtd: characters({ rental: '-40000' }), links: [link('l-rental', DANA, { partnerSeStatus: 'limited', activityType: 'rental', activeParticipation: true })] }),
      entity('k1', { ytd: characters({ ordinary: '10000' }), recurringYtd: characters({ ordinary: '10000' }), w2WagesEffective: '0', ubia: '0', links: [link('l-k1', DANA, { partnerSeStatus: 'limited', activityType: 'passive' })] }),
      entity('inv', { ytd: characters(books), recurringYtd: characters(books), links: [link('l-inv', DANA, { partnerSeStatus: 'limited', activityType: 'investment' })] }),
    ],
    { itemized: { saltPaid: '60000', mortgageInterest: '30000', charitableCash: '25000', charitableNoncash: '0', other: '0' } },
    qdViaAdjustment ? [{ ...adjBase, id: 'qd', label: 'Qualified dividends', kind: 'income', amount: '20000', isQualifiedDividend: true, personId: DANA }] : [],
  );
}

describe('Hale fixture — MFJ 2026, taxable income in the §199A phase-in range', () => {
  const r = computeFederal(hale());

  it('income by character: dividends are the qualified bucket alone (R2-01); rental −40,000 netted against 10,000 passive income', () => {
    // wages 170,000 (Dana) + 50,000 (Evan officer) = 220,000; business ordinary 150,000 + 100,000 + 10,000 = 260,000;
    // rental −10,000 after §469; interest 5,000; dividends 20,000 (all qualified); net LTCG 60,000 → 555,000.
    expect(r.income.wages).toBe('220000');
    expect(r.income.businessOrdinary).toBe('260000');
    expect(r.income.rental).toBe('-10000');
    expect(r.income.dividends).toBe('20000');
    expect(r.income.qualifiedDividends).toBe('20000');
    expect(r.income.capitalGainNet).toBe('60000');
    expect(r.income.totalIncome).toBe('555000');
  });

  it('§469: passive income 10,000 absorbs part of the rental loss; the §469(i) allowance is fully phased out at this MAGI', () => {
    // passive losses 40,000 − passive income 10,000 = 30,000 excess; eligible active-participation loss min(40,000, 30,000) = 30,000;
    // MAGI (AGI without passive losses) = 552,761.925 ≥ 150,000 → allowance 0 → 30,000 suspended, all on the rental.
    const l = r.lossLimitations;
    expect(l.passiveIncome).toBe('10000');
    expect(l.passiveLosses).toBe('40000');
    expect(l.rentalAllowance).toMatchObject({ variant: 'standard', eligibleLoss: '30000', afterPhaseOut: '0', used: '0', magi: '552762' });
    expect(l.suspendedPassiveLoss).toBe('30000');
    expect(l.shares.find((s) => s.linkId === 'l-rental')).toMatchObject({ passiveSuspended: '30000', allowed: '-10000' });
    expect(l.shares.find((s) => s.linkId === 'l-k1')).toMatchObject({ passiveSuspended: '0', allowed: '10000' });
    expect(l.excessBusinessLoss).toBe('0');
    expect(r.entities.find((e) => e.companyId === 'rental')!.shares[0]!.shareAfterLossLimits.rental).toBe('-10000');
  });

  it('SE tax on Dana\'s 100,000 general-partner share against the wage base left after 170,000 of W-2 wages', () => {
    // NESE 100,000 × 0.9235 = 92,350; SS 0.124 × min(92,350, 184,500 − 170,000 = 14,500) = 1,798; Medicare 0.029 × 92,350 = 2,678.15 → 4,476.15; ½ = 2,238.075.
    const dana = r.persons.find((p) => p.personId === DANA)!;
    expect(dana.nese).toBe('92350');
    expect(dana.seTaxSocialSecurity).toBe('1798');
    expect(r.seTax).toBe('4476');
    expect(r.adjustmentsToIncome.halfSeTax).toBe('2238');
    expect(r.exact.agi).toBe('552761.925'); // 555,000 − 2,238.075
    expect(r.agi).toBe('552762');
  });

  it('itemized beats standard: SALT cap phased down 30% of the excess over 505,000, charitable less the 0.5% floor, no §68 below the 37% bracket', () => {
    // SALT cap 40,400 − 0.3 × (552,761.925 − 505,000 = 47,761.925) = 40,400 − 14,328.5775 = 26,071.4225 (paid 60,000)
    // charitable 25,000 − 0.005 × 552,761.925 = 25,000 − 2,763.809625 = 22,236.190375; mortgage 30,000 → 78,307.612875
    // standard would be 32,200 + 1,650 (Dana 66) + 2,000 non-itemizer charitable = 35,850.
    expect(r.deductions.chosen).toBe('itemized');
    expect(r.deductions.itemized.saltCap).toBe('26071');
    expect(r.deductions.itemized.saltAllowed).toBe('26071');
    expect(r.deductions.itemized.charitableFloor).toBe('2764');
    expect(r.deductions.itemized.charitableAllowed).toBe('22236');
    expect(r.deductions.itemized.benefitCapReduction).toBe('0');
    expect(r.exact.deduction).toBe('78307.612875');
    expect(r.deductions.deduction).toBe('78308');
    expect(r.deductions.standard.total).toBe('35850');
    expect(codes(r).has('TE_SALT_PHASED_DOWN')).toBe(true);
  });

  it('Schedule 1-A: Dana is 66 but the senior deduction is fully phased out (6,000 − 6% × (MAGI − 150,000) < 0)', () => {
    expect(r.deductions.sch1a.inEffect).toBe(true);
    expect(r.deductions.sch1a.senior).toBe('0');
    expect(r.deductions.sch1a.total).toBe('0');
  });

  it('§199A: phase-in 0.473029, W-2/UBIA limit phased in on the S corp, SSTB applicable percentage, zero-limit passive K-1', () => {
    // TI before QBI (pre-§68 itemized, Q32) = 552,761.925 − 78,307.612875 = 474,454.312125; excess over 403,500 = 70,954.312125; ÷ 150,000 = 0.4730287475.
    // S corp: QBI 150,000 → tentative 30,000; limit max(0.5 × 50,000 = 25,000; 0.25 × 50,000 + 0.025 × 100,000 = 15,000) = 25,000;
    //         component 30,000 − (30,000 − 25,000) × 0.4730287475 = 27,634.8562625.
    // SSTB:   QBI 100,000 − ½ SE 2,238.075 = 97,761.925 × applicable (1 − 0.4730287475 = 0.5269712525) = 51,517.7240640610625; tentative 10,303.5448128…;
    //         W-2 150,000 × 0.5269712525 = 79,045.69 → limit 39,522.84 > tentative → component 10,303.5448128….
    // K-1:    QBI 10,000 → tentative 2,000; W-2 0 / UBIA 0 → limit 0 → 2,000 − 2,000 × 0.4730287475 = 1,053.942505.
    // Σ = 38,992.3435803…; overall limit 0.2 × (474,454.312125 − (60,000 + 20,000)) = 78,890.862425 → deduction 38,992.
    expect(r.qbi.method).toBe('computed');
    expect(r.qbi.taxableIncomeBeforeQbi).toBe('474454');
    expect(r.qbi.phaseInFraction).toBe('0.473029');
    const comp = (id: string) => r.qbi.components.find((c) => c.linkId === id)!;
    expect(comp('l-scorp')).toMatchObject({ eligible: true, limitApplied: true, wageUbiaLimit: '25000', tentative: '30000', component: '27635' });
    expect(comp('l-sstb')).toMatchObject({ eligible: true, sstb: true, component: '10304', limitApplied: false });
    expect(comp('l-k1')).toMatchObject({ eligible: true, wageUbiaLimit: '0', component: '1054' });
    expect(comp('l-rental').eligible).toBe(false);
    expect(comp('l-inv').eligible).toBe(false);
    expect(r.qbi.overallLimit).toBe('78891');
    expect(r.qbi.deduction).toBe('38992');
    expect(codes(r).has('TE_QBI_SSTB_PHASED')).toBe(true);
    expect(codes(r).has('TE_QBI_W2_WAGES_MISSING')).toBe(false);
    expect(codes(r).has('TE_QBI_UBIA_MISSING')).toBe(false);
  });

  it('regular tax: QD 20,000 + LTCG 60,000 all at 15%, ordinary portion in the 24% bracket', () => {
    // TI = 474,454.312125 − 38,992.3435803… = 435,461.968544…; preferential 80,000; ordinary portion 355,461.968544…
    // ordinary tax 2,480 + 9,120 + 24,332 + 0.24 × (355,461.968544 − 211,400 = 144,061.968544) = 70,506.872450…; + 80,000 × 15% = 12,000 → 82,506.87 → 82,507.
    expect(r.taxableIncome).toBe('435462');
    expect(r.regularTax.worksheet).toMatchObject({ preferentialIncome: '80000', taxedAtZero: '0', taxedAtFifteen: '80000', taxedAtTwenty: '0', ordinaryPortion: '355462' });
    expect(r.regularTax.tax).toBe('82507');
    expect(r.regularTax.marginalOrdinaryRate).toBe('0.24');
    expect(r.regularTax.marginalCapitalGainRate).toBe('0.15');
  });

  it('Additional Medicare on NESE above the threshold left by wages; NIIT on interest + dividends + gains + rental + passive K-1', () => {
    // Medicare wages 170,000 + 50,000 = 220,000 < 250,000; NESE 92,350 − (250,000 − 220,000) = 62,350 × 0.009 = 561.15.
    // NII 5,000 + 20,000 + 60,000 − 10,000 + 10,000 = 85,000 ≤ MAGI − 250,000 → 85,000 × 0.038 = 3,230.
    expect(r.otherTaxes.additionalMedicare).toMatchObject({ medicareWages: '220000', wagesAboveThreshold: '0', neseAboveThreshold: '62350' });
    expect(r.additionalMedicareTax).toBe('561');
    expect(r.otherTaxes.niit).toMatchObject({ interest: '5000', dividends: '20000', capitalGains: '60000', rental: '-10000', passiveOrdinary: '10000', netInvestmentIncome: '85000', base: '85000' });
    expect(r.niit).toBe('3230');
    // federal total 82,506.87 + 4,476.15 + 561.15 + 3,230 = 90,774.17
    expect(r.federalTotal).toBe('90774');
  });

  it('R2-01 property: the same qualified dividends entered as an adjustment give the same return', () => {
    const viaAdj = computeFederal(hale(true));
    for (const k of ['totalIncome', 'agi', 'deduction', 'qbi', 'taxableIncome', 'regularTax', 'niit', 'federalTotal'] as const) expect(viaAdj.exact[k]).toBe(r.exact[k]);
    expect(viaAdj.income.dividends).toBe('20000');
    expect(viaAdj.income.qualifiedDividends).toBe('20000');
  });
});

// ── Okafor (MFJ, top bracket) ─────────────────────────────────────────
const FEMI = 'femi'; const NGOZI = 'ngozi';
const okafor = (): FederalEngineInput => inputBase('mfj',
  [person(FEMI, 'primary', '1959-06-01', { w2Wages: '1000000', w2SocialSecurityWages: '1000000' }), person(NGOZI, 'spouse', '1970-01-01')],
  [
    entity('schc', { entityType: 'sch_c', ytd: characters({ ordinary: '-700000' }), recurringYtd: characters({ ordinary: '-700000' }), w2WagesEffective: '0', ubia: '0', links: [link('l-schc', NGOZI)] }),
    entity('sstb', { ytd: characters({ ordinary: '200000' }), recurringYtd: characters({ ordinary: '200000' }), isSstb: true, w2WagesEffective: '300000', ubia: '0', links: [link('l-sstb', FEMI, { profitPct: 50, partnerSeStatus: 'general' })] }),
    entity('inv', { ytd: characters({ interest: '20000', dividends_qualified: '50000', capital_gain_lt: '300000' }), recurringYtd: characters({ interest: '20000', dividends_qualified: '50000', capital_gain_lt: '300000' }), links: [link('l-inv', FEMI, { partnerSeStatus: 'limited', activityType: 'investment' })] }),
  ],
  { itemized: { saltPaid: '80000', mortgageInterest: '40000', charitableCash: '100000', charitableNoncash: '0', other: '0' } },
);

describe('Okafor fixture — MFJ 2026, top bracket with a §461(l) excess business loss', () => {
  const r = computeFederal(okafor());

  it('§461(l): Sch C −700,000 + SSTB 100,000 = −600,000 business loss; 88,000 over the 512,000 threshold is added back', () => {
    expect(r.lossLimitations.businessNet).toBe('-600000');
    expect(r.lossLimitations.eblThreshold).toBe('512000');
    expect(r.lossLimitations.excessBusinessLoss).toBe('88000');
    // business ordinary −700,000 + 100,000 + 88,000 = −512,000; total 1,000,000 − 512,000 + 20,000 + 50,000 + 300,000 = 858,000
    expect(r.income.businessOrdinary).toBe('-512000');
    expect(r.income.totalIncome).toBe('858000');
    expect(codes(r).has('TE_EXCESS_BUSINESS_LOSS')).toBe(true);
    expect(codes(r).has('TE_EBL_QBI_TIMING')).toBe(true); // R2-20 note
  });

  it('SE tax: wages already exceed the wage base, so only Medicare on Femi\'s NESE; Ngozi\'s loss gives no SE tax', () => {
    // NESE 92,350 × 0.029 = 2,678.15; ½ = 1,339.075; AGI 858,000 − 1,339.075 = 856,660.925
    expect(r.seTax).toBe('2678');
    expect(r.persons.find((p) => p.personId === NGOZI)!.seTax).toBe('0');
    expect(r.exact.agi).toBe('856660.925');
  });

  it('itemized: SALT at the 10,000 floor, charitable less 0.5% of AGI, then the §68 2/37 reduction on the lesser of itemized or TI over 768,700', () => {
    // SALT: 40,400 − 0.3 × 351,660.925 < 10,000 → floor 10,000. Charitable 100,000 − 4,283.304625 = 95,716.695375. Before cap 145,716.695375.
    // §68 base = AGI − Sch 1-A − QBI = 856,660.925; over 768,700 = 87,960.925 (the lesser); × 2/37 = 4,754.644594594595 → total 140,962.050780405405.
    expect(r.deductions.chosen).toBe('itemized');
    expect(r.deductions.itemized.saltCap).toBe('10000');
    expect(r.deductions.itemized.charitableFloor).toBe('4283');
    expect(r.deductions.itemized.charitableAllowed).toBe('95717');
    expect(r.deductions.itemized.beforeBenefitCap).toBe('145717');
    expect(r.deductions.itemized.benefitCapReduction).toBe('4755');
    expect(r.exact.deduction).toBe('140962.050780405405');
    expect(r.deductions.sch1a.senior).toBe('0'); // Femi is 67; phased out
    expect(codes(r).has('TE_ITEMIZED_BENEFIT_CAPPED')).toBe(true);
    expect(codes(r).has('TE_QBI_PRE_68_BASIS')).toBe(true);
  });

  it('§199A: SSTB excluded above the phase-in range; the Sch C loss is a net QBI loss carried forward; deduction 0', () => {
    // TI before QBI (pre-§68) = 856,660.925 − 145,716.695375 = 710,944.229625 > 553,500 → phase-in 1.
    expect(r.qbi.phaseInFraction).toBe('1');
    expect(r.qbi.components.find((c) => c.linkId === 'l-sstb')).toMatchObject({ eligible: false, reason: expect.stringMatching(/above the phase-in range/) });
    expect(r.qbi.components.find((c) => c.linkId === 'l-schc')).toMatchObject({ eligible: true, qbi: '-700000', component: '0' });
    expect(r.qbi.netLossCarryforward).toBe('700000');
    expect(r.qbi.deduction).toBe('0');
    expect(codes(r).has('TE_QBI_NET_LOSS_CARRYFORWARD')).toBe(true);
  });

  it('regular tax: QD 50,000 + LTCG 300,000 split 248,001 at 15% / 101,999 at 20% around the 613,700 breakpoint', () => {
    // TI = 856,660.925 − 140,962.050780405405 = 715,698.874219594595; ordinary portion 365,698.874219594595.
    // ordinary tax 2,480 + 9,120 + 24,332 + 0.24 × 154,298.874219594595 = 72,963.729812702703; 15%: 613,700 − 365,698.874… = 248,001.125780405405 → 37,200.168867060811;
    // 20%: 350,000 − 248,001.125… = 101,998.874219594595 → 20,399.774843918919; total 130,563.673523682432 → 130,564.
    expect(r.exact.taxableIncome).toBe('715698.874219594595');
    expect(r.regularTax.worksheet).toMatchObject({ preferentialIncome: '350000', taxedAtZero: '0', taxedAtFifteen: '248001', taxedAtTwenty: '101999', ordinaryPortion: '365699' });
    expect(r.regularTax.tax).toBe('130564');
    expect(r.regularTax.marginalCapitalGainRate).toBe('0.2');
  });

  it('Additional Medicare on 750,000 of wages above the threshold plus all of the NESE; NIIT on 370,000; federal total 154,883', () => {
    // 0.009 × (750,000 + 92,350) = 7,581.15; NIIT 0.038 × 370,000 = 14,060; total 130,563.67 + 2,678.15 + 7,581.15 + 14,060 = 154,882.97.
    expect(r.otherTaxes.additionalMedicare).toMatchObject({ wagesAboveThreshold: '750000', neseAboveThreshold: '92350' });
    expect(r.additionalMedicareTax).toBe('7581');
    expect(r.otherTaxes.niit.netInvestmentIncome).toBe('370000');
    expect(r.niit).toBe('14060');
    expect(r.federalTotal).toBe('154883');
  });
});

// ── Quinn (single, §469(i) allocation) ───────────────────────────────
const SAM = 'sam';
const quinn = (): FederalEngineInput => inputBase('single',
  [person(SAM, 'primary', '1985-02-02', { w2Wages: '40000', w2SocialSecurityWages: '40000' })],
  [
    entity('schc', { entityType: 'sch_c', ytd: characters({ ordinary: '50000' }), recurringYtd: characters({ ordinary: '50000' }), w2WagesEffective: '0', ubia: '0', links: [link('l-schc', SAM)] }),
    entity('rental', { ytd: characters({ rental: '-20000' }), recurringYtd: characters({ rental: '-20000' }), links: [link('l-rental', SAM, { partnerSeStatus: 'limited', activityType: 'rental', activeParticipation: true })] }),
    entity('biz', { ytd: characters({ ordinary: '-20000' }), recurringYtd: characters({ ordinary: '-20000' }), w2WagesEffective: '0', ubia: '0', links: [link('l-biz', SAM, { partnerSeStatus: 'limited', activityType: 'passive' })] }),
  ],
);

describe('Quinn fixture — single 2026, §469(i) allowance goes to the rental first (R2-03)', () => {
  const r = computeFederal(quinn());

  it('the 25,000 allowance (MAGI 86,468 < 100,000) covers the whole rental loss; the passive business loss is suspended in full', () => {
    // SE: 50,000 × 0.9235 = 46,175; SS 0.124 × min(46,175, 144,500) = 5,725.7; Medicare 1,339.075 → 7,064.775; ½ 3,532.3875.
    // MAGI without passive losses = 40,000 + 50,000 − 3,532.3875 = 86,467.6125.
    expect(r.lossLimitations.rentalAllowance).toMatchObject({ variant: 'standard', afterPhaseOut: '25000', eligibleLoss: '20000', used: '20000', magi: '86468' });
    expect(r.lossLimitations.suspendedPassiveLoss).toBe('20000');
    expect(r.lossLimitations.shares.find((s) => s.linkId === 'l-rental')).toMatchObject({ passiveSuspended: '0', allowed: '-20000' });
    expect(r.lossLimitations.shares.find((s) => s.linkId === 'l-biz')).toMatchObject({ passiveSuspended: '20000', allowed: '0' });
    expect(r.income.rental).toBe('-20000');
    expect(r.income.businessOrdinary).toBe('50000');
    expect(r.entities.find((e) => e.companyId === 'biz')!.shares[0]!.shareAfterLossLimits.ordinary).toBe('0');
    expect(r.entities.find((e) => e.companyId === 'biz')!.shares[0]!.share.ordinary).toBe('-20000');
  });

  it('§199A sees the Sch C alone (the suspended business loss does not net against it): 20% × (50,000 − 3,532.3875) = 9,293.52', () => {
    // AGI 70,000 − 3,532.3875 = 66,467.6125; standard 16,100; TI before QBI 50,367.6125; overall limit 10,073.5225 > 9,293.5225.
    // (Before R2-03 the business showed −10,000 allowed, netted to 36,467.61 of QBI → 7,293.52.)
    expect(r.agi).toBe('66468');
    expect(r.qbi.components.find((c) => c.linkId === 'l-biz')).toMatchObject({ eligible: true, qbi: '0', component: '0' });
    expect(r.qbi.components.find((c) => c.linkId === 'l-schc')).toMatchObject({ qbi: '46468', component: '9294' });
    expect(r.qbi.deduction).toBe('9294');
    // TI 50,367.6125 − 9,293.5225 = 41,074.09; tax 1,240 + 0.12 × 28,674.09 = 4,680.8908 → 4,681; total + SE 7,064.775 = 11,745.67.
    expect(r.taxableIncome).toBe('41074');
    expect(r.regularTax.tax).toBe('4681');
    expect(r.seTax).toBe('7065');
    expect(r.niit).toBe('0');
    expect(r.federalTotal).toBe('11746');
  });
});

describe('fixture parameters', () => {
  it('the seed values the hand computations rely on are the shipped ones', () => {
    const drift = Object.entries(SEED_USED).filter(([k, v]) => JSON.stringify(params[k]?.value) !== JSON.stringify(v)).map(([k]) => k);
    expect(drift).toEqual([]);
  });
});

describe('R7-12 — TE_SS_WAGES_DEFAULTED carries its dollar effect', () => {
  it('a warning with the SE Social Security amount at stake when the defaulted wages leave room under the wage base (Hale: Dana)', () => {
    // Dana: box 1 170,000, no SS wages entered; wage base 184,500 − 170,000 = 14,500 left → SE SS 0.124 × 14,500 = 1,798 at most overstated.
    const w = computeFederal(hale()).warnings.find((x) => x.code === 'TE_SS_WAGES_DEFAULTED' && x.details?.['personId'] === DANA);
    expect(w?.severity).toBe('warning');
    expect(w?.message).toContain('1,798');
    expect(w?.details?.['maxOverstatement']).toBe('1798');
  });
  it('stays an info when the box 1 wages alone already use the whole wage base (Okafor: no SE Social Security to overstate)', () => {
    const input = okafor();
    input.persons[0]!.w2SocialSecurityWages = null; // Femi: box 1 1,000,000 > wage base
    const w = computeFederal(input).warnings.find((x) => x.code === 'TE_SS_WAGES_DEFAULTED');
    expect(w?.severity).toBe('info');
  });
});
