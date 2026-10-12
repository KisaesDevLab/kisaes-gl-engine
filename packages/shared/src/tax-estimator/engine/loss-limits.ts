// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 3 — loss limitations, in this order:
//   1. `allowed_loss_override` (basis / at-risk): a link's loss is capped at the
//      override magnitude; the excess is disallowed (shown, not deducted).
//   2. Passive activity rules (§469): losses of `passive` / `rental` links offset
//      only passive income of the same taxpayer. §469(i): up to the parameter
//      allowance of the net rental real-estate loss from links with
//      `active_participation` is allowed against nonpassive income, phased out
//      linearly between the MAGI start / end parameters (D10); MFS: the
//      `mfs_living_apart` parameters when the spouses lived apart all year,
//      otherwise no allowance (§469(i)(5)(B)). MAGI = AGI computed without any
//      passive loss (§469(i)(3)(E)) — federal.ts probes it with a first pass
//      (`magi: null` suspends everything) and calls again with the figure.
//      Allocation follows Form 8582: Worksheet 4 nets the §469(i) allowance
//      against the active-participation rental losers first (pro rata by their
//      loss); Worksheet 5 then spreads the unallowed total over the REMAINING
//      losses (the rental remainders and every other passive loser) pro rata.
//      The suspended amounts are shown, not deducted (no carryforward tracking).
//   3. Excess business loss (§461(l)): the aggregate trade-or-business net
//      (ordinary + rental + §1231 of non-investment links + guaranteed payments,
//      after §469) below −threshold is disallowed and becomes an NOL note.
// PURE: the input AggregatedIncome is not mutated; the limited copy is returned
// as `income` for the later steps. SE income is untouched (§469 / §461(l) are
// income-tax limits, not Schedule SE limits).

import { INCOME_CHARACTERS, type CharacterAmounts, type IncomeCharacter } from '../entities-api.js';
import type { ActivityType } from '../types.js';
import {
  ZERO, dAbs, dAdd, dCmp, dDiv, dFloorZero, dIsNeg, dIsPos, dIsZero, dMin, dMul, dNeg, dSub, dSum, type Dec,
} from '../decimal.js';
import { sumCharacters, type AggregatedIncome, type AllocatedShare, type PersonIncome } from './income.js';
import type { EngineContext } from './context.js';
import type { LossLimitationResult, LossLimitationShareResult, RentalAllowanceResult } from './types.js';

const STEP = 'loss_limits';

export interface LossLimitationOptions {
  /**
   * MAGI for the §469(i) phase-out (AGI without passive losses). null = not yet
   * known: the allowance is withheld (everything in excess is suspended) and
   * `needsMagi` says whether a second pass with the figure would change anything.
   */
  magi: Dec | null;
  /** §469(i)(5): MFS spouses lived apart all year. */
  mfsLivedApartAllYear: boolean;
  /** Company names by linkId for labels (optional). */
  companyNames?: ReadonlyMap<string, string>;
}

export interface LossLimitationExact extends LossLimitationResult {
  /** The limited copy of the income (shares and person characters rewritten). */
  income: AggregatedIncome;
  /** true when an active-participation rental loss exceeds passive income, so the §469(i) allowance depends on MAGI. */
  needsMagi: boolean;
}

const PASSIVE_TYPES: ReadonlySet<ActivityType> = new Set<ActivityType>(['passive', 'rental']);
const BUSINESS_CHARACTERS: readonly IncomeCharacter[] = ['ordinary', 'rental', 'section_1231'];

export function isPassiveActivity(activityType: ActivityType): boolean {
  return PASSIVE_TYPES.has(activityType);
}

/**
 * Add `amount` (≥ 0) back against the negative characters of a share, pro rata by
 * their magnitude, so the share's net loss shrinks by exactly `amount`.
 */
export function addBackLoss(share: CharacterAmounts, amount: Dec): CharacterAmounts {
  if (!dIsPos(amount)) return { ...share };
  const negatives = INCOME_CHARACTERS.filter((k) => dIsNeg(share[k]));
  const negSum = dSum(negatives.map((k) => dAbs(share[k])));
  if (!dIsPos(negSum)) return { ...share };
  const capped = dMin(amount, negSum);
  const out = { ...share };
  let remaining = capped;
  negatives.forEach((k, i) => {
    const part = i === negatives.length - 1 ? remaining : dMin(remaining, dDiv(dMul(capped, dAbs(share[k])), negSum));
    out[k] = dAdd(share[k], part);
    remaining = dSub(remaining, part);
  });
  return out;
}

interface Work {
  share: AllocatedShare;
  original: CharacterAmounts;
  current: CharacterAmounts;
  overrideDisallowed: Dec;
  passiveSuspended: Dec;
}

function label(w: Work, names: ReadonlyMap<string, string> | undefined): string {
  return names?.get(w.share.linkId) ?? w.share.linkId;
}

/** Variant of the §469(i) parameters for the filing status. */
function allowanceVariant(ctx: EngineContext, livedApart: boolean): 'standard' | 'mfs_living_apart' | 'none' {
  if (ctx.filingStatus !== 'mfs') return 'standard';
  return livedApart ? 'mfs_living_apart' : 'none';
}

export function applyLossLimitations(income: AggregatedIncome, options: LossLimitationOptions, ctx: EngineContext): LossLimitationExact {
  const notes: string[] = [];
  const names = options.companyNames;
  const works: Work[] = [];
  for (const p of income.byPerson.values()) {
    for (const s of p.shares) works.push({ share: s, original: s.share, current: { ...s.share }, overrideDisallowed: ZERO, passiveSuspended: ZERO });
  }

  // 1. allowed_loss_override (basis / at-risk).
  let overrideDisallowed: Dec = ZERO;
  for (const w of works) {
    const override = w.share.allowedLossOverride;
    if (override == null) continue;
    const net = sumCharacters(w.current);
    const cap = dAbs(override);
    if (!dIsNeg(net)) {
      ctx.info('TE_LOSS_OVERRIDE_UNUSED', `${label(w, names)}: an allowed-loss override (${cap}) is set but the share is not a loss; it has no effect.`, { linkId: w.share.linkId });
      continue;
    }
    const loss = dAbs(net);
    if (dCmp(loss, cap) <= 0) {
      ctx.info('TE_LOSS_OVERRIDE_UNUSED', `${label(w, names)}: the loss ${loss} is within the allowed-loss override ${cap}; nothing disallowed.`, { linkId: w.share.linkId });
      continue;
    }
    const disallowed = dSub(loss, cap);
    w.current = addBackLoss(w.current, disallowed);
    w.overrideDisallowed = disallowed;
    overrideDisallowed = dAdd(overrideDisallowed, disallowed);
    ctx.warn('TE_LOSS_OVERRIDE_APPLIED', `${label(w, names)}: loss limited to ${cap} by the basis / at-risk override; ${disallowed} is not deducted this year.`, { linkId: w.share.linkId, disallowed });
    ctx.trace.add({ step: STEP, id: `loss_override.${w.share.linkId}`, label: `${label(w, names)} — loss disallowed by basis / at-risk override`, exact: dNeg(disallowed), source: 'input', formula: `loss ${loss} capped at ${cap}`, personId: w.share.personId });
  }

  // 2. Passive activity netting (§469), taxpayer level.
  const passive = works.filter((w) => isPassiveActivity(w.share.activityType));
  let passiveIncome: Dec = ZERO; let passiveLosses: Dec = ZERO; let activeRentalNet: Dec = ZERO;
  for (const w of passive) {
    const net = sumCharacters(w.current);
    if (dIsNeg(net)) passiveLosses = dAdd(passiveLosses, dAbs(net)); else passiveIncome = dAdd(passiveIncome, net);
    if (w.share.activityType === 'rental' && w.share.activeParticipation) activeRentalNet = dAdd(activeRentalNet, net);
  }
  const excess = dFloorZero(dSub(passiveLosses, passiveIncome));
  const eligibleLoss = dIsPos(excess) ? dMin(dFloorZero(dNeg(activeRentalNet)), excess) : ZERO;
  const needsMagi = dIsPos(eligibleLoss);
  let rental: RentalAllowanceResult = { variant: 'not_needed', maximum: ZERO, magi: null, afterPhaseOut: ZERO, eligibleLoss, used: ZERO };
  if (needsMagi && options.magi != null) {
    const variant = allowanceVariant(ctx, options.mfsLivedApartAllYear);
    if (variant === 'none') {
      ctx.warn('TE_PASSIVE_MFS_NO_ALLOWANCE', 'Married filing separately and not living apart all year: no §469(i) rental loss allowance (§469(i)(5)(B)).');
      rental = { variant, maximum: ZERO, magi: options.magi, afterPhaseOut: ZERO, eligibleLoss, used: ZERO };
    } else {
      const keys = [`passive.rental_allowance.${variant}`, `passive.rental_allowance_phaseout_start.${variant}`, `passive.rental_allowance_phaseout_end.${variant}`];
      const maximum = ctx.params.money(keys[0]!);
      const start = ctx.params.money(keys[1]!);
      const end = ctx.params.money(keys[2]!);
      const magi = options.magi;
      let afterPhaseOut: Dec;
      if (dCmp(magi, start) <= 0) afterPhaseOut = maximum;
      else if (dCmp(magi, end) >= 0 || dCmp(end, start) <= 0) afterPhaseOut = ZERO;
      else afterPhaseOut = dDiv(dMul(maximum, dSub(end, magi)), dSub(end, start));
      const used = dMin(eligibleLoss, afterPhaseOut);
      if (dCmp(afterPhaseOut, maximum) < 0) {
        ctx.info('TE_PASSIVE_ALLOWANCE_PHASED_OUT', `§469(i) rental allowance reduced from ${maximum} to ${afterPhaseOut} because MAGI ${magi} exceeds ${start}${dIsZero(afterPhaseOut) ? ' (fully phased out)' : ''}.`, { magi, afterPhaseOut });
      }
      ctx.trace.add({ step: STEP, id: 'passive.rental_allowance', label: `§469(i) rental real estate allowance (active participation${variant === 'mfs_living_apart' ? ', MFS living apart' : ''})`, exact: used, source: 'parameter', formula: `min(eligible loss ${eligibleLoss}, ${maximum} phased out between MAGI ${start} and ${end} at MAGI ${magi})`, parameterKeys: keys });
      rental = { variant, maximum, magi, afterPhaseOut, eligibleLoss, used };
    }
  }
  const suspended = dFloorZero(dSub(excess, rental.used));
  if (dIsPos(suspended)) {
    const losers = passive.filter((w) => dIsNeg(sumCharacters(w.current)));
    // Form 8582 Worksheet 4: the allowance goes to the active-participation rental losers first, pro rata by loss.
    const remainingLoss = new Map<Work, Dec>();
    const rentalLosers = losers.filter((w) => w.share.activityType === 'rental' && w.share.activeParticipation);
    const rentalLossSum = dSum(rentalLosers.map((w) => dAbs(sumCharacters(w.current))));
    let allowanceLeft = rental.used;
    losers.forEach((w) => remainingLoss.set(w, dAbs(sumCharacters(w.current))));
    rentalLosers.forEach((w, i) => {
      const loss = remainingLoss.get(w)!;
      const covered = i === rentalLosers.length - 1 ? dMin(allowanceLeft, loss) : dMin(loss, dDiv(dMul(rental.used, loss), rentalLossSum));
      allowanceLeft = dSub(allowanceLeft, covered);
      remainingLoss.set(w, dSub(loss, covered));
    });
    // Worksheet 5: the unallowed total over the remaining losses, pro rata.
    const remainingSum = dSum([...remainingLoss.values()]);
    let remaining = suspended;
    losers.forEach((w, i) => {
      const loss = remainingLoss.get(w)!;
      const part = i === losers.length - 1 ? dMin(remaining, loss) : dMin(remaining, loss, dIsPos(remainingSum) ? dDiv(dMul(suspended, loss), remainingSum) : ZERO);
      w.current = addBackLoss(w.current, part);
      w.passiveSuspended = part;
      remaining = dSub(remaining, part);
      if (!dIsPos(part)) return;
      ctx.trace.add({ step: STEP, id: `passive_suspended.${w.share.linkId}`, label: `${label(w, names)} — passive loss suspended (§469)`, exact: dNeg(part), source: 'parameter', formula: `${suspended} unallowed × ${loss} ÷ ${remainingSum} (Form 8582 Wks 5; rental losses first reduced by the §469(i) allowance ${rental.used}, Wks 4)`, personId: w.share.personId });
    });
    if (options.magi != null || !needsMagi) {
      const allowanceNote = dIsPos(rental.used) ? ' and the §469(i) allowance ' + rental.used : '';
      ctx.warn('TE_PASSIVE_LOSS_SUSPENDED', `Passive losses of ${passiveLosses} exceed passive income ${passiveIncome}${allowanceNote}; ${suspended} is suspended (carried forward, not tracked).`, { suspended });
      notes.push(`Passive loss suspended under §469: ${suspended} (carryforward not tracked).`);
    }
  }
  if (dIsPos(passiveLosses)) {
    ctx.trace.add({ step: STEP, id: 'passive.net', label: 'Passive activities — losses allowed against passive income', exact: dNeg(dMin(passiveLosses, passiveIncome)), source: 'gl_map', formula: `losses ${passiveLosses} vs income ${passiveIncome}` });
  }

  // Rebuild persons with the limited shares.
  const byPerson = new Map<string, PersonIncome>();
  for (const p of income.byPerson.values()) {
    let character = { ...p.character };
    const shares = p.shares.map((s) => {
      const w = works.find((x) => x.share === s)!;
      for (const k of INCOME_CHARACTERS) character = { ...character, [k]: dAdd(character[k], dSub(w.current[k], w.original[k])) };
      return { ...s, share: w.current };
    });
    byPerson.set(p.personId, { ...p, character, shares });
  }

  // 3. Excess business loss (§461(l)) on the aggregate after §469.
  let businessNet: Dec = ZERO;
  const businessByPerson = new Map<string, Dec>();
  for (const p of byPerson.values()) {
    let net = p.guaranteedPayments;
    for (const s of p.shares) {
      if (s.activityType === 'investment') continue;
      net = dAdd(net, dSum(BUSINESS_CHARACTERS.map((k) => s.share[k])));
    }
    businessByPerson.set(p.personId, net);
    businessNet = dAdd(businessNet, net);
  }
  let excessBusinessLoss: Dec = ZERO;
  let eblThreshold: Dec = ZERO;
  if (dIsNeg(businessNet)) {
    const key = ctx.filingStatus === 'mfj' ? 'ebl.threshold.mfj' : 'ebl.threshold.standard';
    eblThreshold = ctx.params.money(key);
    excessBusinessLoss = dFloorZero(dSub(dAbs(businessNet), eblThreshold));
    if (dIsPos(excessBusinessLoss)) {
      // Add the excess back to the ordinary income of the persons with a business loss, pro rata.
      const losers = [...businessByPerson].filter(([, v]) => dIsNeg(v));
      const lossSum = dSum(losers.map(([, v]) => dAbs(v)));
      let remaining = excessBusinessLoss;
      losers.forEach(([pid, v], i) => {
        const part = i === losers.length - 1 ? remaining : dDiv(dMul(excessBusinessLoss, dAbs(v)), lossSum);
        const p = byPerson.get(pid)!;
        byPerson.set(pid, { ...p, character: { ...p.character, ordinary: dAdd(p.character.ordinary, part) } });
        remaining = dSub(remaining, part);
      });
      ctx.warn('TE_EXCESS_BUSINESS_LOSS', `Aggregate business loss ${dAbs(businessNet)} exceeds the §461(l) threshold ${eblThreshold}; ${excessBusinessLoss} is disallowed this year and becomes a net operating loss carryforward (not tracked).`, { excessBusinessLoss });
      notes.push(`Excess business loss (§461(l)): ${excessBusinessLoss} disallowed; treated as an NOL carryforward (not tracked).`);
      ctx.info('TE_EBL_QBI_TIMING', `The §461(l) disallowed loss ${excessBusinessLoss} still reduces this year's qualified business income; Reg. 1.199A-3(b)(1)(iv) takes it into QBI only in the year it is allowed, so the (untracked) QBI loss carryforward is overstated by up to that amount.`, { excessBusinessLoss });
      notes.push(`QBI is figured before the §461(l) disallowance; the disallowed loss reduces QBI in the year it is allowed (Reg. 1.199A-3(b)(1)(iv)) — the QBI loss carryforward shown is overstated by up to ${excessBusinessLoss}.`);
    }
    ctx.trace.add({ step: STEP, id: 'ebl', label: 'Excess business loss disallowed (§461(l))', exact: excessBusinessLoss, source: 'parameter', formula: `max(0, business loss ${dAbs(businessNet)} − threshold ${eblThreshold})`, parameterKeys: [key] });
  }

  const shares: LossLimitationShareResult[] = works.map((w) => ({
    linkId: w.share.linkId, personId: w.share.personId, companyName: label(w, names), activityType: w.share.activityType,
    passive: isPassiveActivity(w.share.activityType), net: sumCharacters(w.original), overrideDisallowed: w.overrideDisallowed,
    passiveSuspended: w.passiveSuspended, allowed: sumCharacters(w.current),
  }));
  if (dIsPos(overrideDisallowed)) notes.push(`Loss disallowed by basis / at-risk overrides: ${overrideDisallowed}.`);

  return {
    applied: true, overrideDisallowed, passiveIncome, passiveLosses, rentalAllowance: rental, suspendedPassiveLoss: suspended,
    businessNet, eblThreshold, excessBusinessLoss, shares, notes,
    income: { byPerson, otherAboveTheLine: income.otherAboveTheLine, itemizedOther: income.itemizedOther },
    needsMagi,
  };
}
