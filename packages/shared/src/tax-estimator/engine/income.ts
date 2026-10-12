// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md federal steps 1–2 (and "Projection"): entity tax-basis income by
// character → full-year projection → allocation to persons by profit_pct /
// loss_pct → guaranteed payments and officer wages → adjustments → taxpayer
// income by character with capital-gain netting (§1211 limit). PURE.
//
// Internal amounts are unrounded decimal strings; federal.ts rounds for the
// result DTO. Character amounts are profit-positive (a loss is negative).

import type { ActivityType, EntityTaxType } from '../types.js';
import { INCOME_CHARACTERS, type CharacterAmounts, type IncomeCharacter } from '../entities-api.js';
import type { PartnerSeStatus } from '../taxpayers-api.js';
import {
  ZERO, ONE, dAdd, dSub, dMul, dDiv, dIsNeg, dIsPos, dIsZero, dMax, dMin, dNeg, dSum, dec, percentToFraction, type Dec,
} from '../decimal.js';
import type { EngineContext } from './context.js';
import type { EngineAdjustment, EngineEntity, EnginePerson } from './types.js';

const MONTHS_PER_YEAR = 12;
const STEP_INCOME = 'entity_income';
const STEP_ALLOCATE = 'allocation';

// ── Character helpers ────────────────────────────────────────────────

export function characters(partial: Partial<Record<IncomeCharacter, Dec>>): CharacterAmounts {
  const out = {} as Record<IncomeCharacter, Dec>;
  for (const c of INCOME_CHARACTERS) out[c] = partial[c] === undefined ? ZERO : dec(partial[c]!);
  return out;
}

export function sumCharacters(c: CharacterAmounts): Dec {
  return dSum(INCOME_CHARACTERS.map((k) => c[k]));
}

function mapCharacters(c: CharacterAmounts, f: (v: Dec, k: IncomeCharacter) => Dec): CharacterAmounts {
  const out = {} as Record<IncomeCharacter, Dec>;
  for (const k of INCOME_CHARACTERS) out[k] = f(c[k], k);
  return out;
}

function addCharacters(a: CharacterAmounts, b: CharacterAmounts): CharacterAmounts {
  return mapCharacters(a, (v, k) => dAdd(v, b[k]));
}

// ── Projection ───────────────────────────────────────────────────────

/** YTD + (recurring YTD ÷ months elapsed) × months remaining. Zero elapsed months → YTD. */
export function projectAmount(ytd: Dec, recurringYtd: Dec, monthsElapsed: number, monthsRemaining: number): Dec {
  if (monthsElapsed <= 0 || monthsRemaining <= 0) return dec(ytd);
  const runRate = dDiv(recurringYtd, String(monthsElapsed));
  return dAdd(ytd, dMul(runRate, String(monthsRemaining)));
}

export function projectCharacters(ytd: CharacterAmounts, recurringYtd: CharacterAmounts, monthsElapsed: number, monthsRemaining: number): CharacterAmounts {
  return mapCharacters(ytd, (v, k) => projectAmount(v, recurringYtd[k], monthsElapsed, monthsRemaining));
}

/** Owner items, GPs and officer wages have no non-recurring split: the whole YTD is run-rated. */
function projectWhole(ytd: Dec, e: EngineEntity): Dec {
  return projectAmount(ytd, ytd, e.monthsElapsed, e.monthsRemaining);
}

// ── Allocation ───────────────────────────────────────────────────────

export interface AllocatedShare {
  linkId: string;
  personId: string;
  entityType: EntityTaxType;
  activityType: ActivityType;
  partnerSeStatus: PartnerSeStatus | null;
  isOfficer: boolean;
  profitFraction: Dec;
  lossFraction: Dec;
  /** Allocated full-year amounts by character after link adjustments (profit-positive). */
  share: CharacterAmounts;
  guaranteedPayment: Dec;
  officerWages: Dec;
  sehiAsW2Wages: Dec;
  ownerSehi: Dec;
  ownerRetirement: Dec;
  /** SE income from this link (MODULE.md step 4). */
  seIncome: Dec;
  qbiEligible: boolean | null;
  activeParticipation: boolean;
  allowedLossOverride: Dec | null;
}

export interface AllocatedEntity {
  entity: EngineEntity;
  projected: CharacterAmounts;
  projectedProfit: Dec;
  shares: AllocatedShare[];
}

const SE_PARTNER_STATUSES: ReadonlySet<PartnerSeStatus> = new Set<PartnerSeStatus>(['general', 'llc_member_manager']);

function entityId(e: EngineEntity): string {
  return `${e.tenantId}:${e.companyId}`;
}

/** Fractions per link: null profit_pct = 100% for a single link, else 0% + warning; null loss_pct = profit fraction. */
function linkFractions(e: EngineEntity, ctx: EngineContext): Map<string, { profit: Dec; loss: Dec }> {
  const out = new Map<string, { profit: Dec; loss: Dec }>();
  const single = e.links.length === 1;
  for (const l of e.links) {
    let profit: Dec;
    if (l.profitPct == null) {
      profit = single ? ONE : ZERO;
      if (!single) ctx.warn('TE_LINK_PCT_MISSING', `${e.companyName}: link for person ${l.personId} has no profit % and the entity has several owners; nothing was allocated to it.`, { entityId: entityId(e), linkId: l.linkId });
    } else {
      profit = percentToFraction(l.profitPct);
    }
    const loss = l.lossPct == null ? profit : percentToFraction(l.lossPct);
    out.set(l.linkId, { profit, loss });
  }
  return out;
}

/** Person a null-person owner item / GP belongs to: the single link's person, else the primary (with a warning). */
function ownerPerson(e: EngineEntity, personId: string | null, ctx: EngineContext): string {
  if (personId) return ctx.resolvePerson(personId);
  if (e.links.length === 1) return e.links[0]!.personId;
  ctx.warn('TE_OWNER_ITEM_UNATTRIBUTED', `${e.companyName}: an owner-level amount has no person and the entity has several owners; it was attributed to the primary person.`, { entityId: entityId(e) });
  return ctx.resolvePerson(null);
}

function sumTo(map: Map<string, Dec>, personId: string, amount: Dec): void {
  map.set(personId, dAdd(map.get(personId) ?? ZERO, amount));
}

/** Character an income adjustment lands in, from its flags. */
export function adjustmentCharacter(a: EngineAdjustment): IncomeCharacter {
  if (a.isCapitalGainLt) return 'capital_gain_lt';
  if (a.isCapitalGainSt) return 'capital_gain_st';
  if (a.is1231) return 'section_1231';
  if (a.isQualifiedDividend) return 'dividends_qualified';
  if (a.typeCode === 'interest_income') return 'interest';
  return 'ordinary';
}

/** Signed effect of an adjustment on income (income +, deduction −, addback + × pct). */
function adjustmentEffect(a: EngineAdjustment): Dec {
  if (a.kind === 'deduction') return dNeg(a.amount);
  if (a.kind === 'addback') return dMul(a.amount, a.pct == null ? ONE : percentToFraction(a.pct));
  return dec(a.amount);
}

/**
 * Apply link-level adjustments to one share. `depreciation_tax_vs_book` replaces the
 * book depreciation the provider left in profit (the share of taxDepreciationBookYtd,
 * projected) with the adjustment's tax amount.
 */
function applyLinkAdjustments(share: CharacterAmounts, seIncome: Dec, fraction: Dec, bookDepreciation: Dec, adjustments: EngineAdjustment[], ctx: EngineContext, e: EngineEntity, linkId: string, personId: string): { share: CharacterAmounts; seIncome: Dec } {
  let out = share;
  let se = seIncome;
  let bookSwapped = false;
  for (const a of adjustments) {
    let effect = adjustmentEffect(a);
    let character: IncomeCharacter = a.kind === 'income' ? adjustmentCharacter(a) : 'ordinary';
    if (a.typeCode === 'depreciation_tax_vs_book') {
      // bookDepreciation is profit-positive (negative); adding it back removes the book figure.
      const addBack = dMul(dNeg(bookDepreciation), fraction);
      effect = dAdd(effect, bookSwapped ? ZERO : addBack);
      bookSwapped = true;
      character = 'ordinary';
    }
    out = { ...out, [character]: dAdd(out[character], effect) };
    if (character === 'dividends_qualified') out = { ...out, dividends_ordinary: dAdd(out.dividends_ordinary, effect) };
    if (a.affectsSe && character === 'ordinary') se = dAdd(se, effect);
    ctx.trace.add({
      step: STEP_ALLOCATE, id: `adjustment.${a.id}`, label: `${a.label} (${e.companyName})`, exact: effect, source: 'adjustment',
      formula: a.kind === 'addback' ? `${a.amount} × ${a.pct == null ? '100%' : `${a.pct}%`} add-back` : a.kind === 'deduction' ? `−${a.amount}${a.typeCode === 'depreciation_tax_vs_book' ? ' tax depreciation, book depreciation added back' : ''}` : `+${a.amount} ${character}`,
      personId, entityId: `${entityId(e)}#${linkId}`,
    });
  }
  return { share: out, seIncome: se };
}

/** SE income for a link (step 4): Sch C / Sch F full ordinary share; SE partners ordinary + GP; limited GP only; corporations none. */
export function seIncomeFor(entityType: EntityTaxType, partnerSeStatus: PartnerSeStatus | null, ordinaryShare: Dec, guaranteedPayment: Dec): Dec {
  switch (entityType) {
    case 'sch_c':
    case 'sch_f':
      return dec(ordinaryShare);
    case 'partnership':
      if (partnerSeStatus == null || SE_PARTNER_STATUSES.has(partnerSeStatus)) return dAdd(ordinaryShare, guaranteedPayment);
      return dec(guaranteedPayment);
    default:
      return ZERO;
  }
}

export function allocateEntity(e: EngineEntity, adjustments: EngineAdjustment[], ctx: EngineContext): AllocatedEntity {
  const eid = entityId(e);
  const projected = projectCharacters(e.ytd, e.recurringYtd, e.monthsElapsed, e.monthsRemaining);
  const projectedProfit = sumCharacters(projected);
  if (e.monthsElapsed <= 0) ctx.warn('TE_NO_MONTHS_ELAPSED', `${e.companyName}: no closed months; the projection equals the year-to-date books.`, { entityId: eid });
  for (const w of e.warnings) ctx.warn(w.code, `${e.companyName}: ${w.message}`, w.details, w.severity);

  for (const k of INCOME_CHARACTERS) {
    if (dIsZero(projected[k]) && dIsZero(e.ytd[k])) continue;
    ctx.trace.add({
      step: STEP_INCOME, id: `entity.${eid}.${k}`, label: `${e.companyName} — ${k} (projected)`, exact: projected[k], source: 'gl_map',
      formula: e.monthsRemaining > 0 ? `YTD ${e.ytd[k]} + recurring ${e.recurringYtd[k]} ÷ ${e.monthsElapsed} × ${e.monthsRemaining}` : `YTD ${e.ytd[k]} (year closed)`,
      entityId: eid,
    });
  }

  const fractions = linkFractions(e, ctx);
  const useLoss = dIsNeg(projectedProfit);
  const gpByPerson = new Map<string, Dec>();
  for (const g of e.guaranteedPayments) sumTo(gpByPerson, ownerPerson(e, g.personId, ctx), projectWhole(g.amount, e));
  const wagesByPerson = new Map<string, Dec>();
  for (const w of e.officerWages) sumTo(wagesByPerson, ownerPerson(e, w.personId, ctx), projectWhole(w.amount, e));
  const sehiByPerson = new Map<string, Dec>();
  const retirementByPerson = new Map<string, Dec>();
  const sehiW2ByPerson = new Map<string, Dec>();
  for (const o of e.ownerItems) {
    const pid = ownerPerson(e, o.personId, ctx);
    sumTo(sehiByPerson, pid, projectWhole(o.sehi, e));
    sumTo(retirementByPerson, pid, projectWhole(o.retirement, e));
    sumTo(sehiW2ByPerson, pid, projectWhole(o.sehiAsW2Wages, e));
  }
  const bookDepreciation = projectWhole(e.taxDepreciationBookYtd, e);

  const shares: AllocatedShare[] = e.links.map((l) => {
    const personId = ctx.resolvePerson(l.personId);
    const f = fractions.get(l.linkId)!;
    const fraction = useLoss ? f.loss : f.profit;
    const base = mapCharacters(projected, (v) => dMul(v, fraction));
    const gp = gpByPerson.get(personId) ?? ZERO;
    const linkAdjustments = adjustments.filter((a) => a.linkId === l.linkId);
    const applied = applyLinkAdjustments(base, seIncomeFor(e.entityType, l.partnerSeStatus, base.ordinary, gp), fraction, bookDepreciation, linkAdjustments, ctx, e, l.linkId, personId);
    const share: AllocatedShare = {
      linkId: l.linkId, personId, entityType: e.entityType, activityType: l.activityType, partnerSeStatus: l.partnerSeStatus,
      isOfficer: l.isOfficer, profitFraction: f.profit, lossFraction: f.loss, share: applied.share, guaranteedPayment: gp,
      officerWages: wagesByPerson.get(personId) ?? ZERO, sehiAsW2Wages: sehiW2ByPerson.get(personId) ?? ZERO,
      ownerSehi: sehiByPerson.get(personId) ?? ZERO, ownerRetirement: retirementByPerson.get(personId) ?? ZERO,
      seIncome: applied.seIncome, qbiEligible: l.qbiEligible, activeParticipation: l.activeParticipation,
      allowedLossOverride: l.allowedLossOverride == null ? null : dec(l.allowedLossOverride),
    };
    ctx.trace.add({
      step: STEP_ALLOCATE, id: `share.${l.linkId}`, label: `${e.companyName} — share of ${useLoss ? 'loss' : 'profit'}`, exact: sumCharacters(share.share),
      source: 'input', formula: `${projectedProfit} × ${fraction} (${useLoss ? 'loss' : 'profit'} %)`, personId, entityId: eid,
    });
    if (dIsPos(gp)) ctx.trace.add({ step: STEP_ALLOCATE, id: `gp.${l.linkId}`, label: `${e.companyName} — guaranteed payment`, exact: gp, source: 'gl_map', personId, entityId: eid });
    if (dIsPos(share.officerWages)) ctx.trace.add({ step: STEP_ALLOCATE, id: `officer_wages.${l.linkId}`, label: `${e.companyName} — officer W-2 wages`, exact: share.officerWages, source: 'gl_map', personId, entityId: eid });
    if (dIsPos(share.sehiAsW2Wages)) ctx.trace.add({ step: STEP_ALLOCATE, id: `sehi_w2.${l.linkId}`, label: `${e.companyName} — >2% shareholder health in W-2 box 1`, exact: share.sehiAsW2Wages, source: 'gl_map', personId, entityId: eid });
    return share;
  });

  // Persons with owner items / GP / wages but no link: route them anyway so nothing is dropped.
  const linked = new Set(shares.map((s) => s.personId));
  for (const [pid] of [...gpByPerson, ...wagesByPerson, ...sehiByPerson, ...retirementByPerson]) {
    if (linked.has(pid)) continue;
    ctx.warn('TE_OWNER_ITEM_NO_LINK', `${e.companyName}: person ${pid} has owner-level amounts but no link to this entity; they were attached to an empty share.`, { entityId: eid, personId: pid });
    shares.push({
      linkId: `${eid}:${pid}`, personId: pid, entityType: e.entityType, activityType: 'active', partnerSeStatus: null, isOfficer: false,
      profitFraction: ZERO, lossFraction: ZERO, share: characters({}), guaranteedPayment: gpByPerson.get(pid) ?? ZERO,
      officerWages: wagesByPerson.get(pid) ?? ZERO, sehiAsW2Wages: sehiW2ByPerson.get(pid) ?? ZERO, ownerSehi: sehiByPerson.get(pid) ?? ZERO,
      ownerRetirement: retirementByPerson.get(pid) ?? ZERO, seIncome: seIncomeFor(e.entityType, null, ZERO, gpByPerson.get(pid) ?? ZERO),
      qbiEligible: null, activeParticipation: false, allowedLossOverride: null,
    });
    linked.add(pid);
  }

  return { entity: e, projected, projectedProfit, shares };
}

// ── Taxpayer-level aggregation ───────────────────────────────────────

export interface PersonIncome {
  personId: string;
  /** Outside W-2 wages + officer wages + sehiAsW2Wages (box 1). */
  wages: Dec;
  /** Social Security wages for the SE wage-base offset. */
  socialSecurityWages: Dec;
  character: CharacterAmounts;
  guaranteedPayments: Dec;
  seIncome: Dec;
  reitDividends: Dec;
  ptpIncome: Dec;
  /** Owner-level pools (positive) before limits. */
  sehiPremiums: Dec;
  retirementContributions: Dec;
  hsaContributions: Dec;
  /** Other above-the-line deductions attributed to this person. */
  otherAboveTheLine: Dec;
  shares: AllocatedShare[];
}

export interface AggregatedIncome {
  byPerson: Map<string, PersonIncome>;
  /** Above-the-line deductions with no person (taxpayer level). */
  otherAboveTheLine: Dec;
  /** Deductions that are neither above the line nor Schedule 1-A: itemized "other". */
  itemizedOther: Dec;
}

const RETIREMENT_CODES: ReadonlySet<string> = new Set(['sep_solo_401k', 'retirement_catch_up']);

export function aggregatePersons(entities: AllocatedEntity[], persons: EnginePerson[], adjustments: EngineAdjustment[], ctx: EngineContext): AggregatedIncome {
  const byPerson = new Map<string, PersonIncome>();
  for (const p of persons) {
    byPerson.set(p.personId, {
      personId: p.personId, wages: dec(p.w2Wages), socialSecurityWages: p.w2SocialSecurityWages == null ? dec(p.w2Wages) : dec(p.w2SocialSecurityWages),
      character: characters({}), guaranteedPayments: ZERO, seIncome: ZERO, reitDividends: ZERO, ptpIncome: ZERO, sehiPremiums: ZERO,
      retirementContributions: ZERO, hsaContributions: ZERO, otherAboveTheLine: ZERO, shares: [],
    });
    if (dIsPos(p.w2Wages)) ctx.trace.add({ step: STEP_INCOME, id: `wages.${p.personId}`, label: `${p.displayName} — W-2 wages`, exact: p.w2Wages, source: 'input', personId: p.personId });
  }
  const get = (pid: string): PersonIncome => {
    const r = byPerson.get(ctx.resolvePerson(pid));
    if (!r) throw new Error('TE_NO_PERSONS: the taxpayer has no persons');
    return r;
  };

  for (const ae of entities) {
    for (const s of ae.shares) {
      const p = get(s.personId);
      p.character = addCharacters(p.character, s.share);
      p.guaranteedPayments = dAdd(p.guaranteedPayments, s.guaranteedPayment);
      p.character = { ...p.character, ordinary: dAdd(p.character.ordinary, s.guaranteedPayment) };
      p.seIncome = dAdd(p.seIncome, s.seIncome);
      p.wages = dAdd(p.wages, dAdd(s.officerWages, s.sehiAsW2Wages));
      // Officer wages are Social Security wages; the >2% health add-on is not.
      p.socialSecurityWages = dAdd(p.socialSecurityWages, s.officerWages);
      p.sehiPremiums = dAdd(p.sehiPremiums, s.ownerSehi);
      p.retirementContributions = dAdd(p.retirementContributions, s.ownerRetirement);
      p.shares.push(s);
    }
  }

  let otherAboveTheLine: Dec = ZERO;
  let itemizedOther: Dec = ZERO;
  for (const a of adjustments) {
    if (a.linkId) continue; // applied in allocateEntity
    const pid = ctx.resolvePerson(a.personId);
    const p = get(pid);
    if (a.kind === 'deduction') {
      if (a.typeCode === 'owner_health_insurance') p.sehiPremiums = dAdd(p.sehiPremiums, a.amount);
      else if (a.typeCode && RETIREMENT_CODES.has(a.typeCode)) p.retirementContributions = dAdd(p.retirementContributions, a.amount);
      else if (a.typeCode === 'hsa_contribution') p.hsaContributions = dAdd(p.hsaContributions, a.amount);
      else if (a.isAboveTheLine) {
        if (a.personId) p.otherAboveTheLine = dAdd(p.otherAboveTheLine, a.amount);
        else otherAboveTheLine = dAdd(otherAboveTheLine, a.amount);
        ctx.trace.add({ step: STEP_INCOME, id: `adjustment.${a.id}`, label: a.label, exact: dNeg(a.amount), source: 'adjustment', formula: 'above-the-line deduction', personId: a.personId });
      } else {
        itemizedOther = dAdd(itemizedOther, a.amount);
        ctx.trace.add({ step: STEP_INCOME, id: `adjustment.${a.id}`, label: a.label, exact: dNeg(a.amount), source: 'adjustment', formula: 'itemized deduction (other)', personId: a.personId });
      }
      continue;
    }
    const effect = adjustmentEffect(a);
    const character = a.kind === 'income' ? adjustmentCharacter(a) : 'ordinary';
    p.character = { ...p.character, [character]: dAdd(p.character[character], effect) };
    if (character === 'dividends_qualified') p.character = { ...p.character, dividends_ordinary: dAdd(p.character.dividends_ordinary, effect) };
    if (a.isReitDividend) p.reitDividends = dAdd(p.reitDividends, effect);
    if (a.isPtp) p.ptpIncome = dAdd(p.ptpIncome, effect);
    if (a.affectsSe && character === 'ordinary') p.seIncome = dAdd(p.seIncome, effect);
    ctx.trace.add({
      step: STEP_INCOME, id: `adjustment.${a.id}`, label: a.label, exact: effect, source: 'adjustment', personId: pid,
      formula: a.kind === 'addback' ? `${a.amount} × ${a.pct == null ? '100%' : `${a.pct}%`} add-back` : `${character}${a.affectsSe ? ', SE income' : ''}`,
    });
  }

  return { byPerson, otherAboveTheLine, itemizedOther };
}

// ── Net income by character (step 1 totals) ──────────────────────────

export interface IncomeExact {
  wages: Dec;
  businessOrdinary: Dec;
  guaranteedPayments: Dec;
  rental: Dec;
  interest: Dec;
  dividends: Dec;
  qualifiedDividends: Dec;
  capitalGainShortTerm: Dec;
  capitalGainLongTerm: Dec;
  section1231: Dec;
  capitalGainNet: Dec;
  capitalLossDisallowed: Dec;
  otherIncome: Dec;
  totalIncome: Dec;
  /** Schedule D line 15 equivalent for the QD/LTCG worksheet: net LTCG limited by the overall net gain, ≥ 0. */
  netLongTermGainForWorksheet: Dec;
}

export function netIncome(persons: PersonIncome[], ctx: EngineContext): IncomeExact {
  const total = persons.reduce((acc, p) => addCharacters(acc, p.character), characters({}));
  const wages = dSum(persons.map((p) => p.wages));
  const guaranteedPayments = dSum(persons.map((p) => p.guaranteedPayments));

  // §1231: net gain is long-term capital gain; net loss is ordinary.
  const s1231 = total.section_1231;
  const ordinaryFrom1231 = dIsNeg(s1231) ? s1231 : ZERO;
  const ltFrom1231 = dIsPos(s1231) ? s1231 : ZERO;
  const businessOrdinary = dAdd(total.ordinary, ordinaryFrom1231);
  const st = total.capital_gain_st;
  const lt = dAdd(total.capital_gain_lt, ltFrom1231);
  const netGain = dAdd(st, lt);
  let capitalGainNet = netGain;
  let disallowed: Dec = ZERO;
  if (dIsNeg(netGain)) {
    const limitKey = ctx.filingStatus === 'mfs' ? 'capital_loss.limit.mfs' : 'capital_loss.limit.standard';
    const limit = ctx.params.money(limitKey);
    capitalGainNet = dMax(netGain, dNeg(limit));
    disallowed = dSub(capitalGainNet, netGain);
    if (dIsPos(disallowed)) ctx.warn('TE_CAPITAL_LOSS_LIMITED', `Net capital loss ${netGain} is limited to ${capitalGainNet} this year (§1211); ${disallowed} carries forward (not tracked).`, { disallowed });
    ctx.trace.add({ step: STEP_INCOME, id: 'capital_gain_net', label: 'Net capital gain / (loss) after §1211 limit', exact: capitalGainNet, source: 'parameter', formula: `max(${netGain}, −${limit})`, parameterKeys: [limitKey] });
  } else if (!dIsZero(netGain)) {
    ctx.trace.add({ step: STEP_INCOME, id: 'capital_gain_net', label: 'Net capital gain', exact: capitalGainNet, source: 'input', formula: `short-term ${st} + long-term ${lt}` });
  }
  const netLongTermGainForWorksheet = dIsPos(lt) && dIsPos(netGain) ? dMin(lt, netGain) : ZERO;

  const totalIncome = dSum([wages, businessOrdinary, total.rental, total.interest, total.dividends_ordinary, capitalGainNet]);
  ctx.trace.add({ step: STEP_INCOME, id: 'total_income', label: 'Total income', exact: totalIncome, source: 'gl_map', formula: 'wages + business + rental + interest + dividends + net capital gain' });
  return {
    wages, businessOrdinary, guaranteedPayments, rental: total.rental, interest: total.interest, dividends: total.dividends_ordinary,
    qualifiedDividends: total.dividends_qualified, capitalGainShortTerm: st, capitalGainLongTerm: lt, section1231: s1231,
    capitalGainNet, capitalLossDisallowed: disallowed, otherIncome: ZERO, totalIncome, netLongTermGainForWorksheet,
  };
}

export { MONTHS_PER_YEAR };
