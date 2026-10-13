// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bridge from the Phase 3–5 API DTOs to the engine input. Pure mapping, no
// tax judgment: the service fetches TaxBasisPl per linked company, the links,
// persons, year settings and the scenario's adjustments (joined to their
// types), and calls these builders. Kept in the engine so the shapes cannot
// drift apart; services never assemble FederalEngineInput by hand.

import { INCOME_CHARACTERS, type CharacterAmounts, type TaxBasisPl } from '../entities-api.js';
import { OUTSIDE_TENANT_ID, outsideLinkId, type OutsideEntityDTO, type OutsideEntityYearDTO } from '../outside-entities-api.js';
import type { DependentDTO, LinkDTO, PersonDTO } from '../taxpayers-api.js';
import type { AdjustmentDTO, AdjustmentTypeDTO, YearSettingsDTO } from '../years-api.js';
import { ZERO, dDiv, dIsZero, dMul, dSum, dec, type Dec } from '../decimal.js';
import type { EngineAdjustment, EngineDependent, EngineEntity, EngineItemized, EnginePerson, EngineYearInputs, RetirementPlanType } from './types.js';

const num = (v: number | string | null | undefined): Dec => (v == null || v === '' ? ZERO : dec(v));

export interface EntitySettingsForEngine {
  isSstb: boolean;
  rentalQbiTradeOrBusiness: boolean;
}

/** One linked company's tax-basis P&L + its links (for this taxpayer and year) → engine entity. */
export function engineEntityFromTaxBasisPl(pl: TaxBasisPl, links: ReadonlyArray<LinkDTO>, settings: EntitySettingsForEngine): EngineEntity {
  if (!pl.entityType) throw new Error(`TE_ENTITY_TYPE_MISSING: ${pl.companyName} has no tax entity type`);
  const own = links.filter((l) => l.tenantId === pl.tenantId && l.companyId === pl.companyId && l.taxYear === pl.taxYear && !l.outOfScope);
  return {
    tenantId: pl.tenantId,
    companyId: pl.companyId,
    companyName: pl.companyName,
    entityType: pl.entityType,
    monthsElapsed: pl.monthsElapsed,
    monthsRemaining: pl.monthsRemaining,
    ytd: pl.byCharacter,
    recurringYtd: pl.recurring,
    ownerItems: pl.ownerLevel.byPerson.map((o) => ({ personId: o.personId, sehi: o.ownerSehi, retirement: o.ownerRetirement, sehiAsW2Wages: o.sehiAsW2Wages })),
    guaranteedPayments: pl.guaranteedPayments.map((g) => ({ personId: g.personId, amount: g.amount })),
    officerWages: pl.w2Wages.byPerson.map((w) => ({ personId: w.personId, amount: w.ytd })),
    taxDepreciationBookYtd: dSum(pl.taxDepreciationDiffers.map((d) => d.bookAmount)),
    links: own.map((l) => ({
      linkId: l.id, personId: l.personId, profitPct: l.profitPct, lossPct: l.lossPct, partnerSeStatus: l.partnerSeStatus, isOfficer: l.isOfficer,
      activityType: l.activityType, activeParticipation: l.activeParticipation, qbiEligible: l.qbiEligible, allowedLossOverride: l.allowedLossOverride,
    })),
    isSstb: settings.isSstb,
    rentalQbiTradeOrBusiness: settings.rentalQbiTradeOrBusiness,
    w2WagesEffective: pl.w2Wages.effective,
    includeSehiInW2Wages: pl.w2Wages.includeSehiInW2Wages ?? false,
    ubia: pl.ubia,
    warnings: pl.warnings,
  };
}

// ── Businesses outside MyBooks (Q45) ─────────────────────────────────

const FULL_YEAR_MONTHS = 12;

function enteredCharacters(a: Partial<Record<string, string | number | null>> | null | undefined): CharacterAmounts {
  return Object.fromEntries(INCOME_CHARACTERS.map((k) => [k, num(a?.[k])])) as CharacterAmounts;
}

/**
 * Q45: one outside business (definition) + one tax year's amounts → engine entity, so every
 * engine step treats it exactly like a linked business.
 *  - `full_year`: monthsElapsed 12 / remaining 0 → the amounts are used as entered.
 *  - `ytd`: monthsElapsed = through month, remaining = 12 − it → the engine projects YTD + YTD ÷
 *    elapsed × remaining; every amount is recurring (no non-recurring split for entered figures).
 *  - `owner_share`: the single owner link is sent with a blank % (= 100% for a sole link), so the engine allocates
 *    all of it (the stated % is informational and shown from the DTO); `entity_total`: the
 *    stated % (blank profit % = 100 for the single owner, blank loss % = the profit %).
 * Guaranteed payments, officer wages and owner items are the owner's own in both bases.
 */
export function engineEntityFromOutside(def: OutsideEntityDTO, year: OutsideEntityYearDTO): EngineEntity {
  const ytdMode = year.entryMode === 'ytd';
  const elapsed = ytdMode ? Math.min(FULL_YEAR_MONTHS, Math.max(1, year.throughMonth ?? FULL_YEAR_MONTHS)) : FULL_YEAR_MONTHS;
  const ownerShare = year.amountBasis === 'owner_share';
  const amounts = enteredCharacters(year.amounts as unknown as Record<string, string>);
  const pid = def.personId;
  const ownerItem = { personId: pid, sehi: num(year.ownerSehi), retirement: num(year.ownerRetirement), sehiAsW2Wages: def.entityType === 's_corp' ? num(year.sehiAsW2Wages) : ZERO };
  const hasOwnerItem = [ownerItem.sehi, ownerItem.retirement, ownerItem.sehiAsW2Wages].some((v) => !dIsZero(v));
  const gp = def.entityType === 'partnership' ? num(year.guaranteedPayments) : ZERO;
  const wages = def.entityType === 's_corp' ? num(year.officerWages) : ZERO;
  return {
    tenantId: OUTSIDE_TENANT_ID,
    companyId: def.id,
    companyName: def.name,
    entityType: def.entityType,
    monthsElapsed: elapsed,
    monthsRemaining: FULL_YEAR_MONTHS - elapsed,
    ytd: amounts,
    recurringYtd: amounts,
    ownerItems: hasOwnerItem ? [ownerItem] : [],
    guaranteedPayments: dIsZero(gp) ? [] : [{ personId: pid, amount: gp }],
    officerWages: dIsZero(wages) ? [] : [{ personId: pid, amount: wages }],
    taxDepreciationBookYtd: ZERO,
    links: [{
      linkId: outsideLinkId(def.id), personId: pid,
      // Owner's share: a blank % on the single owner link = 100% (income.ts linkFractions), so all of it is allocated.
      profitPct: ownerShare ? null : def.profitPct, lossPct: ownerShare ? null : def.lossPct,
      partnerSeStatus: def.entityType === 'partnership' ? def.partnerSeStatus : null, isOfficer: def.entityType === 's_corp' && def.isOfficer,
      activityType: def.activityType, activeParticipation: def.activityType === 'rental' && def.activeParticipation,
      qbiEligible: def.qbiEligible, allowedLossOverride: year.allowedLossOverride == null ? null : num(year.allowedLossOverride),
    }],
    isSstb: def.isSstb,
    rentalQbiTradeOrBusiness: def.rentalQbiTradeOrBusiness,
    w2WagesEffective: year.w2Wages == null ? null : num(year.w2Wages),
    includeSehiInW2Wages: def.entityType === 's_corp' && year.includeSehiInW2Wages,
    ubia: year.ubia == null ? null : num(year.ubia),
    warnings: [],
    source: 'outside',
    amountBasis: year.amountBasis,
    entryMode: year.entryMode,
  };
}

/**
 * Q45: Schedule AI period figures (Jan 1 → end of month `periodMonths`) of an outside business,
 * as the engine input for that column (annualizeFederalInput then scales them).
 *  - `full_year`: the entered amounts spread evenly by month (× periodMonths ÷ 12).
 *  - `ytd` through month T: the YTD prorated evenly (× periodMonths ÷ T) when the period ends by T;
 *    null (column unavailable — the installment falls back to the regular amount, like a linked
 *    business whose books do not reach the period end) when it ends after T.
 * §199A W-2 wages are a full-year figure (× periodMonths ÷ 12, like a linked W-2 override); UBIA is kept.
 */
export function outsidePeriodEntity(e: EngineEntity, periodMonths: number): EngineEntity | null {
  const ytdMode = e.entryMode === 'ytd';
  if (ytdMode && periodMonths > e.monthsElapsed) return null;
  const base = String(ytdMode ? e.monthsElapsed : FULL_YEAR_MONTHS);
  // Multiply first, then divide (exact for whole months: 60,000 × 5 ÷ 6 = 50,000).
  const scale = (v: string): Dec => dDiv(dMul(v, String(periodMonths)), base);
  const chars = (c: CharacterAmounts): CharacterAmounts => Object.fromEntries(INCOME_CHARACTERS.map((k) => [k, scale(c[k])])) as CharacterAmounts;
  return {
    ...e,
    monthsElapsed: periodMonths,
    monthsRemaining: FULL_YEAR_MONTHS - periodMonths,
    ytd: chars(e.ytd),
    recurringYtd: chars(e.recurringYtd),
    ownerItems: e.ownerItems.map((o) => ({ ...o, sehi: scale(o.sehi), retirement: scale(o.retirement), sehiAsW2Wages: scale(o.sehiAsW2Wages) })),
    guaranteedPayments: e.guaranteedPayments.map((g) => ({ ...g, amount: scale(g.amount) })),
    officerWages: e.officerWages.map((w) => ({ ...w, amount: scale(w.amount) })),
    taxDepreciationBookYtd: scale(e.taxDepreciationBookYtd),
    w2WagesEffective: e.w2WagesEffective == null ? null : dDiv(dMul(e.w2WagesEffective, String(periodMonths)), String(FULL_YEAR_MONTHS)),
  };
}

/**
 * Per-person year inputs the app collects (Annual settings → People, R7-01). R7-04: no
 * person-level withholding or HSA contribution input exists — withholding is year-level and
 * HSA contributions are adjustments — so EnginePerson.withholding / .hsaContribution are '0'.
 */
export interface PersonYearInputs {
  /** Outside W-2 wages (box 1) for the year; officer wages come from the entities. */
  w2Wages?: number | string | null;
  w2SocialSecurityWages?: number | string | null;
  retirementPlan?: RetirementPlanType | null;
  retirementEmployeeDeferral?: number | string | null;
}

export function enginePersonFromDto(p: PersonDTO, year: YearSettingsDTO, extra: PersonYearInputs = {}): EnginePerson {
  const sch1a = p.role === 'primary' ? year.sch1a.primary : year.sch1a.spouse;
  const hsa = p.role === 'primary' ? year.hsaCoverage.primary : year.hsaCoverage.spouse;
  return {
    personId: p.id,
    role: p.role,
    displayName: `${p.firstName} ${p.lastName}`.trim(),
    dateOfBirth: p.dateOfBirth,
    isBlind: p.isBlind,
    sehiEligibleMonths: [...p.sehiEligibleMonths],
    w2Wages: num(extra.w2Wages),
    w2SocialSecurityWages: extra.w2SocialSecurityWages == null ? null : num(extra.w2SocialSecurityWages),
    withholding: '0',
    retirementPlan: extra.retirementPlan ?? null,
    retirementEmployeeDeferral: extra.retirementEmployeeDeferral == null ? null : num(extra.retirementEmployeeDeferral),
    hsaCoverage: hsa ?? 'none',
    hsaContribution: '0',
    sch1a: { qualifiedTips: num(sch1a?.qualifiedTips), qualifiedOvertime: num(sch1a?.qualifiedOvertime), carLoanInterest: num(sch1a?.carLoanInterest) },
  };
}

/** Q44: a stored dependent → engine dependent (the engine applies the first / last tax-year window). */
export function engineDependentFromDto(d: DependentDTO): EngineDependent {
  return {
    dependentId: d.id, displayName: d.displayName, dateOfBirth: d.dateOfBirth, kind: d.kind,
    monthsLivedWith: d.monthsLivedWith, isStudent: d.isStudent, isDisabled: d.isDisabled,
    firstTaxYear: d.firstTaxYear, lastTaxYear: d.lastTaxYear,
  };
}

/** The adjustment's FULL-YEAR amount is the sum of its 12-month allocation (actuals + plan / run-rate). */
export function engineAdjustmentFromDto(a: AdjustmentDTO, type: Pick<AdjustmentTypeDTO, 'code' | 'kind' | 'affectsSe' | 'affectsQbi' | 'isCapitalGainLt' | 'isCapitalGainSt' | 'isQualifiedDividend' | 'isReitDividend' | 'isPtp' | 'is1231' | 'isAboveTheLine' | 'nonRecurring' | 'defaultPct'>): EngineAdjustment {
  return {
    id: a.id,
    label: a.label || a.adjustmentTypeName,
    typeCode: type.code,
    kind: type.kind,
    amount: dSum(a.monthly.map((m) => dec(m))),
    pct: a.pct ?? type.defaultPct,
    personId: a.personId,
    linkId: a.linkId,
    affectsSe: type.affectsSe,
    affectsQbi: type.affectsQbi,
    isCapitalGainLt: type.isCapitalGainLt,
    isCapitalGainSt: type.isCapitalGainSt,
    isQualifiedDividend: type.isQualifiedDividend,
    isReitDividend: type.isReitDividend,
    isPtp: type.isPtp,
    is1231: type.is1231,
    isAboveTheLine: type.isAboveTheLine,
    nonRecurring: a.nonRecurring || type.nonRecurring,
  };
}

export interface YearExtras {
  unrecaptured1250Gain?: number | string | null;
  collectiblesGain?: number | string | null;
  amtExposureFlagged?: boolean;
  /** §469(i)(5) MFS flag; default = YearSettingsDTO.mfsLivedApartAllYear (Phase 10b). */
  mfsLivedApartAllYear?: boolean;
}

/**
 * Phase 10b (Q28): the year's per-person inputs (YearSettingsDTO.personInputs, keyed
 * by role) → PersonYearInputs for enginePersonFromDto. Withholding stays at the
 * taxpayer level (the voucher path credits YearSettingsDTO.withholding.federal).
 */
export function personYearInputsFromDto(year: YearSettingsDTO, role: PersonDTO['role']): PersonYearInputs {
  const p = role === 'primary' ? year.personInputs?.primary : year.personInputs?.spouse;
  if (!p) return {};
  return {
    w2Wages: p.w2Wages ?? null,
    w2SocialSecurityWages: p.w2SocialSecurityWages ?? null,
    retirementPlan: p.retirementPlanType ?? null,
    retirementEmployeeDeferral: p.employeeDeferral ?? null,
  };
}

export function engineYearFromDto(y: YearSettingsDTO, extra: YearExtras = {}): EngineYearInputs {
  const itemized: EngineItemized = {
    saltPaid: num(y.itemized.saltPaid), mortgageInterest: num(y.itemized.mortgageInterest), charitableCash: num(y.itemized.charitableCash),
    charitableNoncash: num(y.itemized.charitableNoncash), other: num(y.itemized.other),
  };
  return {
    rateMode: y.rateMode,
    effectiveRateOverride: y.effectiveRateOverride == null ? null : dec(y.effectiveRateOverride),
    deductionMode: y.deductionMode,
    itemized,
    creditsNonrefundable: num(y.creditsNonrefundable),
    creditsRefundable: num(y.creditsRefundable),
    careExpenses: num(y.careExpenses),
    unrecaptured1250Gain: num(extra.unrecaptured1250Gain),
    collectiblesGain: num(extra.collectiblesGain),
    amtExposureFlagged: extra.amtExposureFlagged ?? false,
    mfsLivedApartAllYear: extra.mfsLivedApartAllYear ?? y.mfsLivedApartAllYear ?? false,
  };
}
