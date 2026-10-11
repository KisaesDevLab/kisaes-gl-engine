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

export const STATE_RULE_VALUE_TYPES = ['bool', 'money', 'rate', 'date_list', 'rate_list', 'enum', 'high_agi_rule', 'farmer_rule'] as const;
export type StateRuleValueType = typeof STATE_RULE_VALUE_TYPES[number];

export interface StateRuleDef {
  key: string;
  type: StateRuleValueType;
  label: string;
  /** For 'enum' types. */
  options?: readonly string[];
  /** If true the value may be JSON null (rule does not exist in that state). */
  nullable?: boolean;
}

export const STATE_RULE_REGISTRY: readonly StateRuleDef[] = [
  { key: 'has_income_tax', type: 'bool', label: 'Broad-based personal income tax' },
  { key: 'required_threshold', type: 'money', label: 'Estimates required when tax due after withholding/credits is at least' },
  { key: 'safe_harbor.current_pct', type: 'rate', label: 'Safe harbor: % of current-year tax' },
  { key: 'safe_harbor.prior_pct', type: 'rate', label: 'Safe harbor: % of prior-year tax', nullable: true },
  { key: 'safe_harbor.high_agi_rule', type: 'high_agi_rule', label: 'High-AGI prior-year rule ({ threshold, pct })', nullable: true },
  { key: 'installments.due_dates', type: 'date_list', label: 'Installment due dates' },
  { key: 'installments.pcts', type: 'rate_list', label: 'Installment percentages' },
  { key: 'farmer.rule', type: 'farmer_rule', label: 'Farmer/fisherman rule ({ ratio, current_pct, due_date, file_by })', nullable: true },
  { key: 'penalty.rate_source', type: 'enum', label: 'Underpayment penalty rate source', options: ['federal', 'state'] },
  { key: 'penalty.rate', type: 'rate', label: 'State underpayment penalty annual rate (when source = state)', nullable: true },
  { key: 'credit_for_other_state', type: 'bool', label: 'Credit for tax paid to other states' },
  { key: 'nonresident_method', type: 'enum', label: 'How nonresident tax is computed', options: ['ratio', 'sourced_flat', 'other'] },
  { key: 'holidays', type: 'date_list', label: 'State holidays used for due-date roll-forward' },
];

const REQUIRED_WHEN_TAXED = STATE_RULE_REGISTRY.map((d) => d.key);

/** Keys a complete (state, year) row set must contain. */
export function requiredStateRuleKeys(hasIncomeTax: boolean): string[] {
  return hasIncomeTax ? REQUIRED_WHEN_TAXED : ['has_income_tax'];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function getStateRuleDef(key: string): StateRuleDef | undefined {
  return STATE_RULE_REGISTRY.find((d) => d.key === key);
}

export function validateStateRuleValue(def: StateRuleDef, value: unknown): string | null {
  if (value === null) return def.nullable ? null : 'null not allowed for this key';
  switch (def.type) {
    case 'bool': return typeof value === 'boolean' ? null : 'expected true/false';
    case 'money': case 'rate': return isNum(value) && value >= 0 ? null : 'expected a non-negative number';
    case 'date_list': return Array.isArray(value) && value.every((x) => typeof x === 'string' && ISO_DATE.test(x)) ? null : 'expected YYYY-MM-DD dates';
    case 'rate_list': return Array.isArray(value) && value.length > 0 && value.every((x) => isNum(x) && x >= 0) ? null : 'expected a non-empty list of non-negative numbers';
    case 'enum': return typeof value === 'string' && (def.options ?? []).includes(value) ? null : `expected one of ${(def.options ?? []).join(', ')}`;
    case 'high_agi_rule': {
      const v = value as { threshold?: unknown; pct?: unknown };
      return v && isNum(v.threshold) && isNum(v.pct) ? null : 'expected { threshold, pct }';
    }
    case 'farmer_rule': {
      const v = value as { ratio?: unknown; current_pct?: unknown; due_date?: unknown; file_by?: unknown };
      return v && isNum(v.ratio) && isNum(v.current_pct) && typeof v.due_date === 'string' && ISO_DATE.test(v.due_date) && typeof v.file_by === 'string' && ISO_DATE.test(v.file_by)
        ? null : 'expected { ratio, current_pct, due_date, file_by }';
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
