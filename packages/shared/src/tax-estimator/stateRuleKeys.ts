// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// State estimated-tax rule registry (features/tax-estimator/MODULE.md "State rule keys").
// 50 states + DC = 51 jurisdictions. Jurisdictions with no broad personal income tax
// need only `has_income_tax = false`; the rest need the full key set per tax year.

export const STATE_CODES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO',
  'MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
] as const;
export type StateCode = typeof STATE_CODES[number];

/** Jurisdictions with NO broad-based personal income tax for 2025–2026 (verify yearly). */
export const NO_BROAD_INCOME_TAX_STATES: readonly StateCode[] = ['AK','FL','NV','NH','SD','TN','TX','WA','WY'];

export const STATE_NAMES: Record<StateCode, string> = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',
  FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',
  MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
  NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',
  PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
};

export function isIncomeTaxState(code: StateCode): boolean {
  return !NO_BROAD_INCOME_TAX_STATES.includes(code);
}

export const STATE_RULE_VALUE_TYPES = ['bool', 'money', 'rate', 'date', 'date_list', 'rate_list', 'enum', 'high_agi_rule', 'farmer_rule', 'rate_schedule', 'requirement_gate', 'exemptions',
  'brackets', 'standard_deduction', 'capital_gains', 'federal_tax_deduction', 'capital_gains_excise'] as const;
export type StateRuleValueType = typeof STATE_RULE_VALUE_TYPES[number];

/** `required_threshold` / `penalty.min_balance_due` boundary: "$X or more" vs "more than $X". */
export const THRESHOLD_COMPARISONS = ['at_least', 'more_than'] as const;
export type ThresholdComparison = typeof THRESHOLD_COMPARISONS[number];

/**
 * How the underpayment penalty accrues. daily_simple = rate x days/365 (federal pattern);
 * monthly_or_fraction = rate/12 per month or part of a month (HI); monthly_compound =
 * rate/12 per month or fraction, compounded (ME); tiered_flat = flat late-payment
 * percentages, not a rate over time (IL; penalty.rate is null).
 */
export const PENALTY_METHODS = ['daily_simple', 'monthly_or_fraction', 'monthly_compound', 'tiered_flat'] as const;
export type PenaltyMethod = typeof PENALTY_METHODS[number];

/** farmer.rule.treatment. Absent = single_installment (the federal pattern). */
export const FARMER_TREATMENTS = ['single_installment', 'quarterly', 'exempt'] as const;
export type FarmerTreatment = typeof FARMER_TREATMENTS[number];

/** One dated leg of `penalty.rate_schedule`, inclusive calendar dates. */
export interface StateRatePeriod { from: string; to: string; rate: number }

/**
 * `requirement_gate` kinds (D12b, OPEN-QUESTIONS Q26): income-based tests that
 * replace or qualify the plain `required_threshold` test of "tax after
 * withholding and credits". Absent / null = the plain threshold test.
 * - gross_income_both_years: estimates required only when state gross income
 *   exceeds `threshold` (`threshold_mfj` joint) in BOTH the current and the
 *   preceding year, in addition to the threshold test (AZ).
 * - gross_over_exemptions_deductions: required when gross income exceeds
 *   exemptions + deductions + `non_withheld_floor` (GA; no tax-due minimum).
 * - non_withheld_income: required when income not subject to withholding
 *   exceeds `threshold` (PA), regardless of the tax-due figure.
 * - prior_year_liability_also: the threshold test must ALSO hold for the
 *   prior-year liability (ME: current and prior-year liability both at least $1,000).
 * - nets_withholding_only: the threshold is measured on tax less withholding
 *   only — credits are not subtracted (NM).
 */
export const REQUIREMENT_GATE_KINDS = ['gross_income_both_years', 'gross_over_exemptions_deductions', 'non_withheld_income', 'prior_year_liability_also', 'nets_withholding_only'] as const;
export type RequirementGateKind = typeof REQUIREMENT_GATE_KINDS[number];

export interface RequirementGateRule {
  kind: RequirementGateKind;
  /** gross_income_both_years / non_withheld_income / prior_year_liability_also. */
  threshold?: number;
  /** gross_income_both_years: the married-filing-jointly threshold (defaults to `threshold`). */
  threshold_mfj?: number;
  /** gross_over_exemptions_deductions: the fixed add-on to exemptions + deductions. */
  non_withheld_floor?: number;
}

/**
 * `exemptions` (Q44): a state's personal / dependent exemptions (reduce the state base) and
 * personal / dependent exemption CREDITS (reduce the state tax), resident returns. Per
 * component: a number (0 = the state has none, cited) or null (could not be sourced — the
 * engine applies nothing for it and warns). `*_by_status` = the WHOLE-RETURN amount for a
 * filing status when it is not simply per-filer × filers (wins over the per-filer figure).
 * `simplified` = income phase-outs / tiers / age-based amounts are not modelled (the stored
 * figure is the base or maximum, described in `note`); the engine warns.
 */
export const EXEMPTION_STATUSES = ['single', 'mfj', 'mfs', 'hoh', 'qss'] as const;
export interface StateExemptionsRule {
  personal_exemption: number | null;
  personal_exemption_by_status?: Partial<Record<typeof EXEMPTION_STATUSES[number], number>>;
  dependent_exemption: number | null;
  personal_credit: number | null;
  personal_credit_by_status?: Partial<Record<typeof EXEMPTION_STATUSES[number], number>>;
  dependent_credit: number | null;
  simplified?: boolean;
  note?: string;
}

// ── Q53: state rate schedules, standard deduction, starting point, capital gains ──

/**
 * `starting_point`: what the state return starts from. federal_taxable_before_qbi = federal taxable
 * income with the §199A deduction added back (MT); state_specific = the state's own gross income
 * (approximated by federal AGI, info).
 */
export const STATE_STARTING_POINTS = ['federal_agi', 'federal_taxable', 'federal_taxable_before_qbi', 'state_specific'] as const;
export type StateStartingPoint = typeof STATE_STARTING_POINTS[number];

/**
 * One marginal bracket: `rate` applies to state taxable income above `over` up to the next bracket's
 * `over`. `add` (optional) = a fixed amount added once the income exceeds `over` (a schedule notch,
 * e.g. OH "$342 plus 2.75% of the excess over $26,050").
 */
export interface StateBracket { over: number; rate: number; add?: number }
export type StateBracketsByStatus = Record<typeof EXEMPTION_STATUSES[number], StateBracket[]>;

/**
 * `brackets` (Q53): the state's rate schedule by filing status (flat-rate state = one bracket
 * `[{ over: 0, rate }]`). `schedules_by_income` = alternative schedules the state switches to by
 * state taxable income (AR): the engine uses the LAST entry whose `income_over` is below the state
 * taxable income, else the main schedule. `simplified` = features the shape cannot express (benefit
 * recapture, table midpoints, bracket-adjustment credits) — described in `note`; the engine warns.
 */
export interface StateBracketsRule extends StateBracketsByStatus {
  schedules_by_income?: Array<StateBracketsByStatus & { income_over: number }>;
  simplified?: boolean;
  note?: string;
}

/** `standard_deduction` (Q53): whole-return amount by filing status (0 = none / already in the base). */
export interface StateStandardDeductionRule extends Record<typeof EXEMPTION_STATUSES[number], number> {
  simplified?: boolean;
  note?: string;
}

/**
 * `capital_gains` (Q53/Kurt): the state's treatment of capital gains.
 * - ordinary: taxed like other income;
 * - exclusion: `exclusion_tiers` (marginal % of the gain excluded between `over` and the next `over`),
 *   floored at `exclusion_min` (capped at the gain) and capped at `exclusion_cap`, subtracted from the base;
 * - alternative_rate: tax = lesser of the regular schedule and schedule(TI − gain) + gain × `max_rate` (HI);
 * - separate_rates: `ltcg_brackets` stacked on top of ordinary taxable income (MT) and/or `stcg_rate` on the
 *   net short-term gain (MA);
 * - qualifying_assets_only: a deduction for specific assets only (in-state property, holding period, business
 *   sale) the estimator cannot identify — nothing is applied (info).
 * `applies_to`: net_ltcg = net long-term gain; net_capital_gain = net short + long-term gain.
 */
export const CAPITAL_GAINS_TREATMENTS = ['ordinary', 'exclusion', 'alternative_rate', 'separate_rates', 'qualifying_assets_only'] as const;
export type CapitalGainsTreatment = typeof CAPITAL_GAINS_TREATMENTS[number];
export const CAPITAL_GAINS_APPLIES_TO = ['net_ltcg', 'net_capital_gain'] as const;
export interface StateCapitalGainsRule {
  treatment: CapitalGainsTreatment;
  applies_to?: typeof CAPITAL_GAINS_APPLIES_TO[number];
  exclusion_tiers?: Array<{ over: number; pct: number }> | null;
  exclusion_min?: number | null;
  exclusion_cap?: number | null;
  max_rate?: number | null;
  ltcg_brackets?: StateBracketsByStatus | null;
  stcg_rate?: number | null;
  /** Surtax on the gain (any treatment) when federal AGI exceeds `surtax_agi_over` (MD 2%). */
  surtax_rate?: number | null;
  surtax_agi_over?: number | null;
  includes_qualified_dividends?: boolean;
  simplified?: boolean;
  note?: string;
}

/**
 * `federal_tax_deduction` (Q53; AL, MO, OR): deduction of federal income tax from the state base.
 * The tier is chosen by the state AGI (last tier whose `agi_over` is below it); deduction =
 * min(federal income tax × pct, cap[fs]) — no cap when `cap` is absent / null.
 */
export interface StateFederalTaxDeductionRule {
  tiers: Array<{ agi_over: number; pct: number; cap?: Partial<Record<typeof EXEMPTION_STATUSES[number], number>> | null }>;
  simplified?: boolean;
  note?: string;
}

/**
 * `capital_gains_excise` (Q53/Kurt; WA RCW 82.87): a capital gains tax in a state with no broad income
 * tax. Resident rows only: tax = Σ `brackets` over (net long-term gain − `standard_deduction`), the
 * bracket `over` measured on that taxable gain. `estimates_required` false = due with the return.
 */
export interface StateCapitalGainsExciseRule {
  standard_deduction: number;
  brackets: StateBracket[];
  estimates_required?: boolean;
  note?: string;
}

export interface StateRuleDef {
  key: string;
  type: StateRuleValueType;
  label: string;
  /** For 'enum' types. */
  options?: readonly string[];
  /** If true the value may be JSON null (rule does not exist in that state). */
  nullable?: boolean;
  /** If true the key is not part of the required (complete) key set; only the states it applies to seed it. */
  optional?: boolean;
}

export const STATE_RULE_REGISTRY: readonly StateRuleDef[] = [
  { key: 'has_income_tax', type: 'bool', label: 'Broad-based personal income tax' },
  { key: 'estimates_required', type: 'bool', label: 'State has a quarterly individual estimated-tax regime (false = no vouchers, no underpayment penalty)' },
  { key: 'required_threshold', type: 'money', label: 'Estimates required when tax due after withholding/credits is at least' },
  { key: 'threshold_comparison', type: 'enum', label: 'Threshold boundary for required_threshold and penalty.min_balance_due (null = at_least)', options: THRESHOLD_COMPARISONS, nullable: true },
  { key: 'safe_harbor.current_pct', type: 'rate', label: 'Safe harbor: % of current-year tax' },
  { key: 'safe_harbor.prior_pct', type: 'rate', label: 'Safe harbor: % of prior-year tax', nullable: true },
  { key: 'safe_harbor.high_agi_rule', type: 'high_agi_rule', label: 'High-AGI prior-year rule ({ threshold, pct, threshold_mfs?, no_prior_year_agi?, no_prior_year_agi_mfs? })', nullable: true },
  { key: 'installments.due_dates', type: 'date_list', label: 'Installment due dates' },
  { key: 'installments.pcts', type: 'rate_list', label: 'Installment percentages' },
  { key: 'installments.q4_file_and_pay_date', type: 'date', label: 'Last installment waived if the return is filed and paid in full by (null = no such relief)', nullable: true },
  { key: 'return_due_date', type: 'date', label: 'Return due date that ends the penalty period (null = April 15 of the next year)', nullable: true },
  { key: 'farmer.rule', type: 'farmer_rule', label: 'Farmer/fisherman rule ({ ratio, current_pct, due_date, file_by, treatment? })', nullable: true },
  { key: 'penalty.rate_source', type: 'enum', label: 'Underpayment penalty rate source', options: ['federal', 'state'] },
  { key: 'penalty.rate', type: 'rate', label: 'State underpayment penalty annual rate (when source = state)', nullable: true },
  { key: 'penalty.rate_schedule', type: 'rate_schedule', label: 'Dated penalty rates [{ from, to, rate }] (supersedes penalty.rate on covered days; null = single rate)', nullable: true },
  { key: 'penalty.method', type: 'enum', label: 'How the penalty accrues (null = daily_simple)', options: PENALTY_METHODS, nullable: true },
  { key: 'penalty.min_balance_due', type: 'money', label: 'No penalty when tax after credits less withholding is below (null = use required_threshold)', nullable: true },
  { key: 'credit_for_other_state', type: 'bool', label: 'Credit for tax paid to other states' },
  { key: 'nonresident_method', type: 'enum', label: 'How nonresident tax is computed', options: ['ratio', 'sourced_flat', 'other'] },
  { key: 'holidays', type: 'date_list', label: 'State holidays used for due-date roll-forward' },
  { key: 'exemptions', type: 'exemptions', label: 'Personal / dependent exemptions and exemption credits ({ personal_exemption, dependent_exemption, personal_credit, dependent_credit, *_by_status?, simplified?, note? }; null = not sourced)', nullable: true, optional: true },
  // Q53: rate schedules (optional keys, seeded for every income-tax state + DC; missing / null → the
  // row falls back to its effective rate with a warning).
  { key: 'starting_point', type: 'enum', label: 'Starting point of the state return (state_specific = approximated by federal AGI)', options: STATE_STARTING_POINTS, nullable: true, optional: true },
  { key: 'brackets', type: 'brackets', label: 'Rate schedule by filing status ({ single, mfj, mfs, hoh, qss: [{ over, rate }] } + optional schedules_by_income, simplified, note; null = not sourced)', nullable: true, optional: true },
  { key: 'standard_deduction', type: 'standard_deduction', label: 'Standard deduction by filing status ({ single, mfj, mfs, hoh, qss } + optional simplified, note; 0 = none)', nullable: true, optional: true },
  { key: 'capital_gains', type: 'capital_gains', label: 'Capital gains treatment ({ treatment, applies_to, exclusion_tiers, exclusion_min, exclusion_cap, max_rate, ltcg_brackets, stcg_rate, includes_qualified_dividends, simplified, note }; null = not sourced)', nullable: true, optional: true },
  { key: 'federal_tax_deduction', type: 'federal_tax_deduction', label: 'Deduction for federal income tax ({ tiers: [{ agi_over, pct, cap? }] }; AL, MO, OR)', nullable: true, optional: true },
  { key: 'capital_gains_excise', type: 'capital_gains_excise', label: 'Capital gains excise tax for a state with no income tax ({ standard_deduction, brackets: [{ over, rate }], estimates_required }; WA)', nullable: true, optional: true },
  { key: 'requirement_gate', type: 'requirement_gate', label: 'Income-based estimate-requirement gate ({ kind, threshold?, threshold_mfj?, non_withheld_floor? }; absent = plain threshold test)', nullable: true, optional: true },
];

const REQUIRED_WHEN_TAXED = STATE_RULE_REGISTRY.filter((d) => !d.optional).map((d) => d.key);

/** Keys a complete (state, year) row set must contain. */
export function requiredStateRuleKeys(hasIncomeTax: boolean): string[] {
  return hasIncomeTax ? REQUIRED_WHEN_TAXED : ['has_income_tax'];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** Strict calendar check (rejects 2026-02-30). */
function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function getStateRuleDef(key: string): StateRuleDef | undefined {
  return STATE_RULE_REGISTRY.find((d) => d.key === key);
}

// ── Q53 validators ──

function validateBracketList(list: unknown, where: string): string | null {
  if (!Array.isArray(list) || list.length === 0) return `${where}: expected a non-empty list of { over, rate }`;
  let prev = -1;
  for (const [i, b] of (list as unknown[]).entries()) {
    if (!isObj(b)) return `${where}: expected { over, rate }`;
    const r = b as { over?: unknown; rate?: unknown };
    if (!isNum(r.over) || r.over < 0 || !isNum(r.rate) || r.rate < 0 || r.rate >= 1) return `${where}: each bracket needs over ≥ 0 and a rate between 0 and 1`;
    if (i === 0 && r.over !== 0) return `${where}: the first bracket must start at over 0`;
    const add = (b as { add?: unknown }).add;
    if (add !== undefined && !(isNum(add) && add >= 0)) return `${where}: add must be a non-negative number`;
    if (r.over <= prev) return `${where}: brackets must be in ascending order of over`;
    prev = r.over;
  }
  return null;
}

function validateByStatusBrackets(v: Record<string, unknown>, where: string): string | null {
  for (const fs of EXEMPTION_STATUSES) {
    const err = validateBracketList(v[fs], `${where}${fs}`);
    if (err) return err;
  }
  return null;
}

function validateNoteFlags(v: Record<string, unknown>): string | null {
  if (v['simplified'] !== undefined && typeof v['simplified'] !== 'boolean') return 'simplified must be true/false';
  if (v['note'] !== undefined && typeof v['note'] !== 'string') return 'note must be text';
  return null;
}

function validateBracketsRule(value: unknown): string | null {
  if (!isObj(value)) return 'expected { single, mfj, mfs, hoh, qss: [{ over, rate }] }';
  const v = value as Record<string, unknown>;
  const main = validateByStatusBrackets(v, '');
  if (main) return main;
  if (v['schedules_by_income'] !== undefined) {
    if (!Array.isArray(v['schedules_by_income'])) return 'schedules_by_income must be a list';
    let prev = -1;
    for (const [i, sch] of (v['schedules_by_income'] as unknown[]).entries()) {
      if (!isObj(sch)) return 'schedules_by_income: expected { income_over, single, mfj, mfs, hoh, qss }';
      const o = sch as Record<string, unknown>;
      if (!isNum(o['income_over']) || (o['income_over'] as number) < 0) return `schedules_by_income[${i}]: income_over must be a non-negative number`;
      if ((o['income_over'] as number) <= prev) return 'schedules_by_income must be in ascending order of income_over';
      prev = o['income_over'] as number;
      const err = validateByStatusBrackets(o, `schedules_by_income[${i}].`);
      if (err) return err;
    }
  }
  return validateNoteFlags(v);
}

function validateStandardDeductionRule(value: unknown): string | null {
  if (!isObj(value)) return 'expected { single, mfj, mfs, hoh, qss }';
  const v = value as Record<string, unknown>;
  for (const fs of EXEMPTION_STATUSES) {
    if (!(isNum(v[fs]) && (v[fs] as number) >= 0)) return `${fs} must be a non-negative number`;
  }
  return validateNoteFlags(v);
}

function validateCapitalGainsRule(value: unknown): string | null {
  if (!isObj(value)) return 'expected { treatment, ... }';
  const v = value as Record<string, unknown>;
  if (!(CAPITAL_GAINS_TREATMENTS as readonly unknown[]).includes(v['treatment'])) return `treatment must be one of ${CAPITAL_GAINS_TREATMENTS.join(', ')}`;
  if (v['applies_to'] !== undefined && !(CAPITAL_GAINS_APPLIES_TO as readonly unknown[]).includes(v['applies_to'])) return `applies_to must be one of ${CAPITAL_GAINS_APPLIES_TO.join(', ')}`;
  const optNonNeg = (k: string) => v[k] === undefined || v[k] === null || (isNum(v[k]) && (v[k] as number) >= 0);
  for (const k of ['exclusion_min', 'exclusion_cap', 'max_rate', 'stcg_rate', 'surtax_rate', 'surtax_agi_over']) if (!optNonNeg(k)) return `${k} must be a non-negative number or null`;
  if (isNum(v['surtax_rate']) && !isNum(v['surtax_agi_over'])) return 'surtax_rate needs surtax_agi_over';
  for (const k of ['max_rate', 'stcg_rate', 'surtax_rate']) if (isNum(v[k]) && (v[k] as number) >= 1) return `${k} must be a rate below 1`;
  const tiers = v['exclusion_tiers'];
  if (tiers !== undefined && tiers !== null) {
    if (!Array.isArray(tiers) || tiers.length === 0) return 'exclusion_tiers must be a non-empty list of { over, pct } or null';
    let prev = -1;
    for (const [i, t] of (tiers as unknown[]).entries()) {
      if (!isObj(t)) return 'exclusion_tiers: expected { over, pct }';
      const o = t as { over?: unknown; pct?: unknown };
      if (!isNum(o.over) || o.over < 0 || !isNum(o.pct) || o.pct < 0 || o.pct > 1) return 'exclusion_tiers: over ≥ 0 and pct between 0 and 1';
      if (i === 0 && o.over !== 0) return 'exclusion_tiers: the first tier must start at over 0';
      if (o.over <= prev) return 'exclusion_tiers must be in ascending order of over';
      prev = o.over;
    }
  }
  if (v['treatment'] === 'exclusion' && !(Array.isArray(tiers) && tiers.length > 0) && !isNum(v['exclusion_min'])) return 'exclusion needs exclusion_tiers or exclusion_min';
  if (v['treatment'] === 'alternative_rate' && !isNum(v['max_rate'])) return 'alternative_rate needs max_rate';
  if (v['ltcg_brackets'] !== undefined && v['ltcg_brackets'] !== null) {
    if (!isObj(v['ltcg_brackets'])) return 'ltcg_brackets must be { single, mfj, mfs, hoh, qss } or null';
    const err = validateByStatusBrackets(v['ltcg_brackets'] as Record<string, unknown>, 'ltcg_brackets.');
    if (err) return err;
  }
  if (v['treatment'] === 'separate_rates' && !isObj(v['ltcg_brackets']) && !isNum(v['stcg_rate'])) return 'separate_rates needs ltcg_brackets or stcg_rate';
  if (v['includes_qualified_dividends'] !== undefined && typeof v['includes_qualified_dividends'] !== 'boolean') return 'includes_qualified_dividends must be true/false';
  return validateNoteFlags(v);
}

function validateFederalTaxDeductionRule(value: unknown): string | null {
  if (!isObj(value)) return 'expected { tiers: [{ agi_over, pct, cap? }] }';
  const v = value as Record<string, unknown>;
  const tiers = v['tiers'];
  if (!Array.isArray(tiers) || tiers.length === 0) return 'tiers must be a non-empty list';
  let prev = -1;
  for (const [i, t] of (tiers as unknown[]).entries()) {
    if (!isObj(t)) return 'tiers: expected { agi_over, pct, cap? }';
    const o = t as Record<string, unknown>;
    if (!isNum(o['agi_over']) || (o['agi_over'] as number) < 0 || !isNum(o['pct']) || (o['pct'] as number) < 0 || (o['pct'] as number) > 1) return 'tiers: agi_over ≥ 0 and pct between 0 and 1';
    if (i === 0 && o['agi_over'] !== 0) return 'tiers: the first tier must start at agi_over 0';
    if ((o['agi_over'] as number) <= prev) return 'tiers must be in ascending order of agi_over';
    prev = o['agi_over'] as number;
    if (o['cap'] !== undefined && o['cap'] !== null) {
      if (!isObj(o['cap'])) return 'cap must be an object keyed by filing status';
      for (const [fs, n] of Object.entries(o['cap'] as Record<string, unknown>)) {
        if (!(EXEMPTION_STATUSES as readonly string[]).includes(fs)) return `cap: unknown filing status ${fs}`;
        if (!(isNum(n) && n >= 0)) return `cap.${fs} must be a non-negative number`;
      }
    }
  }
  return validateNoteFlags(v);
}

function validateCapitalGainsExciseRule(value: unknown): string | null {
  if (!isObj(value)) return 'expected { standard_deduction, brackets }';
  const v = value as Record<string, unknown>;
  if (!(isNum(v['standard_deduction']) && (v['standard_deduction'] as number) >= 0)) return 'standard_deduction must be a non-negative number';
  const err = validateBracketList(v['brackets'], 'brackets');
  if (err) return err;
  if (v['estimates_required'] !== undefined && typeof v['estimates_required'] !== 'boolean') return 'estimates_required must be true/false';
  if (v['note'] !== undefined && typeof v['note'] !== 'string') return 'note must be text';
  return null;
}

export function validateStateRuleValue(def: StateRuleDef, value: unknown): string | null {
  if (value === null) return def.nullable ? null : 'null not allowed for this key';
  switch (def.type) {
    case 'bool': return typeof value === 'boolean' ? null : 'expected true/false';
    case 'money': case 'rate': return isNum(value) && value >= 0 ? null : 'expected a non-negative number';
    case 'date': return typeof value === 'string' && isIsoDate(value) ? null : 'expected a YYYY-MM-DD date';
    case 'date_list': return Array.isArray(value) && value.every((x) => typeof x === 'string' && ISO_DATE.test(x)) ? null : 'expected YYYY-MM-DD dates';
    case 'rate_list': return Array.isArray(value) && value.length > 0 && value.every((x) => isNum(x) && x >= 0) ? null : 'expected a non-empty list of non-negative numbers';
    case 'enum': return typeof value === 'string' && (def.options ?? []).includes(value) ? null : `expected one of ${(def.options ?? []).join(', ')}`;
    case 'high_agi_rule': {
      if (!isObj(value)) return 'expected { threshold, pct }';
      const v = value as { threshold?: unknown; pct?: unknown; threshold_mfs?: unknown; no_prior_year_agi?: unknown; no_prior_year_agi_mfs?: unknown };
      if (!isNum(v.threshold) || !isNum(v.pct)) return 'expected { threshold, pct }';
      const optNum = (x: unknown) => x === undefined || (isNum(x) && x >= 0);
      return optNum(v.threshold_mfs) && optNum(v.no_prior_year_agi) && optNum(v.no_prior_year_agi_mfs)
        ? null : 'threshold_mfs / no_prior_year_agi / no_prior_year_agi_mfs must be non-negative numbers';
    }
    case 'farmer_rule': {
      if (!isObj(value)) return 'expected { ratio, current_pct, due_date, file_by }';
      const v = value as { ratio?: unknown; current_pct?: unknown; due_date?: unknown; file_by?: unknown; treatment?: unknown };
      if (!(isNum(v.ratio) && isNum(v.current_pct) && typeof v.due_date === 'string' && isIsoDate(v.due_date) && typeof v.file_by === 'string' && isIsoDate(v.file_by))) {
        return 'expected { ratio, current_pct, due_date, file_by }';
      }
      if (v.treatment !== undefined && !(FARMER_TREATMENTS as readonly unknown[]).includes(v.treatment)) {
        return `treatment must be one of ${FARMER_TREATMENTS.join(', ')}`;
      }
      return null;
    }
    case 'requirement_gate': {
      if (!isObj(value)) return 'expected { kind, ... }';
      const v = value as { kind?: unknown; threshold?: unknown; threshold_mfj?: unknown; non_withheld_floor?: unknown };
      if (!(REQUIREMENT_GATE_KINDS as readonly unknown[]).includes(v.kind)) return `kind must be one of ${REQUIREMENT_GATE_KINDS.join(', ')}`;
      const optNum = (x: unknown) => x === undefined || (isNum(x) && x >= 0);
      if (!optNum(v.threshold) || !optNum(v.threshold_mfj) || !optNum(v.non_withheld_floor)) return 'threshold / threshold_mfj / non_withheld_floor must be non-negative numbers';
      const needsThreshold = v.kind === 'gross_income_both_years' || v.kind === 'non_withheld_income' || v.kind === 'prior_year_liability_also';
      if (needsThreshold && !isNum(v.threshold)) return `${String(v.kind)} needs a threshold`;
      if (v.kind === 'gross_over_exemptions_deductions' && !isNum(v.non_withheld_floor)) return 'gross_over_exemptions_deductions needs non_withheld_floor';
      return null;
    }
    case 'exemptions': {
      if (!isObj(value)) return 'expected { personal_exemption, dependent_exemption, personal_credit, dependent_credit }';
      const v = value as Record<string, unknown>;
      for (const k of ['personal_exemption', 'dependent_exemption', 'personal_credit', 'dependent_credit']) {
        if (!(k in v)) return `missing ${k} (use null when not sourced)`;
        if (v[k] !== null && !(isNum(v[k]) && (v[k] as number) >= 0)) return `${k} must be a non-negative number or null`;
      }
      for (const k of ['personal_exemption_by_status', 'personal_credit_by_status']) {
        if (v[k] === undefined) continue;
        if (!isObj(v[k])) return `${k} must be an object keyed by filing status`;
        for (const [fs, n] of Object.entries(v[k] as Record<string, unknown>)) {
          if (!(EXEMPTION_STATUSES as readonly string[]).includes(fs)) return `${k}: unknown filing status ${fs}`;
          if (!(isNum(n) && n >= 0)) return `${k}.${fs} must be a non-negative number`;
        }
      }
      if (v['simplified'] !== undefined && typeof v['simplified'] !== 'boolean') return 'simplified must be true/false';
      if (v['note'] !== undefined && typeof v['note'] !== 'string') return 'note must be text';
      return null;
    }
    case 'brackets': return validateBracketsRule(value);
    case 'standard_deduction': return validateStandardDeductionRule(value);
    case 'capital_gains': return validateCapitalGainsRule(value);
    case 'federal_tax_deduction': return validateFederalTaxDeductionRule(value);
    case 'capital_gains_excise': return validateCapitalGainsExciseRule(value);
    case 'rate_schedule': {
      if (!Array.isArray(value) || value.length === 0) return 'expected a non-empty list of { from, to, rate }';
      let prevTo = '';
      for (const p of value as unknown[]) {
        if (!isObj(p)) return 'expected a non-empty list of { from, to, rate }';
        const r = p as { from?: unknown; to?: unknown; rate?: unknown };
        if (typeof r.from !== 'string' || !isIsoDate(r.from) || typeof r.to !== 'string' || !isIsoDate(r.to) || !isNum(r.rate) || r.rate < 0) {
          return 'each period needs from/to YYYY-MM-DD dates and a non-negative rate';
        }
        if (r.from > r.to) return `period ${r.from}..${r.to} ends before it starts`;
        if (prevTo && r.from <= prevTo) return 'periods must be in date order and must not overlap';
        prevTo = r.to;
      }
      return null;
    }
    default: return 'unknown type';
  }
}

export interface StateRuleSeedRow {
  state: StateCode;
  year: number;
  key: string;
  value: unknown;
  citation: string;
  status: 'verified' | 'unverified' | 'provisional';
}

/**
 * Penalty rate for one calendar day under a resolved rule set: a `penalty.rate_schedule`
 * leg covering `isoDate` wins; otherwise the single `penalty.rate`. `covered` is false
 * when a schedule exists but has no leg for that day (e.g. a next-year rate not yet
 * published) — the caller then uses the returned single rate and shows "verify".
 */
export function statePenaltyRateOn(rules: Record<string, unknown>, isoDate: string): { rate: number | null; fromSchedule: boolean; covered: boolean } {
  const single = typeof rules['penalty.rate'] === 'number' ? (rules['penalty.rate'] as number) : null;
  const sched = rules['penalty.rate_schedule'];
  if (Array.isArray(sched) && sched.length > 0) {
    const leg = (sched as StateRatePeriod[]).find((p) => p.from <= isoDate && isoDate <= p.to);
    return leg ? { rate: leg.rate, fromSchedule: true, covered: true } : { rate: single, fromSchedule: false, covered: false };
  }
  return { rate: single, fromSchedule: false, covered: true };
}
