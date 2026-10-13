// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q53 (Kurt, 2026-10-13: "Why have tax rate schedule for federal but not states?") — the state
// rate-schedule computation, pure. MODULE.md "State calculation":
//   start          = the state's `starting_point` (federal AGI | federal taxable income |
//                    state_specific → federal AGI, info) or the row's custom base (taken as entered);
//   state AGI      = start − capital gain exclusion (`capital_gains`, exclusion treatment);
//   taxable income = state AGI − federal income tax deduction (`federal_tax_deduction`, AL / MO / OR)
//                    − standard deduction (`standard_deduction`) − personal / dependent exemptions
//                    (Q44 `exemptions`), not below 0;
//   tax            = `brackets` schedule for the filing status (or the `schedules_by_income` entry
//                    the taxable income reaches), with the `capital_gains` alternative rate (HI) or
//                    separate rates (MT long-term schedule stacked on ordinary income, MA short-term).
// Every figure is traced. Rule values are read through the StateRuleReader (D12a statuses).

import type { FilingStatus } from '../types.js';
import {
  ZERO, dAdd, dCmp, dDiv, dFloorZero, dIsPos, dMax, dMin, dMul, dRoundDollars, dSub, dec, type Dec,
} from '../decimal.js';
import type {
  StateBracket, StateCapitalGainsRule, StateFederalTaxDeductionRule, StateStartingPoint, StateCapitalGainsExciseRule,
} from '../stateRuleKeys.js';
import { STATE_STARTING_POINTS } from '../stateRuleKeys.js';
import type { BracketRow } from './parameters.js';
import { bracketSlices, bracketTax } from './bracket-tax.js';
import type { FederalFiguresForState, StateRuleReader, StateTraceBuilder, StateTraceInput } from './state-types.js';

export const KEY_STARTING_POINT = 'starting_point';
export const KEY_BRACKETS = 'brackets';
export const KEY_STANDARD_DEDUCTION = 'standard_deduction';
export const KEY_CAPITAL_GAINS = 'capital_gains';
export const KEY_FEDERAL_TAX_DEDUCTION = 'federal_tax_deduction';
export const KEY_CAPITAL_GAINS_EXCISE = 'capital_gains_excise';

const STEP_TAX = 'state_tax';
const R = dRoundDollars;

/** The slice of StateContext the schedule needs (kept structural so state.ts does not import back). */
export interface ScheduleCtx {
  warn(code: string, message: string, details?: Record<string, unknown>): void;
  info(code: string, message: string, details?: Record<string, unknown>): void;
  readonly trace: StateTraceBuilder;
}

/** Federal capital-gain figures the state treatment reads (≥ 0). */
export interface StateGains {
  /** Net long-term gain limited by the overall net gain (Schedule D line 15 / worksheet). */
  ltcg: Dec;
  /** Net capital gain (short + long term) in federal AGI, ≥ 0. */
  netCapitalGain: Dec;
  /** Net short-term part of the net capital gain. */
  stcg: Dec;
  qualifiedDividends: Dec;
}

export function gainsFromFederal(f: FederalFiguresForState): StateGains {
  const ltcg = dFloorZero(dec(f.netLongTermGain ?? ZERO));
  const netCapitalGain = dFloorZero(dec(f.capitalGainNet ?? ZERO));
  return { ltcg, netCapitalGain, stcg: dFloorZero(dSub(netCapitalGain, dMin(ltcg, netCapitalGain))), qualifiedDividends: dFloorZero(dec(f.qualifiedDividends ?? ZERO)) };
}

/** [{ over, rate }] → BracketRow[] (upper = the next bracket's over). */
export function toBracketRows(list: ReadonlyArray<StateBracket>): BracketRow[] {
  return list.map((b, i) => ({ upper: i + 1 < list.length ? dec(list[i + 1]!.over) : null, rate: dec(b.rate) }));
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Brackets for the filing status from a by-status map; null when absent / malformed. */
function statusBrackets(map: unknown, fs: FilingStatus): StateBracket[] | null {
  if (!isObj(map)) return null;
  const list = map[fs];
  return Array.isArray(list) && list.length > 0 ? (list as StateBracket[]) : null;
}

/** Whether a usable schedule exists for the filing status (the rate_mode fallback test). */
export function scheduleAvailable(rules: StateRuleReader | null, fs: FilingStatus): boolean {
  if (!rules || !rules.has(KEY_BRACKETS)) return false;
  return statusBrackets(rules.object(KEY_BRACKETS), fs) != null;
}

export interface ScheduleChoice { rows: BracketRow[]; list: StateBracket[]; label: string }

/** The main schedule, or the last `schedules_by_income` entry whose income_over is below `taxable`. */
export function chooseSchedule(rule: Record<string, unknown>, fs: FilingStatus, taxable: Dec): ScheduleChoice | null {
  const main = statusBrackets(rule, fs);
  if (!main) return null;
  let chosen: ScheduleChoice = { rows: toBracketRows(main), list: main, label: 'main schedule' };
  const alts = rule['schedules_by_income'];
  if (Array.isArray(alts)) {
    for (const a of alts as Array<Record<string, unknown>>) {
      const over = a['income_over'];
      const list = statusBrackets(a, fs);
      if (typeof over === 'number' && list && dCmp(taxable, dec(over)) > 0) chosen = { rows: toBracketRows(list), list, label: `schedule for state taxable income over ${over}` };
    }
  }
  return chosen;
}

/** Marginal tiers: Σ pct × (part of the gain between over and the next over). */
export function tieredExclusion(gain: Dec, tiers: ReadonlyArray<{ over: number; pct: number }>): Dec {
  if (!dIsPos(gain)) return ZERO;
  let out: Dec = ZERO;
  for (const [i, t] of tiers.entries()) {
    const lo = dec(t.over);
    if (dCmp(gain, lo) <= 0) break;
    const next = i + 1 < tiers.length ? dec(tiers[i + 1]!.over) : null;
    const hi = next == null ? gain : dMin(gain, next);
    out = dAdd(out, dMul(dSub(hi, lo), dec(t.pct)));
  }
  return out;
}

export interface ScheduleCalc {
  startingPoint: StateStartingPoint | 'row_base' | 'custom' | 'sourced';
  start: Dec;
  capitalGainExclusion: Dec;
  /** start − capital gain exclusion (the base the federal-tax-deduction tier and the credit ratio read). */
  stateAgi: Dec;
  federalTaxDeduction: Dec;
  standardDeduction: Dec;
  exemptions: Dec;
  taxableIncome: Dec;
  /** Schedule tax incl. alternative / separate capital-gain rates, before exemption credits. */
  tax: Dec;
  scheduleLabel: string;
  capitalGainsTreatment: string | null;
  ruleKeys: string[];
}

export interface ScheduleArgs {
  state: string;
  filingStatus: FilingStatus;
  rules: StateRuleReader;
  federal: FederalFiguresForState;
  /** Row base selector — used only when the state has no `starting_point` on file. */
  rowBase: 'federal_agi' | 'federal_taxable' | 'custom';
  /** Custom base (taken as entered: state taxable income, no deductions applied). */
  customBase: Dec | null;
  /** Q44 household exemptions (null = none / not sourced). */
  exemption: Dec | null;
  exemptionKeys: string[];
  /**
   * Prorated mode (nonresident, the state's method sourced_flat / other): start = the sourced income,
   * deductions and exemptions × `ratio`, no capital-gain treatment.
   */
  prorated?: { sourced: Dec; ratio: Dec } | null;
  idPrefix: string;
  labelPrefix: string;
}

function trace(ctx: ScheduleCtx, args: ScheduleArgs, id: string, row: Omit<StateTraceInput, 'step' | 'id' | 'state'>): void {
  ctx.trace.add({ step: STEP_TAX, id: `${args.idPrefix}.${id}`, state: args.state, ...row });
}

function readStartingPoint(args: ScheduleArgs, ctx: ScheduleCtx): { point: ScheduleCalc['startingPoint']; start: Dec; keys: string[] } {
  const { rules, federal, state } = args;
  if (args.prorated) return { point: 'sourced', start: dFloorZero(args.prorated.sourced), keys: [] };
  if (args.rowBase === 'custom') {
    if (args.customBase == null) {
      ctx.warn('TE_STATE_CUSTOM_BASE_MISSING', `${state}: base is 'custom' but no custom base amount was entered; federal AGI was used.`, { state });
      return { point: 'row_base', start: dec(federal.agi), keys: [] };
    }
    return { point: 'custom', start: dec(args.customBase), keys: [] };
  }
  const has = rules.has(KEY_STARTING_POINT);
  const sp = has ? rules.text(KEY_STARTING_POINT) : null;
  if (sp && (STATE_STARTING_POINTS as readonly string[]).includes(sp)) {
    const point = sp as StateStartingPoint;
    if (point === 'state_specific') {
      ctx.info('TE_STATE_STARTING_POINT_APPROX', `${state} computes its own gross income; federal AGI was used as the starting point (approximation). The estimate may differ.`, { state });
      return { point, start: dec(federal.agi), keys: [KEY_STARTING_POINT] };
    }
    if (point === 'federal_taxable_before_qbi') return { point, start: dAdd(dec(federal.taxableIncome), dec(federal.qbiDeduction ?? ZERO)), keys: [KEY_STARTING_POINT] };
    return { point, start: dec(point === 'federal_taxable' ? federal.taxableIncome : federal.agi), keys: [KEY_STARTING_POINT] };
  }
  if (has) ctx.warn('TE_STATE_STARTING_POINT_UNSOURCED', `${state}: the starting point could not be sourced for the year (null); the row's base (${args.rowBase === 'federal_taxable' ? 'federal taxable income' : 'federal AGI'}) was used. Verify.`, { state });
  else ctx.info('TE_STATE_STARTING_POINT_MISSING', `${state}: no starting-point rule is on file for the year; the row's base (${args.rowBase === 'federal_taxable' ? 'federal taxable income' : 'federal AGI'}) was used.`, { state });
  return { point: 'row_base', start: dec(args.rowBase === 'federal_taxable' ? federal.taxableIncome : federal.agi), keys: has ? [KEY_STARTING_POINT] : [] };
}

/** The capital-gains rule when present and usable; warnings for missing / null. */
export function readCapitalGains(rules: StateRuleReader, state: string, ctx: ScheduleCtx): { rule: StateCapitalGainsRule | null; keys: string[] } {
  if (!rules.has(KEY_CAPITAL_GAINS)) {
    ctx.info('TE_STATE_CAPITAL_GAINS_MISSING', `${state}: no capital gains rule is on file for the year; gains were taxed as ordinary income.`, { state });
    return { rule: null, keys: [] };
  }
  const v = rules.object(KEY_CAPITAL_GAINS);
  if (!v) {
    ctx.warn('TE_STATE_CAPITAL_GAINS_UNSOURCED', `${state}: the capital gains treatment could not be sourced for the year (stored as an explicit null); gains were taxed as ordinary income. Verify.`, { state });
    return { rule: null, keys: [KEY_CAPITAL_GAINS] };
  }
  return { rule: v as unknown as StateCapitalGainsRule, keys: [KEY_CAPITAL_GAINS] };
}

function gainFor(rule: StateCapitalGainsRule, g: StateGains): Dec {
  const base = rule.applies_to === 'net_capital_gain' ? g.netCapitalGain : g.ltcg;
  return rule.includes_qualified_dividends ? dAdd(base, g.qualifiedDividends) : base;
}

function gainLabel(rule: StateCapitalGainsRule): string {
  return `${rule.applies_to === 'net_capital_gain' ? 'net capital gain' : 'net long-term capital gain'}${rule.includes_qualified_dividends ? ' + qualified dividends' : ''}`;
}

/** Capital gain exclusion (exclusion treatment only). */
function capitalGainExclusion(rule: StateCapitalGainsRule, g: StateGains, args: ScheduleArgs, ctx: ScheduleCtx): Dec {
  const gain = gainFor(rule, g);
  if (!dIsPos(gain)) return ZERO;
  const tiers = rule.exclusion_tiers ?? [];
  let excluded = tiers.length > 0 ? tieredExclusion(gain, tiers) : ZERO;
  const parts = [tiers.length > 0 ? `tiers ${tiers.map((t) => `${t.pct} over ${t.over}`).join(', ')} on ${gain} = ${excluded}` : `no tiers`];
  if (typeof rule.exclusion_min === 'number') {
    const floor = dMin(dec(rule.exclusion_min), gain);
    if (dCmp(floor, excluded) > 0) { excluded = floor; parts.push(`raised to the minimum ${floor}`); }
  }
  if (typeof rule.exclusion_cap === 'number' && dCmp(excluded, dec(rule.exclusion_cap)) > 0) {
    excluded = dec(rule.exclusion_cap);
    parts.push(`capped at ${rule.exclusion_cap}`);
  }
  trace(ctx, args, 'capital_gain_exclusion', { label: `${args.labelPrefix} capital gain exclusion (${gainLabel(rule)} ${R(gain)})`, exact: excluded, source: 'state_rule', ruleKeys: [KEY_CAPITAL_GAINS], formula: parts.join('; ') });
  return excluded;
}

function federalTaxDeduction(args: ScheduleArgs, stateAgi: Dec, ctx: ScheduleCtx): { amount: Dec; keys: string[] } {
  const { rules, state, filingStatus } = args;
  if (!rules.has(KEY_FEDERAL_TAX_DEDUCTION)) return { amount: ZERO, keys: [] };
  const v = rules.object(KEY_FEDERAL_TAX_DEDUCTION) as unknown as StateFederalTaxDeductionRule | null;
  if (!v) {
    ctx.warn('TE_STATE_FEDERAL_TAX_DEDUCTION_UNSOURCED', `${state}: the federal income tax deduction could not be sourced for the year (null); none was applied. Verify.`, { state });
    return { amount: ZERO, keys: [KEY_FEDERAL_TAX_DEDUCTION] };
  }
  if (args.federal.federalIncomeTax == null) {
    ctx.warn('TE_STATE_FEDERAL_TAX_UNKNOWN', `${state}: the federal income tax figure was not supplied; the federal income tax deduction was not applied.`, { state });
    return { amount: ZERO, keys: [KEY_FEDERAL_TAX_DEDUCTION] };
  }
  const fedTax = dFloorZero(dec(args.federal.federalIncomeTax));
  let tier = v.tiers[0]!;
  for (const t of v.tiers) if (dCmp(stateAgi, dec(t.agi_over)) > 0) tier = t;
  const pctAmount = dMul(fedTax, dec(tier.pct));
  const cap = tier.cap?.[filingStatus];
  const amount = typeof cap === 'number' ? dMin(pctAmount, dec(cap)) : pctAmount;
  if (v.simplified) ctx.info('TE_STATE_FEDERAL_TAX_DEDUCTION_SIMPLIFIED', `${state}: the federal income tax deduction is simplified${v.note ? ` (${v.note})` : ''}. The estimate may differ.`, { state });
  trace(ctx, args, 'federal_tax_deduction', {
    label: `${args.labelPrefix} federal income tax deduction (state AGI ${R(stateAgi)} → ${tier.pct} tier)`, exact: amount, source: 'state_rule', ruleKeys: [KEY_FEDERAL_TAX_DEDUCTION],
    formula: `min(federal income tax ${fedTax} × ${tier.pct} = ${pctAmount}${typeof cap === 'number' ? `, cap ${cap}` : ', no cap'})`,
  });
  return { amount, keys: [KEY_FEDERAL_TAX_DEDUCTION] };
}

function standardDeduction(args: ScheduleArgs, ctx: ScheduleCtx): { amount: Dec; keys: string[] } {
  const { rules, state, filingStatus } = args;
  if (!rules.has(KEY_STANDARD_DEDUCTION)) {
    ctx.info('TE_STATE_STD_DEDUCTION_MISSING', `${state}: no standard deduction rule is on file for the year; none was applied.`, { state });
    return { amount: ZERO, keys: [] };
  }
  const v = rules.object(KEY_STANDARD_DEDUCTION);
  if (!v) {
    ctx.warn('TE_STATE_STD_DEDUCTION_UNSOURCED', `${state}: the standard deduction could not be sourced for the year (stored as an explicit null); none was applied. Verify.`, { state });
    return { amount: ZERO, keys: [KEY_STANDARD_DEDUCTION] };
  }
  const n = v[filingStatus];
  if (v['simplified'] === true) ctx.info('TE_STATE_STD_DEDUCTION_SIMPLIFIED', `${state}: the standard deduction uses the base amount; phase-outs, sliding scales or age / blind additions are not modelled${typeof v['note'] === 'string' && v['note'] ? ` (${v['note']})` : ''}. The estimate may differ.`, { state });
  return { amount: typeof n === 'number' ? dec(n) : ZERO, keys: [KEY_STANDARD_DEDUCTION] };
}

/** Σ fixed `add` amounts of the brackets `income` exceeds (schedule notches). */
export function bracketAdds(income: Dec, list: ReadonlyArray<StateBracket>): Dec {
  let out: Dec = ZERO;
  for (const b of list) if (typeof b.add === 'number' && dCmp(income, dec(b.over)) > 0) out = dAdd(out, dec(b.add));
  return out;
}

/** Schedule tax incl. notches (pure). */
export function stateScheduleTax(income: Dec, list: ReadonlyArray<StateBracket>): Dec {
  return dAdd(bracketTax(income, toBracketRows(list)), bracketAdds(income, list));
}

/** Schedule tax with per-bracket trace rows. */
function scheduleTaxTraced(args: ScheduleArgs, ctx: ScheduleCtx, taxable: Dec, list: ReadonlyArray<StateBracket>, id: string, label: string): Dec {
  for (const s of bracketSlices(taxable, toBracketRows(list))) {
    const add = list[s.index - 1]?.add;
    trace(ctx, args, `${id}.bracket.${s.index}`, {
      label: `${args.labelPrefix} ${label} bracket ${s.index}: ${s.lower} to ${s.upper ?? 'no limit'} at ${s.rate}${typeof add === 'number' ? ` plus ${add}` : ''}`,
      exact: typeof add === 'number' ? dAdd(s.tax, dec(add)) : s.tax, source: 'state_rule', ruleKeys: [KEY_BRACKETS], formula: `${s.taxable} × ${s.rate}${typeof add === 'number' ? ` + ${add}` : ''}`,
    });
  }
  return stateScheduleTax(taxable, list);
}

/**
 * The full schedule computation for one row (resident, or a nonresident's as-if-resident /
 * prorated computation). null = no usable schedule for the filing status (caller falls back).
 */
export function computeScheduleTax(args: ScheduleArgs, ctx: ScheduleCtx): ScheduleCalc | null {
  const { rules, state, filingStatus } = args;
  if (!scheduleAvailable(rules, filingStatus)) return null;
  const bracketsRule = rules.object(KEY_BRACKETS)!;
  const keys: string[] = [KEY_BRACKETS];
  const sp = readStartingPoint(args, ctx);
  keys.push(...sp.keys);
  trace(ctx, args, 'start', { label: `${args.labelPrefix} starting point (${sp.point.replace(/_/g, ' ')})`, exact: sp.start, source: sp.point === 'custom' || sp.point === 'sourced' ? 'input' : 'gl_map', ruleKeys: sp.keys });

  let cgExcluded: Dec = ZERO;
  let cgRule: StateCapitalGainsRule | null = null;
  let fedDed: Dec = ZERO;
  let std: Dec = ZERO;
  let exemptions: Dec = ZERO;
  let stateAgi = sp.start;
  let taxable: Dec;
  if (sp.point === 'custom') {
    ctx.info('TE_STATE_CUSTOM_BASE_AS_ENTERED', `${state}: the base is a custom amount, taken as the state taxable income — no standard deduction, exemptions, capital gain or federal tax adjustments were applied.`, { state });
    taxable = dFloorZero(sp.start);
  } else {
    const ratio = args.prorated?.ratio ?? null;
    if (!args.prorated) {
      const cg = readCapitalGains(rules, state, ctx);
      keys.push(...cg.keys);
      cgRule = cg.rule;
      if (cgRule?.treatment === 'exclusion') cgExcluded = capitalGainExclusion(cgRule, gainsFromFederal(args.federal), args, ctx);
      if (cgRule?.treatment === 'qualifying_assets_only') {
        ctx.info('TE_STATE_CAPITAL_GAINS_QUALIFYING_ONLY', `${state}: the capital gain deduction applies only to qualifying assets the estimator cannot identify${cgRule.note ? ` (${cgRule.note})` : ''}; none was applied. Enter a custom base to include it.`, { state });
      }
      if (cgRule?.simplified) ctx.info('TE_STATE_CAPITAL_GAINS_SIMPLIFIED', `${state}: the capital gains treatment is simplified${cgRule.note ? ` (${cgRule.note})` : ''}. The estimate may differ.`, { state });
      stateAgi = dSub(sp.start, cgExcluded);
    }
    const fd = federalTaxDeduction(args, stateAgi, ctx);
    keys.push(...fd.keys);
    const sd = standardDeduction(args, ctx);
    keys.push(...sd.keys);
    fedDed = fd.amount;
    std = sd.amount;
    let ex = args.exemption != null && dIsPos(args.exemption) ? args.exemption : ZERO;
    if (ratio != null) {
      fedDed = dMul(fedDed, ratio);
      std = dMul(std, ratio);
      ex = dMul(ex, ratio);
    }
    if (dIsPos(std)) trace(ctx, args, 'standard_deduction', { label: `${args.labelPrefix} standard deduction (${filingStatus})${ratio != null ? ' × income ratio' : ''}`, exact: std, source: 'state_rule', ruleKeys: [KEY_STANDARD_DEDUCTION], formula: ratio != null ? `${sd.amount} × ${ratio}` : undefined });
    const afterStd = dFloorZero(dSub(dSub(stateAgi, fedDed), std));
    exemptions = dMin(ex, afterStd);
    if (dIsPos(exemptions)) {
      keys.push(...args.exemptionKeys);
      trace(ctx, args, 'exemptions', { label: `${args.labelPrefix} personal / dependent exemptions${ratio != null ? ' × income ratio' : ''}`, exact: exemptions, source: 'state_rule', ruleKeys: args.exemptionKeys, formula: `min(${ex}, ${afterStd})` });
    }
    taxable = dSub(afterStd, exemptions);
  }
  trace(ctx, args, 'taxable', {
    label: `${args.labelPrefix} state taxable income`, exact: taxable, source: 'state_rule', ruleKeys: keys,
    formula: sp.point === 'custom' ? `custom ${sp.start}, not below 0` : `${sp.start} − capital gain exclusion ${cgExcluded} − federal tax deduction ${fedDed} − standard deduction ${std} − exemptions ${exemptions}, not below 0`,
  });

  const choice = chooseSchedule(bracketsRule, filingStatus, taxable)!;
  if (bracketsRule['simplified'] === true) {
    ctx.info('TE_STATE_BRACKETS_SIMPLIFIED', `${state}: the rate schedule is simplified${typeof bracketsRule['note'] === 'string' && bracketsRule['note'] ? ` (${bracketsRule['note']})` : ''}. The estimate may differ.`, { state });
  }
  const regular = scheduleTaxTraced(args, ctx, taxable, choice.list, 'schedule', choice.label === 'main schedule' ? 'schedule' : choice.label);
  let tax = regular;

  // Alternative / separate capital-gain rates (not in prorated mode or on a custom base).
  if (cgRule && sp.point !== 'custom' && !args.prorated && dIsPos(taxable)) {
    const g = gainsFromFederal(args.federal);
    if (cgRule.treatment === 'alternative_rate' && typeof cgRule.max_rate === 'number') {
      const gain = dMin(gainFor(cgRule, g), taxable);
      if (dIsPos(gain)) {
        const ordinary = dSub(taxable, gain);
        const alt = dAdd(stateScheduleTax(ordinary, choice.list), dMul(gain, dec(cgRule.max_rate)));
        trace(ctx, args, 'capital_gain_alternative', { label: `${args.labelPrefix} alternative tax on ${gainLabel(cgRule)}`, exact: alt, source: 'state_rule', ruleKeys: [KEY_CAPITAL_GAINS, KEY_BRACKETS], formula: `schedule(${ordinary}) + ${gain} × ${cgRule.max_rate}; tax = min(regular ${regular}, alternative ${alt})` });
        tax = dMin(regular, alt);
      }
    } else if (cgRule.treatment === 'separate_rates') {
      let stPart: Dec = ZERO;
      let ltPart: Dec = ZERO;
      if (typeof cgRule.stcg_rate === 'number') stPart = dMin(g.stcg, taxable);
      const ltList = statusBrackets(cgRule.ltcg_brackets, filingStatus);
      if (ltList) ltPart = dMin(cgRule.includes_qualified_dividends ? dAdd(g.ltcg, g.qualifiedDividends) : g.ltcg, dSub(taxable, stPart));
      if (dIsPos(stPart) || dIsPos(ltPart)) {
        const ordinary = dSub(dSub(taxable, stPart), ltPart);
        const ordinaryTax = scheduleTaxTraced(args, ctx, ordinary, choice.list, 'ordinary', 'ordinary income');
        let parts = `schedule(${ordinary}) ${ordinaryTax}`;
        tax = ordinaryTax;
        if (dIsPos(stPart)) {
          const st = dMul(stPart, dec(cgRule.stcg_rate!));
          trace(ctx, args, 'capital_gain_short_term', { label: `${args.labelPrefix} net short-term capital gain at ${cgRule.stcg_rate}`, exact: st, source: 'state_rule', ruleKeys: [KEY_CAPITAL_GAINS], formula: `${stPart} × ${cgRule.stcg_rate}` });
          tax = dAdd(tax, st);
          parts += ` + short-term ${st}`;
        }
        if (dIsPos(ltPart) && ltList) {
          const ltRows = toBracketRows(ltList);
          const below = dAdd(ordinary, stPart);
          const top = dAdd(below, ltPart);
          const lt = dSub(bracketTax(top, ltRows), bracketTax(below, ltRows));
          trace(ctx, args, 'capital_gain_long_term', { label: `${args.labelPrefix} net long-term capital gain on its own schedule (stacked on other taxable income)`, exact: lt, source: 'state_rule', ruleKeys: [KEY_CAPITAL_GAINS], formula: `ltcg schedule(${top}) − ltcg schedule(${below})` });
          tax = dAdd(tax, lt);
          parts += ` + long-term ${lt}`;
        }
        trace(ctx, args, 'capital_gain_separate', { label: `${args.labelPrefix} tax with separate capital gain rates`, exact: tax, source: 'state_rule', ruleKeys: [KEY_CAPITAL_GAINS, KEY_BRACKETS], formula: parts });
      }
    }
  }
  if (cgRule && sp.point !== 'custom' && !args.prorated && typeof cgRule.surtax_rate === 'number' && typeof cgRule.surtax_agi_over === 'number') {
    const agi = dec(args.federal.agi);
    if (dCmp(agi, dec(cgRule.surtax_agi_over)) > 0) {
      const gain = gainFor(cgRule, gainsFromFederal(args.federal));
      const surtax = dMul(gain, dec(cgRule.surtax_rate));
      if (dIsPos(surtax)) {
        trace(ctx, args, 'capital_gain_surtax', { label: `${args.labelPrefix} capital gains surtax (federal AGI ${R(agi)} over ${cgRule.surtax_agi_over})`, exact: surtax, source: 'state_rule', ruleKeys: [KEY_CAPITAL_GAINS], formula: `${gain} × ${cgRule.surtax_rate}` });
        tax = dAdd(tax, surtax);
      }
    }
  }
  trace(ctx, args, 'schedule_tax', { label: `${args.labelPrefix} tax from the rate schedule (${choice.label})`, exact: tax, source: 'state_rule', ruleKeys: keys });
  return {
    startingPoint: sp.point, start: sp.start, capitalGainExclusion: cgExcluded, stateAgi, federalTaxDeduction: fedDed, standardDeduction: std, exemptions,
    taxableIncome: taxable, tax, scheduleLabel: choice.label, capitalGainsTreatment: cgRule?.treatment ?? null, ruleKeys: keys,
  };
}

/** min(1, max(0, a ÷ b)); 0 when b ≤ 0. */
export function incomeRatio(a: Dec, b: Dec): Dec {
  if (!dIsPos(b)) return ZERO;
  return dMin(dec(1), dMax(ZERO, dDiv(a, b)));
}

/** WA capital gains excise (resident): Σ brackets over (net long-term gain − standard deduction). */
export function capitalGainsExcise(rule: StateCapitalGainsExciseRule, gains: StateGains): { taxableGain: Dec; tax: Dec; rows: BracketRow[] } {
  const taxableGain = dFloorZero(dSub(gains.ltcg, dec(rule.standard_deduction)));
  const rows = toBracketRows(rule.brackets);
  return { taxableGain, tax: bracketTax(taxableGain, rows), rows };
}

