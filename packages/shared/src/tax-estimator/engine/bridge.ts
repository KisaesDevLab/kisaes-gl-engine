// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bridge from the Phase 3–5 API DTOs to the engine input. Pure mapping, no
// tax judgment: the service fetches TaxBasisPl per linked company, the links,
// persons, year settings and the scenario's adjustments (joined to their
// types), and calls these builders. Kept in the engine so the shapes cannot
// drift apart; services never assemble FederalEngineInput by hand.

import type { TaxBasisPl } from '../entities-api.js';
import type { LinkDTO, PersonDTO } from '../taxpayers-api.js';
import type { AdjustmentDTO, AdjustmentTypeDTO, YearSettingsDTO } from '../years-api.js';
import { ZERO, dSum, dec, type Dec } from '../decimal.js';
import type { EngineAdjustment, EngineEntity, EngineItemized, EnginePerson, EngineYearInputs, RetirementPlanType } from './types.js';

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
    ubia: pl.ubia,
    warnings: pl.warnings,
  };
}

export interface PersonYearInputs {
  /** Outside W-2 wages (box 1) for the year; officer wages come from the entities. */
  w2Wages?: number | string | null;
  w2SocialSecurityWages?: number | string | null;
  withholding?: number | string | null;
  retirementPlan?: RetirementPlanType | null;
  retirementEmployeeDeferral?: number | string | null;
  /** HSA contributions not captured as an adjustment. */
  hsaContribution?: number | string | null;
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
    withholding: num(extra.withholding),
    retirementPlan: extra.retirementPlan ?? null,
    retirementEmployeeDeferral: extra.retirementEmployeeDeferral == null ? null : num(extra.retirementEmployeeDeferral),
    hsaCoverage: hsa ?? 'none',
    hsaContribution: num(extra.hsaContribution),
    sch1a: { qualifiedTips: num(sch1a?.qualifiedTips), qualifiedOvertime: num(sch1a?.qualifiedOvertime), carLoanInterest: num(sch1a?.carLoanInterest) },
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
    unrecaptured1250Gain: num(extra.unrecaptured1250Gain),
    collectiblesGain: num(extra.collectiblesGain),
    amtExposureFlagged: extra.amtExposureFlagged ?? false,
  };
}
