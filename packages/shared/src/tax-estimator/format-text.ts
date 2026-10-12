// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// QA D7 / D19: engine trace formulas and warning messages carry exact decimal
// strings ("bracket tax on 138725.7318071403638391314"). These helpers format
// them for people (screen and PDF) without touching the computed figures.

import { dRound } from './decimal.js';

const MONEY_PLACES = 2;
const RATE_SIG_PLACES = 6;
const GROUP_FROM_DIGITS = 5; // 4-digit integers are usually years; leave them alone

/** "0.2200" → "0.22", "110" → "110", "5.000" → "5". */
const trimZeros = (d: string) => (d.includes('.') ? d.replace(/0+$/, '').replace(/\.$/, '') : d);
const group = (intDigits: string) => intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "138725.7318071403638391314" → "138,725.73"; "0.2200000" → "0.22"; "182000" → "182,000"; "2026" unchanged. */
export function formatNumberToken(token: string): string {
  const neg = token.startsWith('-');
  const body = neg ? token.slice(1) : token;
  const [int = '', frac] = body.split('.');
  let out: string;
  if (frac === undefined) {
    out = int.length >= GROUP_FROM_DIGITS ? group(int) : int;
  } else if (int !== '0') {
    const r = dRound(body, MONEY_PLACES);
    const [ri = '', rf = ''] = r.split('.');
    const cents = rf.padEnd(MONEY_PLACES, '0');
    out = `${group(ri)}${/^0+$/.test(cents) ? '' : `.${cents}`}`;
  } else {
    const trimmed = trimZeros(dRound(body, RATE_SIG_PLACES));
    out = trimmed === '' ? '0' : trimmed;
  }
  return `${neg ? '-' : ''}${out}`;
}

// A number not glued to letters, dates (2026-04-15), ids or other numbers.
const NUMBER_RE = /(?<![\w.:/#-])-?\d+(?:\.\d+)?(?![\w/#]|-\d|\.\d|:\w)/g;

/** Format every free-standing number in a trace formula or message. Dates, ids and codes are left as they are. */
export function formatNumbersInText(text: string): string {
  return text.replace(NUMBER_RE, (m) => formatNumberToken(m));
}

// ── presentation of engine prose (QA D8 / D19) ─────────────────────────────

const COMPARISON_GATE = /\((\w+), threshold (-?\d+(?:\.\d+)?) (more_than|at_least)\)/g;
const COMPARISON_WORD = /\b(more_than|at_least)\b/g;
const DOUBLED_PREFIX_ANY = /^([A-Z]{2}|[A-Za-z]+): (?:\1: )+/;
const HARBOR_FRACTION_TEXT = /harbor is (\d+(?:\.\d+)?) of prior-year tax/g;
// QA D19: the state gate note "Tax 7590.29 less withholding 2000 and credits 0 = 5590.29; threshold 100 (at_least)".
const GATE_MONEY = /(\b(?:Tax|withholding|credits|threshold)|=) (-?\d+(?:\.\d+)?)(?![\d.,]*\d)/g;
const THRESHOLD_CMP = /threshold (\$[\d,.]+) \((more than|at least)\)/g;
const DOUBLE_PERIOD = /(?<!\.)\.\.(?!\.)/g;
const BASE_KEYS: Record<string, string> = { federal_agi: 'federal AGI', federal_taxable: 'federal taxable income' };
const BASE_KEY = /"?\b(federal_agi|federal_taxable)\b"?/g;
// A JSON table frozen into older text (complete, or cut off with an ellipsis).
const JSON_TABLE = /\[\{"(?:[^\]…]*)(?:\}\]|…)/g;
const PERCENT_SCALE = 100;
const PCT_PLACES = 2;

const moneyText = (n: string) => { const [i = '', f] = dRound(n, MONEY_PLACES).split('.'); return `${group(i)}${f && !/^0+$/.test(f) ? `.${f.padEnd(MONEY_PLACES, '0')}` : ''}`; };
const pctOf = (fraction: string) => `${trimZeros(dRound(String(Number(fraction) * PERCENT_SCALE), PCT_PLACES))}%`;

/**
 * Engine prose for people: "AR: AR: …" collapses, "(threshold, threshold 1000 more_than)"
 * reads "(required when the tax is more than 1,000)", a prior-year harbor fraction reads as a
 * percent, and every number is formatted (no 20-digit decimals). Dates and codes are untouched.
 */
export function presentEngineText(text: string): string {
  return formatNumbersInText(text
    .replace(JSON_TABLE, (m) => {
      const rows = m.split('{').length - 1;
      return m.endsWith('}]') ? `a table of ${rows} ${rows === 1 ? 'row' : 'rows'} (see Admin > Tax parameters)` : 'a table of values (see Admin > Tax parameters)';
    })
    .replace(DOUBLED_PREFIX_ANY, '$1: ')
    .replace(COMPARISON_GATE, (_m, _method: string, threshold: string, cmp: string) => `(required when the tax is ${cmp === 'more_than' ? 'more than' : 'at least'} $${moneyText(threshold)})`)
    .replace(COMPARISON_WORD, (w) => (w === 'more_than' ? 'more than' : 'at least'))
    .replace(GATE_MONEY, (_m, word: string, n: string) => `${word} $${moneyText(n)}`)
    .replace(THRESHOLD_CMP, (_m, amount: string, cmp: string) => `threshold: ${cmp} ${amount}`)
    .replace(BASE_KEY, (_m, k: string) => BASE_KEYS[k] ?? k)
    .replace(HARBOR_FRACTION_TEXT, (_m, f: string) => `harbor is ${pctOf(f)} of prior-year tax`)
    .replace(DOUBLE_PERIOD, '.'));
}

/** A parameter value for people: numbers formatted, a structured value named by its shape (never JSON). */
export function presentParameterValue(v: unknown): string {
  if (typeof v === 'number') return formatNumberToken(String(v));
  if (typeof v === 'string') return presentEngineText(v);
  if (Array.isArray(v)) return `a table of ${v.length} ${v.length === 1 ? 'row' : 'rows'} (see Admin > Tax parameters)`;
  if (v !== null && typeof v === 'object') return 'a structured value (see Admin > Tax parameters)';
  return String(v);
}

interface PresentableWarning { code: string; message: string; details?: Record<string, unknown> }

/** A warning's message for the screen and the PDF. Unverified structured parameters name their shape instead of dumping JSON. */
export function presentWarningMessage(w: PresentableWarning): string {
  if (w.code === 'TE_PARAM_UNVERIFIED' && w.details && typeof w.details['value'] === 'object' && w.details['value'] !== null) {
    const v = w.details['value'];
    const shape = Array.isArray(v) ? `a table of ${v.length} ${v.length === 1 ? 'row' : 'rows'}` : 'a structured value';
    return `Tax parameter '${String(w.details['key'])}' is ${String(w.details['status'])} (not CPA-verified); the estimate uses its current value (${shape}; see Admin > Tax parameters).`;
  }
  return presentEngineText(w.message);
}

/** Which tile the safe-harbor card / PDF marks "Recommended": under lesser_of, the lower of the two available amounts (QA D8). */
export function recommendedHarborRule(sh: {
  appliedRule: string; currentYear: { amount: string }; priorYear: { available: boolean; amount: string | null };
}): 'current_year' | 'prior_year' {
  if (sh.appliedRule === 'prior_year') return 'prior_year';
  if (sh.appliedRule === 'current_year') return 'current_year';
  if (!sh.priorYear.available || sh.priorYear.amount == null) return 'current_year';
  return Number(sh.priorYear.amount) < Number(sh.currentYear.amount) ? 'prior_year' : 'current_year';
}
