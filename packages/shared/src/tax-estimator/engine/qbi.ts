// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 9 — §199A qualified business income deduction, full:
//   * one component per qualifying link: qualified items (ordinary + rental when
//     the entity is a §162 rental + the §1231 share when the taxpayer's net §1231
//     is a loss; guaranteed payments, officer wages, interest, dividends and
//     gains are never QBI; link adjustments flagged affects_qbi = false are
//     backed out) less the ½ SE tax, SEHI and retirement deductions attributable
//     to the business (allocated across the person's businesses by SE income /
//     by the business that paid the premium — Reg. 1.199A-3(b)(1)(vi));
//   * threshold and phase-in on taxable income before QBI (pre-§68 deduction,
//     Q32): below the threshold the component is rate × QBI; above threshold +
//     range it is min(rate × QBI, max(50% W-2, 25% W-2 + 2.5% UBIA)); in the
//     range the excess over the limit is phased in. SSTB: QBI, W-2 and UBIA are
//     multiplied by the applicable percentage (1 − phase-in fraction), nothing
//     above the range. W-2 wages = the entity's full-year w2_wages total /
//     override × the link's profit fraction (D8); UBIA manual, blank → the UBIA
//     limb is not computed and a warning is raised (D8);
//   * loss netting within the year (Reg. 1.199A-1(d)(2)(iii)): a loss business
//     reduces the positive businesses pro rata, its W-2 / UBIA are disregarded;
//     a net loss carries forward (not tracked, noted);
//   * REIT dividends / PTP income component (no W-2 / UBIA limit);
//   * overall limit = rate × (taxable income before QBI − net capital gain incl.
//     qualified dividends); minimum deduction (§199A(i)) when active QBI ≥ the
//     parameter threshold; `manualDeduction` overrides the result (kept as
//     computedDeduction for comparison).

import { INCOME_CHARACTERS } from '../entities-api.js';
import {
  ZERO, ONE, dAbs, dAdd, dClamp, dCmp, dDiv, dFloorZero, dIsNeg, dIsPos, dIsZero, dMax, dMin, dMul, dNeg, dSub, dSum, dec, percentToFraction, type Dec,
} from '../decimal.js';
import type { EngineContext } from './context.js';
import { adjustmentCharacter, entityId, type AggregatedIncome, type AllocatedEntity, type AllocatedShare } from './income.js';
import type { EngineAdjustment, QbiComponentResult, QbiInput, QbiResult } from './types.js';

const STEP_QBI = 'qbi';

export interface QbiPersonDeductions {
  halfSeTax: Dec;
  sehi: Dec;
  retirement: Dec;
}

export interface QbiContext {
  /** AGI − pre-§68 deduction − Schedule 1-A (taxable income before the QBI deduction, Q32). */
  taxableIncomeBeforeQbi: Dec;
  /** Net capital gain including qualified dividends (overall-limit subtraction). */
  netCapitalGainWithQd: Dec;
  /** Income after loss limitations (step 3). */
  income: AggregatedIncome;
  entities: ReadonlyArray<AllocatedEntity>;
  adjustments: ReadonlyArray<EngineAdjustment>;
  /** Step 4–6 deductions per person, attributable to the businesses. */
  personDeductions: ReadonlyMap<string, QbiPersonDeductions>;
  /** Taxpayer net §1231: a gain is capital (not QBI), a loss is ordinary (QBI). */
  section1231Net: Dec;
}

export type QbiExact = QbiResult;

interface Component extends QbiComponentResult {
  share: AllocatedShare;
}

/** Signed effect of a link adjustment on the share's ordinary character (mirrors income.ts). */
function ordinaryEffect(a: EngineAdjustment): Dec {
  if (a.kind === 'deduction') return dNeg(a.amount);
  if (a.kind === 'addback') return dMul(a.amount, a.pct == null ? ONE : percentToFraction(a.pct));
  return adjustmentCharacter(a) === 'ordinary' ? dec(a.amount) : ZERO;
}

/** Pro rata split of `pool` by `weights` (last recipient takes the remainder so the parts sum exactly). */
function allocate(pool: Dec, weights: ReadonlyArray<[string, Dec]>): Map<string, Dec> {
  const out = new Map<string, Dec>();
  const total = dSum(weights.map(([, w]) => w));
  if (!dIsPos(pool) || !dIsPos(total)) return out;
  let remaining = pool;
  weights.forEach(([id, w], i) => {
    const part = i === weights.length - 1 ? remaining : dDiv(dMul(pool, w), total);
    out.set(id, part);
    remaining = dSub(remaining, part);
  });
  return out;
}

function eligibility(s: AllocatedShare, e: AllocatedEntity | undefined): { eligible: boolean; reason: string | null } {
  if (s.entityType === 'c_corp') return { eligible: false, reason: 'C corporation income is not qualified business income' };
  if (s.qbiEligible === false) return { eligible: false, reason: 'excluded by the link\'s QBI setting' };
  if (s.qbiEligible === true) return { eligible: true, reason: null };
  if (s.activityType === 'investment') return { eligible: false, reason: 'investment activity (portfolio income is not QBI)' };
  if (s.activityType === 'rental' && !(e?.entity.rentalQbiTradeOrBusiness ?? false)) {
    return { eligible: false, reason: 'rental not treated as a §162 trade or business (rental_qbi_trade_or_business off)' };
  }
  return { eligible: true, reason: null };
}

const positive = (weights: Array<[string, Dec]>): Array<[string, Dec]> => weights.filter(([, w]) => dIsPos(w));

/**
 * The entity's full-year W-2 wages for the §199A limit. Q41 (CPA decision): the >2% S corporation
 * shareholder health insurance added to the officer's W-2 box 1 is EXCLUDED unless the entity
 * year's `includeSehiInW2Wages` switch is on, in which case the projected add-on (Σ owner items,
 * one amount per person) is added to w2WagesEffective. Unknown wages stay unknown unless the
 * switch alone contributes a positive amount.
 */
function entityW2Wages(e: AllocatedEntity, ctx: EngineContext): Dec | null {
  const base = e.entity.w2WagesEffective == null ? null : dec(e.entity.w2WagesEffective);
  if (!e.entity.includeSehiInW2Wages) return base;
  const seen = new Set<string>();
  let addOn: Dec = ZERO;
  for (const s of e.shares) {
    if (seen.has(s.personId)) continue;
    seen.add(s.personId);
    addOn = dAdd(addOn, s.sehiAsW2Wages);
  }
  if (!dIsPos(addOn)) return base;
  const total = dAdd(base ?? ZERO, addOn);
  ctx.trace.add({
    step: STEP_QBI, id: `qbi.w2_sehi.${e.entity.companyId}`, label: `${e.entity.companyName} — >2% shareholder health included in §199A W-2 wages (entity-year switch)`,
    exact: total, source: 'input', formula: `W-2 wages ${base ?? 'unknown'} + health add-on ${addOn}`, entityId: entityId(e.entity),
  });
  return total;
}

export function computeQbi(input: QbiInput, q: QbiContext, ctx: EngineContext): QbiExact {
  const { params, filingStatus: fs } = ctx;
  const rate = params.rate('qbi.rate');
  const threshold = params.moneyFs('qbi.threshold', fs);
  const range = params.moneyFs('qbi.phase_in_range', fs);
  const w2Pct = params.rate('qbi.w2_wage_pct');
  const altW2Pct = params.rate('qbi.alt_w2_wage_pct');
  const ubiaPct = params.rate('qbi.ubia_pct');
  const tiLimitPct = params.rate('qbi.taxable_income_limit_pct');
  const minAmount = params.money('qbi.min_deduction_amount');
  const minActiveQbi = params.money('qbi.min_deduction_active_qbi_threshold');
  const thresholdKeys = ['qbi.rate', `qbi.threshold.${fs}`, `qbi.phase_in_range.${fs}`];

  const ti = q.taxableIncomeBeforeQbi;
  const excess = dSub(ti, threshold);
  const phaseIn = dIsPos(range) ? dClamp(dDiv(excess, range), ZERO, ONE) : (dIsPos(excess) ? ONE : ZERO);
  const aboveThreshold = dIsPos(excess);
  const fullyPhased = dCmp(phaseIn, ONE) >= 0;
  const entityByLink = new Map<string, AllocatedEntity>();
  for (const e of q.entities) for (const s of e.shares) entityByLink.set(s.linkId, e);

  // ── Components: qualified items less attributable deductions, SSTB percentage ──
  const components: Component[] = [];
  for (const p of q.income.byPerson.values()) {
    const ded = q.personDeductions.get(p.personId) ?? { halfSeTax: ZERO, sehi: ZERO, retirement: ZERO };
    const seWeights = positive(p.shares.map((s) => [s.linkId, s.seIncome]));
    const sehiWeights = positive(p.shares.map((s) => [s.linkId, s.ownerSehi]));
    const wageWeights = positive(p.shares.map((s) => [s.linkId, s.officerWages]));
    const sePool = dAdd(ded.halfSeTax, ded.retirement);
    const seAlloc = allocate(sePool, seWeights);
    const sehiAlloc = allocate(ded.sehi, sehiWeights.length > 0 ? sehiWeights : seWeights.length > 0 ? seWeights : wageWeights);
    if (dIsPos(sePool) && seWeights.length === 0) ctx.info('TE_QBI_DEDUCTION_UNALLOCATED', `${p.personId}: ½ SE tax / retirement deductions ${sePool} could not be attributed to a business (no SE income); QBI is not reduced by them.`, { personId: p.personId });
    if (dIsPos(ded.sehi) && sehiAlloc.size === 0) ctx.info('TE_QBI_DEDUCTION_UNALLOCATED', `${p.personId}: the SEHI deduction ${ded.sehi} could not be attributed to a business; QBI is not reduced by it.`, { personId: p.personId });

    for (const s of p.shares) {
      const e = entityByLink.get(s.linkId);
      const { eligible, reason } = eligibility(s, e);
      const companyName = e?.entity.companyName ?? s.linkId;
      const sstb = e?.entity.isSstb ?? false;
      let items: Dec = ZERO;
      let attributable: Dec = ZERO;
      let qbi: Dec = ZERO;
      let w2: Dec | null = null;
      let ubia: Dec | null = null;
      let excludeReason = reason;
      if (eligible) {
        items = dAdd(s.share.ordinary, s.share.rental);
        if (!dIsPos(q.section1231Net)) items = dAdd(items, s.share.section_1231);
        for (const a of q.adjustments) if (a.linkId === s.linkId && !a.affectsQbi) items = dSub(items, ordinaryEffect(a));
        attributable = dAdd(seAlloc.get(s.linkId) ?? ZERO, sehiAlloc.get(s.linkId) ?? ZERO);
        qbi = dSub(items, attributable);
        const fraction = s.profitFraction;
        const entityW2 = e ? entityW2Wages(e, ctx) : null;
        w2 = entityW2 == null ? null : dMul(entityW2, fraction);
        ubia = e?.entity.ubia == null ? null : dMul(e.entity.ubia, fraction);
        if (sstb && aboveThreshold) {
          if (fullyPhased) {
            excludeReason = 'specified service trade or business above the phase-in range';
            qbi = ZERO; w2 = w2 == null ? null : ZERO; ubia = ubia == null ? null : ZERO;
          } else {
            const applicable = dSub(ONE, phaseIn);
            qbi = dMul(qbi, applicable);
            w2 = w2 == null ? null : dMul(w2, applicable);
            ubia = ubia == null ? null : dMul(ubia, applicable);
            ctx.info('TE_QBI_SSTB_PHASED', `${companyName}: specified service business — QBI, W-2 wages and UBIA reduced to ${applicable} of their amounts (taxable income in the phase-in range).`, { linkId: s.linkId });
          }
        }
      }
      components.push({
        share: s, linkId: s.linkId, personId: s.personId, companyName, entityType: s.entityType, activityType: s.activityType,
        eligible: eligible && excludeReason == null, reason: excludeReason, sstb, qualifiedItems: items, attributableDeductions: attributable, qbi,
        qbiAfterNetting: ZERO, w2Wages: w2, ubia, tentative: ZERO, wageUbiaLimit: null, limitApplied: false, component: ZERO,
      });
    }
  }

  // ── Loss netting within the year ──
  const live = components.filter((c) => c.eligible);
  const gains = live.filter((c) => dIsPos(c.qbi));
  const losses = live.filter((c) => dIsNeg(c.qbi));
  const totalGain = dSum(gains.map((c) => c.qbi));
  const totalLoss = dSum(losses.map((c) => dAbs(c.qbi)));
  const absorbed = dMin(totalLoss, totalGain);
  const netLossCarryforward = dFloorZero(dSub(totalLoss, totalGain));
  const absorbedBy = allocate(absorbed, gains.map((c) => [c.linkId, c.qbi]));
  for (const c of gains) c.qbiAfterNetting = dSub(c.qbi, absorbedBy.get(c.linkId) ?? ZERO);
  for (const c of losses) { c.qbiAfterNetting = ZERO; c.w2Wages = c.w2Wages == null ? null : ZERO; c.ubia = c.ubia == null ? null : ZERO; }
  if (dIsPos(totalLoss)) {
    ctx.trace.add({ step: STEP_QBI, id: 'qbi.loss_netting', label: 'QBI losses netted against QBI of the other businesses', exact: dNeg(absorbed), source: 'gl_map', formula: `losses ${totalLoss} vs income ${totalGain}` });
    if (dIsPos(netLossCarryforward)) ctx.warn('TE_QBI_NET_LOSS_CARRYFORWARD', `Net qualified business loss ${netLossCarryforward} carries forward to next year's QBI (not tracked); no §199A deduction from the businesses this year.`, { netLossCarryforward });
  }

  // ── W-2 / UBIA limit and phase-in per component ──
  let componentsTotal: Dec = ZERO;
  let activeQbi: Dec = ZERO;
  for (const c of live) {
    if (c.activityType === 'active') activeQbi = dAdd(activeQbi, c.qbi);
    c.tentative = dMul(rate, c.qbiAfterNetting);
    let component = c.tentative;
    const keys = [...thresholdKeys];
    if (aboveThreshold && dIsPos(c.qbiAfterNetting)) {
      if (c.w2Wages == null) ctx.warn('TE_QBI_W2_WAGES_MISSING', `${c.companyName}: W-2 wages for the §199A limit are unknown (no w2_wages accounts and no override); treated as 0.`, { linkId: c.linkId });
      if (c.ubia == null) ctx.warn('TE_QBI_UBIA_MISSING', `${c.companyName}: UBIA of qualified property is blank; the 25% W-2 + 2.5% UBIA limb was not computed (D8). Enter UBIA on the entity's tax year if the business holds depreciable property.`, { linkId: c.linkId });
      const w2 = c.w2Wages ?? ZERO;
      const w2Limb = dMul(w2Pct, w2);
      const altLimb = c.ubia == null ? null : dAdd(dMul(altW2Pct, w2), dMul(ubiaPct, c.ubia));
      const limit = altLimb == null ? w2Limb : dMax(w2Limb, altLimb);
      c.wageUbiaLimit = limit;
      keys.push('qbi.w2_wage_pct', 'qbi.alt_w2_wage_pct', 'qbi.ubia_pct');
      if (dCmp(c.tentative, limit) > 0) {
        c.limitApplied = true;
        component = fullyPhased ? limit : dSub(c.tentative, dMul(dSub(c.tentative, limit), phaseIn));
      }
    }
    c.component = component;
    componentsTotal = dAdd(componentsTotal, component);
    const limitNote = c.wageUbiaLimit == null ? '' : ', limit ' + c.wageUbiaLimit + (fullyPhased ? '' : ', phase-in ' + phaseIn);
    ctx.trace.add({
      step: STEP_QBI, id: `qbi.component.${c.linkId}`, label: `${c.companyName} — §199A component${c.sstb ? ' (SSTB)' : ''}${c.limitApplied ? ' (W-2 / UBIA limited)' : ''}`, exact: component, source: 'parameter',
      formula: `${rate} × QBI ${c.qbiAfterNetting}${limitNote}`, personId: c.personId, parameterKeys: keys,
    });
  }
  for (const c of components) {
    if (!c.eligible && !dIsZero(dSum(INCOME_CHARACTERS.map((k) => c.share.share[k])))) {
      ctx.info('TE_QBI_LINK_EXCLUDED', `${c.companyName}: not included in QBI — ${c.reason}.`, { linkId: c.linkId });
    }
  }

  // ── REIT / PTP component ──
  const persons = [...q.income.byPerson.values()];
  const reitPtpIncome = dSum(persons.map((p) => dAdd(p.reitDividends, p.ptpIncome)));
  if (dIsNeg(reitPtpIncome)) ctx.info('TE_QBI_PTP_LOSS_CARRYFORWARD', `Net REIT / PTP loss ${dAbs(reitPtpIncome)} carries forward (not tracked); no REIT / PTP component this year.`);
  const reitPtpComponent = dMul(rate, dFloorZero(reitPtpIncome));
  if (!dIsZero(reitPtpIncome)) ctx.trace.add({ step: STEP_QBI, id: 'qbi.reit_ptp', label: 'Qualified REIT dividends / PTP income component', exact: reitPtpComponent, source: 'parameter', formula: `${rate} × max(0, ${reitPtpIncome})`, parameterKeys: ['qbi.rate'] });

  // ── Overall limit, minimum deduction, override ──
  const combined = dAdd(componentsTotal, reitPtpComponent);
  const overallLimit = dMul(tiLimitPct, dFloorZero(dSub(ti, q.netCapitalGainWithQd)));
  let computed = dFloorZero(dMin(combined, overallLimit));
  let minimumApplied = false;
  if (dIsPos(minAmount) && dCmp(activeQbi, minActiveQbi) >= 0 && dCmp(computed, minAmount) < 0) {
    const floor = dMin(minAmount, dFloorZero(ti));
    if (dCmp(floor, computed) > 0) {
      computed = floor;
      minimumApplied = true;
      ctx.info('TE_QBI_MINIMUM_APPLIED', `§199A(i) minimum deduction ${minAmount} applies (active QBI ${activeQbi} ≥ ${minActiveQbi}).`, { activeQbi });
    }
  }
  const phaseNote = aboveThreshold ? ', phase-in ' + phaseIn : '';
  ctx.trace.add({ step: STEP_QBI, id: 'qbi.taxable_income_base', label: `Taxable income before QBI (pre-§68 deduction) vs threshold ${threshold}${phaseNote}`, exact: ti, source: 'parameter', parameterKeys: thresholdKeys });
  ctx.trace.add({ step: STEP_QBI, id: 'qbi.overall_limit', label: 'QBI overall limit (taxable income before QBI less net capital gain incl. qualified dividends)', exact: overallLimit, source: 'parameter', formula: `${tiLimitPct} × max(0, ${ti} − ${q.netCapitalGainWithQd})`, parameterKeys: ['qbi.taxable_income_limit_pct'] });

  let deduction = computed;
  let method: QbiResult['method'] = live.length > 0 || dIsPos(reitPtpComponent) ? 'computed' : 'none';
  if (input.manualDeduction != null) {
    deduction = dFloorZero(dec(input.manualDeduction));
    method = 'manual';
    ctx.warn('TE_QBI_MANUAL_OVERRIDE', `The §199A deduction is overridden to ${deduction} (engine computed ${computed}).`, { manual: deduction, computed });
  }
  ctx.trace.add({
    step: STEP_QBI, id: 'qbi', label: `Qualified business income deduction${method === 'manual' ? ' (MANUAL OVERRIDE)' : minimumApplied ? ' (§199A(i) minimum)' : ''}`, exact: deduction, source: method === 'manual' ? 'input' : 'parameter',
    formula: method === 'manual' ? `override; computed ${computed}` : `min(components ${componentsTotal} + REIT/PTP ${reitPtpComponent}, overall limit ${overallLimit})`,
    parameterKeys: method === 'manual' ? undefined : ['qbi.taxable_income_limit_pct', 'qbi.min_deduction_amount', 'qbi.min_deduction_active_qbi_threshold'],
  });

  return {
    method, deduction, computedDeduction: computed, taxableIncomeBeforeQbi: ti, threshold, phaseInRange: range, phaseInFraction: phaseIn,
    components: components.map(({ share: _share, ...c }) => c), netLossCarryforward, reitPtpIncome, reitPtpComponent, combined, overallLimit, activeQbi, minimumApplied,
  };
}
